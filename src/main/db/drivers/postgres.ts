/**
 * PostgreSQL driver, built on node-postgres.
 *
 * Two things work differently enough from MySQL to be worth calling out:
 *
 * - A connection is bound to one *database*, and the tree's top level is that
 *   database's schemas. `SET search_path` moves between them; there is no `USE`
 *   and no way to reach another database without reconnecting.
 * - The wire protocol names a result column only by its table OID and attribute
 *   number, where MySQL sends the table name and per-column flags outright. The
 *   catalogue lookups those OIDs need are cached in `tableCache`/`typeCache`,
 *   because the editable-grid check runs after every single query.
 */

import pg from 'pg'
import type { PoolConfig } from 'pg'
import type {
  CellValue,
  ColumnMeta,
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  SchemaInfo,
  TableDefinition
} from '@shared/types'
import type { Driver, DriverConnection, DriverContext, RawResult } from '../driver'
import { pgCreateTable } from '@shared/pgDdl'

const { Client, types: pgTypes } = pg

/** Blobs larger than this are summarised rather than hex-dumped into the grid. */
const MAX_INLINE_BLOB = 256

const OID_BOOL = 16
const OID_BYTEA = 17

/**
 * Every value arrives as the exact text the server rendered, which is the same
 * bargain the MySQL side strikes with `dateStrings`/`bigNumberStrings`: no
 * timezone shifts on timestamps, no precision lost off numerics, and JSON and
 * arrays keep their Postgres literal form instead of being re-serialised by JS.
 */
const passthroughTypes = {
  getTypeParser(oid: number, format?: string) {
    if (oid === OID_BOOL) return (value: string): string => (value === 't' ? 'true' : 'false')
    // bytea still becomes a Buffer so it can be summarised by size below.
    if (oid === OID_BYTEA) return pgTypes.getTypeParser(oid, format as never)
    return (value: string): string => value
  }
} as unknown as PoolConfig['types']

/** Errors that mean the socket is gone rather than the statement being bad. */
const LOST_CONNECTION_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETRESET',
  // admin_shutdown, crash_shutdown, cannot_connect_now
  '57P01',
  '57P02',
  '57P03',
  // connection_exception / connection_does_not_exist / connection_failure
  '08000',
  '08003',
  '08006'
])

/** Referential actions, as `pg_constraint` stores them. */
const FK_ACTIONS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT'
}

interface TypeInfo {
  name: string
  isNumeric: boolean
}

interface AttributeInfo {
  name: string
  table: string
  schema: string
  isPrimaryKey: boolean
  isNotNull: boolean
  isAutoIncrement: boolean
}

/** Turns whatever the driver produced into something the grid can render. */
function normaliseCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Buffer.isBuffer(value)) {
    return value.length <= MAX_INLINE_BLOB
      ? '\\x' + value.toString('hex')
      : `BYTEA (${value.length} bytes)`
  }
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

class PostgresConnection implements DriverConnection {
  private usable = true

  constructor(
    private readonly client: pg.Client,
    readonly backendId: number,
    private readonly driver: PostgresDriver
  ) {}

  markDead(): void {
    this.usable = false
  }

  /**
   * Runs a statement and returns rows only.
   *
   * Every catalogue lookup the driver makes for itself goes through here rather
   * than `query`. That is not just to save work: describing a result set means
   * looking up the OIDs in it, and looking those up is itself a query — so
   * routing internal lookups through `query` would recurse without end.
   */
  async rawQuery(sql: string, params?: unknown[]): Promise<{ rows: CellValue[][]; fields: pg.FieldDef[]; affectedRows: number }> {
    const raw = await this.client.query({
      text: sql,
      values: params as never,
      // Matches the MySQL side's `rowsAsArray`: cheaper for wide results, and
      // the grid is column-indexed anyway.
      rowMode: 'array'
    })
    // The simple query protocol returns one result per statement in the text.
    // We split beforehand, so anything extra is a trailing empty statement.
    const result = Array.isArray(raw) ? raw[raw.length - 1] : raw
    return {
      rows: ((result?.rows as unknown[][]) ?? []).map((row) => row.map(normaliseCell)),
      fields: result?.fields ?? [],
      affectedRows: result?.rowCount ?? 0
    }
  }

