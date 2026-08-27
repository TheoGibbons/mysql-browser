/**
 * A pragmatic syntax checker behind the editor's red error markers.
 *
 * This is deliberately *not* a parser. MySQL's grammar is far too large to
 * reimplement, and a half-finished parser would flag valid SQL — which is much
 * worse than flagging nothing, because a red mark you learn to ignore is worse
 * than no mark at all. So rather than try to prove a statement correct, the
 * rules below only fire on shapes no server would accept: unterminated
 * literals, unbalanced parentheses, clauses in the wrong order, dangling
 * commas.
 *
 * Everything the rules can't be sure about — routine bodies, `DELIMITER`
 * scripts, anything whose scope we lost — is skipped rather than guessed at.
 */

import { opensEscapeString, splitStatements, type Statement } from '@shared/sql'
import type { DbEngine } from '@shared/types'

export interface SqlDiagnostic {
  /** Absolute document offsets of the text to underline. */
  from: number
  to: number
  message: string
  /**
   * True for "you haven't finished typing this yet" complaints — an unclosed
   * bracket, a trailing `AND`. The editor hides these while the caret is still
   * inside the statement they're about, so typing doesn't light up in red.
   */
  incomplete: boolean
}

/** Past this the linter stands down; a dump this big isn't being hand-edited. */
const MAX_LINT_LENGTH = 200_000

// ------------------------------------------------------------------- lexer

type TokenKind = 'word' | 'number' | 'string' | 'quoted' | 'param' | 'punct'

interface Token {
  kind: TokenKind
  text: string
  /** Upper-cased text for `word` tokens, empty otherwise. */
  key: string
  /** Absolute document offsets. */
  from: number
  to: number
}

interface Lexed {
  tokens: Token[]
  errors: SqlDiagnostic[]
  /** A literal or comment ran off the end, so the token stream can't be trusted. */
  truncated: boolean
}

/** Matches the opening of a Postgres dollar-quoted body: `$$` or `$tag$`. */
const DOLLAR_QUOTE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/
const WORD_START = /[A-Za-z_$\u0080-\uffff]/
const WORD_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/
const DIGIT = /[0-9]/

/** Longest first, so `<=>` never lexes as `<=` followed by `>`. */
const OPERATORS = ['<=>', '->>', '<<', '>>', '<=', '>=', '<>', '!=', '||', '&&', ':=', '::', '->']

/**
 * Where to stop underlining something that never closed.
 *
 * An unterminated quote or comment really does swallow the rest of the script
 * — that's why it's an error — but drawing the squiggle over all of it turns
 * the whole editor red and buries the one character that caused it. The mark
 * stops at the end of the opening line instead.
 */
function markToLineEnd(sql: string, from: number): number {
  const newline = sql.indexOf('\n', from)
  return newline < 0 ? sql.length : newline
}

/**
 * Splits one statement into tokens, mirroring the comment and quoting rules
 * `splitStatements` uses so the two always agree on where a literal ends.
 * `base` is the statement's offset in the document, so every position the
 * linter reports is already absolute.
 */
