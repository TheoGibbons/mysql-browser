/**
 * Background updates via electron-updater.
 *
 * The app holds live database connections and unsaved editor content, so it
 * never restarts itself. Updates download quietly and `autoInstallOnAppQuit`
 * applies them when the user closes the app of their own accord; the renderer
 * only offers an explicit "Restart now" for people who don't want to wait.
 */

import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'

/** Re-checks while the app stays open for days at a time. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Long enough that opening connections isn't competing with the download. */
const FIRST_CHECK_DELAY_MS = 10_000

let state: UpdateState = { phase: 'idle' }

export function getUpdateState(): UpdateState {
  return state
}

function setState(next: UpdateState): void {
  state = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updates:state', next)
  }
}

export function initUpdater(): void {
  // electron-updater has no update feed to read in development, and calling it
  // there throws rather than no-ops.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking' }))

  autoUpdater.on('update-available', (info) =>
    setState({ phase: 'downloading', version: info.version, percent: 0 })
  )

  autoUpdater.on('update-not-available', () => setState({ phase: 'idle' }))

  autoUpdater.on('download-progress', (progress) => {
    if (state.phase !== 'downloading') return
    setState({ ...state, percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => setState({ phase: 'ready', version: info.version }))

  // A missing or unreachable feed is the common case here (an unconfigured
  // `publish` target, or the user being offline). It isn't worth interrupting
  // anyone over, so it stays in the log and out of the UI.
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err?.message ?? err)
    setState({ phase: 'error', message: err?.message ?? String(err) })
  })

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS)
  setInterval(() => void check(), CHECK_INTERVAL_MS)
}

/** Safe to call at any time; resolves once the check settles. */
export async function check(): Promise<UpdateState> {
  if (!app.isPackaged) return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (err: any) {
    console.error('[updater] check failed', err?.message ?? err)
  }
  return state
}

/**
 * Restarts into the new version now. The caller is responsible for warning
 * about in-flight work first — `before-quit` still runs, so sessions shut down
 * cleanly on the way out.
 */
export function installNow(): boolean {
  if (state.phase !== 'ready') return false
  setImmediate(() => autoUpdater.quitAndInstall())
  return true
}