  async query(sql: string, params?: unknown[]): Promise<RawResult> {
    const result = await this.rawQuery(sql, params)

    if (result.fields.length === 0) {
      return { columns: [], rows: [], affectedRows: result.affectedRows, hasResultSet: false }
    }
    return {
      columns: await this.driver.describeColumns(this, result.fields),
      rows: result.rows,
      affectedRows: 0,
      hasResultSet: true
    }
  }

  async ping(): Promise<void> {
    await this.client.query('SELECT 1')
  }

  async end(): Promise<void> {
    this.usable = false
    await this.client.end()
  }

  destroy(): void {
    this.usable = false
    // There is no synchronous kill; end() rejects on an already-dead socket.
    void this.client.end().catch(() => undefined)
  }

  isUsable(): boolean {
    return this.usable
  }
}

export class PostgresDriver implements Driver {
  readonly engine = 'postgres' as const

  /** OID -> type name. Stable for the life of the database. */
  private readonly typeCache = new Map<number, TypeInfo>()
  /** `tableOid:attnum` -> column facts, for the editable-grid check. */
  private readonly attributeCache = new Map<string, AttributeInfo>()
  /** Table OIDs whose attributes have already been fetched. */
  private readonly loadedTables = new Set<number>()

  constructor(private readonly ctx: DriverContext) {}

  /**
   * Catalogue lookups, which must skip the column-describing path — see
   * `PostgresConnection.rawQuery`. Only this driver ever creates the
   * connections it is handed, so the cast always holds.
   */
  private async rows(
    conn: DriverConnection,
    sql: string,
    params?: unknown[]
  ): Promise<CellValue[][]> {
    const result = await (conn as PostgresConnection).rawQuery(sql, params)
    return result.rows
  }

  /** The database a connection opens; Postgres cannot cross one mid-session. */
  private get database(): string {
    return this.ctx.config.database?.trim() || 'postgres'
  }

  private get searchPath(): string {
    return this.ctx.currentSchema() || this.ctx.config.defaultSchema || 'public'
  }

  async open(onLost?: () => void): Promise<DriverConnection> {
    const { config, prefs } = this.ctx
    const tunnel = this.ctx.tunnel()

    const build = async (): Promise<pg.Client> =>
      new Client({
        host: tunnel ? '127.0.0.1' : config.host || '127.0.0.1',
        port: tunnel ? tunnel.localPort : config.port || 5432,
        user: config.user,
        password: await this.ctx.password(),
        database: this.database,
        connectionTimeoutMillis: Math.max(1, prefs.connectTimeoutSec) * 1000,
        application_name: 'MySQL Browser',
        types: passthroughTypes,
        ssl: config.useSSL
          ? { rejectUnauthorized: config.rejectUnauthorized !== false }
          : undefined
      })

    let client = await build()
    try {
      await client.connect()
    } catch (err: any) {
      // `28P01 invalid_password` after a stale IAM token: mint a new one and
      // try once more before reporting a credentials failure.
      if (err?.code !== '28P01' || !(await this.ctx.refreshPassword())) throw err
      client = await build()
      await client.connect()
    }

    const connection = new PostgresConnection(
      client,
      (client as unknown as { processID: number }).processID ?? 0,
      this
    )
    // An idle socket dropped by the server must not take the worker down, but it
    // does have to be recorded so the dead connection is not handed out again.
    client.on('error', () => {
      connection.markDead()
      onLost?.()
    })
    client.on('end', () => {
      connection.markDead()
      onLost?.()
    })

    const schema = this.searchPath
    if (schema) {
      // Keeping pg_catalog on the path is what lets unqualified calls to
      // built-in functions keep working after the path is narrowed.
      await client
        .query(`SET search_path TO "${schema.replace(/"/g, '""')}", pg_catalog`)
        .catch(() => undefined)
    }

    return connection
  }

