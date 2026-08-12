# MySQL Browser

A fast, parallel MySQL browser for Windows — a stripped-down MySQL Workbench
whose defining feature is **parallelism**: every connection tab, and every query
tab within it, runs on its own thread with its own MySQL connection, so a slow
query in one tab never blocks the UI or any other tab.

## Architecture

Electron, three processes:

- **Renderer** (`src/renderer`) — React 19 + Zustand. The UI: home page, schema
  tree, CodeMirror 6 SQL editor with schema-aware completion, virtualized result
  grid, history, and the create/alter table designer.
- **Main** (`src/main`) — owns storage (`store.ts`) and the IPC surface
  (`ipc.ts`). Spawns one **DB worker thread per open connection tab**.
- **DB worker** (`src/main/db/worker.ts`) — runs on its own thread. Holds the
  control connection plus **one MySQL connection per query tab**, so two tabs of
  the same connection execute concurrently. All socket reads and row parsing
  happen here, off the UI thread. Supports TCP, SSH tunnelling (`tunnel.ts`) and
  AWS IAM auth tokens (`iam.ts`, auto-refreshed before the 15-minute expiry).

`src/shared` is the contract shared by all three (types, SQL helpers, the worker
protocol).

## Where things live

| Feature | File |
| --- | --- |
| Connections home page | `renderer/src/components/HomePage.tsx` |
| Add/edit connection (TCP / SSH / IAM) | `components/ConnectionDialog.tsx` |
| Preferences (global + per-connection) | `components/PreferencesDialog.tsx` |
| Schema tree + context menus | `components/SchemaTree.tsx` |
| SQL editor | `components/QueryEditor.tsx` |
| Result grid (edit/apply/revert) | `components/ResultsGrid.tsx` + `lib/grid.ts` |
| History | `components/HistoryView.tsx` |
| Create/alter table designer | `components/TableDesigner.tsx` + `lib/designerSql.ts` |
| Data Export / Data Import | `components/ExportImportTab.tsx`, `TransferObjects.tsx`, `TransferRunner.tsx` |
| `mysqldump`/`mysql` command build + run | `shared/transfer.ts`, `main/tools.ts` |
| Grid ↔ SQL, apply plans | `lib/grid.ts`, `shared/sql.ts` |

## Safety: never silently modify the database

Anything that would change data or schema from a *menu/button* (drop table,
truncate, alter, create, grid Apply) opens a new tab pre-populated with the SQL,
or shows a copyable confirmation modal — the user runs it themselves. Only
non-modifying actions run automatically: double-click schema → `USE`, the
"Select rows - limit 1000" button, and SQL the user typed into the editor and
executed. See `store.runQuery` and `SchemaTree`.

## Persistence

Under Electron's `userData`:

- `connections.json` — saved connections; passwords/SSH secrets encrypted at
  rest with Windows DPAPI (`safeStorage`).
- `preferences.json` — global preferences.
- `sessions/<connectionId>/meta.json` — schema cache, open-tab order, layout.
- `sessions/<connectionId>/tabs/*.json` — **one file per tab**, including its
  result grid. Restored when the connection is next opened (works offline).

## Develop / build

```bash
npm install          # electron/esbuild postinstall scripts are pre-approved in package.json
npm run dev          # electron-vite dev server
npm run typecheck    # tsc for both the node and web projects
npm run build        # production build into out/
npm run dist         # unpacked Windows app into release/
```

## Not yet implemented

The table designer omits Triggers, Partitioning and Options, per spec.
