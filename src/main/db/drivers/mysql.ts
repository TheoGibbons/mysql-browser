/** MySQL/MariaDB driver, built on mysql2. */

import mysql from 'mysql2/promise'
import type { Connection, ConnectionOptions, FieldPacket } from 'mysql2/promise'
import type {
  CellValue,
  ColumnMeta,
  ForeignKeyInfo,
  IndexInfo,
  SchemaInfo,
  TableDefinition
} from '@shared/types'
import type { Driver, DriverConnection, DriverContext, RawResult } from '../driver'
import {
  BINARY_CHARSET,
  FLAG_AUTO_INCREMENT,
  FLAG_NOT_NULL,
  FLAG_PRI_KEY,
  isNumericType,
  typeNameWithFlags
} from '../types'

/** Blobs larger than this are summarised rather than hex-dumped into the grid. */
const MAX_INLINE_BLOB = 256

/**
 * Network-level failures that mean "this socket is gone", as opposed to a SQL
 * error the server deliberately returned.
 */
const LOST_CONNECTION_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKET',
  'EHOSTUNREACH',
  'ENETRESET',
  'ER_CLIENT_INTERACTION_TIMEOUT'
])

/** Small payloads inline as hex; anything larger is described, not dumped. */
function hexOrSummary(field: any, noun: string): string | null {
  const buf = field.buffer()
  if (buf === null) return null
  return buf.length <= MAX_INLINE_BLOB
    ? '0x' + buf.toString('hex')
    : `${noun} (${buf.length} bytes)`
}

/**
 * Converts binary payloads into something the grid can display.
 *
 * Every cell has to leave here as a `CellValue` scalar. mysql2 will otherwise
 * hand back a parsed object for JSON and a Buffer for binary columns, and both
 * reach code that assumes a string — the grid renders them as `[object Object]`
 * and the clipboard/SQL builders throw outright.
 */
function castField(field: any, next: () => unknown): unknown {
  const type: string = field.type
  if (type === 'GEOMETRY') {
    const buf = field.buffer()
    return buf === null ? null : `GEOMETRY (${buf.length} bytes)`
  }
  // The server's own rendering of the document, rather than a re-serialised
  // parse of it: key order and number formatting stay as MySQL stored them.
  if (type === 'JSON') return field.string()
  if (type === 'VECTOR') {
    const buf = field.buffer()
    return buf === null ? null : `VECTOR (${buf.length} bytes)`
  }
  if (type === 'BLOB' || type === 'TINY_BLOB' || type === 'MEDIUM_BLOB' || type === 'LONG_BLOB') {
    const isBinary = field.characterSet === BINARY_CHARSET
    if (!isBinary) return field.string()
    return hexOrSummary(field, 'BLOB')
  }
  // BINARY/VARBINARY arrive as STRING/VAR_STRING on the binary charset; every
  // other collation is an ordinary CHAR/VARCHAR mysql2 already decodes for us.
  if (type === 'STRING' || type === 'VAR_STRING') {
    if (field.characterSet !== BINARY_CHARSET) return next()
    return hexOrSummary(field, 'BINARY')
  }
  if (type === 'BIT') {
    const buf = field.buffer()
    if (buf === null) return null
    let value = 0n
    for (const byte of buf) value = (value << 8n) | BigInt(byte)
    return value.toString()
  }
  return next()
}

function describeColumns(fields: FieldPacket[]): ColumnMeta[] {
  return (fields || []).map((f) => {
    const raw = f as unknown as Record<string, any>
    const type: number = raw.columnType ?? raw.type ?? 253
    const flags: number = raw.flags ?? 0
    return {
      name: f.name,
      orgName: raw.orgName || f.name,
      orgTable: raw.orgTable || raw.table || '',
      schema: raw.schema || raw.db || '',
      type,
      typeName: typeNameWithFlags(type, flags),
      isPrimaryKey: (flags & FLAG_PRI_KEY) !== 0,
      isNotNull: (flags & FLAG_NOT_NULL) !== 0,
      isAutoIncrement: (flags & FLAG_AUTO_INCREMENT) !== 0,
      isNumeric: isNumericType(type)
    }
  })
}

class MysqlConnection implements DriverConnection {
  constructor(
    private readonly conn: Connection,
    readonly backendId: number
  ) {}

