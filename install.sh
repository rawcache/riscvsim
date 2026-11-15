#!/bin/sh
# StudyRISC-V CLI installer (macOS / Linux)
#
#   curl -fsSL https://studyriscv.com/install.sh | sh
#
# Downloads a prebuilt riscvsim binary for your OS/arch from GitHub releases
# (no toolchain required). If no prebuilt binary exists for your platform it
# falls back to building from source with cargo, if available.

set -eu

REPO="rawcache/riscvsim"
INSTALL_DIR="${RISCVSIM_INSTALL_DIR:-$HOME/.local/bin}"
BASE_URL="https://github.com/$REPO/releases/latest/download"

# green = success, red = error, cyan = status — matching riscvsim itself.
# Colors auto-disable when not writing to a terminal or NO_COLOR is set.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_STATUS='\033[36m'; C_OK='\033[92m'; C_ERR='\033[31m'; C_DIM='\033[90m'; C_END='\033[0m'
else
  C_STATUS=''; C_OK=''; C_ERR=''; C_DIM=''; C_END=''
fi

info() { printf "${C_STATUS}%s${C_END}\n" "$1"; }
ok()   { printf "${C_OK}%s${C_END}\n" "$1"; }
dim()  { printf "${C_DIM}%s${C_END}\n" "$1"; }
fail() { printf "${C_ERR}%s${C_END}\n" "$1" >&2; exit 1; }

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin) os_tag="macos" ;;
  Linux)  os_tag="linux" ;;
  *) fail "✗ unsupported OS: $os — build from source instead: cargo build --release in cli/" ;;
esac

case "$arch" in
  arm64|aarch64) arch_tag="arm64" ;;
  x86_64|amd64)  arch_tag="x86_64" ;;
  *) fail "✗ unsupported architecture: $arch" ;;
esac

asset="riscvsim-${os_tag}-${arch_tag}.tar.gz"
url="$BASE_URL/$asset"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

info "Downloading riscvsim (${os_tag}/${arch_tag})..."

if curl -fsSL "$url" -o "$tmpdir/$asset" 2>/dev/null; then
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"
  mkdir -p "$INSTALL_DIR"
  mv "$tmpdir/riscvsim" "$INSTALL_DIR/riscvsim"
  chmod +x "$INSTALL_DIR/riscvsim"
elif command -v cargo >/dev/null 2>&1; then
  printf "${C_ERR}%s${C_END}\n" "✗ prebuilt binary not yet available for your platform — building from source instead (requires Rust)"
  info "Cloning $REPO..."
  git clone --depth 1 "https://github.com/$REPO" "$tmpdir/src" >/dev/null 2>&1 \
    || fail "✗ could not clone $REPO"
  info "Building riscvsim (this takes a minute)..."
  (cd "$tmpdir/src/cli" && cargo build --release --quiet) \
    || fail "✗ cargo build failed"
  mkdir -p "$INSTALL_DIR"
  mv "$tmpdir/src/cli/target/release/riscvsim" "$INSTALL_DIR/riscvsim"
else
  fail "✗ prebuilt binary not yet available for your platform, and cargo is not installed — install Rust from https://rustup.rs and re-run"
fi

# verify the binary actually runs before declaring victory
"$INSTALL_DIR/riscvsim" --version >/dev/null 2>&1 \
  || fail "✗ installed binary failed to run — please report this at https://github.com/$REPO/issues"

ok "✓ riscvsim installed ($("$INSTALL_DIR/riscvsim" --version))"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    dim "add it to your PATH:"
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

printf '\n'
printf 'get started:\n'
printf '  riscvsim run program.s        # assemble + run, print final state\n'
printf '  riscvsim run program.s -v     # full instruction trace\n'
printf '  riscvsim serve program.s      # step through it in the browser\n'
