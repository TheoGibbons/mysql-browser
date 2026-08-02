/** SQL snippets produced by the schema tree's context menus. */

import { placeholder, qualify, quoteIdent } from '@shared/sql'

export function selectRows(schema: string, table: string, limit = 1000): string {
  return `SELECT * FROM ${qualify(schema, table)} LIMIT ${limit};`
}

export function createSchema(name = 'new_schema'): string {
  return `CREATE DATABASE ${quoteIdent(name)};`
}

export function alterSchema(
  name: string,
  charset = 'utf8mb4',
  collation = 'utf8mb4_0900_ai_ci'
): string {
  return `ALTER SCHEMA ${quoteIdent(name)}  DEFAULT CHARACTER SET ${charset}  DEFAULT COLLATE ${collation} ;`
}

export function dropSchema(name: string): string {
  return `DROP DATABASE ${quoteIdent(name)};`
}

export function dropTable(schema: string, table: string): string {
  return `DROP TABLE ${qualify(schema, table)};`
}

export function truncateTable(schema: string, table: string): string {
  return `TRUNCATE TABLE ${qualify(schema, table)};`
}

export function insertIntoTemplate(schema: string, table: string, columns: string[]): string {
  const names = columns.map(quoteIdent).join(',')
  const values = columns.map(placeholder).join(',')
  return `INSERT INTO ${qualify(schema, table)} (${names})VALUES(${values});`
}

export function insertSetTemplate(schema: string, table: string, columns: string[]): string {
  const assignments = columns.map((c) => `${quoteIdent(c)}=${placeholder(c)}`).join(',')
  return `INSERT INTO ${qualify(schema, table)} SET (${assignments});`
}

export function updateTemplate(schema: string, table: string, columns: string[]): string {
  const assignments = columns.map((c) => `${quoteIdent(c)}=${placeholder(c)}`).join(',')
  const first = columns[0] ?? 'id'
  return `UPDATE ${qualify(schema, table)} SET ${assignments} WHERE ${quoteIdent(first)}=${placeholder(first)};`
}

export function deleteTemplate(schema: string, table: string, columns: string[]): string {
  const first = columns[0] ?? 'id'
  return `DELETE FROM ${qualify(schema, table)} WHERE ${quoteIdent(first)}=${placeholder(first)};`
}