  async serverVersion(conn: DriverConnection): Promise<string> {
    const rows = await this.rows(conn, 'SHOW server_version')
    return String(rows[0]?.[0] ?? 'unknown')
  }

  async cancel(control: DriverConnection, backendId: number): Promise<void> {
    if (!backendId) return
    await control.query('SELECT pg_cancel_backend($1)', [backendId])
  }

  isConnectionLost(err: any): boolean {
    if (!err) return false
    if (err.code && LOST_CONNECTION_CODES.has(String(err.code))) return true
    const message = String(err.message || '')
    return (
      message.includes('Connection terminated') ||
      message.includes('connection error') ||
      message.includes('Client has encountered a connection error') ||
      this.isEnqueueRefusal(err)
    )
  }

  /**
   * node-postgres rejects immediately, without writing to the socket, once the
   * client has been closed — so the statement provably never ran.
   */
  isEnqueueRefusal(err: any): boolean {
    const message = String(err?.message || '')
    return (
      message.includes('Client was closed and is not queryable') ||
      message.includes('Cannot use a pool after calling end')
    )
  }

  /**
   * Postgres hands back an exact 1-based offset on `err.position` for syntax
   * errors and many semantic ones — no guessing needed. `pg` delivers it as a
   * string.
   */
  errorPosition(err: any, sql: string): number | null {
    const position = Number(err?.position)
    if (!Number.isInteger(position) || position < 1) return null
    return position <= sql.length + 1 ? position : null
  }

