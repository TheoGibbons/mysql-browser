import { useEffect, useRef, useState } from 'react'
import {
  PASSWORD_FILE_TOKEN,
  TUNNEL_HOST_TOKEN,
  TUNNEL_PORT_TOKEN,
  type TransferKind
} from '@shared/transfer'
import { formatBytes, type TransferRun } from '../store'
import { StopIcon } from './ui/Icons'
import { Splitter } from './ui/Splitter'

interface Props {
  kind: TransferKind
  /** The command as it will run — generated, or the user's edit of it. */
  command: string
  edited: boolean
  onCommandChange(command: string): void
  onReset(): void
  /** Why Start is disabled, or null when it is not. */
  blockedReason: string | null
  run: TransferRun | undefined
  running: boolean
  onStart(): void
  onStop(): void
  onClear(): void
  /** File or directory the run produced, offered as Show in folder. */
  revealPath: string
  /** Postgres passes its password out of band, which is worth saying once. */
  passwordNote: string
  /** Height of the output console, dragged by the splitter above it. */
  logHeight: number
  onLogHeight(height: number): void
  onLogHeightCommit(): void
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * The bottom half of a transfer tab: the command that will run, editable, and
 * the console for the run itself. Everything above only exists to write the text
 * in this box — if the user would rather type it, that works exactly as well.
 */
export function TransferRunner({
  kind,
  command,
  edited,
  onCommandChange,
  onReset,
  blockedReason,
  run,
  running,
  onStart,
  onStop,
  onClear,
  revealPath,
  passwordNote,
  logHeight,
  onLogHeight,
  onLogHeightCommit
}: Props): JSX.Element {
  const logRef = useRef<HTMLDivElement>(null)
  const [, setTick] = useState(0)

  // A session file written before this pane was resizable has no height in it,
  // and an unset height would let the console grow with its own output.
  const height = Number.isFinite(logHeight) && logHeight > 0 ? logHeight : 120

  // A running dump has a clock, so the elapsed time has to redraw on its own.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setTick((t) => t + 1), 500)
    return () => clearInterval(timer)
  }, [running])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run?.chunks.length])

  const tokens = [
    command.includes(PASSWORD_FILE_TOKEN) &&
      `${PASSWORD_FILE_TOKEN} — a temporary option file holding the password, written just before the tool starts and deleted when it exits.`,
    command.includes(TUNNEL_HOST_TOKEN) &&
      `${TUNNEL_HOST_TOKEN}/${TUNNEL_PORT_TOKEN} — the local end of the SSH tunnel opened for this run.`,
    passwordNote
  ].filter((t): t is string => typeof t === 'string' && t !== '')

  const percent =
    run && run.total !== null && run.total > 0
      ? Math.min(100, Math.round((run.bytes / run.total) * 100))
      : null

  return (
    <div className="transfer-foot">
      <div className="pane-head">
        <span className="pane-title">Command</span>
        {edited && <span className="tag-warn">edited by hand — options no longer apply</span>}
        <div className="spacer" />
        <button
          className="toolbar-btn"
          onClick={() => void window.api.clipboard.write(command)}
          title="Copy the command to the clipboard"
        >
          Copy
        </button>
        <button
          className="toolbar-btn"
          disabled={!edited}
          onClick={onReset}
          title="Go back to the command generated from the options above"
        >
          Reset
        </button>
      </div>

      <textarea
        className="field transfer-cmd"
        spellCheck={false}
        value={command}
        onChange={(e) => onCommandChange(e.target.value)}
        placeholder="The command that will run"
      />

      {tokens.length > 0 && (
        <div className="transfer-tokens">
          {tokens.map((token) => (
            <div key={token}>{token}</div>
          ))}
        </div>
      )}

      <div className="transfer-actions">
        {running ? (
          <button className="btn danger" style={{ minWidth: 110 }} onClick={onStop}>
            <StopIcon size={12} /> Stop
          </button>
        ) : (
          <button
            className="btn primary"
            style={{ minWidth: 110 }}
            disabled={blockedReason !== null}
            title={blockedReason ?? undefined}
            onClick={onStart}
          >
            {kind === 'export' ? 'Start Export' : 'Start Import'}
          </button>
        )}

        {run && (
          <span className={`transfer-status ${run.status}`}>
            {run.status === 'running'
              ? `Running · ${elapsed(Date.now() - run.startedAt)}${
                  percent !== null
                    ? ` · ${percent}% of ${formatBytes(run.total ?? 0)}`
                    : run.bytes > 0
                      ? ` · ${formatBytes(run.bytes)} written`
                      : ''
                }`
              : run.status === 'ok'
                ? `Finished in ${elapsed(run.durationMs)} · ${formatBytes(run.bytes)}`
                : run.status === 'cancelled'
                  ? `Stopped after ${elapsed(run.durationMs)}`
                  : `Failed (exit code ${run.exitCode ?? '?'}) after ${elapsed(run.durationMs)}`}
          </span>
        )}

        {!run && blockedReason && <span className="hint">{blockedReason}</span>}

        <div className="spacer" />

        {run && run.chunks.length > 0 && (
          <button
            className="toolbar-btn"
            title="Copy everything the tool printed to the clipboard"
            onClick={() =>
              void window.api.clipboard.write(run.chunks.map((chunk) => chunk.text).join(''))
            }
          >
            Copy log
          </button>
        )}
        {run && !running && revealPath && run.status === 'ok' && (
          <button className="toolbar-btn" onClick={() => void window.api.files.reveal(revealPath)}>
            Show in folder
          </button>
        )}
        {run && !running && (
          <button className="toolbar-btn" onClick={onClear}>
            Clear log
          </button>
        )}
      </div>

      {run && (
        <Splitter
          orientation="horizontal"
          size={height}
          grow="after"
          min={48}
          max={400}
          onResize={onLogHeight}
          onCommit={onLogHeightCommit}
        />
      )}

      {run && (
        <div className={`transfer-log ${run.status}`} style={{ height }} ref={logRef}>
          {run.chunks.map((chunk, index) => (
            <span key={index} className={`log-${chunk.stream}`}>
              {chunk.text}
            </span>
          ))}
          {run.chunks.length === 0 && <span className="log-info">Waiting for output…</span>}
        </div>
      )}
    </div>
  )
}
