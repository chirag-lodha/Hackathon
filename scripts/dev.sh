#!/usr/bin/env bash
# Brivo Lumina — local development launcher.
# Starts Postgres (Docker), installs frontend deps if needed, then runs the Go
# backend (hot data) and the Vite dev server (hot reload) together.
#
#   ./scripts/dev.sh
#
# Ctrl-C stops the backend and frontend (Postgres keeps running in Docker;
# stop it with `docker compose down`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Ports (5432/8080 are taken by other services on this machine).
export LUMINA_ADDR="${LUMINA_ADDR:-:8090}"

echo "==> [1/4] Starting Postgres (docker compose)…"
docker compose up -d postgres

echo "==> [2/4] Waiting for Postgres to be healthy…"
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' lumina-postgres 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  sleep 1
done
echo "    Postgres: ${status:-unknown}"

echo "==> [3/4] Installing frontend dependencies (if needed)…"
if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
else
  echo "    node_modules present, skipping."
fi

echo "==> [4/4] Starting backend (${LUMINA_ADDR}) + frontend (:5173)…"
(cd backend && LUMINA_ADDR="$LUMINA_ADDR" go run .) &
BACKEND_PID=$!

# Stop the backend when this script exits.
cleanup() {
  echo
  echo "==> Stopping backend (pid $BACKEND_PID)…"
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Frontend runs in the foreground; closing it returns control here.
cd frontend && npm run dev
