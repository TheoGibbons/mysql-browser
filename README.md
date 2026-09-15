# MySQL Browser

A fast, parallel MySQL browser for Windows — a stripped-down MySQL Workbench
whose defining feature is **parallelism**: every connection tab, and every query
tab within it, runs on its own thread with its own MySQL connection, so a slow
query in one tab never blocks the UI or any other tab.

The application itself is a Windows desktop app, distributed as an installer
from [GitHub Releases](https://github.com/TheoGibbons/mysql-browser/releases) —
there is nothing to deploy to run it. **The five deployment sections below cover
the marketing site in `site/`**, a single static page that points visitors at
the latest installer. See [Releasing the app](#releasing-the-app) for the
desktop side.

## Deploying to LIVE

Needs only Docker. This path serves plain HTTP on port 80 and TLS is the
operator's job — put Cloudflare, nginx or Caddy in front of it.

```bash
git clone https://github.com/TheoGibbons/mysql-browser.git ~/projects/mysql-browser
cd ~/projects/mysql-browser
cp .env.production.example .env

# Set before continuing:
#   SITE_BIND=0.0.0.0   SITE_PORT=80   <- uncomment both; publishes publicly
#                                         instead of on loopback
nano .env

docker compose up -d --build
```

| TCP port | Allowed source | Purpose |
|---|---|---|
| 22 | Administrator IP | SSH and deployment |
| 80 | Public internet | Marketing site |

The security group is the enforcement boundary, not `ufw`: Docker publishes
ports by writing DNAT rules straight into iptables, which host firewalls do not
see.

## Deploying to LIVE with hobby-traefik

Requires the shared proxy. If it is not running on this instance yet:

```bash
git clone https://github.com/TheoGibbons/hobby-traefik.git ~/projects/hobby-traefik
cd ~/projects/hobby-traefik
bash scripts/deploy.sh
```

Point `mysql-browser.sinkmailer.com` at this instance **before** deploying, or
Let's Encrypt cannot validate it and no certificate is issued. Then:

```bash
git clone https://github.com/TheoGibbons/mysql-browser.git ~/projects/mysql-browser
cd ~/projects/mysql-browser
cp .env.production.example .env

# Set before continuing:
#   APP_HOST  public DNS name, already pointing at this instance
nano .env

bash scripts/deploy.sh
```

No host port is published in this mode — Traefik reaches the container over the
`traefik-public` network and owns 80 and 443 itself.

Deploys on this path do not take the site down. The script starts the new release
beside the old one with the [docker-rollout](https://github.com/wowu/docker-rollout)
CLI plugin, waits for it to pass its health check, lets Traefik drain the old one,
then removes it. A release that never turns healthy is discarded and the old one
keeps serving. For the few seconds both run, a `mysql-browser-site-lb` cookie,
holding only an identifier for the container, keeps each browser on one release.
Deploying hobby-traefik installs the plugin; the script stops before pulling, with
the install command, on a server that lacks it.

## Deploying Locally

Needs only Docker. Nothing is published beyond loopback.

```bash
git clone https://github.com/TheoGibbons/mysql-browser.git ~/projects/mysql-browser
cd ~/projects/mysql-browser
cp .env.example .env

bash scripts/up-local.sh
```

Open <http://localhost:3084>.

## Deploying Locally with hobby-traefik

Start the shared proxy first if it is not already running:

```bash
git clone https://github.com/TheoGibbons/hobby-traefik.git ~/projects/hobby-traefik
cd ~/projects/hobby-traefik
cp .env.example .env
bash scripts/up-local.sh
```

Then:

```bash
git clone https://github.com/TheoGibbons/mysql-browser.git ~/projects/mysql-browser
cd ~/projects/mysql-browser
cp .env.traefik.example .env

bash scripts/up-local-traefik.sh
```

Open <http://mysql-browser.localhost:8085>.

## Setup push-to-deploy

A push to `main` that touches `site/`, the Compose files or `scripts/` deploys
to EC2 through `.github/workflows/deploy.yml`.

**Part 1 — once per server, not once per project.** Skip it if another project
on this instance has already done it, and skip it entirely while this repository
is public — a public clone needs no credential.

```bash
# On the EC2 instance. Create a fine-grained PAT with Contents: Read-only,
# scoped to the repositories this box deploys:
#   https://github.com/settings/personal-access-tokens
read -rsp 'PAT: ' PAT && echo

git config --global credential.helper store
printf 'https://x-access-token:%s@github.com\n' "$PAT" > ~/.git-credentials
chmod 600 ~/.git-credentials
```

A deploy key cannot be shared: GitHub binds one to a single repository and
rejects the same key on a second with "Key is already in use". The PAT has no
such limit.

**Part 2 — once per repository.** The same EC2 keypair is reused for every
project, so only these four secrets are new:

```bash
# Locally, with the gh CLI authenticated:
gh secret set EC2_HOST            --env production --body '<ec2-public-dns>'
gh secret set EC2_USER            --env production --body 'ubuntu'
gh secret set EC2_SSH_PRIVATE_KEY --env production < ~/.ssh/<ec2-deploy-key>
gh secret set EC2_KNOWN_HOSTS     --env production \
  --body "$(ssh-keyscan -H <ec2-public-dns> 2>/dev/null)"
```

The deploy stops rather than overwrite tracked files edited directly on the
server. Commit through Git instead of letting the live and local copies drift.

A push deploys with the `scripts/deploy.sh` already on the server, which then
pulls. A change to the script itself therefore takes effect from the deploy after
the one that ships it.

`.github/workflows/release.yml` needs no secrets — it builds on `windows-latest`
and publishes with the automatic `GITHUB_TOKEN`.

## Releasing the app

Releases are driven by tags, and the tag must agree with `package.json`:

```bash
# 1. Bump the version and commit it.
npm version 0.2.0 -m "Release %s"

# 2. Push the commit and the tag it created.
git push origin main --follow-tags
```

The tag push runs `.github/workflows/release.yml`, which builds the NSIS
installer on Windows and uploads it to a GitHub Release along with the
`latest.yml` that the updater reads. The workflow refuses to build if the tag
and `package.json` disagree, because the release would then be named after one
version while the update feed advertised another.

Two settings in `package.json` matter more than they look:

- **`publish.releaseType: "release"`.** electron-builder defaults to `draft`,
  and a draft release is invisible to both the updater and the `releases/latest`
  API — the release exists, the download button stays on the fallback, and no
  installed copy is ever offered the update.
- **`artifactName`.** The default contains spaces, which survive in a URL but
  read badly. The filename still carries the version either way, which is why
  the download button resolves the real asset through the API rather than
  hard-coding a path.

## How updates reach installed copies

`src/main/updater.ts` is already wired end to end — main process → preload →
the `UpdateChip` in the renderer — and needs no token, because the repository is
public and the feed is read anonymously.

The app holds live database connections and unsaved editor content, so it never
restarts itself. It checks 10 seconds after launch and every 6 hours after that,
downloads in the background, and `autoInstallOnAppQuit` applies the update the
next time the user closes the app. The chip offers an explicit "Restart now" for
people who would rather not wait. A missing or unreachable feed is logged and
kept out of the UI, since being offline is the ordinary case.

**The installer is unsigned.** Windows SmartScreen will warn on first run until
the download builds reputation, which is the main argument for buying a code
signing certificate later. Signing needs no change to any of the above — add the
certificate as a secret and electron-builder picks it up.

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

The marketing site is unrelated to all of it: `site/public/index.html` is one
static page served by nginx, with no build step.

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
| Background updates | `main/updater.ts`, `components/UpdateChip.tsx` |
| Marketing site | `site/public/index.html`, `site/nginx.conf` |

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
npm install              # electron/esbuild postinstall scripts are pre-approved in package.json
npm run dev              # electron-vite dev server
npm run typecheck        # tsc for both the node and web projects
npm run build            # production build into out/
npm run dist             # unpacked Windows app into release/
npm run dist:installer   # NSIS installer into release/, without publishing
```

`npm run release` is what CI runs; it publishes, so prefer `dist:installer`
locally.

## Not yet implemented

The table designer omits Triggers, Partitioning and Options, per spec.
