#!/bin/sh
# riscvsim installer, attached to each GitHub release.
#
#   curl -fsSL <release>/install.sh | sh
#
# Detects your OS and CPU, downloads the matching archive from the same
# release, checks its SHA-256 checksum, and installs riscvsim into a bin
# folder in your home (override with RISCVSIM_INSTALL_DIR).
#
# The release workflow fills in the repository name below; this template is
# never run as-is.
set -eu

REPO="__RISCVSIM_REPO__"
TAG="__RISCVSIM_TAG__"
INSTALL_DIR="${RISCVSIM_INSTALL_DIR:-$HOME/.local/bin}"
# RISCVSIM_RELEASE_URL points at another copy of the release (used by tests).
BASE_URL="${RISCVSIM_RELEASE_URL:-https://github.com/$REPO/releases/download/$TAG}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  G='\033[32m'; R='\033[31m'; Y='\033[33m'; C='\033[36m'; E='\033[0m'
else
  G=''; R=''; Y=''; C=''; E=''
fi

say()  { printf '  %b\n' "$1"; }
ok()   { say "${G}✓${E} $1"; }
fail() { say "${R}✗${E} $1" >&2; exit 1; }

# A friendly way to show paths inside your home folder.
# shellcheck disable=SC2088  # the tilde is for display only
pretty() {
  case "$1" in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

printf '\n'
say "riscvsim ${C}›${E} install"
printf '\n'

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) fail "this installer supports macOS and Linux. Elsewhere: cargo install --path cli" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) cpu=arm64 ;;
  x86_64|amd64) cpu=x86_64 ;;
  *) fail "there is no prebuilt riscvsim for this CPU ($(uname -m)). Build it: cargo install --path cli" ;;
esac
if [ "$os" = linux ] && [ "$cpu" = arm64 ]; then
  fail "there is no prebuilt riscvsim for Linux on ARM yet. Build it: cargo install --path cli"
fi
asset="riscvsim-$os-$cpu.tar.gz"
ok "found your system: $os, $cpu"

command -v curl >/dev/null 2>&1 || fail "curl is needed to download riscvsim; install it and run this again"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

curl -fsSL "$BASE_URL/$asset" -o "$tmp/$asset" ||
  fail "could not download $asset. Check your connection and try again"
curl -fsSL "$BASE_URL/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
  fail "could not download the checksum file. Check your connection and try again"
ok "downloaded $asset"

expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
[ -n "$expected" ] || fail "the checksum file has no entry for $asset; please report this"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
fi
[ "$expected" = "$actual" ] || fail "the download does not match its checksum, so it was not installed. Try again"
ok "checksum verified"

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$INSTALL_DIR"
mv "$tmp/riscvsim" "$INSTALL_DIR/riscvsim"
chmod +x "$INSTALL_DIR/riscvsim"
version=$("$INSTALL_DIR/riscvsim" --version 2>/dev/null | cut -d' ' -f1-2) ||
  fail "the installed riscvsim did not start; please report this"
ok "$version installed to $(pretty "$INSTALL_DIR")"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf '\n'
    say "${Y}!${E} $(pretty "$INSTALL_DIR") is not on your PATH yet. Add this line to your shell profile:"
    case "$INSTALL_DIR" in
      "$HOME"/*) shown="\$HOME/${INSTALL_DIR#"$HOME"/}" ;;
      *) shown="$INSTALL_DIR" ;;
    esac
    say "  ${C}export PATH=\"$shown:\$PATH\"${E}"
    ;;
esac

printf '\n'
say "Try it: ${C}riscvsim demo${E}"
printf '\n'
