#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

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
echo "This project runs locally in the browser via Rust/WASM."

echo "Installing frontend dependencies"
cd "$FRONTEND_DIR"
npm ci

echo "Starting frontend dev server on port $FRONTEND_PORT"
npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" &
FRONTEND_PID=$!

echo "Frontend URL: http://localhost:$FRONTEND_PORT"
wait "$FRONTEND_PID"
