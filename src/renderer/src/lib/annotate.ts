/**
 * "Run and annotate": runs each statement of a read-only script and writes its
 * result underneath it as `-- ` comments, so the script and what it returned
 * can be copied out together.
 *
 * Every block opens with a `-- ▸ ` line, and only ever continues with `-- |`
 * and `-- …` lines, so the next run can find and remove the old blocks before
 * writing new ones. Line comments rather than `/* *\/`, since a value holding
 * `*\/` would end a block comment early and turn the rest into SQL.
 */

import {
  splitStatements,
  statementEffect,
  stripLeadingComments,
  type Statement
} from '@shared/sql'
import type { DbEngine, ResultSet } from '@shared/types'
import { textTable } from './grid'

/** Rows written under each statement; the rest are only counted. */
export const ANNOTATE_ROW_LIMIT = 50

/** Longer values are cut short, so one blob can't swamp the script. */
const MAX_CELL_CHARS = 100

const HEADER = '-- ▸ '
const CONTINUATION = /^-- [|…]/

/** Removes every result block an earlier run wrote. */
export function stripAnnotations(sql: string): string {
  const kept: string[] = []
  let inBlock = false
  for (const line of sql.split('\n')) {
    if (line.startsWith(HEADER)) {
      inBlock = true
      continue
    }
    if (inBlock && CONTINUATION.test(line)) continue
    inBlock = false
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * True for a "statement" of nothing but comments: what a note after the last
 * `;` splits into. Nothing to run, and nothing to judge read-only. MySQL's
 * `/*! … *\/` comments never count, since the server runs what's inside them.
 */
function isCommentOnly(sql: string): boolean {
  if (/\/\*M?!/.test(sql)) return false
  return stripLeadingComments(sql) === ''
}

/** The statements a run executes: everything but comment-only fragments. */
export function annotatableStatements(sql: string, engine: DbEngine): Statement[] {
  return splitStatements(sql, engine).filter((s) => !isCommentOnly(s.text))
}

/** The first statement that keeps a script from being annotated, 1-based. */
export interface AnnotateBlocker {
  statement: number
  statements: number
  opening: string
}

/**
 * Why the script can't be annotated, or `null` when every statement is
 * read-only. Uses the same allowlist as the modify confirmation, so anything
 * it can't prove harmless blocks the run.
 */
export function annotateBlocker(statements: Statement[], engine: DbEngine): AnnotateBlocker | null {
  const index = statements.findIndex((s) => statementEffect(s.text, engine) !== 'read')
  if (index < 0) return null
  const opening = /^\S+/.exec(stripLeadingComments(statements[index].text))?.[0] ?? ''
  return { statement: index + 1, statements: statements.length, opening: opening.slice(0, 40) }
}

/**
 * Where a statement's result block goes, and the line breaks around it.
 *
 * Normally at the end of the statement's last line, so a trailing `-- note`
 * stays with the statement. When something else follows the `;` on that line —
 * the next statement, or a block comment — the block goes straight after the
 * `;` and the rest moves down a line, since a block comment could otherwise
 * swallow the result and the next statement would end up commented out.
 */
export function insertionPoint(
  sql: string,
  statement: Statement,
  engine: DbEngine
): { at: number; before: string; after: string } {
  let at = statement.end
  let probe = at
  while (probe < sql.length && /\s/.test(sql[probe])) probe++
  if (sql[probe] === ';') at = probe + 1

  const lineEnd = sql.indexOf('\n', at)
  const rest = sql.slice(at, lineEnd < 0 ? sql.length : lineEnd)
  const comment = engine === 'mysql' ? /^\s*(--(\s|$)|#)/ : /^\s*--/
  if (/^\s*$/.test(rest) || comment.test(rest)) {
    return { at: lineEnd < 0 ? sql.length : lineEnd, before: '\n', after: '' }
  }
  return { at, before: '\n', after: '\n' }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

/** The block written under a statement that ran. */
export function formatResult(result: ResultSet): string[] {
  const took = duration(result.durationMs + result.fetchMs)
  if (result.columns.length === 0) return [`${HEADER}OK · ${took}`]

  const total = result.totalRows ?? result.rows.length
  const shown = result.rows.slice(0, ANNOTATE_ROW_LIMIT)
  const lines = [
    `${HEADER}${plural(total, 'row')} · ${took}`,
    ...textTable(result.columns, shown, MAX_CELL_CHARS).map((line) => `-- ${line}`)
  ]
  if (total > shown.length) {
    lines.push(`-- … ${plural(total - shown.length, 'more row')} not shown`)
  }
  return lines
}

/** The block written under a statement the server refused, on one line. */
export function formatError(message: string): string[] {
  return [`${HEADER}ERROR: ${message.replace(/\s*\n\s*/g, ' ').trim()}`]
}

/** The block written under the statement that was running when Stop was pressed. */
export function formatStopped(): string[] {
  return [`${HEADER}Stopped`]
}
