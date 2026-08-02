import { useEffect, useMemo, useRef } from 'react'
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion
} from '@codemirror/autocomplete'
import { MySQL, sql } from '@codemirror/lang-sql'
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { statementAt } from '@shared/sql'

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
  readOnly?: boolean
  /** Background tint for the editor, from the connection's colour. */
  background?: string
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
      const statement = statementAt(doc.toString(), view.state.selection.main.head)
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
  readOnly = false,
  background
}: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const debounceRef = useRef<number | null>(null)
  const langCompartment = useRef(new Compartment())

  // Handlers are read through a ref so re-created callbacks never rebuild the view.
  const handlers = useRef({ onChange, onExecuteCurrent, onExecuteAll })
  handlers.current = { onChange, onExecuteCurrent, onExecuteAll }

  const languageExtension = useMemo(
    () =>
      sql({
        dialect: MySQL,
        schema: completionSchema,
        defaultSchema: defaultSchema ?? undefined,
        upperCaseKeywords: true
      }),
    [completionSchema, defaultSchema]
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
                handlers.current.onExecuteCurrent()
                return true
              }
            },
            {
              key: 'Ctrl-Shift-Enter',
              preventDefault: true,
              run: () => {
                flush()
                handlers.current.onExecuteAll()
                return true
              }
            },
            { key: 'Ctrl-Space', preventDefault: true, run: startCompletion },
            { key: 'Tab', run: acceptCompletion },
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
      getStatementAtCursor: () => {
        const text = view.state.doc.toString()
        return statementAt(text, view.state.selection.main.head)?.text ?? null
      },
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

  // The CodeMirror content is transparent (see styles.css), so tinting the host
  // shows through the editor without touching syntax colours.
  return (
    <div className="editor-host" ref={hostRef} style={background ? { background } : undefined} />
  )
}
