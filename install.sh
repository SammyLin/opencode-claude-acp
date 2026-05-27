#!/usr/bin/env bash
# install.sh — set up opencode-claude-acp from a git checkout (no npm registry).
# Installs dependencies locally, then installs the opencode skill.
#
# Usage:
#   ./install.sh                # install skill into ~/.config/opencode/skills
#   ./install.sh --claude       # install into ~/.claude/skills
#   ./install.sh --dir <path>   # custom skills dir
#   ./install.sh --uninstall    # remove the skill
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required but not found on PATH." >&2
  exit 1
fi

# Skip dependency install for uninstall.
if [[ " $* " != *" --uninstall "* ]]; then
  echo "Installing dependencies (bundles the claude-agent-acp agent)..."
  npm install --omit=dev
fi

echo "Installing the ask-claude-code skill..."
node "$ROOT/scripts/install-skill.mjs" "$@"

echo
echo "Done. Try it directly:"
echo "  node \"$ROOT/acp-client.mjs\" --selftest"
