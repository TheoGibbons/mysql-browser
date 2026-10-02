/**
 * Runs the external dump/restore tools behind Data Export and Data Import.
 *
 * Three things matter here:
 *
 * - **No shell.** The command the user sees is parsed into an argv and spawned
 *   directly, with `<` and `>` wired to real file streams. That keeps behaviour
 *   identical whether the app is launched from cmd, PowerShell or Explorer, and
 *   leaves nothing for a stray quote in a table name to break out of.
 * - **No password on the command line.** It goes into a temporary option file
 *   (MySQL) or `PGPASSFILE` (Postgres) that exists only while the tool runs, so
 *   the command can be copied, logged or pasted into a bug report as-is.
 * - **The connection's own plumbing.** SSH connections get a tunnel opened for
 *   the run, and IAM connections have their token command run for a fresh
 *   password, so exporting works on the same connections querying does.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ConnectionConfig, Preferences, ToolName, ToolRunEvent } from '@shared/types'
import {
  PASSWORD_FILE_TOKEN,
  TUNNEL_HOST_TOKEN,
  TUNNEL_PORT_TOKEN,
  parseCommandLine
} from '@shared/transfer'
import { IamTokenProvider } from './db/iam'
import { openTunnel, type Tunnel } from './db/tunnel'

/** Stop forwarding tool chatter past this much; dumps can be enormous. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 400

export interface ToolRunRequest {
  command: string
  /** File or directory the run writes, watched for progress and revealed after. */
  outputPath?: string
}

interface RunningTool {
  child: ChildProcess | null
  cancelled: boolean
  /** Resolves once the run has exited *and* its temporary files are gone. */
  finished: Promise<void>
  /** Marks the run cancelled, even if the process has not been spawned yet. */
  kill(): void
}

const running = new Map<string, RunningTool>()

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------

const EXE = process.platform === 'win32' ? '.exe' : ''

/** Directories worth looking in before giving up and asking the user. */
function candidateDirs(): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)

  if (process.platform === 'win32') {
    for (const root of ['C:\\Program Files\\MySQL', 'C:\\Program Files (x86)\\MySQL']) {
      for (const entry of listDirs(root)) {
        dirs.push(entry, path.join(entry, 'bin'))
      }
    }
    for (const root of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
      for (const entry of listDirs(root)) dirs.push(path.join(entry, 'bin'))
    }
  } else {
    dirs.push('/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/opt/mysql-client/bin')
    for (const entry of listDirs('/Library/PostgreSQL')) dirs.push(path.join(entry, 'bin'))
    for (const entry of listDirs('/usr/lib/postgresql')) dirs.push(path.join(entry, 'bin'))
  }

  return dirs
}

function listDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      // Newest version first: "MySQL Server 8.4" should beat "MySQL Server 5.7".
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch {
    return []
  }
}

/** First location on this machine holding `tool`, or '' when there is none. */
export function detectTool(tool: ToolName): string {
  const exe = `${tool}${EXE}`
  for (const dir of candidateDirs()) {
    const candidate = path.join(dir, exe)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* next candidate */
    }
  }
  return ''
}

/**
 * The version line reported by an external database tool. Keeping this probe in
 * the main process lets the renderer inspect a user-selected executable without
 * giving it general process-spawning access.
 */
export async function toolVersion(command: string): Promise<string> {
  const executable = resolveExecutable(command)
  const child = spawn(executable, ['--version'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  const collect = (chunk: Buffer): void => {
    // A version line is tiny; cap unexpected output from a misidentified tool.
    if (output.length < 4096) output += chunk.toString('utf8').slice(0, 4096 - output.length)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error(`Timed out reading the version from "${command}".`)))
    }, 5000)

    child.once('error', (err) => finish(() => reject(err)))
    child.once('close', (code) =>
      finish(() => {
        const version = output.trim()
        if (code === 0 && version) resolve(version)
        else reject(new Error(version || `"${command}" exited with code ${code ?? '?'}.`))
      })
    )
  })
}

/** Resolves a bare tool name against PATH, since spawning does not do it for us. */
function resolveExecutable(command: string): string {
  if (command.includes('/') || command.includes('\\')) return command
  const withExt = EXE && !command.toLowerCase().endsWith(EXE) ? `${command}${EXE}` : command
  for (const dir of candidateDirs()) {
    const candidate = path.join(dir, withExt)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* next candidate */
    }
  }
  return command
}

