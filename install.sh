#!/usr/bin/env bash
# Install me-pi: link repo-owned resources into the live Pi/agent directories.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd -P)"
PI_AGENT="$HOME/.pi/agent"
AGENTS_HOME="$HOME/.agents"

if ! command -v pi >/dev/null 2>&1; then
  echo "✗ pi is required to register this rig and its packages" >&2
  exit 1
fi

is_tracked() {
  git -C "$REPO" ls-files --error-unmatch -- "$1" >/dev/null 2>&1
}

# Link only repo-owned resources into real user directories. Existing machine
# resources are preserved; name collisions are reported, never overwritten.
link_entry() {
  local source="$1" destination="$2" label="$3"
  if [ -L "$destination" ]; then
    if [ "$(readlink "$destination")" = "$source" ]; then
      echo "✓ $label"
    else
      echo "⚠ $destination already links elsewhere; left unchanged"
    fi
  elif [ -e "$destination" ]; then
    echo "⚠ $destination already exists; left unchanged (resolve name collision manually)"
  else
    ln -s "$source" "$destination"
    echo "✓ $label"
  fi
}

link_repo_skills() {
  local source name
  for source in "$REPO"/skills/*; do
    [ -d "$source" ] || continue
    name="$(basename "$source")"
    if ! is_tracked "skills/$name/SKILL.md"; then
      echo "⚠ untracked repo skill $name; left out of live config"
      continue
    fi
    link_entry "$source" "$AGENTS_HOME/skills/$name" "skill $name"
  done
}

# Pi's example directory: next to the resolved pi binary (fake/npm-global layout)
# or inside the managed install's current release.
find_pi_example() {
  local pi_real candidate version
  local relative=examples/extensions/interactive-shell.ts
  pi_real="$(realpath "$(command -v pi)")"
  candidate="$(dirname "$(dirname "$pi_real")")/$relative"
  if [ ! -f "$candidate" ] && version="$(head -n1 "$PI_AGENT/install/current-version" 2>/dev/null)"; then
    candidate="$PI_AGENT/install/releases/$version/node_modules/@earendil-works/pi-coding-agent/$relative"
  fi
  [ -f "$candidate" ] || return 1
  printf '%s\n' "$candidate"
}

install_interactive_shell() {
  local destination="$PI_AGENT/extensions/interactive-shell.ts" source
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "· interactive-shell.ts already exists; leaving it unchanged"
    return 0
  fi
  source="$(find_pi_example || true)"
  if [ -z "$source" ]; then
    echo "⚠ Pi's interactive-shell example not found; skipped (copy it manually)"
    return 0
  fi
  cp "$source" "$destination"
  echo "✓ interactive-shell.ts copied from the installed Pi example"
}

mkdir -p "$PI_AGENT/extensions" "$AGENTS_HOME/skills"
link_repo_skills
link_entry "$REPO/CODING_STANDARDS.md" "$AGENTS_HOME/CODING_STANDARDS.md" "shared coding standards"
link_entry "$REPO/GLOBAL_AGENTS.md" "$PI_AGENT/AGENTS.md" "global AGENTS.md"

# Expose the delegation helper on PATH when a user bin directory exists.
if [ -d "$HOME/.local/bin" ]; then
  link_entry "$REPO/bin/delegate" "$HOME/.local/bin/delegate" "delegate command"
else
  echo "· ~/.local/bin missing; add $REPO/bin to PATH to use delegate"
fi

# Seed preferences once; package installs below update the live settings without
# replacing machine-local model, auth, or session state.
if [ ! -f "$PI_AGENT/settings.json" ]; then
  cp "$REPO/settings.json" "$PI_AGENT/settings.json"
  echo "✓ settings.json installed from template"
else
  echo "· settings.json exists — left alone"
fi

# `pi install` stores the exact spec and replaces an existing unpinned entry.
pi install "$REPO/extensions"
pi install npm:pi-web-access@0.38.0

install_interactive_shell
if command -v rtk >/dev/null 2>&1; then
  if rtk init --global --agent pi; then
    echo "✓ RTK Pi extension installed/updated"
  else
    echo "⚠ RTK initialization failed or refused an overwrite; inspect manually" >&2
  fi
else
  echo "· rtk not found; skipped RTK extension setup (install rtk separately)"
fi

echo
echo "Done. Restart pi sessions to load the updated rig."
