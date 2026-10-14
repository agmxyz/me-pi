#!/usr/bin/env bash
# Install me-pi: link repo-owned policy into live Pi/agent directories and register packages.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd -P)"
PI_AGENT="$HOME/.pi/agent"
AGENTS_HOME="$HOME/.agents"

if ! command -v pi >/dev/null 2>&1; then
  echo "✗ pi is required to register this rig and its packages" >&2
  exit 1
fi

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

prune_retired_repo_links() {
  local entry target
  for entry in "$AGENTS_HOME"/skills/*; do
    [ -L "$entry" ] || continue
    target="$(readlink "$entry")"
    case "$target" in
      "$REPO"/skills/*)
        rm -f "$entry"
        echo "✓ pruned retired repo skill link $(basename "$entry")"
        ;;
    esac
  done
  if [ -L "$HOME/.local/bin/delegate" ] && [ "$(readlink "$HOME/.local/bin/delegate")" = "$REPO/bin/delegate" ]; then
    rm -f "$HOME/.local/bin/delegate"
    echo "✓ pruned retired delegate CLI link"
  fi
  if [ -L "$AGENTS_HOME/CODING_STANDARDS.md" ] && [ "$(readlink "$AGENTS_HOME/CODING_STANDARDS.md")" = "$REPO/CODING_STANDARDS.md" ]; then
    rm -f "$AGENTS_HOME/CODING_STANDARDS.md"
    echo "✓ pruned retired coding standards link"
  fi
}

# Pi loads ~/.agents/skills natively; remove redundant symlinks in ~/.pi/agent/skills
# that merely mirror ~/.agents/skills/* so Pi does not scan every skill twice.
prune_redundant_pi_skill_mirrors() {
  [ -d "$PI_AGENT/skills" ] || return 0
  local entry resolved agents_skills_real
  agents_skills_real="$(cd "$AGENTS_HOME/skills" 2>/dev/null && pwd -P || true)"
  [ -n "$agents_skills_real" ] || return 0
  for entry in "$PI_AGENT"/skills/*; do
    [ -L "$entry" ] || continue
    resolved="$(cd -P "$entry" 2>/dev/null && pwd -P || true)"
    case "$resolved" in
      "$agents_skills_real"/*)
        rm -f "$entry"
        ;;
    esac
  done
}

# Pi's example directory: next to the resolved pi binary (fake/npm-global layout)
# or inside the managed install's current release.
find_pi_example() {
  local name="$1" pi_real candidate version
  local relative="examples/extensions/$name"
  pi_real="$(realpath "$(command -v pi)")"
  candidate="$(dirname "$(dirname "$pi_real")")/$relative"
  if [ ! -f "$candidate" ] && version="$(head -n1 "$PI_AGENT/install/current-version" 2>/dev/null)"; then
    candidate="$PI_AGENT/install/releases/$version/node_modules/@earendil-works/pi-coding-agent/$relative"
  fi
  [ -f "$candidate" ] || return 1
  printf '%s\n' "$candidate"
}

install_pi_example() {
  local name="$1" destination="$PI_AGENT/extensions/$1" source
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "· $name already exists; leaving it unchanged"
    return 0
  fi
  source="$(find_pi_example "$name" || true)"
  if [ -z "$source" ]; then
    echo "⚠ Pi's $name example not found; skipped (copy it manually)"
    return 0
  fi
  cp "$source" "$destination"
  echo "✓ $name copied from the installed Pi example"
}

mkdir -p "$PI_AGENT/extensions" "$AGENTS_HOME/skills"
prune_retired_repo_links
prune_redundant_pi_skill_mirrors
link_entry "$REPO/GLOBAL_AGENTS.md" "$PI_AGENT/AGENTS.md" "global AGENTS.md"

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

install_pi_example interactive-shell.ts
install_pi_example handoff.ts
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
