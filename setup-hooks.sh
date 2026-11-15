#!/usr/bin/env bash
# setup-hooks.sh
#
# Installs a local pre-push safety hook that blocks accidentally pushing
# private/product files (amplify.yml, customHttp.yml, amplify/, frontend/)
# to this public repo. Git hooks live in .git/hooks/, which is NOT version
# controlled and does not survive a fresh clone — run this once after
# cloning this repo to install the hook locally.
#
# Usage:
#   ./setup-hooks.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_PATH="$REPO_ROOT/.git/hooks/pre-push"

if [[ ! -d "$REPO_ROOT/.git" ]]; then
  echo "✗ .git directory not found — run this from the root of a real git checkout of this repo." >&2
  exit 1
fi

cat > "$HOOK_PATH" << 'HOOK_EOF'
#!/usr/bin/env bash
# Installed by setup-hooks.sh — blocks pushing private-only file patterns
# to this public repo.
BLOCKED='amplify\.yml|customHttp\.yml|^amplify/|^frontend/'
if git diff --name-only origin/main HEAD 2>/dev/null | grep -qE "$BLOCKED"; then
  echo "✗ BLOCKED: attempting to push files matching private-only patterns to public remote."
  echo "  Matched files:"
  git diff --name-only origin/main HEAD 2>/dev/null | grep -E "$BLOCKED"
  exit 1
fi
HOOK_EOF

chmod +x "$HOOK_PATH"

echo "✓ pre-push safety hook installed at $HOOK_PATH"
echo "  Blocks pushes containing: amplify.yml, customHttp.yml, amplify/, frontend/"
