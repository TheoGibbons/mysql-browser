#!/usr/bin/env bash
# Local, through the shared hobby-traefik proxy. Publishes no host port.
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.traefik.example .env
fi

if ! docker network inspect traefik-public >/dev/null 2>&1; then
  echo "The traefik-public network does not exist. Start hobby-traefik first." >&2
  exit 1
fi

# Explicit -f list so docker-compose.override.yml is skipped; Traefik reaches
# the container over traefik-public, not a host port.
compose=(
  docker compose
  -f docker-compose.yml
  -f docker-compose.traefik.yml
)

"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --remove-orphans --wait --wait-timeout 90
"${compose[@]}" ps

host="$(grep -E '^APP_HOST=' .env | cut -d= -f2)"
echo
echo "Site: http://${host:-mysql-browser.localhost}:8085"
