#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8080}"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "FRONTEND deps:"
cd "$ROOT_DIR/frontend"
npm ci

echo "BACKEND build (compiles shared/):"
cd "$ROOT_DIR/backend"
mvn -q clean package

echo "BACKEND start:"
java -jar "target/riscvsim-backend-0.1.0.jar" &
BACKEND_PID=$!

echo "Waiting for backend on localhost:${BACKEND_PORT} ..."
for _ in {1..30}; do
  if curl -fsS "http://localhost:${BACKEND_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "FRONTEND dev server:"
cd "$ROOT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

wait