function lex(sql: string, base: number, engine: DbEngine): Lexed {
  const isPg = engine === 'postgres'
  const tokens: Token[] = []
  const errors: SqlDiagnostic[] = []
  /** Offsets of the `(`s still waiting for a partner. */
  const unclosed: number[] = []
  let truncated = false
  let i = 0

  const fail = (from: number, to: number, message: string, incomplete: boolean): void => {
    errors.push({ from: base + from, to: base + to, message, incomplete })
  }

  const push = (kind: TokenKind, from: number, to: number): void => {
    const text = sql.slice(from, to)
    tokens.push({
      kind,
      text,
      key: kind === 'word' ? text.toUpperCase() : '',
      from: base + from,
      to: base + to
    })
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (/\s/.test(ch)) {
      i++
      continue
    }

    // Postgres ends the line on any `--`; MySQL only when whitespace follows.
    if (ch === '-' && next === '-' && (isPg || sql[i + 2] === undefined || /\s/.test(sql[i + 2]))) {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }

    if (!isPg && ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }

    if (ch === '/' && next === '*') {
      const start = i
      i += 2
      let depth = 1
      while (i < sql.length && depth > 0) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else if (isPg && sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else {
          i++
        }
      }
      if (depth > 0) {
        fail(start, markToLineEnd(sql, start), 'Unterminated block comment — missing */', true)
        truncated = true
      }
      continue
    }

    if (isPg && ch === '$') {
      // A `$$ … $$` body is one opaque token; its semicolons and keywords are
      // not ours to read.
      const tag = DOLLAR_QUOTE.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        if (close < 0) {
          fail(i, markToLineEnd(sql, i), `Unterminated ${tag[0]} quoted string`, true)
          truncated = true
          i = sql.length
        } else {
          push('string', i, close + tag[0].length)
          i = close + tag[0].length
        }
        continue
      }
      if (DIGIT.test(next ?? '')) {
        const start = i
        i++
        while (i < sql.length && DIGIT.test(sql[i])) i++
        push('param', start, i)
        continue
      }
    }

    if (ch === "'" || ch === '"' || (!isPg && ch === '`')) {
      const start = i
      const quote = ch
      // Backslash only escapes inside a MySQL literal, or Postgres' `E'…'`
      // form — the same rule `splitStatements` uses.
      const backslashEscapes = isPg
        ? quote === "'" && opensEscapeString(sql, start)
        : quote !== '`'
      let closed = false
      i++
      while (i < sql.length) {
        if (sql[i] === '\\' && backslashEscapes) {
          i += 2
          continue
        }
        if (sql[i] === quote) {
          // A doubled quote is an escaped quote, not a terminator.
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        i++
      }
      const identifier = quote === '`' || (isPg && quote === '"')
      if (!closed) {
        fail(
          start,
          markToLineEnd(sql, start),
          identifier
            ? `Unterminated quoted identifier — missing closing ${quote}`
            : `Unterminated string — missing closing ${quote}`,
          true
        )
        truncated = true
        continue
      }
      push(identifier ? 'quoted' : 'string', start, i)
      continue
    }

    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(next ?? ''))) {
      const start = i
      if (ch === '0' && (next === 'x' || next === 'X')) {
        i += 2
        while (i < sql.length && /[0-9a-fA-F]/.test(sql[i])) i++
      } else {
        while (i < sql.length && /[0-9.]/.test(sql[i])) i++
        if (sql[i] === 'e' || sql[i] === 'E') {
          const mark = i
          i++
          if (sql[i] === '+' || sql[i] === '-') i++
          if (DIGIT.test(sql[i] ?? '')) {
            while (i < sql.length && DIGIT.test(sql[i])) i++
          } else {
            // A bare `e` after the digits belongs to whatever follows.
            i = mark
          }
        }
      }
      push('number', start, i)
      continue
    }

    // User and system variables: `@x`, `@@global.x`, and the bare `@` that
    // separates `'user'@'host'`.
    if (ch === '@') {
      const start = i
      i++
      if (sql[i] === '@') i++
      while (i < sql.length && (WORD_CHAR.test(sql[i]) || sql[i] === '.')) i++
      push('param', start, i)
      continue
    }

    if (ch === '?') {
      push('param', i, i + 1)
      i++
      continue
    }

    if (ch === ':' && next !== ':' && WORD_START.test(next ?? '')) {
      const start = i
      i++
      while (i < sql.length && WORD_CHAR.test(sql[i])) i++
      push('param', start, i)
      continue
    }

    if (WORD_START.test(ch)) {
      const start = i
      while (i < sql.length && WORD_CHAR.test(sql[i])) i++
      push('word', start, i)
      continue
    }

    if (ch === '(') {
      push('punct', i, i + 1)
      unclosed.push(i)
      i++
      continue
    }

    if (ch === ')') {
      if (unclosed.length === 0) {
        fail(i, i + 1, "Unmatched ')' — no opening parenthesis", false)
      } else {
        unclosed.pop()
      }
      push('punct', i, i + 1)
      i++
      continue
    }

    const operator = OPERATORS.find((op) => sql.startsWith(op, i))
    if (operator) {
      push('punct', i, i + operator.length)
      i += operator.length
      continue
    }

    push('punct', i, i + 1)
    i++
  }

  for (const at of unclosed) {
    fail(at, at + 1, "Unclosed '(' — missing closing parenthesis", true)
  }

  return { tokens, errors, truncated }
}

// ------------------------------------------------------------------- rules

