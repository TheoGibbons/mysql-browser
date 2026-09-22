import { useEffect, useMemo, useRef } from 'react'
import {
  Compartment,
  EditorState,
  Facet,
  RangeSet,
  RangeSetBuilder,
  StateField
} from '@codemirror/state'
import { StateEffect } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import {
  copyLineDown,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab
} from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion
} from '@codemirror/autocomplete'
import type { Completion, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { MySQL, PostgreSQL, sql } from '@codemirror/lang-sql'
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { referencedTables, statementAt } from '@shared/sql'
import type { Statement } from '@shared/sql'
import type { DbEngine, QueryFailure } from '@shared/types'
import { forEachDiagnostic, linter, lintKeymap } from '@codemirror/lint'
import type { Diagnostic } from '@codemirror/lint'
import { lintSql, type SqlDiagnostic } from '../lib/sqlLint'

/**
 * The connection's engine, carried in editor state so the statement-splitting
 * helpers below — which decide what actually gets executed — agree with the
 * server the text is headed for.
 */
const sqlEngine = Facet.define<DbEngine, DbEngine>({
  combine: (values) => values[0] ?? 'mysql'
})

export interface EditorApi {
  getSql(): string
  /** Selected text, or `null` when the selection is empty. */
  getSelection(): string | null
  /** The statement the caret sits in. */
  getStatementAtCursor(): string | null
  setSql(sql: string): void
  focus(): void
}

interface Props {
  tabId: string
  initialSql: string
  /** Fired on a debounce, plus immediately before executing. */
  onChange(sql: string): void
  onExecuteCurrent(): void
  onExecuteAll(): void
  apiRef: React.MutableRefObject<EditorApi | null>
  /** `schema -> table -> columns`, used for completion. */
  completionSchema: Record<string, Record<string, string[]>>
  defaultSchema: string | null
  /** Asked to fetch columns for a schema the statement mentions but that isn't cached. */
  onNeedSchemaColumns?(schema: string): void
  readOnly?: boolean
  /** Background tint for the editor, from the connection's colour. */
  background?: string
  /** Picks the grammar, the keyword set and the statement splitter. */
  engine: DbEngine
  /** The last failed run, marked in the editor with the server's own message. */
  failure?: QueryFailure | null
}

interface CompletionContextData {
  schema: Record<string, Record<string, string[]>>
  defaultSchema: string | null
  onNeedSchemaColumns?(schema: string): void
}

/** Case-insensitive lookup, since MySQL identifier casing varies by platform. */
function lookup<T>(map: Record<string, T>, name: string): T | undefined {
  const direct = map[name]
  if (direct !== undefined) return direct
  const lower = name.toLowerCase()
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lower) return map[key]
  }
  return undefined
}

/**
 * Completes the columns of the tables in the current statement's FROM/JOIN
 * clauses. `@codemirror/lang-sql` only offers columns behind a dotted prefix
 * (`t.col`), so an unqualified `where <caret>` would otherwise see nothing but
 * schema names and keywords.
 */
function fromClauseCompletions(
  dataRef: React.MutableRefObject<CompletionContextData>
): CompletionSource {
  return (context): CompletionResult | null => {
    const word = context.matchBefore(/[\w$]*/)
    if (!word) return null
    if (word.from === word.to && !context.explicit) return null

    // Qualified and quoted paths are lang-sql's job.
    const prev = context.state.sliceDoc(Math.max(0, word.from - 1), word.from)
    if (prev === '.' || prev === '`' || prev === '"') return null

    const { schema, defaultSchema, onNeedSchemaColumns } = dataRef.current
    const statement = statementAt(
      context.state.doc.toString(),
      context.pos,
      context.state.facet(sqlEngine)
    )
    if (!statement) return null

    const options: Completion[] = []
    const seen = new Set<string>()

    for (const ref of referencedTables(statement.text)) {
      const schemaName = ref.schema ?? defaultSchema
      if (!schemaName) continue

      const tables = lookup(schema, schemaName)
      if (!tables) continue

      const columns = lookup(tables, ref.table)
      if (!columns) continue
      if (columns.length === 0) {
        // Known table, columns not fetched yet — pull them in for next time.
        onNeedSchemaColumns?.(schemaName)
        continue
      }

      if (ref.alias && !seen.has(ref.alias)) {
        seen.add(ref.alias)
        options.push({ label: ref.alias, type: 'constant', detail: ref.table, boost: 2 })
      }
      for (const column of columns) {
        if (seen.has(column)) continue
        seen.add(column)
        options.push({
          label: column,
          type: 'property',
          detail: ref.alias ?? ref.table,
          boost: 1
        })
      }
    }

    if (options.length === 0) return null
    return { from: word.from, options, validFor: /^[\w$]*$/ }
  }
}

