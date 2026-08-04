import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { HistoryColumnWidths, HistoryEntry } from '@shared/types'
import { DEFAULT_HISTORY_COLUMNS } from '@shared/types'
import { useContextMenu } from './ui/ContextMenu'

/** Status icon gutter — not resizable, it only ever holds a ✓ or a !. */
const GUTTER_WIDTH = 26
const MIN_COL_WIDTH = 30

type ResizableColumn = keyof HistoryColumnWidths

/** `1 sec ago`, `2 mins ago`, … refreshed every second. */
function relativeTime(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 1) return 'just now'
  if (seconds === 1) return '1 sec ago'
  if (seconds < 60) return `${seconds} secs ago`

  const minutes = Math.round(seconds / 60)
  if (minutes === 1) return '1 min ago'
  if (minutes < 60) return `${minutes} mins ago`

  const hours = Math.round(minutes / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`

  const days = Math.round(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  return `${(ms / 1000).toFixed(3)} sec`
}

interface Props {
  entries: HistoryEntry[]
  widths: HistoryColumnWidths | undefined
  onResize(widths: HistoryColumnWidths): void
  /** Fired once when a drag ends, so the new widths are persisted just once. */
  onResizeCommit(): void
  onUseSql(sql: string): void
}

export function HistoryView({
  entries,
  widths,
  onResize,
  onResizeCommit,
  onUseSql
}: Props): JSX.Element {
  const menu = useContextMenu()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const atBottomRef = useRef(true)
  const resizeRef = useRef<{ col: ResizableColumn; startX: number; startWidth: number } | null>(null)

  // Sessions saved before the columns were resizable have no widths stored.
  const size = useMemo<HistoryColumnWidths>(
    () => ({ ...DEFAULT_HISTORY_COLUMNS, ...(widths ?? {}) }),
    [widths]
  )
  const sizeRef = useRef(size)
  sizeRef.current = size

  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize
  const onCommitRef = useRef(onResizeCommit)
  onCommitRef.current = onResizeCommit

  // The relative-time column and the running-query elapsed time both need this.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // Follow the tail, but don't yank the view if the user has scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [entries.length])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  // --- column resizing ----------------------------------------------------

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const resize = resizeRef.current
      if (!resize) return
      const next = Math.max(MIN_COL_WIDTH, resize.startWidth + (e.clientX - resize.startX))
      onResizeRef.current({ ...sizeRef.current, [resize.col]: Math.round(next) })
    }
    const up = (): void => {
      if (!resizeRef.current) return
      resizeRef.current = null
      document.body.classList.remove('resizing-col')
      onCommitRef.current()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-col')
    }
  }, [])

  const startResize = (col: ResizableColumn) => (e: React.PointerEvent) => {
    e.preventDefault()
    resizeRef.current = { col, startX: e.clientX, startWidth: size[col] }
    document.body.classList.add('resizing-col')
  }

  const header = (col: ResizableColumn, label: string): JSX.Element => (
    <th>
      {label}
      <span className="col-resizer" onPointerDown={startResize(col)} />
    </th>
  )

  const totalWidth =
    GUTTER_WIDTH + size.seq + size.time + size.action + size.message + size.duration

  return (
    <div className="grid-wrap" ref={scrollRef} onScroll={onScroll}>
      <table className="history-table" style={{ width: totalWidth, minWidth: '100%' }}>
        <colgroup>
          <col style={{ width: GUTTER_WIDTH }} />
          <col style={{ width: size.seq }} />
          <col style={{ width: size.time }} />
          <col style={{ width: size.action }} />
          <col style={{ width: size.message }} />
          <col style={{ width: size.duration }} />
          {/* Soaks up any width left over when the pane is wider than the columns. */}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th />
            {header('seq', '#')}
            {header('time', 'Time')}
            {header('action', 'Action')}
            {header('message', 'Message')}
            {header('duration', 'Duration / Fetch')}
            <th className="filler" />
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: 'var(--text-dim)', padding: '6px 8px' }}>
                Queries you run appear here.
              </td>
            </tr>
          )}
          {entries.map((entry) => {
            const running = entry.status === 'running'
            const elapsed = running ? now - entry.startedAt : null
            const singleLineAction = entry.action.replace(/\s+/g, ' ').trim()

            return (
              <tr
                key={entry.id}
                className={entry.status === 'error' ? 'err' : ''}
                onContextMenu={(e) => {
                  e.preventDefault()
                  menu.show(e, [
                    {
                      label: 'Copy action',
                      onSelect: () => void window.api.clipboard.write(entry.action)
                    },
                    {
                      label: 'Copy message',
                      onSelect: () => void window.api.clipboard.write(entry.message)
                    },
                    { separator: true },
                    {
                      label: 'Open in a new tab',
                      onSelect: () => onUseSql(entry.action)
                    }
                  ])
                }}
                title={entry.action}
              >
                <td style={{ textAlign: 'center' }}>
                  <span className={`status-icon ${entry.status}`}>
                    {entry.status === 'ok' ? '✓' : entry.status === 'error' ? '!' : ''}
                  </span>
                </td>
                <td>{entry.seq}</td>
                <td title={new Date(entry.startedAt).toLocaleString()}>
                  {relativeTime(entry.startedAt, now)}
                </td>
                <td className="action">{singleLineAction}</td>
                <td className="message">
                  {running && elapsed !== null
                    ? `Running… ${(elapsed / 1000).toFixed(0)}s`
                    : entry.message}
                </td>
                <td>
                  {running
                    ? ''
                    : `${formatDuration(entry.durationMs)}${
                        entry.fetchMs !== null ? ` / ${formatDuration(entry.fetchMs)}` : ''
                      }`}
                </td>
                <td className="filler" />
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