  async query(sql: string, params?: unknown[]): Promise<RawResult> {
    const [rows, fields] = await this.conn.query<any>(sql, params)
    const list = (fields as FieldPacket[]) || []

    if (list.length === 0) {
      const ok = rows as { affectedRows?: number }
      return { columns: [], rows: [], affectedRows: ok?.affectedRows ?? 0, hasResultSet: false }
    }
    return {
      columns: describeColumns(list),
      rows: rows as CellValue[][],
      affectedRows: 0,
      hasResultSet: true
    }
  }

  async ping(): Promise<void> {
    await this.conn.ping()
  }

  async end(): Promise<void> {
    await this.conn.end()
  }

  destroy(): void {
    this.conn.destroy()
  }

  /** False as soon as mysql2 knows the socket has errored, closed, or been destroyed. */
  isUsable(): boolean {
    const core = (this.conn as unknown as { connection?: { state?: string } }).connection
    const state = core?.state
    // Older mysql2 builds have no `state` getter; assume usable and let the
    // per-connection dead flag and query errors catch the failure instead.
    if (!state) return true
    return state === 'authenticated' || state === 'connected'
  }
}

export class MysqlDriver implements Driver {
  readonly engine = 'mysql' as const

  constructor(private readonly ctx: DriverContext) {}

  private async options(): Promise<ConnectionOptions> {
    const { config, prefs } = this.ctx
    const tunnel = this.ctx.tunnel()
    const password = await this.ctx.password()
    const isIam = config.method === 'iam'

    const options: ConnectionOptions = {
      host: tunnel ? '127.0.0.1' : config.host || '127.0.0.1',
      port: tunnel ? tunnel.localPort : config.port || 3306,
      user: config.user,
      password,
      database: this.ctx.currentSchema() || undefined,
      connectTimeout: Math.max(1, prefs.connectTimeoutSec) * 1000,
      // Arrays are ~3x cheaper than objects for wide result sets and map directly
      // onto the grid's column-indexed model.
      rowsAsArray: true,
      // Keep temporal and high-precision values exactly as the server sent them.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      charset: 'utf8mb4_general_ci',
      typeCast: castField
    }

    if (isIam) {
      // An RDS IAM user is created WITH AWSAuthenticationPlugin, and the server
      // asks such clients for `mysql_clear_password` — the token is the password,
      // sent as-is. mysql2 refuses that plugin unless it is enabled explicitly,
      // and RDS only accepts a token over TLS, so both are non-negotiable here.
      options.enableCleartextPlugin = true
    }

    if (config.useSSL || isIam) {
      // RDS presents an Amazon CA that is not in Node's trust store, so IAM
      // connections only verify when the user has asked for it deliberately.
      options.ssl = {
        rejectUnauthorized: config.useSSL ? config.rejectUnauthorized !== false : false
      }
    }

    return options
  }

  /**
   * RDS answers every IAM misconfiguration with a bare "Access denied", so spell
   * out what is left to check once the token itself has been generated.
   */
  private decorateError(err: any): any {
    if (this.ctx.config.method !== 'iam' || err?.code !== 'ER_ACCESS_DENIED_ERROR') return err
    const message =
      `${err.sqlMessage || err.message}\n\n` +
      'The token command succeeded, so the database rejected the token itself. Check that ' +
      "the MySQL user was created WITH AWSAuthenticationPlugin AS 'RDS', that the IAM identity " +
      'the token was signed with is allowed rds-db:connect for that user, and that --username in ' +
      'the token command matches the username above exactly (it is case-sensitive).'
    err.message = message
    err.sqlMessage = message
    return err
  }

  async open(onLost?: () => void): Promise<DriverConnection> {
    let conn: Connection
    try {
      conn = await mysql.createConnection(await this.options())
    } catch (err: any) {
      // A cached IAM token can be past its 15-minute window before the refresh
      // timer notices — after the machine sleeps, say. Mint a fresh one and try
      // once more before telling the user their credentials were rejected.
      if (err?.code !== 'ER_ACCESS_DENIED_ERROR' || !(await this.ctx.refreshPassword())) {
        throw this.decorateError(err)
      }
      conn = await mysql.createConnection(await this.options()).catch((retryErr) => {
        throw this.decorateError(retryErr)
      })
    }
    // A dropped socket on an idle connection must not take the process down, but
    // it does have to be recorded — otherwise the dead connection stays cached and
    // every later query fails with "connection is in closed state" forever.
    conn.on('error', () => onLost?.())
    conn.on('end', () => onLost?.())

    return new MysqlConnection(conn, (conn as unknown as { threadId: number }).threadId)
  }