/** Workbench-like SQL colours. */
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#0033b3', fontWeight: '600' },
  { tag: tags.operatorKeyword, color: '#0033b3', fontWeight: '600' },
  { tag: tags.string, color: '#c41a16' },
  { tag: tags.special(tags.string), color: '#c41a16' },
  { tag: tags.number, color: '#1750eb' },
  { tag: tags.bool, color: '#0033b3', fontWeight: '600' },
  { tag: tags.null, color: '#0033b3', fontWeight: '600' },
  { tag: tags.comment, color: '#8c8c8c', fontStyle: 'italic' },
  { tag: tags.lineComment, color: '#8c8c8c', fontStyle: 'italic' },
  { tag: tags.variableName, color: '#1b1b1b' },
  { tag: tags.typeName, color: '#008a55' },
  { tag: tags.function(tags.variableName), color: '#7a3e9d' },
  { tag: tags.punctuation, color: '#555555' },
  { tag: tags.bracket, color: '#555555' },
  { tag: tags.quote, color: '#008a55' }
])

/**
 * Runs `compute`, or gives up quietly.
 *
 * Unlike a `ViewPlugin`, which CodeMirror wraps in its own try/catch, an
 * exception thrown out of a `StateField` update escapes `state.update()` and
 * takes the editor with it — the user stops being able to type. A bug in the
 * statement splitter must cost the markers, never the editing.
 */
function attempt<T>(compute: () => T, fallback: T): T {
  try {
    return compute()
  } catch (error) {
    console.error('SQL analysis failed', error)
    return fallback
  }
}

function findCaretStatement(state: EditorState): Statement | null {
  return attempt(
    () => statementAt(state.doc.toString(), state.selection.main.head, state.facet(sqlEngine)),
    null
  )
}

/**
 * The statement the caret sits in. Kept in state so
 * the shading, the gutter dot and the editor API all name the same statement
 * from one document scan.
 *
 * Only recomputed when the caret actually leaves the statement, so arrowing
 * around inside one costs nothing.
 */
const caretStatement = StateField.define<Statement | null>({
  create: (state) => findCaretStatement(state),
  update: (value, tr) => {
    if (tr.docChanged) return findCaretStatement(tr.state)

    const caret = tr.state.selection.main.head
    if (caret === tr.startState.selection.main.head) return value
    if (value && caret >= value.start && caret <= value.end + 1) return value
    return findCaretStatement(tr.state)
  }
})

/**
 * The last failed run, held in editor state so it can be marked alongside the
 * local rules. Set from outside via `setQueryFailure`; the next edit clears it,
 * since the text the server complained about no longer exists.
 */
const setQueryFailure = StateEffect.define<QueryFailure | null>()

const queryFailure = StateField.define<QueryFailure | null>({
  create: () => null,
  update: (value, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(setQueryFailure)) return effect.value
    }
    return tr.docChanged ? null : value
  }
})

/**
 * Turns the server's verdict into a diagnostic.
 *
 * The statement is located by its text rather than by a stored offset, which
 * keeps this honest across every way a query can be launched — whole buffer,
 * selection, or the statement at the caret. If the text isn't there any more,
 * nothing is marked.
 */
