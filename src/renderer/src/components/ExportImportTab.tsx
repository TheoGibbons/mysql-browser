import type { ConnectionConfig, Preferences } from '@shared/types'
import { ExportIcon, ImportIcon } from './ui/Icons'

interface Props {
  kind: 'export' | 'import'
  config: ConnectionConfig
  prefs: Preferences
}

/**
 * Placeholder for the mysqldump-backed Data Export / Data Import features.
 * The tab exists, is restored with the session, and shows the configuration it
 * will use once the feature lands.
 */
export function ExportImportTab({ kind, config, prefs }: Props): JSX.Element {
  const isExport = kind === 'export'
  const toolPath = isExport ? prefs.mysqldumpPath : prefs.mysqlPath
  const toolName = isExport ? 'mysqldump' : 'mysql'

  return (
    <div className="placeholder-tab">
      <div style={{ maxWidth: 520 }}>
        <div style={{ marginBottom: 10 }}>
          {isExport ? <ExportIcon size={28} /> : <ImportIcon size={28} />}
        </div>
        <h2 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>
          Data {isExport ? 'Export' : 'Import'}
        </h2>
        <p style={{ margin: '0 0 14px' }}>
          Not implemented yet. This tab will drive <code>{toolName}</code> against{' '}
          <strong>{config.name}</strong>.
        </p>

        <div
          style={{
            textAlign: 'left',
            border: '1px solid var(--border-light)',
            borderRadius: 3,
            padding: '8px 10px',
            background: 'var(--bg-panel)',
            fontSize: 11,
            lineHeight: 1.9
          }}
        >
          <div>
            <strong>Server:</strong> {config.host}:{config.port}
          </div>
          <div>
            <strong>User:</strong> {config.user}
          </div>
          <div>
            <strong>Path to {toolName}:</strong>{' '}
            {toolPath || <em style={{ color: 'var(--warn)' }}>not set — configure in Preferences</em>}
          </div>
          <div>
            <strong>Export directory:</strong>{' '}
            {prefs.exportDirectory || (
              <em style={{ color: 'var(--warn)' }}>not set — configure in Preferences</em>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