// ---------------------------------------------------------------------------
// Temporary credential files
// ---------------------------------------------------------------------------

async function writeSecretFile(kind: string, contents: string): Promise<string> {
  const target = path.join(os.tmpdir(), `mysql-browser-${kind}-${randomBytes(9).toString('hex')}`)
  // 0600 is what makes a .pgpass acceptable to libpq on Unix; on Windows the
  // file is in the user's own temp directory and the mode is ignored.
  await fsp.writeFile(target, contents, { encoding: 'utf8', mode: 0o600 })
  return target
}

/** A `[client]` option file. Values are double-quoted, so both escapes matter. */
function optionFile(password: string): string {
  if (!password) return '[client]\n'
  const escaped = password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `[client]\npassword="${escaped}"\n`
}

/** A `.pgpass` line. Wildcards everywhere but the password: it is single-use. */
function pgpassFile(password: string): string {
  const escaped = password.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
  return `*:*:*:*:${escaped}\n`
}

// ---------------------------------------------------------------------------
// Reading a failure
// ---------------------------------------------------------------------------

/** Lines that report an error, from mysql, mysqldump, psql, pg_dump and pg_restore. */
const ERROR_LINES = [
  // ERROR 1205 (HY000) at line 12: Lock wait timeout exceeded; …
  /^ERROR \d+/,
  // mysqldump: Couldn't execute '…': … (1227) — and Error 2013:, Got errno 28 on write
  /^(?:.*[\\/])?mysql\w*(?:\.exe)?: (?:Couldn't|Can't|Error|Got errno|unknown (?:option|variable))/i,
  // psql:dump.sql:12: ERROR:  … — and pg_dump: error:, mysqldump: Got error: 1045:
  /\b(?:error|fatal):/i
]

/** The MySQL error number in one of those lines. */
const MYSQL_CODE = /^ERROR (\d+)|\berror:? (\d+):|mysql\w*(?:\.exe)?: Couldn't execute .*\((\d+)\)\s*$/i

const UNREACHABLE =
  'The tool could not reach the server at the host and port in the command. Check that the server is running and reachable from this machine.'

/** What usually lies behind the MySQL errors a dump or restore runs into most. */
const MYSQL_HINTS: Record<number, string> = {
  1045: 'The server turned down the user name or password. The tool signs in with the connection’s own credentials, so check them in its settings.',
  1205: 'Another connection is holding locks on the rows this statement needs — usually a transaction left open in another client or app, or a large one still rolling back. performance_schema.data_locks shows which connection holds them; run this again once it lets go.',
  1213: 'This statement deadlocked with another connection writing to the same tables, and MySQL rolled it back. Stop whatever else is writing to them, then run this again.',
  1227: 'The user lacks a privilege a statement needs. In a dump that is usually SET @@GLOBAL.GTID_PURGED (export again with "Do not set GTID_PURGED") or a DEFINER naming another user on a view, trigger or routine.',
  2002: UNREACHABLE,
  2003: UNREACHABLE,
  2005: UNREACHABLE
}

function hintFor(errorLine: string): string | null {
  const code = Number(MYSQL_CODE.exec(errorLine)?.slice(1).find(Boolean))
  return MYSQL_HINTS[code] ?? null
}

/** Longest line kept while looking; one that runs on is judged by its start. */
const MAX_LINE = 4096

/**
 * Watches a tool's stderr for the first line reporting an error, so a failed
 * run can say why instead of "exited with code 1". It sees every byte, including
 * what the log stops showing, so a failure late in a chatty run still counts.
 * The first error rather than the last, because later ones tend to follow from it.
 */
class ErrorLineWatch {
  private partial = ''
  private found: string | null = null

  feed(text: string): void {
    if (this.found !== null) return
    const lines = (this.partial + text).split('\n')
    this.partial = lines.pop()!.slice(0, MAX_LINE)
    for (const line of lines) if (this.check(line)) return
  }

  /** The error line, once the stream has ended. */
  finish(): string | null {
    if (this.found === null && this.partial) this.check(this.partial)
    this.partial = ''
    return this.found
  }