function serverDiagnostic(state: EditorState): Diagnostic | null {
  const failure = state.field(queryFailure)
  if (!failure) return null

  const doc = state.doc.toString()
  const at = doc.indexOf(failure.statement.trim())
  if (at < 0) return null

  const statementEnd = at + failure.statement.trim().length
  // Without an offset the server still told us *which* statement broke, so
  // mark the whole thing rather than nothing.
  if (failure.position === null) {
    return {
      from: at,
      to: statementEnd,
      severity: 'error',
      source: 'server',
      message: failure.message,
      markClass: 'cm-sql-error'
    }
  }

  const from = Math.min(at + failure.position - 1, statementEnd - 1)
  // Underline to the end of the word the server pointed at, so there's
  // something to see and to hover.
  const word = /^[\w$`'".]+/.exec(doc.slice(from, statementEnd))
  return {
    from,
    to: Math.min(from + (word ? word[0].length : 1), statementEnd),
    severity: 'error',
    source: 'server',
    message: failure.message,
    markClass: 'cm-sql-error'
  }
}

/**
 * The syntax check, run through `@codemirror/lint` so the diagnostics come
 * with hover tooltips, a problems panel and F8 navigation, and so they're
 * computed off the transaction path — a linter crash can't wedge the editor.
 *
 * The server's own error is folded in here rather than drawn separately, so
 * both kinds of problem share one gutter, one tooltip and one panel.
 */
const sqlLinter = linter(
  (view) => {
    const { state } = view
    const found = attempt(
      () => lintSql(state.doc.toString(), state.facet(sqlEngine), state.selection.main.head),
      [] as readonly SqlDiagnostic[]
    )
    const limit = state.doc.length
    const diagnostics: Diagnostic[] = found.map((d) => ({
      from: Math.min(d.from, limit),
      to: Math.min(d.to, limit),
      severity: 'error' as const,
      source: 'sql',
      message: d.message,
      // Our own squiggle, drawn with `text-decoration` rather than lint's
      // background image so it survives line wrapping.
      markClass: 'cm-sql-error'
    }))

    const fromServer = attempt(() => serverDiagnostic(state), null)
    if (fromServer) diagnostics.push(fromServer)

    return diagnostics.sort((a, b) => a.from - b.from || a.to - b.to)
  },
  {
    delay: 300,
    // Which "unfinished" complaints are hushed depends on the statement the
    // caret is in, so a move between statements needs a fresh pass — a move
    // within one does not. A new server verdict always needs one.
    needsRefresh: (update) => {
      if (update.startState.field(queryFailure) !== update.state.field(queryFailure)) return true
      const before = update.startState.field(caretStatement)
      const after = update.state.field(caretStatement)
      return before?.start !== after?.start || before?.end !== after?.end
    }
  }
)

/** Shades the statement the caret is inside, like Workbench's current-statement marker. */
const currentStatementHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.build(update.view)
      }
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>()
      const doc = view.state.doc
      const statement = view.state.field(caretStatement)
      if (!statement) return builder.finish()

      const fromLine = doc.lineAt(Math.min(statement.start, doc.length)).number
      const toLine = doc.lineAt(Math.min(statement.end, doc.length)).number
      const decoration = Decoration.line({ class: 'cm-current-statement' })

      for (let n = fromLine; n <= toLine; n++) {
        builder.add(doc.line(n).from, doc.line(n).from, decoration)
      }
      return builder.finish()
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

class ErrorMarker extends GutterMarker {
  constructor(readonly message: string) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof ErrorMarker && other.message === this.message
  }

  toDOM(): Node {
    const box = document.createElement('span')
    box.className = 'cm-lint-error'
    box.textContent = '×'
    box.title = this.message
    return box
  }
}

/** Workbench's blue dot: the statement at the caret. */
class CaretStatementMarker extends GutterMarker {
  eq(other: GutterMarker): boolean {
    return other instanceof CaretStatementMarker
  }

  toDOM(): Node {
    const dot = document.createElement('span')
    dot.className = 'cm-statement-marker'
    dot.title = 'Statement at the cursor'
    return dot
  }
}

const caretStatementMarker = new CaretStatementMarker()

/**
 * The strip between the line numbers and the text: a red cross on any line
 * carrying a problem, otherwise a dot beside the statement being edited. The
 * cross wins, so a broken current statement reads as broken.
 */
const statusGutter = gutter({
  class: 'cm-status-gutter',
  markers: (view) => {
    const { state } = view
    const doc = state.doc

    // Several problems can land on one line; the marker's tooltip lists them all.
    const byLine = new Map<number, string[]>()
    forEachDiagnostic(state, (diagnostic, from) => {
      const line = doc.lineAt(Math.min(from, doc.length))
      const messages = byLine.get(line.from)
      if (messages) messages.push(diagnostic.message)
      else byLine.set(line.from, [diagnostic.message])
    })

    const markers: Range<GutterMarker>[] = []
    for (const [at, messages] of byLine) {
      markers.push(new ErrorMarker(messages.join('\n')).range(at))
    }

    const statement = state.field(caretStatement)
    if (statement) {
      const at = doc.lineAt(Math.min(statement.start, doc.length)).from
      if (!byLine.has(at)) markers.push(caretStatementMarker.range(at))
    }

    return RangeSet.of(markers, true)
  }
})

const DEBOUNCE_MS = 300

export function QueryEditor({
  tabId,
  initialSql,
  onChange,
  onExecuteCurrent,
  onExecuteAll,
  apiRef,
  completionSchema,
  defaultSchema,
  onNeedSchemaColumns,
  readOnly = false,
  background,
  engine,
  failure
}: Props): JSX.Element {
  const sqlDialect = engine === 'postgres' ? PostgreSQL : MySQL
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const debounceRef = useRef<number | null>(null)
  const langCompartment = useRef(new Compartment())

  // Handlers are read through a ref so re-created callbacks never rebuild the view.
  const handlers = useRef({ onChange, onExecuteCurrent, onExecuteAll })
  handlers.current = { onChange, onExecuteCurrent, onExecuteAll }

  // The completion source reads the latest schema through a ref, so a growing
  // column cache never has to reconfigure the editor.
  const completionData = useRef<CompletionContextData>({
    schema: completionSchema,
    defaultSchema,
    onNeedSchemaColumns
  })
  completionData.current = { schema: completionSchema, defaultSchema, onNeedSchemaColumns }

  const languageExtension = useMemo(
    () =>
      sql({
        dialect: sqlDialect,
        schema: completionSchema,
        defaultSchema: defaultSchema ?? undefined,
        upperCaseKeywords: true
      }),
    [completionSchema, defaultSchema, sqlDialect]
  )

  // One editor instance per tab; `tabId` in the dependency list remounts it.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const flush = (): void => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      const view = viewRef.current
      if (view) handlers.current.onChange(view.state.doc.toString())
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: initialSql,
        extensions: [
          lineNumbers(),
          caretStatement,
          queryFailure,
          sqlLinter,
          // After `lineNumbers` so the markers sit between the numbers and the
          // text, the way Workbench arranges them.
          statusGutter,
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          rectangularSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          autocompletion({ activateOnTyping: true, maxRenderedOptions: 40 }),
          sqlEngine.of(engine),
          sqlDialect.language.data.of({ autocomplete: fromClauseCompletions(completionData) }),
          syntaxHighlighting(highlightStyle),
          currentStatementHighlight,
          langCompartment.current.of(languageExtension),
          EditorState.readOnly.of(readOnly),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: 'Ctrl-Enter',
              preventDefault: true,
              run: () => {
                flush()
                handlers.current.onExecuteAll()
                return true
              }
            },
            {
              key: 'Ctrl-Shift-Enter',
              preventDefault: true,
              run: () => {
                flush()
                handlers.current.onExecuteCurrent()
                return true
              }
            },
            { key: 'Ctrl-Space', preventDefault: true, run: startCompletion },
            { key: 'Ctrl-d', preventDefault: true, run: copyLineDown },
            { key: 'Tab', run: acceptCompletion },
            ...lintKeymap,
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
            debounceRef.current = window.setTimeout(() => {
              debounceRef.current = null
              handlers.current.onChange(update.state.doc.toString())
            }, DEBOUNCE_MS)
          }),
          EditorView.domEventHandlers({
            blur: () => {
              flush()
              return false
            }
          })
        ]
      }),
      parent: host
    })

    viewRef.current = view

    apiRef.current = {
      getSql: () => view.state.doc.toString(),
      getSelection: () => {
        const { from, to } = view.state.selection.main
        if (from === to) return null
        return view.state.sliceDoc(from, to)
      },
      getStatementAtCursor: () => view.state.field(caretStatement)?.text ?? null,
      setSql: (next: string) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next }
        })
        handlers.current.onChange(next)
      },
      focus: () => view.focus()
    }

    view.focus()

    return () => {
      flush()
      apiRef.current = null
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  // Swap the language config in place when the schema cache grows.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: langCompartment.current.reconfigure(languageExtension) })
  }, [languageExtension])

  // Push the server's verdict on the last run into editor state, where the
  // linter folds it in with the local rules.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: setQueryFailure.of(failure ?? null) })
  }, [failure])

  // The CodeMirror content is transparent (see styles.css), so tinting the host
  // shows through the editor without touching syntax colours.
  return (
    <div className="editor-host" ref={hostRef} style={background ? { background } : undefined} />
  )
}
