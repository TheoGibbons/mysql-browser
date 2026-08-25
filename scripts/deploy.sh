#!/usr/bin/env bash
# LIVE deploy of the marketing site, run on the EC2 instance by
# .github/workflows/deploy.yml. The server checkout is the deployment source.
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy over tracked changes in $repo_dir" >&2
  exit 1
fi

git pull --ff-only

# What we just pulled has to survive a Windows checkout. A CR in a shell script
# fails as `bad interpreter: ...^M` or `set: pipefail: invalid option name`,
# neither of which names line endings; a lost mode bit fails as `Permission
# denied`. Check here, while the previous release is still serving and nothing
# has been rebuilt. `|| true` because grep and awk exit non-zero on no match,
# which is the healthy case.
crlf="$(git ls-files --eol -- '*.sh' | grep -E 'w/(crlf|mixed)' || true)"
if [[ -n "$crlf" ]]; then
  echo "CRLF line endings in tracked scripts:" >&2
  echo "$crlf" >&2
  echo "Commit a .gitattributes, then: git add --renormalize . && git commit" >&2
  exit 1
fi

not_exec="$(git ls-files -s -- '*.sh' | awk '$1 != "100755" {print $4}' || true)"
if [[ -n "$not_exec" ]]; then
  echo "Tracked scripts are not executable:" >&2
  echo "$not_exec" >&2
  echo "Fix with: git update-index --chmod=+x <file>" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "No .env in $repo_dir. Copy .env.production.example and set APP_HOST." >&2
  exit 1
fi

if ! docker network inspect traefik-public >/dev/null 2>&1; then
  echo "The traefik-public network does not exist. Deploy hobby-traefik first." >&2
  exit 1
fi

# Explicit -f list, which intentionally excludes docker-compose.override.yml:
# production publishes no host port of its own.
compose=(
  docker compose
  -f docker-compose.yml
  -f docker-compose.traefik.yml
  -f docker-compose.prod.yml
)

"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --remove-orphans --wait --wait-timeout 90
"${compose[@]}" ps
