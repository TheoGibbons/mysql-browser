/** Message contract between the main process and a DB worker thread. */

import type {
  ConnectionConfig,
  Preferences,
  QueryOutcome,
  SchemaInfo,
  SessionStatus,
  TableDefinition
} from './types'

export interface WorkerInit {
  sessionId: string
  config: ConnectionConfig
  prefs: Preferences
}

export type WorkerRequest =
  | { id: number; type: 'connect' }
  | { id: number; type: 'disconnect' }
  | { id: number; type: 'test' }
  | { id: number; type: 'query'; tabId: string; sql: string; limitRows?: number }
  | { id: number; type: 'cancel'; tabId: string }
  | { id: number; type: 'listSchemas' }
  | { id: number; type: 'tableDefinition'; schema: string; table: string }
  | { id: number; type: 'tableColumns'; schema: string; table: string }
  | { id: number; type: 'schemaColumns'; schema: string }
  | { id: number; type: 'createStatement'; kind: 'table' | 'schema'; schema: string; table?: string }
  | { id: number; type: 'setPrefs'; prefs: Preferences }
  | { id: number; type: 'charsets' }

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | {
      id: number
      ok: false
      error: {
        message: string
        code?: string
        errno?: number
        sqlState?: string
        /** The statement that failed, and where in it the server pointed. */
        statement?: string
        position?: number
      }
    }

export type WorkerEvent =
  | { event: 'status'; status: SessionStatus; message?: string; serverVersion?: string }
  | { event: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type WorkerMessage = WorkerResponse | WorkerEvent

export function isWorkerEvent(msg: WorkerMessage): msg is WorkerEvent {
  return 'event' in msg
}

/** Result payload shapes, keyed by request type. */
export interface WorkerResults {
  connect: { serverVersion: string }
  disconnect: void
  test: { serverVersion: string; latencyMs: number }
  query: QueryOutcome
  cancel: { killed: boolean }
  listSchemas: SchemaInfo[]
  tableDefinition: TableDefinition
  tableColumns: string[]
  /** table name -> column names, for the whole schema. Feeds code completion. */
  schemaColumns: Record<string, string[]>
  createStatement: string
  setPrefs: void
  charsets: { charset: string; collations: string[] }[]
}
