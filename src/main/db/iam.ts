/**
 * AWS IAM auth tokens. RDS tokens expire after 15 minutes, so the worker keeps
 * a cached token and refreshes it well before every new connection needs one.
 */

import { exec } from 'node:child_process'

/** Refresh a little under the AWS 15-minute lifetime. */
const TOKEN_TTL_MS = 10 * 60 * 1000

export class IamTokenProvider {
  private token: string | null = null
  private fetchedAt = 0
  private inflight: Promise<string> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly command: string,
    private readonly onError: (message: string) => void
  ) {}

  /** Returns a token, reusing the cached one while it is still fresh. */
  async get(force = false): Promise<string> {
    if (!force && this.token && Date.now() - this.fetchedAt < TOKEN_TTL_MS) {
      return this.token
    }
    if (this.inflight) return this.inflight

    this.inflight = this.run()
      .then((token) => {
        this.token = token
        this.fetchedAt = Date.now()
        return token
      })
      .finally(() => {
        this.inflight = null
      })

    return this.inflight
  }

  /** Keeps the cached token warm so opening a new query tab never stalls. */
  startBackgroundRefresh(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.get(true).catch((err: Error) => this.onError(err.message))
    }, TOKEN_TTL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private run(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.command.trim()) {
        reject(new Error('No IAM token command configured for this connection'))
        return
      }
      exec(
        this.command,
        { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr || stdout || err.message).trim().split('\n').slice(-4).join('\n')
            reject(new Error(`IAM token command failed: ${detail}`))
            return
          }
          const token = stdout.trim()
          if (!token) {
            reject(new Error('IAM token command produced no output'))
            return
          }
          resolve(token)
        }
      )
    })
  }
}
