#!/usr/bin/env bash
# Local, standalone. No proxy, no shared network, loopback port only.
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

# No -f list, so Compose picks up docker-compose.override.yml automatically and
# the site gets its loopback host port.
docker compose config --quiet
docker compose up -d --build --remove-orphans --wait --wait-timeout 90
docker compose ps

port="$(grep -E '^SITE_PORT=' .env | cut -d= -f2)"
echo
echo "Site: http://localhost:${port:-3084}"