/**
 * The order clauses have to appear in within one query block. Only words that
 * are reserved in both engines are listed: anything that doubles as an
 * ordinary identifier would turn a valid query red.
 *
 * `SET` and `FOR` are deliberately absent — `INSERT … SELECT … ON CONFLICT DO
 * UPDATE SET` and `CREATE TRIGGER … FOR EACH ROW` both put them "out of order"
 * quite legally.
 */
function clauseRanks(engine: DbEngine): Record<string, number> {
  return {
    SELECT: 10,
    FROM: 20,
    WHERE: 30,
    GROUP: 40,
    HAVING: 50,
    WINDOW: 60,
    ORDER: 70,
    LIMIT: 80,
    // MySQL only accepts `LIMIT n OFFSET m`; Postgres takes either order.
    OFFSET: engine === 'postgres' ? 80 : 85
  }
}

/** Set operators start a fresh query block, so the clause order restarts. */
const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT'])

function clauseLabel(key: string): string {
  return key === 'GROUP' || key === 'ORDER' ? `${key} BY` : key
}

/**
 * The clause a word introduces, or `undefined` if it isn't one here.
 *
 * `GROUP` and `ORDER` only introduce a clause when `BY` follows. Without it the
 * word is something else entirely — Postgres `CREATE GROUP` / `GRANT … TO
 * GROUP`, MySQL 8 `CREATE RESOURCE GROUP`, and the `WITHIN GROUP (ORDER BY …)`
 * of every ordered-set aggregate.
 */
function clauseRankAt(
  tokens: Token[],
  i: number,
  ranks: Record<string, number>
): number | undefined {
  const key = tokens[i].key
  const rank = ranks[key]
  if (rank === undefined) return undefined
  if (key === 'GROUP' || key === 'ORDER') {
    const next = tokens[i + 1]
    if (!next || next.kind !== 'word' || next.key !== 'BY') return undefined
  }
  return rank
}

/**
 * The rule that catches `… LIMIT 1000 ORDER BY x`. Each parenthesised group
 * gets its own scope, so a subquery's `LIMIT` never constrains the outer query
 * and an `OVER (PARTITION BY … ORDER BY …)` is judged on its own.
 */
function checkClauseOrder(
  tokens: Token[],
  ranks: Record<string, number>,
  out: SqlDiagnostic[]
): void {
  const scopes = [{ rank: 0, clause: '' }]

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind === 'punct') {
      if (token.text === '(') scopes.push({ rank: 0, clause: '' })
      else if (token.text === ')' && scopes.length > 1) scopes.pop()
      continue
    }
    if (token.kind !== 'word') continue

    const scope = scopes[scopes.length - 1]
    if (SET_OPERATORS.has(token.key)) {
      scope.rank = 0
      scope.clause = ''
      continue
    }

    const rank = clauseRankAt(tokens, i, ranks)
    if (rank === undefined) continue

    if (rank < scope.rank) {
      out.push({
        from: token.from,
        to: token.to,
        message: `${clauseLabel(token.key)} must come before ${clauseLabel(scope.clause)}`,
        incomplete: false
      })
    }
    // Adopt the new clause either way, so one misplaced keyword doesn't paint
    // every clause after it red as well.
    scope.rank = rank
    scope.clause = token.key
  }
}

/**
 * `ORDER` is reserved in both engines and always takes `BY`.
 *
 * `GROUP` is deliberately not checked, and neither is `PARTITION`: both appear
 * without `BY` in perfectly good SQL — see `clauseRankAt`, plus MySQL's
 * `FROM t PARTITION (p0)`.
 */
function checkOrderBy(tokens: Token[], out: SqlDiagnostic[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind !== 'word' || token.key !== 'ORDER') continue

    const next = tokens[i + 1]
    if (next && next.kind === 'word' && next.key === 'BY') continue
    out.push({
      from: token.from,
      to: token.to,
      message: 'Expected BY after ORDER',
      // Nothing but a part-word after it yet — that's `ORDER B`, still being
      // typed, rather than `ORDER a`.
      incomplete: i + 2 >= tokens.length
    })
  }
}

/** Clause keywords that can never follow a comma. */
const NOT_AFTER_COMMA = new Set([
  'FROM',
  'WHERE',
  'GROUP',
  'HAVING',
  'WINDOW',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'INTO'
])

