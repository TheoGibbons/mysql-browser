/**
 * Owns one DB worker thread per open connection tab and turns its
 * message-passing protocol into promises.
 */

import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ConnectionConfig, Preferences, SessionStatus } from '@shared/types'
import type {
  WorkerEvent,
  WorkerMessage,
  WorkerRequest,
  WorkerResults
} from '@shared/worker-protocol'
import { isWorkerEvent } from '@shared/worker-protocol'

type Pending = {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

export class SessionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly errno?: number,
    readonly sqlState?: string
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

export interface SessionEvents {
  onStatus(status: SessionStatus, message?: string, serverVersion?: string): void
  onLog(level: 'info' | 'warn' | 'error', message: string): void
}

export class Session {
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private terminated = false

  status: SessionStatus = 'offline'
  statusMessage: string | undefined
  serverVersion: string | undefined

  constructor(
    readonly sessionId: string,
    private config: ConnectionConfig,
    private prefs: Preferences,
    private readonly events: SessionEvents
  ) {}

  private spawn(): Worker {
    if (this.worker) return this.worker

    // electron-vite emits the worker next to the main entry point.
    const workerPath = path.join(__dirname, 'dbworker.js')
    const worker = new Worker(workerPath, {
      workerData: { sessionId: this.sessionId, config: this.config, prefs: this.prefs }
    })

    worker.on('message', (msg: WorkerMessage) => this.receive(msg))
    worker.on('error', (err) => this.fail(err.message))
    worker.on('exit', (code) => {
      if (this.terminated) return
      this.fail(code === 0 ? 'Connection worker stopped' : `Connection worker exited (${code})`)
    })

    this.worker = worker
    return worker
  }

  private receive(msg: WorkerMessage): void {
    if (isWorkerEvent(msg)) {
      this.handleEvent(msg)
      return
    }
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    if (msg.ok) {
      entry.resolve(msg.result)
    } else {
      entry.reject(new SessionError(msg.error.message, msg.error.code, msg.error.errno, msg.error.sqlState))
    }
  }

  private handleEvent(msg: WorkerEvent): void {
    if (msg.event === 'status') {
      this.status = msg.status
      this.statusMessage = msg.message
      if (msg.serverVersion) this.serverVersion = msg.serverVersion
      this.events.onStatus(msg.status, msg.message, msg.serverVersion)
    } else {
      this.events.onLog(msg.level, msg.message)
    }
  }

  private fail(message: string): void {
    this.status = 'error'
    this.statusMessage = message
    for (const [, entry] of this.pending) entry.reject(new SessionError(message))
    this.pending.clear()
    this.worker = null
    this.events.onStatus('error', message)
  }

  private send<K extends WorkerRequest['type']>(
    request: Omit<Extract<WorkerRequest, { type: K }>, 'id'>
  ): Promise<WorkerResults[K]> {
    const worker = this.spawn()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ ...request, id } as WorkerRequest)
    })
  }

  // --- lifecycle ---------------------------------------------------------

  async connect(): Promise<{ serverVersion: string }> {
    this.status = 'connecting'
    this.events.onStatus('connecting')
    try {
      return await this.send<'connect'>({ type: 'connect' })
    } catch (err) {
      this.status = 'error'
      this.statusMessage = (err as Error).message
      this.events.onStatus('error', this.statusMessage)
      throw err
    }
  }

  /** Tears the worker down and starts a fresh one. */
  async reconnect(config?: ConnectionConfig, prefs?: Preferences): Promise<{ serverVersion: string }> {
    if (config) this.config = config
    if (prefs) this.prefs = prefs
    await this.close()
    this.terminated = false
    return this.connect()
  }

  async close(): Promise<void> {
    if (!this.worker) {
      this.status = 'offline'
      return
    }
    this.terminated = true
    try {
      await Promise.race([
        this.send<'disconnect'>({ type: 'disconnect' }),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ])
    } catch {
      /* shutting down anyway */
    }
    try {
      await this.worker.terminate()
    } catch {
      /* already gone */
    }
    this.worker = null
    this.pending.clear()
    this.status = 'offline'
  }

  setPreferences(prefs: Preferences): void {
    this.prefs = prefs
    if (this.worker) void this.send<'setPrefs'>({ type: 'setPrefs', prefs }).catch(() => undefined)
  }

  setConfig(config: ConnectionConfig): void {
    this.config = config
  }

  get isConnected(): boolean {
    return this.status === 'connected'
  }

  // --- operations --------------------------------------------------------

  query(tabId: string, sql: string, limitRows?: number) {
    return this.send<'query'>({ type: 'query', tabId, sql, limitRows })
  }

  cancel(tabId: string) {
    return this.send<'cancel'>({ type: 'cancel', tabId })
  }

  listSchemas() {
    return this.send<'listSchemas'>({ type: 'listSchemas' })
  }

  tableDefinition(schema: string, table: string) {
    return this.send<'tableDefinition'>({ type: 'tableDefinition', schema, table })
  }

  tableColumns(schema: string, table: string) {
    return this.send<'tableColumns'>({ type: 'tableColumns', schema, table })
  }

  schemaColumns(schema: string) {
    return this.send<'schemaColumns'>({ type: 'schemaColumns', schema })
  }

  createStatement(kind: 'table' | 'schema', schema: string, table?: string) {
    return this.send<'createStatement'>({ type: 'createStatement', kind, schema, table })
  }

  charsets() {
    return this.send<'charsets'>({ type: 'charsets' })
  }
}

/** Runs a one-shot connectivity check in a throwaway worker. */
export async function testConnection(
  config: ConnectionConfig,
  prefs: Preferences
): Promise<{ serverVersion: string; latencyMs: number }> {
  const session = new Session('test', config, prefs, {
    onStatus: () => undefined,
    onLog: () => undefined
  })
  try {
    return await session['send']<'test'>({ type: 'test' })
  } finally {
    await session.close()
  }
}
