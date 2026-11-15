#!/bin/sh
# StudyRISC-V CLI installer (macOS / Linux)
#
#   curl -fsSL https://studyriscv.com/install.sh | sh
#
# Non-interactive / scripted use (skips any confirmation prompts):
#   curl -fsSL https://studyriscv.com/install.sh | sh -s -- --yes
#   RISCVSIM_INSTALL_YES=1 curl -fsSL https://studyriscv.com/install.sh | sh
#
# Downloads a prebuilt riscvsim binary for your OS/arch from GitHub releases
# (no toolchain required). If no prebuilt binary exists for your platform it
# falls back to building from source with cargo, if available.

set -eu

REPO="rawcache/riscvsim"
INSTALL_DIR="${RISCVSIM_INSTALL_DIR:-$HOME/.local/bin}"
BASE_URL="https://github.com/$REPO/releases/latest/download"

# ---------------------------------------------------------------------------
# flags: -y / --yes (or RISCVSIM_INSTALL_YES=1) answers yes to any
# confirmation prompt. The installer currently has no prompts, so today this
# is a no-op kept for forward compatibility and CI ergonomics.
# ---------------------------------------------------------------------------
ASSUME_YES="${RISCVSIM_INSTALL_YES:-}"
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
  esac
done

confirm() {
  # confirm "question"  ->  0 = yes. Auto-yes when --yes/RISCVSIM_INSTALL_YES
  # is set, or when there is no terminal to ask (piped installs never hang).
  [ -n "$ASSUME_YES" ] && return 0
  [ -t 0 ] || return 0
  printf '%s [Y/n] ' "$1"
  read -r reply || reply=""
  case "$reply" in
    n|N|no|NO) return 1 ;;
    *) return 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# output: animated in a real terminal; plain, instant, ANSI-free everywhere
# else (pipes, logs, CI, NO_COLOR, dumb terminals).
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ -z "${CI:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  FANCY=1
  C_OK='\033[92m'; C_ERR='\033[31m'; C_DIM='\033[90m'; C_SPIN='\033[36m'; C_END='\033[0m'
else
  FANCY=""
  C_OK=""; C_ERR=""; C_DIM=""; C_SPIN=""; C_END=""
fi

tmpdir=$(mktemp -d)
STEP_LOG="$tmpdir/step.log"
cleanup() {
  [ -n "$FANCY" ] && printf '\033[?25h' || true  # always bring the cursor back
  rm -rf "$tmpdir"
}
trap cleanup EXIT INT TERM

ok()   { printf "${C_OK}✓${C_END} %s\n" "$1"; }
dim()  { printf "${C_DIM}%s${C_END}\n" "$1"; }
warn() { printf "${C_ERR}!${C_END} %s\n" "$1" >&2; }
fail() {
  printf "${C_ERR}✗ %s${C_END}\n" "$1" >&2
  if [ -s "$STEP_LOG" ]; then
    tail -4 "$STEP_LOG" | sed 's/^/    /' >&2
  fi
  exit 1
}

# run_step "Doing the thing..." command args...
# Shows a spinner next to the message while the command runs, then settles
# the line to a green check (or red cross). Plain mode prints the message,
# runs the command, and appends the check on its own line.
run_step() {
  step_msg="$1"; shift
  : > "$STEP_LOG"
  if [ -z "$FANCY" ]; then
    printf '%s\n' "$step_msg"
    if "$@" >"$STEP_LOG" 2>&1; then
      ok "$step_msg"
      return 0
    fi
    return 1
  fi
  "$@" >"$STEP_LOG" 2>&1 &
  step_pid=$!
  printf '\033[?25l'
  while kill -0 "$step_pid" 2>/dev/null; do
    for frame in '⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏'; do
      kill -0 "$step_pid" 2>/dev/null || break
      printf "\r${C_SPIN}%s${C_END} %s" "$frame" "$step_msg"
      sleep 0.08
    done
  done
  if wait "$step_pid"; then
    printf "\r${C_OK}✓${C_END} %s\n" "$step_msg"
    printf '\033[?25h'
    return 0
  else
    printf "\r${C_ERR}✗${C_END} %s\n" "$step_msg"
    printf '\033[?25h'
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 1. detect platform
# ---------------------------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin) os_tag="macos" ;;
  Linux)  os_tag="linux" ;;
  *) fail "this installer supports macOS and Linux; on other systems, build from source: cargo build --release in cli/" ;;