  schemaFromStatement(sql: string): string | null {
    // `SET search_path TO a, b` — the first entry is the one new objects and
    // unqualified lookups land in, so that is what the tree should follow.
    const path = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?search_path\s*(?:TO|=)\s*(.+)$/is.exec(sql)
    if (path) {
      const first = path[1].split(',')[0].trim().replace(/;+\s*$/, '')
      const unquoted = /^"(.*)"$/.exec(first)
      const name = unquoted ? unquoted[1].replace(/""/g, '"') : first
      return name && name.toLowerCase() !== 'pg_catalog' ? name : null
    }
    const setSchema = /^\s*SET\s+SCHEMA\s+'([^']+)'/i.exec(sql)
    return setSchema ? setSchema[1] : null
  }

  // --- result metadata ---------------------------------------------------

  /**
   * Fills in the column facts the grid needs from the OIDs the protocol gave
   * us, fetching and caching anything not seen before.
   */
  async describeColumns(
    conn: DriverConnection,
    fields: pg.FieldDef[]
  ): Promise<ColumnMeta[]> {
    const unknownTypes = [...new Set(fields.map((f) => f.dataTypeID))].filter(
      (oid) => !this.typeCache.has(oid)
    )
    if (unknownTypes.length > 0) await this.loadTypes(conn, unknownTypes)

    const unknownTables = [...new Set(fields.map((f) => f.tableID))].filter(
      (oid) => oid > 0 && !this.loadedTables.has(oid)
    )
    if (unknownTables.length > 0) await this.loadAttributes(conn, unknownTables)

    return fields.map((f) => {
      const type = this.typeCache.get(f.dataTypeID)
      const attribute = this.attributeCache.get(`${f.tableID}:${f.columnID}`)
      return {
        name: f.name,
        orgName: attribute?.name || f.name,
        orgTable: attribute?.table || '',
        schema: attribute?.schema || '',
        type: f.dataTypeID,
        typeName: (type?.name || 'unknown').toUpperCase(),
        isPrimaryKey: attribute?.isPrimaryKey ?? false,
        isNotNull: attribute?.isNotNull ?? false,
        isAutoIncrement: attribute?.isAutoIncrement ?? false,
        isNumeric: type?.isNumeric ?? false
      }
    })
  }

  private async loadTypes(conn: DriverConnection, oids: number[]): Promise<void> {
    const rows = await this.rows(
      conn,
      `SELECT oid, typname, typcategory FROM pg_type WHERE oid = ANY($1::oid[])`,
      [oids]
    )
    for (const row of rows) {
      this.typeCache.set(Number(row[0]), {
        name: String(row[1]),
        // 'N' is Postgres' own numeric category, which covers every int, float
        // and numeric width without listing OIDs by hand.
        isNumeric: String(row[2]) === 'N'
      })
    }
    // Cache the misses too, so an unknown OID is not looked up on every query.
    for (const oid of oids) {
      if (!this.typeCache.has(oid)) this.typeCache.set(oid, { name: 'unknown', isNumeric: false })
    }
  }

  private async loadAttributes(conn: DriverConnection, tableOids: number[]): Promise<void> {
    const rows = await this.rows(
      conn,
      `SELECT a.attrelid, a.attnum, a.attname, c.relname, n.nspname, a.attnotnull,
              (a.attidentity <> '' OR pg_get_expr(ad.adbin, ad.adrelid) LIKE 'nextval(%') AS is_auto,
              COALESCE(pk.indisprimary, false) AS is_pk
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
         LEFT JOIN pg_index pk ON pk.indrelid = a.attrelid
                              AND pk.indisprimary
                              AND a.attnum = ANY(pk.indkey::smallint[])
        WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped`,
      [tableOids]
    )

    for (const row of rows) {
      this.attributeCache.set(`${Number(row[0])}:${Number(row[1])}`, {
        name: String(row[2]),
        table: String(row[3]),
        schema: String(row[4]),
        isNotNull: row[5] === true || row[5] === 'true',
        isAutoIncrement: row[6] === true || row[6] === 'true',
        isPrimaryKey: row[7] === true || row[7] === 'true'
      })
    }
    for (const oid of tableOids) this.loadedTables.add(oid)
  }

  // --- catalogue ---------------------------------------------------------

  async listSchemas(conn: DriverConnection): Promise<SchemaInfo[]> {
    // A LEFT JOIN so an empty schema still shows up in the tree.
    const rows = await this.rows(
      conn,
      `SELECT n.nspname, c.relname, c.relkind
         FROM pg_namespace n
         LEFT JOIN pg_class c
                ON c.relnamespace = n.oid AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
        WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
        ORDER BY n.nspname, c.relname`
    )

    const bySchema = new Map<string, SchemaInfo>()
    for (const row of rows) {
      const schema = String(row[0])
      let entry = bySchema.get(schema)
      if (!entry) {
        entry = { name: schema, tables: [] }
        bySchema.set(schema, entry)
      }
      if (row[1] === null) continue
      const kind = String(row[2])
      entry.tables.push({
        name: String(row[1]),
        type: kind === 'v' || kind === 'm' ? 'view' : 'table'
      })
    }
    return [...bySchema.values()]
  }

  async tableColumns(conn: DriverConnection, schema: string, table: string): Promise<string[]> {
    const rows = await this.rows(
      conn,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table]
    )
    return rows.map((r) => String(r[0]))
  }

  async schemaColumns(conn: DriverConnection, schema: string): Promise<Record<string, string[]>> {
    const rows = await this.rows(
      conn,
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
      [schema]
    )
    const out: Record<string, string[]> = {}
    for (const r of rows) {
      const table = String(r[0])
      ;(out[table] ??= []).push(String(r[1]))
    }
    return out
  }

  async tableDefinition(
    conn: DriverConnection,
    schema: string,
    table: string
  ): Promise<TableDefinition> {
    const tableRows = await this.rows(
      conn,
      `SELECT c.oid, obj_description(c.oid, 'pg_class'), c.relkind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table]
    )
    const meta = tableRows[0]
    if (!meta) throw new Error(`Table ${schema}.${table} was not found`)

    const columns = await this.tableColumnInfo(conn, schema, table)
    const indexes = await this.tableIndexes(conn, schema, table)
    const foreignKeys = await this.tableForeignKeys(conn, schema, table)

    const encoding = await this.rows(conn, 'SHOW server_encoding')
      .then((r) => String(r[0]?.[0] ?? ''))
      .catch(() => '')

    return {
      schema,
      name: table,
      charset: encoding,
      // A Postgres table has no single collation; per-column ones are on the
      // columns themselves.
      collation: '',
      // Nothing in Postgres corresponds to a storage engine.
      engine: '',
      comment: meta[1] === null ? '' : String(meta[1]),
      columns,
      indexes,
      foreignKeys
    }
  }

  private async tableColumnInfo(
    conn: DriverConnection,
    schema: string,
    table: string
  ): Promise<ColumnInfo[]> {
    const rows = await this.rows(
      conn,
      `SELECT a.attname,
              format_type(a.atttypid, a.atttypmod),
              a.attnotnull,
              pg_get_expr(ad.adbin, ad.adrelid),
              a.attidentity,
              a.attgenerated,
              col_description(a.attrelid, a.attnum),
              co.collname,
              a.attnum,
              COALESCE(pk.indisprimary, false),
              COALESCE(uq.is_unique, false)
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
         LEFT JOIN pg_collation co ON co.oid = a.attcollation
         LEFT JOIN pg_index pk ON pk.indrelid = a.attrelid
                              AND pk.indisprimary
                              AND a.attnum = ANY(pk.indkey::smallint[])
         LEFT JOIN LATERAL (
              SELECT true AS is_unique
                FROM pg_index i
               WHERE i.indrelid = a.attrelid
                 AND i.indisunique
                 AND NOT i.indisprimary
                 AND i.indnatts = 1
                 AND a.attnum = ANY(i.indkey::smallint[])
               LIMIT 1
         ) uq ON true
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, table]
    )

    return rows.map((r) => {
      const dataType = String(r[1])
      const defaultExpr = r[3] === null ? null : String(r[3])
      const identity = String(r[4] ?? '')
      const generated = String(r[5] ?? '')
      const isSerial = defaultExpr !== null && /^nextval\(/i.test(defaultExpr)
      return {
        name: String(r[0]),
        dataType,
        isPrimaryKey: r[9] === true || r[9] === 'true',
        isNullable: !(r[2] === true || r[2] === 'true'),
        isUnique: r[10] === true || r[10] === 'true',
        isBinary: /bytea/i.test(dataType),
        // Postgres has no unsigned or zero-fill numeric modifiers.
        isUnsigned: false,
        isZeroFill: false,
        isAutoIncrement: identity !== '' || isSerial,
        isGenerated: generated !== '',
        // A serial's `nextval(...)` is an implementation detail of the identity,
        // not a default the user typed, so it is not shown as one.
        defaultValue: isSerial ? null : defaultExpr,
        charset: null,
        collation: r[7] === null ? null : String(r[7]),
        comment: r[6] === null ? '' : String(r[6]),
        ordinal: Number(r[8])
      }
    })
  }

  private async tableIndexes(
    conn: DriverConnection,
    schema: string,
    table: string
  ): Promise<IndexInfo[]> {
    const rows = await this.rows(
      conn,
      `SELECT i.relname, ix.indisprimary, ix.indisunique, am.amname,
              a.attname, k.ord, obj_description(i.oid, 'pg_class'),
              pg_get_indexdef(ix.indexrelid, k.ord::int, true),
              EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid)
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_am am ON am.oid = i.relam
         JOIN LATERAL unnest(ix.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord) ON true
         LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND t.relname = $2
        ORDER BY i.relname, k.ord`,
      [schema, table]
    )

    const byName = new Map<string, IndexInfo>()
    for (const r of rows) {
      const name = String(r[0])
      const isPrimary = r[1] === true || r[1] === 'true'
      const isUnique = r[2] === true || r[2] === 'true'
      const method = String(r[3] || 'btree').toUpperCase()

      let entry = byName.get(name)
      if (!entry) {
        entry = {
          name,
          type: isPrimary ? 'PRIMARY' : isUnique ? 'UNIQUE' : 'INDEX',
          storageType: method,
          comment: r[6] === null ? '' : String(r[6]),
          // Postgres indexes are always visible to the planner.
          visible: true,
          isConstraint: r[8] === true || r[8] === 'true',
          columns: []
        }
        byName.set(name, entry)
      }
      entry.columns.push({
        // attnum 0 means an expression rather than a plain column; show the
        // expression text so the designer at least renders something truthful.
        column: r[4] === null ? String(r[7] ?? '(expression)') : String(r[4]),
        seq: Number(r[5]),
        order: 'ASC',
        length: null
      })
    }
    return [...byName.values()]
  }

  private async tableForeignKeys(
    conn: DriverConnection,
    schema: string,
    table: string
  ): Promise<ForeignKeyInfo[]> {
    const rows = await this.rows(
      conn,
      `SELECT con.conname, fn.nspname, ft.relname, a.attname, fa.attname,
              con.confupdtype, con.confdeltype, k.ord
         FROM pg_constraint con
         JOIN pg_class t ON t.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_class ft ON ft.oid = con.confrelid
         JOIN pg_namespace fn ON fn.oid = ft.relnamespace
         JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON true
         LEFT JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.att
         LEFT JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fatt
        WHERE con.contype = 'f' AND n.nspname = $1 AND t.relname = $2
        ORDER BY con.conname, k.ord`,
      [schema, table]
    )

    const byName = new Map<string, ForeignKeyInfo>()
    for (const r of rows) {
      const name = String(r[0])
      let entry = byName.get(name)
      if (!entry) {
        entry = {
          name,
          referencedSchema: String(r[1] || ''),
          referencedTable: String(r[2] || ''),
          onUpdate: FK_ACTIONS[String(r[5])] ?? '',
          onDelete: FK_ACTIONS[String(r[6])] ?? '',
          columns: []
        }
        byName.set(name, entry)
      }
      entry.columns.push({
        column: String(r[3] ?? ''),
        referencedColumn: String(r[4] ?? '')
      })
    }
    return [...byName.values()]
  }

  /**
   * Postgres has no `SHOW CREATE TABLE`, so the DDL is rebuilt from the
   * catalogue. pg_dump would be exact, but it is a separate binary that may not
   * be installed and could not see through the SSH tunnel.
   */
  async createStatement(
    conn: DriverConnection,
    kind: 'table' | 'schema',
    schema: string,
    table?: string
  ): Promise<string> {
    if (kind === 'schema') {
      return `CREATE SCHEMA "${schema.replace(/"/g, '""')}";`
    }
    const definition = await this.tableDefinition(conn, schema, String(table))
    return pgCreateTable(definition)
  }

  async charsets(conn: DriverConnection): Promise<{ charset: string; collations: string[] }[]> {
    // The encoding belongs to the database as a whole, so there is exactly one;
    // collations are per-column and the designer offers them under it.
    const encoding = await this.rows(conn, 'SHOW server_encoding')
      .then((r) => String(r[0]?.[0] ?? 'UTF8'))
      .catch(() => 'UTF8')

    const rows = await this.rows(
      conn,
      `SELECT DISTINCT collname FROM pg_collation ORDER BY collname`
    )
    return [{ charset: encoding, collations: rows.map((r) => String(r[0])) }]
  }
}
