#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNC_DIR="$ROOT_DIR/amplify/backend/function/riscvsimBackend"
DIST_DIR="$FUNC_DIR/build/distributions"
MIN_ZIP_SIZE_BYTES="${MIN_ZIP_SIZE_BYTES:-200000}"

echo "== Amplify Status =="
if ! command -v amplify >/dev/null 2>&1; then
  echo "ERROR: Amplify CLI not found in PATH."
  exit 1
fi
amplify status

echo
echo "== Deployment Artifact Check =="
if [[ ! -d "$DIST_DIR" ]]; then
  echo "ERROR: Missing distribution directory: $DIST_DIR"
  echo "Run a function build first (for example: gradle -p amplify/backend/function/riscvsimBackend buildZip)."
  exit 1
fi

ZIP_PATH=""
for candidate in "$DIST_DIR/latest-build.zip" "$DIST_DIR/latest_build.zip"; do
  if [[ -f "$candidate" ]]; then
    ZIP_PATH="$candidate"
    break
  fi
done

if [[ -z "$ZIP_PATH" ]]; then
  ZIP_PATH="$(find "$DIST_DIR" -maxdepth 1 -type f -name '*.zip' -print | head -n 1 || true)"
fi

if [[ -z "$ZIP_PATH" ]]; then
  echo "ERROR: No Lambda deployment zip found in $DIST_DIR."
  exit 1
fi

echo "Using zip: $ZIP_PATH"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cpu_found=false
if unzip -Z1 "$ZIP_PATH" | grep -q '^riscvsim/Cpu.class$'; then
  cpu_found=true
else
  unzip -qq "$ZIP_PATH" '*.jar' -d "$TMP_DIR" || true
  while IFS= read -r jar_file; do
    if jar tf "$jar_file" | grep -q '^riscvsim/Cpu.class$'; then
      cpu_found=true
      break
    fi
  done < <(find "$TMP_DIR" -type f -name '*.jar' -print)
fi

if [[ "$cpu_found" != true ]]; then
  echo "ERROR: riscvsim/Cpu.class not found in deployment zip or embedded jars."
  exit 1
fi

zip_size="$(wc -c < "$ZIP_PATH" | tr -d ' ')"
echo "Zip size: ${zip_size} bytes"
if (( zip_size < MIN_ZIP_SIZE_BYTES )); then
  echo "ALERT: Zip appears too small (< ${MIN_ZIP_SIZE_BYTES} bytes). Shared logic may be missing."
  exit 2
fi

echo "PASS: Deployment zip includes shared Cpu.class and exceeds minimum size threshold."