esac

case "$arch" in
  arm64|aarch64) arch_tag="arm64" ;;
  x86_64|amd64)  arch_tag="x86_64" ;;
  *) fail "unsupported architecture: $arch" ;;
esac

ok "Found your platform: ${os_tag}/${arch_tag}"

# Homebrew and the quick-start installer are equally supported, but installing
# both can make the older binary silently win based on PATH order.
if command -v brew >/dev/null 2>&1 && brew list --versions riscvsim >/dev/null 2>&1; then
  brew_prefix=$(brew --prefix riscvsim 2>/dev/null || true)
  brew_binary="${brew_prefix}/bin/riscvsim"
  active_binary=$(command -v riscvsim 2>/dev/null || true)
  warn "Homebrew already manages riscvsim at $brew_binary."
  if [ -n "$active_binary" ]; then
    warn "Your shell currently selects $active_binary; installing to $INSTALL_DIR may change or be hidden by that PATH order."
  else
    warn "Installing to $INSTALL_DIR creates a second copy; whichever directory appears first in PATH will run."
  fi
  dim "After installation, run 'riscvsim doctor' to inspect every PATH-visible copy."
  printf '\n'
fi

asset="riscvsim-${os_tag}-${arch_tag}.tar.gz"
url="$BASE_URL/$asset"

# ---------------------------------------------------------------------------
# 2. download the prebuilt binary (or build from source as a fallback)
# ---------------------------------------------------------------------------
install_from_download() {
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"
  mkdir -p "$INSTALL_DIR"
  mv "$tmpdir/riscvsim" "$INSTALL_DIR/riscvsim"
  chmod +x "$INSTALL_DIR/riscvsim"
}

source_build() {
  git clone --depth 1 "https://github.com/$REPO" "$tmpdir/src" &&
    (cd "$tmpdir/src/cli" && cargo build --release --quiet) &&
    mkdir -p "$INSTALL_DIR" &&
    mv "$tmpdir/src/cli/target/release/riscvsim" "$INSTALL_DIR/riscvsim"
}

if run_step "Downloading riscvsim..." curl -fsSL "$url" -o "$tmpdir/$asset"; then
  run_step "Installing to $INSTALL_DIR..." install_from_download ||
    fail "could not unpack the download; please report this at https://github.com/$REPO/issues"
elif command -v cargo >/dev/null 2>&1; then
  printf "${C_ERR}✗${C_END} %s\n" "prebuilt binary not yet available for your platform, building from source instead (requires Rust)"
  run_step "Building riscvsim from source (this may take a minute or two)..." source_build ||
    fail "the source build failed; please report this at https://github.com/$REPO/issues"
else
  fail "prebuilt binary not yet available for your platform, and cargo is not installed. Install Rust from https://rustup.rs and re-run"
fi

# ---------------------------------------------------------------------------
# 3. verify it actually runs before declaring victory
# ---------------------------------------------------------------------------
run_step "Checking the install..." "$INSTALL_DIR/riscvsim" --version ||
  fail "installed binary failed to run; please report this at https://github.com/$REPO/issues"
version=$("$INSTALL_DIR/riscvsim" --version)

printf '\n'
ok "$version installed"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf '\n'
    dim "one more step so your terminal can find it, add this line to your shell config (for example ~/.zshrc):"
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

printf '\n'
dim "run 'riscvsim' to start the interactive simulator, or 'riscvsim doctor' to inspect this installation"
