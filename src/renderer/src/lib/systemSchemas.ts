/**
 * The schemas a MySQL server owns rather than the user. Both the schema tree and
 * the Data Export object picker hide them by default and offer one click to see
 * them: `information_schema` and `performance_schema` are views over server
 * internals that cannot be dumped at all, and `mysql` and `sys` only matter for
 * the rare job of moving accounts or time zones between servers.
 *
 * Postgres never needs this — its driver filters `pg_*` and `information_schema`
 * out before either component sees them.
 */
export const SYSTEM_SCHEMAS = new Set([
  'information_schema',
  'mysql',
  'performance_schema',
  'sys'
])

export function isSystemSchema(name: string): boolean {
  return SYSTEM_SCHEMAS.has(name.toLowerCase())
}
