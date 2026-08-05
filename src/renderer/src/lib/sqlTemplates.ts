/** SQL snippets produced by the schema tree's context menus. */

import { placeholder } from '@shared/sql'
import { qualify, type Dialect } from '@shared/dialect'

export function selectRows(d: Dialect, schema: string, table: string, limit = 1000): string {
  return `SELECT * FROM ${qualify(d, schema, table)} LIMIT ${limit};`
}

export function createSchema(d: Dialect, name = 'new_schema'): string {
  // MySQL's DATABASE and SCHEMA are the same object; Postgres schemas live
  // inside the database the connection already opened.
  const keyword = d.engine === 'postgres' ? 'SCHEMA' : 'DATABASE'
  return `CREATE ${keyword} ${d.quoteIdent(name)};`
}

export function alterSchema(
  d: Dialect,
  name: string,
  charset = 'utf8mb4',
  collation = 'utf8mb4_0900_ai_ci'
): string {
  if (d.engine === 'postgres') {
    // A Postgres schema carries no charset or collation — its encoding belongs
    // to the database — so renaming and reassigning are all ALTER SCHEMA offers.
    return `ALTER SCHEMA ${d.quoteIdent(name)} RENAME TO ${d.quoteIdent(`${name}_new`)};`
  }
  return `ALTER SCHEMA ${d.quoteIdent(name)}  DEFAULT CHARACTER SET ${charset}  DEFAULT COLLATE ${collation} ;`
}

export function dropSchema(d: Dialect, name: string): string {
  const keyword = d.engine === 'postgres' ? 'SCHEMA' : 'DATABASE'
  return `DROP ${keyword} ${d.quoteIdent(name)};`
}

export function dropTable(d: Dialect, schema: string, table: string): string {
  return `DROP TABLE ${qualify(d, schema, table)};`
}

export function truncateTable(d: Dialect, schema: string, table: string): string {
  return `TRUNCATE TABLE ${qualify(d, schema, table)};`
}

export function insertIntoTemplate(
  d: Dialect,
  schema: string,
  table: string,
  columns: string[]
): string {
  const names = columns.map((c) => d.quoteIdent(c)).join(',')
  const values = columns.map(placeholder).join(',')
  return `INSERT INTO ${qualify(d, schema, table)} (${names})VALUES(${values});`
}

export function insertSetTemplate(
  d: Dialect,
  schema: string,
  table: string,
  columns: string[]
): string {
  // `INSERT ... SET` is MySQL-only.
  if (d.engine === 'postgres') return insertIntoTemplate(d, schema, table, columns)
  const assignments = columns.map((c) => `${d.quoteIdent(c)}=${placeholder(c)}`).join(',')
  return `INSERT INTO ${qualify(d, schema, table)} SET (${assignments});`
}

export function updateTemplate(
  d: Dialect,
  schema: string,
  table: string,
  columns: string[]
): string {
  const assignments = columns.map((c) => `${d.quoteIdent(c)}=${placeholder(c)}`).join(',')
  const first = columns[0] ?? 'id'
  return `UPDATE ${qualify(d, schema, table)} SET ${assignments} WHERE ${d.quoteIdent(first)}=${placeholder(first)};`
}

export function deleteTemplate(
  d: Dialect,
  schema: string,
  table: string,
  columns: string[]
): string {
  const first = columns[0] ?? 'id'
  return `DELETE FROM ${qualify(d, schema, table)} WHERE ${d.quoteIdent(first)}=${placeholder(first)};`
}