/** Catches `SELECT a, FROM t`, `(a, , b)` and a list left hanging on a comma. */
function checkCommas(tokens: Token[], out: SqlDiagnostic[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind !== 'punct' || token.text !== ',') continue

    const prev = tokens[i - 1]
    const next = tokens[i + 1]
    const emptyBefore = !prev || (prev.kind === 'punct' && (prev.text === '(' || prev.text === ','))
    const emptyAfter =
      !next ||
      (next.kind === 'punct' && (next.text === ')' || next.text === ',')) ||
      (next.kind === 'word' && NOT_AFTER_COMMA.has(next.key))

    if (emptyBefore || emptyAfter) {
      out.push({ from: token.from, to: token.to, message: 'Unexpected comma', incomplete: !next })
    }
  }
}

/**
 * Words that can never be the last thing in a statement. Kept short on
 * purpose: `SET` (`SHOW CHARACTER SET`), `ALL` (`LIMIT ALL`), `UPDATE`
 * (`FOR UPDATE`) and `VALUES` (`DEFAULT VALUES`) all end valid statements.
 */
const DANGLING_WORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'HAVING',
  'WINDOW',
  'ORDER',
  'BY',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'USING',
  'AND',
  'OR',
  'NOT',
  'IS',
  'IN',
  'LIKE',
  'BETWEEN',
  'AS',
  'INTO',
  'DISTINCT',
  'UNION',
  'INTERSECT',
  'EXCEPT'
])

/**
 * Trailing operators. `*` is left out because `SELECT *` is a shape people
 * pause on constantly, and the brackets are the parenthesis rules' business.
 */
const DANGLING_PUNCT = new Set([
  ',',
  '.',
  '=',
  '<',
  '>',
  '+',
  '-',
  '/',
  '%',
  '<=',
  '>=',
  '<>',
  '!=',
  '<=>',
  '||',
  '&&',
  ':=',
  '::',
  '->',
  '->>'
])

function checkTail(tokens: Token[], out: SqlDiagnostic[]): void {
  const last = tokens[tokens.length - 1]
  if (!last) return

  const dangling =
    (last.kind === 'word' && DANGLING_WORDS.has(last.key)) ||
    (last.kind === 'punct' && DANGLING_PUNCT.has(last.text))
  if (!dangling) return

  out.push({
    from: last.from,
    to: last.to,
    message: `Incomplete statement — nothing follows '${last.text}'`,
    incomplete: true
  })
}

/**
 * Words a statement may begin with. Generous by design: an unknown opener is
 * only worth reporting because it catches plain typos like `SELCT`.
 */
const STATEMENT_STARTERS = new Set([
  // Queries and DML
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'WITH', 'TABLE', 'VALUES',
  // Introspection
  'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'ANALYZE', 'ANALYSE', 'CHECK', 'CHECKSUM', 'HELP',
  // DDL
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT', 'REINDEX', 'REFRESH', 'CLUSTER',
  // Transactions and session
  'START', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'SET', 'USE', 'XA', 'LOCK',
  'UNLOCK', 'DISCARD', 'RESET', 'CHECKPOINT',
  // Privileges
  'GRANT', 'REVOKE',
  // Admin and maintenance
  'FLUSH', 'KILL', 'OPTIMIZE', 'REPAIR', 'PURGE', 'BINLOG', 'CHANGE', 'STOP', 'RESTART',
  'SHUTDOWN', 'INSTALL', 'UNINSTALL', 'CACHE', 'CLONE', 'VACUUM', 'COPY', 'IMPORT', 'LISTEN',
  'UNLISTEN', 'NOTIFY', 'LOAD', 'HANDLER', 'REASSIGN', 'SECURITY', 'ABORT',
  // Routines and prepared statements
  'CALL', 'DO', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'DECLARE', 'FETCH', 'MOVE', 'CLOSE', 'OPEN',
  'RETURN', 'SIGNAL', 'RESIGNAL', 'GET'
])

/** Statement words that only ever appear inside a routine body. */
const CONTROL_FLOW = new Set([
  'BEGIN', 'END', 'DECLARE', 'IF', 'ELSE', 'ELSEIF', 'ELSIF', 'WHILE', 'LOOP', 'REPEAT', 'UNTIL',
  'CASE', 'WHEN', 'THEN', 'ITERATE', 'LEAVE', 'RETURN', 'SIGNAL', 'RESIGNAL', 'GET', 'FETCH',
  'OPEN', 'CLOSE', 'DELIMITER'
])

const ROUTINE_OBJECTS = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'])

