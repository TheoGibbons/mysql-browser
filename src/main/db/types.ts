/** MySQL protocol type ids and column flags, used to describe result columns. */

export const MYSQL_TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  14: 'NEWDATE',
  15: 'VARCHAR',
  16: 'BIT',
  17: 'TIMESTAMP2',
  18: 'DATETIME2',
  19: 'TIME2',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VARCHAR',
  254: 'CHAR',
  255: 'GEOMETRY'
}

const NUMERIC_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 16, 246])

export function typeName(type: number): string {
  return MYSQL_TYPE_NAMES[type] ?? `TYPE_${type}`
}

export function isNumericType(type: number): boolean {
  return NUMERIC_TYPES.has(type)
}

export const FLAG_NOT_NULL = 1
export const FLAG_PRI_KEY = 2
export const FLAG_UNIQUE_KEY = 4
export const FLAG_MULTIPLE_KEY = 8
export const FLAG_BLOB = 16
export const FLAG_UNSIGNED = 32
export const FLAG_ZEROFILL = 64
export const FLAG_BINARY = 128
export const FLAG_ENUM = 256
export const FLAG_AUTO_INCREMENT = 512
export const FLAG_SET = 2048

/**
 * ENUM and SET are sent over the wire as CHAR (254) with a flag set, so the
 * flags must be consulted to name them correctly.
 */
export function typeNameWithFlags(type: number, flags: number): string {
  if ((flags & FLAG_ENUM) !== 0) return 'ENUM'
  if ((flags & FLAG_SET) !== 0) return 'SET'
  return typeName(type)
}

/** MySQL charset id reserved for raw binary data. */
export const BINARY_CHARSET = 63
