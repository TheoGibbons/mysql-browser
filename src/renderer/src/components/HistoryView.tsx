import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { useContextMenu } from './ui/ContextMenu'

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
  onUseSql(sql: string): void
}

export function HistoryView({ entries, onUseSql }: Props): JSX.Element {
  const menu = useContextMenu()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const atBottomRef = useRef(true)

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

  return (
    <div className="grid-wrap" ref={scrollRef} onScroll={onScroll}>
      <table className="history-table">
        <colgroup>
          <col style={{ width: 26 }} />
          <col style={{ width: 46 }} />
          <col style={{ width: 92 }} />
          <col />
          <col style={{ width: 240 }} />
          <col style={{ width: 150 }} />
        </colgroup>
        <thead>
          <tr>
            <th />
            <th>#</th>
            <th>Time</th>
            <th>Action</th>
            <th>Message</th>
            <th>Duration / Fetch</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={6} style={{ color: 'var(--text-dim)', padding: '6px 8px' }}>
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
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