  private check(line: string): boolean {
    const text = line.trim()
    if (!ERROR_LINES.some((pattern) => pattern.test(text))) return false
    this.found = text.length > 500 ? `${text.slice(0, 500)}…` : text
    return true
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function resolvePassword(config: ConnectionConfig): Promise<string> {
  if (config.method !== 'iam') return config.password ?? ''
  const provider = new IamTokenProvider(config.iamTokenCommand || '', () => undefined)
  try {
    return await provider.get(true)
  } finally {
    provider.stop()
  }
}

/** Total bytes at `target`, whether it is a file or a directory-format dump. */
async function sizeOf(target: string): Promise<number> {
  try {
    const stat = await fsp.stat(target)
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    const entries = await fsp.readdir(target, { withFileTypes: true })
    let total = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      total += (await fsp.stat(path.join(target, entry.name)).catch(() => ({ size: 0 }))).size
    }
    return total
  } catch {
    return 0
  }
}

/**
 * Runs one tool to completion. Resolves when the process has exited (or failed
 * to start); progress and output arrive through `emit` in the meantime.
 */
export async function runTool(
  runId: string,
  config: ConnectionConfig,
  request: ToolRunRequest,
  prefs: Preferences,
  emit: (event: ToolRunEvent) => void
): Promise<void> {
  if (running.has(runId)) throw new Error('This tab is already running a tool')

  let settle = (): void => undefined
  const entry: RunningTool = {
    child: null,
    cancelled: false,
    finished: new Promise<void>((resolve) => {
      settle = resolve
    }),
    kill() {
      this.cancelled = true
      this.child?.kill()
    }
  }
  running.set(runId, entry)

  const startedAt = Date.now()
  const cleanup: (() => void | Promise<void>)[] = []
  const info = (text: string): void => emit({ runId, type: 'info', text })

  try {
    const parsed = parseCommandLine(request.command)
    if (parsed.argv.length === 0) throw new Error('There is no command to run.')

    const env: NodeJS.ProcessEnv = { ...process.env }
    // A password left in the ambient environment would quietly win over the one
    // this run is about to write, and connect as somebody else.
    delete env.PGPASSWORD
    delete env.MYSQL_PWD
    const password = await resolvePassword(config)

    // --- credentials -----------------------------------------------------
    let passwordFile = ''
    if (request.command.includes(PASSWORD_FILE_TOKEN)) {
      passwordFile = await writeSecretFile('cnf', optionFile(password))
      cleanup.push(() => fsp.rm(passwordFile, { force: true }).catch(() => undefined))
    }
    if (config.engine === 'postgres') {
      const pgpass = await writeSecretFile('pgpass', pgpassFile(password))
      cleanup.push(() => fsp.rm(pgpass, { force: true }).catch(() => undefined))
      env.PGPASSFILE = pgpass
      if (config.useSSL) env.PGSSLMODE = config.rejectUnauthorized === false ? 'require' : 'verify-full'
      info(`PGPASSFILE=${pgpass}${env.PGSSLMODE ? ` PGSSLMODE=${env.PGSSLMODE}` : ''}`)
    }

    // --- tunnel ----------------------------------------------------------
    let tunnel: Tunnel | null = null
    if (config.method === 'ssh') {
      info(`Opening an SSH tunnel through ${config.sshUser}@${config.sshHost}…`)
      tunnel = await openTunnel(config, Math.max(1, prefs.connectTimeoutSec) * 1000)
      const opened = tunnel
      cleanup.push(() => opened.close())
      info(`Tunnel listening on 127.0.0.1:${tunnel.localPort}`)
    }

    const argv = parsed.argv.map((arg) =>
      arg
        .split(PASSWORD_FILE_TOKEN)
        .join(passwordFile)
        .split(TUNNEL_HOST_TOKEN)
        .join('127.0.0.1')
        .split(TUNNEL_PORT_TOKEN)
        .join(String(tunnel?.localPort ?? ''))
    )

    // --- redirections ----------------------------------------------------
    let inputTotal: number | null = null
    if (parsed.stdinFile) {
      const stat = await fsp.stat(parsed.stdinFile).catch(() => null)
      if (!stat?.isFile()) throw new Error(`Cannot read "${parsed.stdinFile}".`)
      inputTotal = stat.size
    }

    if (entry.cancelled) throw new CancelledError()

    // --- spawn -----------------------------------------------------------
    const executable = resolveExecutable(argv[0])
    info(`> ${[executable, ...argv.slice(1)].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`)

    const child = spawn(executable, argv.slice(1), {
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    entry.child = child

    let emitted = 0
    let truncated = false
    const forward = (stream: 'out' | 'err') => (chunk: Buffer) => {
      if (truncated) return
      if (emitted >= MAX_OUTPUT_BYTES) {
        truncated = true
        info('Further output is not shown — the tool is still running.')
        return
      }
      emitted += chunk.length
      emit({ runId, type: 'output', stream, text: chunk.toString('utf8') })
    }

    if (parsed.stdoutFile) {
      const out = fs.createWriteStream(parsed.stdoutFile, { flags: parsed.appendStdout ? 'a' : 'w' })
      child.stdout?.pipe(out)
      out.on('error', (err) => info(`Cannot write "${parsed.stdoutFile}": ${err.message}`))
    } else {
      child.stdout?.on('data', forward('out'))
    }
    child.stderr?.on('data', forward('err'))
    const errors = new ErrorLineWatch()
    child.stderr?.on('data', (chunk: Buffer) => errors.feed(chunk.toString('utf8')))

    // --- input -----------------------------------------------------------
    let piped = 0
    if (parsed.stdinFile) {
      const input = fs.createReadStream(parsed.stdinFile)
      input.on('data', (chunk) => {
        piped += chunk.length
      })
      // A tool that dies early (bad password, syntax error) closes its stdin
      // while the file is still being fed to it; that is an ordinary end to the
      // run, not a crash.
      input.on('error', (err) => info(`Reading "${parsed.stdinFile}" failed: ${err.message}`))
      child.stdin?.on('error', () => undefined)
      input.pipe(child.stdin!)
      cleanup.push(() => {
        input.destroy()
      })
    } else {
      child.stdin?.end()
    }

    // --- progress --------------------------------------------------------
    const progressTarget = parsed.stdoutFile || request.outputPath || ''
    const tick = (): void => {
      if (inputTotal !== null) {
        emit({ runId, type: 'progress', bytes: piped, total: inputTotal })
      } else if (progressTarget) {
        void sizeOf(progressTarget).then((bytes) => emit({ runId, type: 'progress', bytes, total: null }))
      }
    }
    // One straight away, so a short run still reports something and an import
    // shows the size it is working through before the first interval elapses.
    tick()
    const timer = setInterval(tick, PROGRESS_INTERVAL_MS)
    cleanup.push(() => clearInterval(timer))

    // --- wait ------------------------------------------------------------
    const result = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ code, signal }))
      }
    )

    clearInterval(timer)
    const bytes = inputTotal !== null ? piped : progressTarget ? await sizeOf(progressTarget) : 0
    const error = result.code === 0 || entry.cancelled ? null : errors.finish()
    const hint = error && hintFor(error)
    if (hint) info(`Hint: ${hint}`)
    emit({
      runId,
      type: 'exit',
      code: result.code,
      signal: result.signal,
      cancelled: entry.cancelled,
      bytes,
      durationMs: Date.now() - startedAt,
      error
    })
  } catch (err) {
    const cancelled = entry.cancelled || err instanceof CancelledError
    const message = cancelled
      ? null
      : (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Could not start "${parseCommandLine(request.command).argv[0]}" — check the tool path.`
        : ((err as Error).message ?? String(err))
    if (message) emit({ runId, type: 'output', stream: 'err', text: `${message}\n` })
    emit({
      runId,
      type: 'exit',
      code: null,
      signal: null,
      cancelled,
      bytes: 0,
      durationMs: Date.now() - startedAt,
      error: message
    })
  } finally {
    running.delete(runId)
    for (const step of cleanup.reverse()) {
      try {
        await step()
      } catch {
        /* best effort */
      }
    }
    settle()
  }
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

/** Stops a run. False when it had already finished. */
export function cancelTool(runId: string): boolean {
  const entry = running.get(runId)
  if (!entry) return false
  entry.kill()
  return true
}

/**
 * Kills every running tool on shutdown and waits for them to tidy up, so no
 * temporary password file outlives the app. Gives up after a moment: quitting
 * must not hang on a process that refuses to die.
 */
export async function cancelAllTools(): Promise<void> {
  const pending = [...running.values()]
  for (const entry of pending) entry.kill()
  await Promise.race([
    Promise.all(pending.map((entry) => entry.finished)),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ])
}