  async serverVersion(conn: DriverConnection): Promise<string> {
    const result = await conn.query('SELECT VERSION()')
    return String(result.rows?.[0]?.[0] ?? 'unknown')
  }

  async cancel(control: DriverConnection, backendId: number): Promise<void> {
    await control.query(`KILL QUERY ${Number(backendId)}`)
  }

  isConnectionLost(err: any): boolean {
    if (!err) return false
    if (err.code && LOST_CONNECTION_CODES.has(err.code)) return true
    const message = String(err.sqlMessage || err.message || '')
    return (
      // Raised by mysql2 when a command is queued after the socket died. The
      // packet never leaves the client, so the statement provably did not run.
      message.includes('closed state') ||
      message.includes('Connection lost') ||
      message.includes('The client was disconnected by the server')
    )
  }

  /**
   * mysql2 refuses every command once its socket is gone, and there is no way to
   * revive it — so treat an enqueue-time rejection as proof the statement never
   * reached the server.
   */
  isEnqueueRefusal(err: any): boolean {
    return String(err?.message || '').includes('closed state')
  }

  schemaFromStatement(sql: string): string | null {
    const m = /^\s*USE\s+`?([^`;\s]+)`?/i.exec(sql)
    return m ? m[1] : null
  }

  /**
   * MySQL reports no offset, but a syntax error quotes the text it choked on:
   * `… right syntax to use near 'ORDER BY x' at line 2`. That snippet is the
   * remaining input from the error onwards, so finding it in the statement
   * recovers the position.
   */
  errorPosition(err: any, sql: string): number | null {
    const message = String(err?.sqlMessage || err?.message || '')
    const near = /near '([\s\S]*?)' at line (\d+)/.exec(message)
    if (!near) return null

    // The snippet is truncated at 80 chars and has its newlines preserved, so
    // match on its first line only.
    const needle = near[1].split('\n')[0]
    if (!needle) return null

    // Search from the reported line, since a short snippet ("FROM") may well
    // occur earlier in the statement too.
    const line = Number(near[2])
    let from = 0
    for (let n = 1; n < line; n++) {
      const nextLine = sql.indexOf('\n', from)
      if (nextLine < 0) break
      from = nextLine + 1
    }

    const at = sql.indexOf(needle, from)
    if (at >= 0) return at + 1
    // The line number is the server's view of a statement we may have trimmed;
    // fall back to the whole statement before giving up.
    const anywhere = sql.indexOf(needle)
    return anywhere >= 0 ? anywhere + 1 : null
  }

  // --- catalogue ---------------------------------------------------------

  async listSchemas(conn: DriverConnection): Promise<SchemaInfo[]> {
    const schemaRows = await conn.query(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
    )
    const tableRows = await conn.query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
         FROM information_schema.TABLES
        ORDER BY TABLE_SCHEMA, TABLE_NAME`
    )

    const bySchema = new Map<string, SchemaInfo>()
    for (const row of schemaRows.rows) {
      const name = String(row[0])
      bySchema.set(name, { name, tables: [] })
    }
    for (const row of tableRows.rows) {
      const schema = String(row[0])
      const entry = bySchema.get(schema) ?? { name: schema, tables: [] }
      if (!bySchema.has(schema)) bySchema.set(schema, entry)
      entry.tables.push({
        name: String(row[1]),
        type: String(row[2]) === 'VIEW' ? 'view' : 'table'
      })
    }

    return [...bySchema.values()]
  }

  async tableColumns(conn: DriverConnection, schema: string, table: string): Promise<string[]> {
    const result = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )
    return result.rows.map((r) => String(r[0]))
  }

  /** Every column in a schema in one round trip — the code-completion source. */
  async schemaColumns(
    conn: DriverConnection,
    schema: string
  ): Promise<Record<string, string[]>> {
    const result = await conn.query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [schema]
    )
    const out: Record<string, string[]> = {}
    for (const r of result.rows) {
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
    const tableRows = await conn.query(
      `SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, table]
    )
    const meta = tableRows.rows[0]
    if (!meta) throw new Error(`Table ${schema}.${table} was not found`)
    const collation = meta[1] ? String(meta[1]) : ''
    const charset = collation ? collation.split('_')[0] : ''

    const colRows = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA,
              CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT, ORDINAL_POSITION
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )

    const columns = colRows.rows.map((r) => {
      const columnType = String(r[1])
      const extra = String(r[5] || '')
      return {
        name: String(r[0]),
        dataType: columnType,
        isPrimaryKey: String(r[3]) === 'PRI',
        isNullable: String(r[2]) === 'YES',
        isUnique: String(r[3]) === 'UNI',
        isBinary: /binary|blob/i.test(columnType),
        isUnsigned: /unsigned/i.test(columnType),
        isZeroFill: /zerofill/i.test(columnType),
        isAutoIncrement: /auto_increment/i.test(extra),
        isGenerated: /GENERATED/i.test(extra),
        defaultValue: r[4] === null ? null : String(r[4]),
        charset: r[6] === null ? null : String(r[6]),
        collation: r[7] === null ? null : String(r[7]),
        comment: String(r[8] || ''),
        ordinal: Number(r[9])
      }
    })

    const indexRows = await conn
      .query(
        `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART,
                INDEX_TYPE, COMMENT, IS_VISIBLE
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [schema, table]
      )
      .catch(async () =>
        // IS_VISIBLE only exists from MySQL 8.0; retry without it on older servers.
        conn.query(
          `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART,
                  INDEX_TYPE, COMMENT, 'YES'
             FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
          [schema, table]
        )
      )

    const indexMap = new Map<string, IndexInfo>()
    for (const r of indexRows.rows) {
      const name = String(r[0])
      const indexType = String(r[6] || 'BTREE')
      let type: IndexInfo['type'] = 'INDEX'
      if (name === 'PRIMARY') type = 'PRIMARY'
      else if (Number(r[1]) === 0) type = 'UNIQUE'
      else if (indexType === 'FULLTEXT') type = 'FULLTEXT'
      else if (indexType === 'SPATIAL') type = 'SPATIAL'

      let entry = indexMap.get(name)
      if (!entry) {
        entry = {
          name,
          type,
          storageType: indexType === 'FULLTEXT' || indexType === 'SPATIAL' ? '' : indexType,
          comment: String(r[7] || ''),
          visible: String(r[8] ?? 'YES') === 'YES',
          // MySQL drops a unique index the same way as any other, so there is
          // never a constraint to route around.
          isConstraint: false,
          columns: []
        }
        indexMap.set(name, entry)
      }
      entry.columns.push({
        column: String(r[3]),
        seq: Number(r[2]),
        order: String(r[4] || 'A') === 'D' ? 'DESC' : 'ASC',
        length: r[5] === null ? null : Number(r[5])
      })
    }

    const fkRows = await conn.query(
      `SELECT k.CONSTRAINT_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
              k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE,
              k.ORDINAL_POSITION
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [schema, table]
    )

    const fkMap = new Map<string, ForeignKeyInfo>()
    for (const r of fkRows.rows) {
      const name = String(r[0])
      let entry = fkMap.get(name)
      if (!entry) {
        entry = {
          name,
          referencedSchema: String(r[1] || ''),
          referencedTable: String(r[2] || ''),
          onUpdate: String(r[5] || ''),
          onDelete: String(r[6] || ''),
          columns: []
        }
        fkMap.set(name, entry)
      }
      entry.columns.push({ column: String(r[3]), referencedColumn: String(r[4]) })
    }

    return {
      schema,
      name: table,
      charset,
      collation,
      engine: String(meta[0] || 'InnoDB'),
      comment: String(meta[2] || ''),
      columns,
      indexes: [...indexMap.values()],
      foreignKeys: [...fkMap.values()]
    }
  }

  async createStatement(
    conn: DriverConnection,
    kind: 'table' | 'schema',
    schema: string,
    table?: string
  ): Promise<string> {
    if (kind === 'schema') {
      const result = await conn.query(`SHOW CREATE DATABASE \`${schema.replace(/`/g, '``')}\``)
      return String(result.rows[0]?.[1] ?? '')
    }
    const result = await conn.query(
      `SHOW CREATE TABLE \`${schema.replace(/`/g, '``')}\`.\`${String(table).replace(/`/g, '``')}\``
    )
    return String(result.rows[0]?.[1] ?? '')
  }

  async charsets(conn: DriverConnection): Promise<{ charset: string; collations: string[] }[]> {
    const result = await conn.query(
      'SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLLATIONS ORDER BY CHARACTER_SET_NAME, COLLATION_NAME'
    )
    const map = new Map<string, string[]>()
    for (const r of result.rows) {
      const cs = String(r[0])
      if (!map.has(cs)) map.set(cs, [])
      map.get(cs)!.push(String(r[1]))
    }
    return [...map.entries()].map(([charset, collations]) => ({ charset, collations }))
  }
}
