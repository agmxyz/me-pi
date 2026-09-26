#!/usr/bin/env bash
# me-pi rig installer — symlinks this repo into the live agent dirs.
# Idempotent: re-run safely. Never copies secrets (auth.json etc. stay in live dirs).
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT="$HOME/.pi/agent"
AGENTS_HOME="$HOME/.agents"

link() { # link <target> <link-path>
  local target="$1" path="$2"
  if [ -L "$path" ]; then
    [ "$(readlink "$path")" = "$target" ] && { echo "✓ $path"; return; }
    echo "! $path is a symlink to $(readlink "$path") — replacing"
    rm "$path"
  elif [ -e "$path" ]; then
    echo "✗ $path exists and is not a symlink — refusing. Move it aside first." >&2
    exit 1
  fi
  ln -s "$target" "$path"
  echo "✓ $path → $target"
}

mkdir -p "$PI_AGENT" "$AGENTS_HOME"

link "$REPO/extensions" "$PI_AGENT/extensions"
link "$REPO/agents"     "$PI_AGENT/agents"
link "$REPO/prompts"    "$PI_AGENT/prompts"
link "$REPO/APPEND_SYSTEM.md" "$PI_AGENT/APPEND_SYSTEM.md"
link "$REPO/skills"     "$AGENTS_HOME/skills"

# settings.json: template on first install only (live file accumulates machine state)
if [ ! -f "$PI_AGENT/settings.json" ]; then
  cp "$REPO/settings.json" "$PI_AGENT/settings.json"
  echo "✓ settings.json installed from template"
else
  echo "· settings.json exists — left alone (diff against repo/settings.json if needed)"
fi

echo
echo "Done. Restart pi sessions to pick up extensions/skills."
