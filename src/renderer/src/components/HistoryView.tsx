import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HistoryColumnWidths, HistoryEntry } from '@shared/types'
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

/** Round to `digits` significant figures, e.g. 32.761 -> 33, 0.678 -> 0.68. */
function sigFig(value: number, digits: number): number {
  if (value === 0) return 0
  const factor = Math.pow(10, digits - 1 - Math.floor(Math.log10(Math.abs(value))))
  return Math.round(value * factor) / factor
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** `12.345 sec` under a minute, then the two largest units — `59 mins 33 secs`, `2 days 12 hrs`. */
function formatDuration(ms: number | null): string {
  if (ms === null) return ''

  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(3)} sec`

  const rounded = Math.round(totalSeconds)
  const years = Math.floor(rounded / 31536000)
  const months = Math.floor((rounded % 31536000) / 2628000)
  const weeks = Math.floor((rounded % 2628000) / 604800)
  const days = Math.floor((rounded % 604800) / 86400)
  const hours = Math.floor((rounded % 86400) / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const seconds = sigFig(totalSeconds % 60, 2)

  if (years) return plural(years, 'year') + (months ? ` ${plural(months, 'month')}` : '')
  if (months) return plural(months, 'month') + (weeks ? ` ${plural(weeks, 'week')}` : '')
  if (weeks) return plural(weeks, 'week') + (days ? ` ${plural(days, 'day')}` : '')
  if (days) return plural(days, 'day') + (hours ? ` ${plural(hours, 'hr')}` : '')
  if (hours) return plural(hours, 'hr') + (minutes ? ` ${plural(minutes, 'min')}` : '')
  return plural(minutes, 'min') + (seconds >= 1 ? ` ${plural(seconds, 'sec')}` : '')
}

interface Props {
  entries: HistoryEntry[]
  widths: HistoryColumnWidths
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

  const sizeRef = useRef(widths)
  sizeRef.current = widths

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
    resizeRef.current = { col, startX: e.clientX, startWidth: widths[col] }
    document.body.classList.add('resizing-col')
  }

  const header = (col: ResizableColumn, label: string): JSX.Element => (
    <th>
      {label}
      <span className="col-resizer" onPointerDown={startResize(col)} />
    </th>
  )

  const totalWidth =
    GUTTER_WIDTH + widths.seq + widths.time + widths.action + widths.message + widths.duration

  return (
    <div className="grid-wrap" ref={scrollRef} onScroll={onScroll}>
      <table className="history-table" style={{ width: totalWidth, minWidth: '100%' }}>
        <colgroup>
          <col style={{ width: GUTTER_WIDTH }} />
          <col style={{ width: widths.seq }} />
          <col style={{ width: widths.time }} />
          <col style={{ width: widths.action }} />
          <col style={{ width: widths.message }} />
          <col style={{ width: widths.duration }} />
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
            const message =
              running && elapsed !== null
                ? `Running… ${(elapsed / 1000).toFixed(0)}s`
                : entry.message
            const duration = running
              ? ''
              : `${formatDuration(entry.durationMs)}${
                  entry.fetchMs !== null ? ` / ${formatDuration(entry.fetchMs)}` : ''
                }`

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
              >
                <td style={{ textAlign: 'center' }} title={entry.status}>
                  <span className={`status-icon ${entry.status}`}>
                    {entry.status === 'ok' ? '✓' : entry.status === 'error' ? '!' : ''}
                  </span>
                </td>
                <td title={String(entry.seq)}>{entry.seq}</td>
                <td title={new Date(entry.startedAt).toLocaleString()}>
                  {relativeTime(entry.startedAt, now)}
                </td>
                <td className="action" title={entry.action}>
                  {singleLineAction}
                </td>
                <td className="message" title={message}>
                  {message}
                </td>
                <td title={duration || undefined}>{duration}</td>
                <td className="filler" />
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
