import { useEffect, useMemo, useState } from 'react'
import type { PgDumpFormat, QueryTabState, TransferState } from '@shared/types'
import { TOOL_SETTING_KEYS } from '@shared/types'
import {
  baseNameOf,
  buildCommand,
  defaultTransferState,
  dirNameOf,
  dumpFileName,
  outputPathOf,
  seedSelection,
  toolFor,
  toolPathFor,
  transferBlockedReason,
  type BuildContext,
  type TransferKind
} from '@shared/transfer'
import { runKey, useAppStore, useTransferStore, type ConnTab } from '../store'
import { ConfirmModifyModal } from './ConfirmModifyModal'
import { TransferObjects } from './TransferObjects'
import { TransferRunner } from './TransferRunner'

interface Props {
  conn: ConnTab
  tab: QueryTabState
}

// ---------------------------------------------------------------------------
// Small form pieces, dense enough to match the rest of the app
// ---------------------------------------------------------------------------

function Check({
  label,
  checked,
  onChange,
  disabled,
  hint
}: {
  label: string
  checked: boolean
  onChange(next: boolean): void
  disabled?: boolean
  hint?: string
}): JSX.Element {
  return (
    <label className={`checkline transfer-check${disabled ? ' disabled' : ''}`} title={hint}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="transfer-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

const CHARSETS = ['utf8mb4', 'utf8', 'latin1', 'binary']

/** PostgreSQL changed major-version numbering from `9.6` to `10`. */
function postgresMajor(version?: string): { label: string; order: number } | null {
  const match = version?.match(/\b(\d+)(?:\.(\d+))?\b/)
  if (!match) return null
  const first = Number(match[1])
  const second = Number(match[2] ?? 0)
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null
  return first >= 10
    ? { label: String(first), order: first * 100 }
    : { label: `${first}.${second}`, order: first * 100 + second }
}

// ---------------------------------------------------------------------------

/**
 * Data Export / Data Import. The options build a command line, the command line
 * is what runs, and the user can edit it — so anything the options cannot
 * express is still one keystroke away rather than a missing feature.
 */
export function ExportImportTab({ conn, tab }: Props): JSX.Element {
  const kind: TransferKind = tab.kind === 'import' ? 'import' : 'export'
  const config = conn.config
  const engine = config.engine
  const isExport = kind === 'export'
  const windows = window.api.platform === 'win32'

  const toolSettings = useAppStore((s) => s.toolSettings)
  const setToolSettings = useAppStore((s) => s.setToolSettings)
  const updateTab = useAppStore((s) => s.updateTab)
  const pushHistory = useAppStore((s) => s.pushHistory)
  const refreshSchemas = useAppStore((s) => s.refreshSchemas)
  const setLayout = useAppStore((s) => s.setLayout)
  const persistMeta = useAppStore((s) => s.persistMeta)

  const runId = runKey(conn.sessionId, tab.id)
  const run = useTransferStore((s) => s.runs[runId])
  const running = run?.status === 'running'
  /** Set when Start needs an answer first: an import, or an overwrite. */
  const [confirming, setConfirming] = useState<'import' | 'overwrite' | null>(null)
  const [pgDumpVersion, setPgDumpVersion] = useState('')

  // A tab saved before this feature existed has no transfer state. Building the
  // fallback once matters: rebuilding it every render would reset the tab's
  // timestamped file name as the user typed.
  const fallback = useMemo(
    () =>
      defaultTransferState({
        kind,
        config,
        settings: toolSettings,
        activeSchema: conn.activeSchema,
        schemas: conn.schemas
      }),
    []
  )
  const stored = tab.transfer ?? fallback

  const tool = toolFor(kind, engine, stored.pgArchive)
  // A tool path detected after the tab was created should still show up.
  const state: TransferState = {
    ...stored,
    toolPath: stored.toolPath || toolPathFor(toolSettings, tool),
    outputDir: stored.outputDir || toolSettings.exportDirectory
  }

  const patch = (next: Partial<TransferState>): void => {
    updateTab(conn.sessionId, tab.id, { transfer: { ...state, ...next } })
  }

  useEffect(() => {
    if (!tab.transfer) updateTab(conn.sessionId, tab.id, { transfer: state })
  }, [])

  // The tab can be opened in the moment between connecting and the schema list
  // arriving, which would otherwise leave an export with nothing ticked and no
  // way to tell that from a deliberately empty selection.
  useEffect(() => {
    if (state.seeded || !isExport || conn.schemas.length === 0) return
    patch({
      seeded: true,
      selection: seedSelection(engine, conn.schemas, conn.activeSchema ?? config.defaultSchema)
    })
  }, [conn.schemas, state.seeded])

  const ctx: BuildContext = { kind, config, state, schemas: conn.schemas, windows }
  const generated = buildCommand(ctx)
  const command = state.command || generated
  const blockedReason = running ? 'A run is already in progress.' : transferBlockedReason(ctx)
  const outputPath = outputPathOf(state, windows)

  // A newer pg_dump can read an older server, but the resulting SQL is not
  // guaranteed to load back into that server. Probe the actual selected binary
  // instead of guessing from its path.
  useEffect(() => {
    if (!(isExport && engine === 'postgres' && state.toolPath && conn.serverVersion)) {
      setPgDumpVersion('')
      return
    }
    let current = true
    setPgDumpVersion('')
    void window.api.tools
      .version(state.toolPath)
      .then((version) => {
        if (current) setPgDumpVersion(version)
      })
      // Version detection is advisory; a missing or unusual executable will
      // still report its normal error if the user tries to run it.
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [isExport, engine, state.toolPath, conn.serverVersion])

  const pgDumpMajor = postgresMajor(pgDumpVersion)
  const pgServerMajor = postgresMajor(conn.serverVersion)
  const pgVersionWarning =
    pgDumpMajor !== null && pgServerMajor !== null && pgDumpMajor.order > pgServerMajor.order

  /**
   * Back to the defaults, keeping the things that are not really settings: where
   * the tool is, where the file goes or comes from, and what the user ticked. A
   * hand-edited command goes, since the point is to see the defaults again.
   */
  const resetDefaults = (): void => {
    const fresh = defaultTransferState({
      kind,
      config,
      settings: toolSettings,
      activeSchema: conn.activeSchema,
      schemas: conn.schemas
    })
    patch({
      ...fresh,
      toolPath: state.toolPath,
      outputDir: state.outputDir,
      // The suffix belongs to the format, so a format that changed takes the
      // file name with it.
      outputName:
        fresh.pgFormat === state.pgFormat
          ? state.outputName
          : dumpFileName(config.name, engine, fresh.pgFormat),
      inputPath: state.inputPath,
      targetSchema: state.targetSchema,
      selection: state.selection,
      seeded: state.seeded,
      command: ''
    })
  }

  // --- destination / source pickers ---------------------------------------

  const pickTool = async (): Promise<void> => {
    const chosen = await window.api.dialog.openFile(
      `Path to ${tool}`,
      [
        { name: `${tool}${windows ? '.exe' : ''}`, extensions: windows ? ['exe'] : ['*'] },
        { name: 'All files', extensions: ['*'] }
      ],
      state.toolPath || undefined
    )
    if (!chosen) return
    patch({ toolPath: chosen })
    void setToolSettings({ [TOOL_SETTING_KEYS[tool]]: chosen })
  }

  const pickOutputDir = async (): Promise<void> => {
    const chosen = await window.api.dialog.openDirectory(
      'Export to directory',
      state.outputDir || undefined
    )
    if (!chosen) return
    // The generated file name is always re-appended, with a fresh timestamp.
    patch({ outputDir: chosen, outputName: dumpFileName(config.name, engine, state.pgFormat) })
    void setToolSettings({ exportDirectory: chosen })
  }

  const pickInput = async (): Promise<void> => {
    const chosen = await window.api.dialog.openFile(
      'Import from file',
      [
        { name: 'Dump files', extensions: ['sql', 'dump', 'tar', 'backup'] },
        { name: 'All files', extensions: ['*'] }
      ],
      state.inputPath || toolSettings.importDirectory || undefined
    )
    if (!chosen) return
    const archive = !/\.sql$/i.test(chosen)
    patch({
      inputPath: chosen,
      // A .dump/.tar can only be read by pg_restore, and a .sql only by psql.
      ...(engine === 'postgres'
        ? {
            pgArchive: archive,
            toolPath: toolPathFor(toolSettings, toolFor('import', 'postgres', archive))
          }
        : {})
    })
    void setToolSettings({ importDirectory: dirNameOf(chosen) })
  }

  // --- running -------------------------------------------------------------

  /**
   * Start, once anything that needs asking has been asked: an import runs
   * modifying SQL, and an export overwrites whatever is already at its path.
   */
  const requestStart = async (): Promise<void> => {
    if (!isExport) {
      setConfirming('import')
      return
    }
    if (await window.api.files.exists(outputPath)) {
      setConfirming('overwrite')
      return
    }
    await startRun()
  }

  const startRun = async (): Promise<void> => {
    setConfirming(null)
    const startedAt = Date.now()

    // Remember where this run happened so the next tab opens in the same place.
    void setToolSettings({
      [TOOL_SETTING_KEYS[tool]]: state.toolPath,
      ...(isExport
        ? { exportDirectory: state.outputDir }
        : { importDirectory: dirNameOf(state.inputPath) })
    })

    const historyId = pushHistory(conn.sessionId, {
      status: 'running',
      startedAt,
      action: `Data ${isExport ? 'export' : 'import'}: ${
        isExport ? state.outputName : baseNameOf(state.inputPath)
      }`,
      message: 'Running…',
      durationMs: null,
      fetchMs: null
    })

    const store = useTransferStore.getState()
    store.begin(runId, {
      command,
      outputPath: isExport ? outputPath : '',
      startedAt,
      historyId
    })

    try {
      await window.api.tools.run(runId, config, {
        command,
        outputPath: isExport ? outputPath : undefined
      })
    } catch (err) {
      // The run never started (or the bridge failed) — close it off here, since
      // no exit event is coming.
      store.apply({ runId, type: 'output', stream: 'err', text: `${(err as Error).message}\n` })
      store.apply({
        runId,
        type: 'exit',
        code: null,
        signal: null,
        cancelled: false,
        bytes: 0,
        durationMs: Date.now() - startedAt
      })
    }
  }

  // --- options -------------------------------------------------------------

  const contentsSelect = (
    <Field label={isExport ? 'Dump:' : 'Apply:'}>
      <select
        className="field"
        value={state.contents}
        disabled={running}
        onChange={(e) => patch({ contents: e.target.value as TransferState['contents'] })}
      >
        <option value="structure-and-data">Dump Structure and Data</option>
        <option value="data-only">Dump Data Only</option>
        <option value="structure-only">Dump Structure Only</option>
      </select>
    </Field>
  )

  const destination = (
    <fieldset className="group transfer-wide">
      <legend>Export to</legend>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="field"
          style={{ flex: 1 }}
          spellCheck={false}
          value={outputPath}
          disabled={running}
          onChange={(e) =>
            patch({ outputDir: dirNameOf(e.target.value), outputName: baseNameOf(e.target.value) })
          }
        />
        <button className="btn" style={{ minWidth: 34 }} disabled={running} onClick={pickOutputDir}>
          …
        </button>
        <button
          className="btn"
          style={{ minWidth: 34 }}
          disabled={running}
          title="Rebuild the file name with the current time"
          onClick={() => patch({ outputName: dumpFileName(config.name, engine, state.pgFormat) })}
        >
          ↻
        </button>
      </div>
    </fieldset>
  )

  const source = (
    <fieldset className="group transfer-wide">
      <legend>Import from</legend>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="field"
          style={{ flex: 1 }}
          spellCheck={false}
          placeholder="Path to a dump file"
          value={state.inputPath}
          disabled={running}
          onChange={(e) => patch({ inputPath: e.target.value })}
        />
        <button className="btn" style={{ minWidth: 34 }} disabled={running} onClick={pickInput}>
          …
        </button>
      </div>
    </fieldset>
  )

  const toolRow = (
    <fieldset className="group transfer-wide">
      <legend>Path to {tool}</legend>
      <div className="row" style={{ gap: 6 }}>
        <input
          className={`field${state.toolPath ? '' : ' invalid'}`}
          style={{ flex: 1 }}
          spellCheck={false}
          placeholder={`Full path to ${tool}${windows ? '.exe' : ''}`}
          value={state.toolPath}
          disabled={running}
          onChange={(e) => patch({ toolPath: e.target.value })}
          onBlur={() => void setToolSettings({ [TOOL_SETTING_KEYS[tool]]: state.toolPath })}
        />
        <button className="btn" style={{ minWidth: 34 }} disabled={running} onClick={pickTool}>
          …
        </button>
      </div>
    </fieldset>
  )

  const mysqlExportOptions = (
    <>
      <fieldset className="group">
        <legend>What to dump</legend>
        {contentsSelect}
        <Check
          label="Include Create Schema"
          checked={state.includeCreateSchema}
          disabled={running}
          onChange={(v) => patch({ includeCreateSchema: v })}
          hint="Adds CREATE DATABASE / USE to the dump (--databases)"
        />
        <Check
          label="Create Dump in a Single Transaction"
          checked={state.singleTransaction}
          disabled={running}
          onChange={(v) => patch({ singleTransaction: v })}
          hint="--single-transaction=TRUE — a consistent snapshot on InnoDB, without locking"
        />
      </fieldset>

      <fieldset className="group">
        <legend>Objects to Export</legend>
        <Check
          label="Dump Stored Procedures and Functions"
          checked={state.routines}
          disabled={running}
          onChange={(v) => patch({ routines: v })}
          hint="--routines"
        />
        <Check
          label="Dump Events"
          checked={state.events}
          disabled={running}
          onChange={(v) => patch({ events: v })}
          hint="--events"
        />
        <Check
          label="Dump Triggers"
          checked={state.triggers}
          disabled={running}
          onChange={(v) => patch({ triggers: v })}
          hint="mysqldump includes triggers unless --skip-triggers is given"
        />
      </fieldset>

      <fieldset className="group">
        <legend>Advanced</legend>
        <Field label="Character set:">
          <select
            className="field"
            value={state.charset}
            disabled={running}
            onChange={(e) => patch({ charset: e.target.value })}
          >
            {CHARSETS.map((cs) => (
              <option key={cs} value={cs}>
                {cs}
              </option>
            ))}
          </select>
        </Field>
        <Check
          label="Skip column statistics"
          checked={state.skipColumnStatistics}
          disabled={running}
          onChange={(v) => patch({ skipColumnStatistics: v })}
          hint="--column-statistics=FALSE — required when an 8.0 client dumps a 5.7 server"
        />
        <Check
          label="Dump binary columns as hex"
          checked={state.hexBlob}
          disabled={running}
          onChange={(v) => patch({ hexBlob: v })}
          hint="--hex-blob"
        />
        <Check
          label="Name every column in INSERTs"
          checked={state.completeInsert}
          disabled={running}
          onChange={(v) => patch({ completeInsert: v })}
          hint="--complete-insert"
        />
        <Check
          label="One INSERT per row"
          checked={state.skipExtendedInsert}
          disabled={running}
          onChange={(v) => patch({ skipExtendedInsert: v })}
          hint="--skip-extended-insert — bigger and slower, but far easier to diff"
        />
        <Check
          label="Do not set GTID_PURGED"
          checked={state.gtidPurgedOff}
          disabled={running}
          onChange={(v) => patch({ gtidPurgedOff: v })}
          hint="--set-gtid-purged=OFF — without this, a dump from a GTID-enabled server will not load into a server that has run transactions of its own"
        />
      </fieldset>
    </>
  )

  const pgExportOptions = (
    <>
      <fieldset className="group">
        <legend>What to dump</legend>
        {contentsSelect}
        <Field label="Rows as:">
          <select
            className="field"
            value={state.pgInserts}
            disabled={running}
            onChange={(e) => patch({ pgInserts: e.target.value as TransferState['pgInserts'] })}
          >
            <option value="copy">Copy</option>
            <option value="inserts">Insert</option>
            <option value="column-inserts">Insert with columns</option>
          </select>
        </Field>
        <Field label="Format:">
          <select
            className="field"
            value={state.pgFormat}
            disabled={running}
            onChange={(e) => {
              const pgFormat = e.target.value as PgDumpFormat
              // The suffix belongs to the format, so the name is rebuilt with it.
              patch({ pgFormat, outputName: dumpFileName(config.name, engine, pgFormat) })
            }}
          >
            <option value="p">File</option>
            <option value="d">Directory</option>
            <option value="c">Custom-format archive</option>
            <option value="t">Tar archive</option>
          </select>
        </Field>
      </fieldset>

      <fieldset className="group">
        <legend>Statements</legend>
        <Check
          label="Add DROP before CREATE"
          checked={state.pgClean}
          disabled={running || state.contents === 'data-only'}
          onChange={(v) => patch({ pgClean: v })}
          hint="--clean"
        />
        <Check
          label="Use DROP … IF EXISTS before CREATE"
          checked={state.pgIfExists}
          disabled={running || state.contents === 'data-only' || !state.pgClean}
          onChange={(v) => patch({ pgIfExists: v })}
          hint="--if-exists, which pg_dump only accepts alongside --clean"
        />
        <Check
          label="Add CREATE DATABASE and reconnect to it"
          checked={state.pgCreate}
          disabled={running || state.contents === 'data-only'}
          onChange={(v) => patch({ pgCreate: v })}
          hint="--create"
        />
        {state.contents === 'data-only' && (
          <div className="prefs-hint" style={{ margin: '4px 0 0' }}>
            pg_dump refuses these alongside <code>--data-only</code>.
          </div>
        )}
      </fieldset>

      <fieldset className="group">
        <legend>Advanced</legend>
        <Check
          label="Skip ownership"
          checked={state.pgNoOwner}
          disabled={running}
          onChange={(v) => patch({ pgNoOwner: v })}
          hint="--no-owner — restore everything as whoever runs the restore"
        />
        <Check
          label="Skip grants"
          checked={state.pgNoPrivileges}
          disabled={running}
          onChange={(v) => patch({ pgNoPrivileges: v })}
          hint="--no-privileges"
        />
        <Check
          label="Report progress per object"
          checked={state.pgVerbose}
          disabled={running}
          onChange={(v) => patch({ pgVerbose: v })}
          hint="--verbose — pg_dump's running commentary, shown in the log below"
        />
      </fieldset>
    </>
  )

  const schemaOptions = conn.schemas.map((s) => s.name)

  const mysqlImportOptions = (
    <>
      <fieldset className="group">
        <legend>Target</legend>
        <Field label="Default schema:">
          <select
            className="field"
            value={state.targetSchema}
            disabled={running}
            onChange={(e) => patch({ targetSchema: e.target.value })}
          >
            <option value="">Use the schema named in the dump</option>
            {schemaOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <div className="prefs-hint" style={{ margin: '4px 0 0' }}>
          A dump written with <em>Include Create Schema</em> chooses its own schema and needs no
          target here.
        </div>
      </fieldset>

      <fieldset className="group">
        <legend>Options</legend>
        <Field label="Character set:">
          <select
            className="field"
            value={state.charset}
            disabled={running}
            onChange={(e) => patch({ charset: e.target.value })}
          >
            {CHARSETS.map((cs) => (
              <option key={cs} value={cs}>
                {cs}
              </option>
            ))}
          </select>
        </Field>
        <Check
          label="Continue after an error"
          checked={state.force}
          disabled={running}
          onChange={(v) => patch({ force: v })}
          hint="--force"
        />
      </fieldset>
    </>
  )

  const pgImportOptions = (
    <>
      <fieldset className="group">
        <legend>Target</legend>
        <Field label="Database:">
          <input
            className="field"
            spellCheck={false}
            placeholder={config.database || 'database'}
            value={state.targetSchema}
            disabled={running}
            onChange={(e) => patch({ targetSchema: e.target.value })}
          />
        </Field>
        <Field label="Restore with:">
          <select
            className="field"
            value={state.pgArchive ? 'pg_restore' : 'psql'}
            disabled={running}
            onChange={(e) => {
              const pgArchive = e.target.value === 'pg_restore'
              patch({
                pgArchive,
                toolPath: toolPathFor(toolSettings, toolFor('import', 'postgres', pgArchive))
              })
            }}
          >
            <option value="psql">psql — plain SQL dump</option>
            <option value="pg_restore">pg_restore — custom, tar or directory archive</option>
          </select>
        </Field>
      </fieldset>

      <fieldset className="group">
        <legend>Options</legend>
        <Check
          label="Stop at the first error"
          checked={state.pgStopOnError}
          disabled={running || state.pgArchive}
          onChange={(v) => patch({ pgStopOnError: v })}
          hint="ON_ERROR_STOP=on"
        />
        <Check
          label="Wrap the restore in one transaction"
          checked={state.pgSingleTransaction}
          disabled={running}
          onChange={(v) => patch({ pgSingleTransaction: v })}
          hint="--single-transaction — all of it lands, or none; turn off for dumps that create a database"
        />
        <Check
          label="Drop objects before creating them"
          checked={state.pgClean}
          disabled={running || !state.pgArchive}
          onChange={(v) => patch({ pgClean: v })}
          hint="--clean (pg_restore only)"
        />
        <Check
          label="Use DROP … IF EXISTS"
          checked={state.pgIfExists}
          disabled={running || !state.pgArchive || !state.pgClean}
          onChange={(v) => patch({ pgIfExists: v })}
          hint="--if-exists (pg_restore only)"
        />
        {state.pgArchive ? (
          <>
            <Check
              label="Skip ownership"
              checked={state.pgNoOwner}
              disabled={running}
              onChange={(v) => patch({ pgNoOwner: v })}
              hint="--no-owner"
            />
            <Check
              label="Skip grants"
              checked={state.pgNoPrivileges}
              disabled={running}
              onChange={(v) => patch({ pgNoPrivileges: v })}
              hint="--no-privileges"
            />
          </>
        ) : (
          <div className="prefs-hint" style={{ margin: '4px 0 0' }}>
            Ownership and grants in a plain SQL dump were decided when it was exported.
          </div>
        )}
      </fieldset>
    </>
  )

  const options = isExport
    ? engine === 'postgres'
      ? pgExportOptions
      : mysqlExportOptions
    : engine === 'postgres'
      ? pgImportOptions
      : mysqlImportOptions

  return (
    <div className="transfer">
      {pgVersionWarning && (
        <div className="banner warn">
          pg_dump {pgDumpMajor?.label} is newer than PostgreSQL {pgServerMajor?.label}. The dump may
          not restore to PostgreSQL {pgServerMajor?.label}; use pg_dump {pgServerMajor?.label} when
          that is the destination.
        </div>
      )}
      {config.method === 'ssh' && (
        <div className="banner info">
          This connection tunnels over SSH, so the tool runs against a temporary local tunnel opened
          for the run.
        </div>
      )}

      <div className="transfer-top">
        {isExport && (
          <div className="transfer-side">
            <TransferObjects
              schemas={conn.schemas}
              selection={state.selection}
              onChange={(selection) => patch({ selection, seeded: true })}
              showSystem={state.showSystemSchemas}
              onShowSystem={(showSystemSchemas) => patch({ showSystemSchemas })}
              loading={conn.schemasLoading}
              onRefresh={() => void refreshSchemas(conn.sessionId, true)}
              canRefresh={conn.status === 'connected'}
              disabled={running}
            />
          </div>
        )}

        <div className="transfer-right">
          <div className="pane-head">
            <span className="pane-title">Options</span>
            <div className="spacer" />
            <button
              className="toolbar-btn"
              disabled={running}
              onClick={resetDefaults}
              title="Put every option back to its default. The tool path, the file paths and the ticked objects are left alone."
            >
              Reset to defaults
            </button>
          </div>
          <div className="transfer-options">
            {toolRow}
            {isExport ? destination : source}
            {options}
          </div>
        </div>
      </div>

      <TransferRunner
        kind={kind}
        command={command}
        edited={state.command !== ''}
        onCommandChange={(value) => patch({ command: value === generated ? '' : value })}
        onReset={() => patch({ command: '' })}
        blockedReason={blockedReason}
        run={run}
        running={running}
        onStart={() => void requestStart()}
        onStop={() => void window.api.tools.cancel(runId)}
        onClear={() => useTransferStore.getState().clear(runId)}
        revealPath={outputPath}
        logHeight={conn.layout.transferLogHeight}
        onLogHeight={(transferLogHeight) => setLayout(conn.sessionId, { transferLogHeight })}
        onLogHeightCommit={() => void persistMeta(conn.sessionId)}
        passwordNote={
          engine === 'postgres'
            ? 'The password is passed to the tool through a temporary PGPASSFILE, never on the command line.'
            : ''
        }
      />

      {confirming === 'import' && (
        <ConfirmModifyModal
          title={`⚠ Import into ${conn.name}`}
          message={`Everything in ${baseNameOf(state.inputPath)} is about to run against this connection. It can drop and overwrite whatever the dump names.`}
          sql={command}
          connectionName={conn.name}
          confirmLabel="Run import"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void startRun()}
        />
      )}

      {confirming === 'overwrite' && (
        <ConfirmModifyModal
          title="⚠ Confirm overwrite"
          message="The export destination below already exists. Continuing will overwrite its contents. This cannot be undone."
          sql={outputPath}
          connectionName={conn.name}
          confirmLabel="Overwrite"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void startRun()}
        />
      )}
    </div>
  )
}
