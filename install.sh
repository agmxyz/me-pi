#!/usr/bin/env bash
# me-pi rig installer — symlinks this repo into the live agent dirs.
# Idempotent; never copies secrets (auth.json etc. stay in live dirs).
# Existing real files/dirs are offered: merge into repo / backup+replace / abort.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT="$HOME/.pi/agent"
AGENTS_HOME="$HOME/.agents"

mkdir -p "$PI_AGENT" "$AGENTS_HOME"

# merge_dir <live_path> <repo_dir> — adopt machine entries into the repo
merge_dir() {
  local live="$1" rdir="$2" entry name c
  for entry in "$live"/* "$live"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    if [ -e "$rdir/$name" ]; then
      if diff -rq "$entry" "$rdir/$name" >/dev/null 2>&1; then
        echo "  = $name identical — skipped"
      else
        echo "  ≠ $name differs from repo:"
        diff -rq "$entry" "$rdir/$name" 2>/dev/null | head -3 | sed 's/^/        /'
        read -rp "        keep (r)epo version or (m)achine version? [r/m]: " c
        case "$c" in
          m) rm -rf "$rdir/$name"; cp -R "$entry" "$rdir/$name"; echo "        → machine version kept" ;;
          *) echo "        → repo version kept" ;;
        esac
      fi
    else
      cp -R "$entry" "$rdir/$name"
      echo "  + $name adopted into rig"
    fi
  done
}

# settle <live_path> <repo_target> <label> — ensure live_path is a symlink to repo_target
settle() {
  local path="$1" target="$2" label="$3" choice
  if [ -L "$path" ]; then
    if [ "$(readlink "$path")" = "$target" ]; then echo "✓ $path"; return; fi
    echo "! $path is a symlink to $(readlink "$path") — replacing"
    rm "$path"
  elif [ -e "$path" ]; then
    echo "⚠ $path already exists ($label)"
    read -rp "  (m)erge into repo / (b)ackup+replace / (a)bort [m/b/a]: " choice
    case "$choice" in
      b) mv "$path" "$path.pre-rig"; echo "  → moved aside to $path.pre-rig" ;;
      m)
        if [ -d "$path" ] && [ -d "$target" ]; then
          merge_dir "$path" "$target"
        else
          echo "  --- diff (machine vs repo) ---"
          diff "$path" "$target" 2>/dev/null | head -10 || echo "  (binary or unreadable — showing nothing)"
          read -rp "  (b)ackup machine copy + install repo version / (a)bort [b/a]: " choice
          [ "$choice" = "a" ] && { echo "aborted — $path untouched"; exit 1; }
        fi
        mv "$path" "$path.pre-rig"
        echo "  → machine version moved aside to $path.pre-rig"
        ;;
      *) echo "aborted — $path untouched"; exit 1 ;;
    esac
  fi
  ln -s "$target" "$path"
  echo "✓ $path → $target"
}

settle "$PI_AGENT/extensions" "$REPO/extensions" "pi extensions"
settle "$PI_AGENT/agents"     "$REPO/agents"     "subagent definitions"
settle "$PI_AGENT/prompts"    "$REPO/prompts"    "workflow prompts"
settle "$AGENTS_HOME/skills"  "$REPO/skills"     "shared skills (pi + codex)"
settle "$PI_AGENT/APPEND_SYSTEM.md" "$REPO/APPEND_SYSTEM.md" "system-prompt addendum"

# settings.json: template on first install only (live file accumulates machine state)
if [ ! -f "$PI_AGENT/settings.json" ]; then
  cp "$REPO/settings.json" "$PI_AGENT/settings.json"
  echo "✓ settings.json installed from template"
else
  echo "· settings.json exists — left alone (diff against repo/settings.json if needed)"
fi

echo
echo "Done. Restart pi sessions to pick up extensions/skills."
