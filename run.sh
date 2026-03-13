#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_URL="${BACKEND_URL:-}"

if [[ ! -d "$FRONTEND_DIR" ]]; then
  echo "ERROR: Missing frontend directory: $FRONTEND_DIR" >&2
  exit 1
fi

cleanup() {
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Frontend dev launcher"
echo "Repo: $ROOT_DIR"

if [[ -z "$BACKEND_URL" ]]; then
  cat <<'EOF'
No BACKEND_URL set.
The UI will still start, but any /api requests will fail unless you either:
  1. start a backend separately and pass BACKEND_URL=http://host:port/api
  2. open the app with ?api=https://your-backend.example/api
EOF
else
  BACKEND_URL="${BACKEND_URL%/}"
  export VITE_API_BASE="$BACKEND_URL"
  echo "Using backend: $VITE_API_BASE"
fi

echo "Installing frontend dependencies"
cd "$FRONTEND_DIR"
npm ci

echo "Starting frontend dev server on port $FRONTEND_PORT"
npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" &
FRONTEND_PID=$!

echo "Frontend URL: http://localhost:$FRONTEND_PORT"
wait "$FRONTEND_PID"