/**
 * True for statements the structural rules must leave alone.
 *
 * A routine body holds its own semicolons, so `splitStatements` chops it into
 * fragments that mean nothing on their own — every one of them would light up
 * red. Rather than pretend to understand `DELIMITER`, the statement that
 * declares a routine, and the control-flow fragments it decays into, are
 * passed over.
 *
 * Deliberately narrow: an earlier version also skipped any statement
 * containing the word `BEGIN` anywhere, which is non-reserved in both engines
 * — so an ordinary column called `begin` quietly switched off every rule.
 */
function isRoutineFragment(tokens: Token[]): boolean {
  const first = tokens[0]
  if (!first || first.kind !== 'word') return false
  if (CONTROL_FLOW.has(first.key)) return true
  if (first.key === 'CREATE' || first.key === 'ALTER' || first.key === 'DROP') {
    return tokens.slice(0, 10).some((t) => t.kind === 'word' && ROUTINE_OBJECTS.has(t.key))
  }
  return false
}

function checkStarter(tokens: Token[], out: SqlDiagnostic[]): void {
  const first = tokens[0]
  if (!first) return
  // `(SELECT …) UNION (SELECT …)` opens on a bracket.
  if (first.kind === 'punct' && first.text === '(') return
  if (first.kind === 'word' && STATEMENT_STARTERS.has(first.key)) return

  out.push({
    from: first.from,
    to: first.to,
    message: `'${first.text}' does not start a SQL statement`,
    // On its own it's indistinguishable from a keyword halfway typed — `SEL`
    // becomes `SELECT` a keystroke later.
    incomplete: tokens.length === 1
  })
}

// ------------------------------------------------------------------- entry

/** A `DELIMITER` line means the `;` splitter is wrong about everything. */
const HAS_DELIMITER = /^[ \t]*DELIMITER\b/im

/**
 * Checks a whole editor buffer, statement by statement.
 *
 * `caret` suppresses the "incomplete" diagnostics for the statement being
 * edited: half-typed SQL is unfinished, not wrong, and marking it red on every
 * keystroke is what makes this kind of feature unbearable.
 */
export function lintSql(
  sql: string,
  engine: DbEngine,
  caret: number | null = null
): SqlDiagnostic[] {
  if (sql.length === 0 || sql.length > MAX_LINT_LENGTH) return []
  if (HAS_DELIMITER.test(sql)) return []

  const ranks = clauseRanks(engine)
  const found: SqlDiagnostic[] = []

  for (const statement of splitStatements(sql, engine)) {
    const editing = isBeingEdited(sql, statement, caret)
    for (const diagnostic of lintStatement(statement, ranks, engine)) {
      if (diagnostic.incomplete && editing) continue
      found.push(diagnostic)
    }
  }

  found.sort((a, b) => a.from - b.from || a.to - b.to)

  // One mark per range: a token can trip two rules, and stacked underlines
  // read as a heavier error rather than as two separate ones.
  const seen = new Set<string>()
  return found.filter((d) => {
    const key = `${d.from}:${d.to}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * True while the caret is still in this statement.
 *
 * `Statement.end` excludes trailing whitespace, so this has to look past it:
 * pressing Enter inside a `VALUES (…), ⏎` list leaves the caret two characters
 * beyond the statement, and treating that as "moved on" would flag the line
 * the moment you finish typing it — the exact noise this suppression exists to
 * prevent. A `;` does count as moving on: you've said the statement is done.
 */
function isBeingEdited(sql: string, statement: Statement, caret: number | null): boolean {
  if (caret === null || caret < statement.start) return false
  if (caret <= statement.end) return true
  return /^\s*$/.test(sql.slice(statement.end, caret))
}

function lintStatement(
  statement: Statement,
  ranks: Record<string, number>,
  engine: DbEngine
): SqlDiagnostic[] {
  const { tokens, errors, truncated } = lex(statement.text, statement.start, engine)
  // A runaway literal swallowed the rest of the text; nothing after it means
  // anything, so report that on its own.
  if (truncated || tokens.length === 0) return errors
  if (isRoutineFragment(tokens)) return errors

  const out = [...errors]
  checkStarter(tokens, out)
  checkClauseOrder(tokens, ranks, out)
  checkOrderBy(tokens, out)
  checkCommas(tokens, out)
  checkTail(tokens, out)
  return out
}
