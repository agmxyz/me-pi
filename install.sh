#!/usr/bin/env bash
# Install me-pi without making machine-owned resource directories repo write targets.
set -euo pipefail
shopt -s dotglob nullglob

REPO="$(cd "$(dirname "$0")" && pwd -P)"
PI_AGENT="$HOME/.pi/agent"
AGENTS_HOME="$HOME/.agents"

physical_dir() {
  (cd "$1" 2>/dev/null && pwd -P) || return 1
}

is_tracked() {
  git -C "$REPO" ls-files --error-unmatch -- "$1" >/dev/null 2>&1
}

is_inside_repo() {
  local path="$1" root
  root="$(physical_dir "$REPO")"
  [ "$path" = "$root" ] || [[ "$path" == "$root/"* ]]
}

# Refuse any existing ancestor of the install paths that resolves into the repo;
# mkdir -p would otherwise create missing children through such a link.
check_repo_free_ancestors() {
  local probe="$1" resolved
  while [ -n "$probe" ] && [ "$probe" != "/" ]; do
    if [ -e "$probe" ] || [ -L "$probe" ]; then
      resolved="$(physical_dir "$probe" || true)"
      if [ -n "$resolved" ] && is_inside_repo "$resolved"; then
        echo "✗ $probe resolves into this repo ($resolved); move it outside the repo before installing" >&2
        return 1
      fi
    fi
    probe="$(dirname "$probe")"
  done
  return 0
}
check_repo_free_ancestors "$PI_AGENT" || exit 1
check_repo_free_ancestors "$AGENTS_HOME" || exit 1

mkdir -p "$PI_AGENT" "$AGENTS_HOME"

# Move untracked entries out of legacy repo-backed agent/skill directories.
# These may have been installed through the old symlink; keep them live, not tracked here.
migrate_legacy_agent_entries() {
  local path="$PI_AGENT/agents" current target staging source name
  [ -L "$path" ] || return 0
  current="$(physical_dir "$path" || true)"
  target="$(physical_dir "$REPO/agents")"
  [ "$current" = "$target" ] || return 0
  staging="$(mktemp -d "$PI_AGENT/.agents-migration.XXXXXX")"
  for source in "$REPO"/agents/*; do
    [ -e "$source" ] || [ -L "$source" ] || continue
    name="$(basename "$source")"
    if ! is_tracked "agents/$name"; then cp -R "$source" "$staging/$name"; fi
  done
  [ -n "$(find "$staging" -mindepth 1 -maxdepth 1 -print -quit)" ] || { rmdir "$staging"; return 0; }
  rm "$path"
  mkdir -p "$path"
  for source in "$staging"/*; do
    [ -e "$source" ] || continue
    name="$(basename "$source")"
    mv "$source" "$path/$name"
    rm -rf "$REPO/agents/$name"
    echo "↪ moved untracked agent $name to the live directory"
  done
  rmdir "$staging" 2>/dev/null || true
}

# Move untracked skills out; back up untracked/ignored files inside tracked
# skills so every repo skill can be linked individually into the live dir.
migrate_legacy_skill_entries() {
  local path="$AGENTS_HOME/skills" current target staging source name relative backup has_work=0
  [ -L "$path" ] || return 0
  current="$(physical_dir "$path" || true)"
  target="$(physical_dir "$REPO/skills")"
  [ "$current" = "$target" ] || return 0

  staging="$(mktemp -d "$AGENTS_HOME/.skills-migration.XXXXXX")"
  backup="$AGENTS_HOME/.me-pi-migration"
  if [ -e "$backup" ] || [ -L "$backup" ]; then
    backup_resolved="$(physical_dir "$backup" || true)"
    if [ -n "$backup_resolved" ] && is_inside_repo "$backup_resolved"; then
      echo "✗ $backup resolves into this repo ($backup_resolved); move it outside the repo before installing" >&2
      return 1
    fi
  fi
  for source in "$REPO"/skills/*; do
    [ -e "$source" ] || [ -L "$source" ] || continue
    name="$(basename "$source")"
    if ! is_tracked "skills/$name"; then
      cp -R "$source" "$staging/$name"
      has_work=1
    else
      while IFS= read -r -d '' relative; do
        destination="$backup/$relative"
        if [ -e "$destination" ] || [ -L "$destination" ]; then
          suffix=1
          base="$destination.$(date +%Y%m%d%H%M%S)"
          while [ -e "$base.$suffix" ] || [ -L "$base.$suffix" ]; do
            suffix=$((suffix + 1))
          done
          destination="$base.$suffix"
        fi
        # mkdir -p follows symlinks beneath the backup root; refuse any
        # ancestor that would route the copy into the repo.
        check_repo_free_ancestors "$destination" || return 1
        mkdir -p "$(dirname "$destination")"
        cp -R "$REPO/$relative" "$destination"
        echo "↪ preserved untracked $relative at $destination (outside the live skills)"
        has_work=1
      done < <(git -C "$REPO" ls-files --others -z -- "skills/$name")
    fi
  done

  [ "$has_work" -eq 1 ] || { rm -rf "$staging"; return 0; }

  rm "$path" # unlink only; do not add a trailing slash
  mkdir -p "$path"
  for source in "$staging"/*; do
    [ -e "$source" ] || continue
    name="$(basename "$source")"
    mv "$source" "$path/$name"
    rm -rf "$REPO/skills/$name"
    echo "↪ moved untracked skill $name to the live directory"
  done
  rm -rf "$staging"

  # Remove the backed-up untracked files so each tracked skill links cleanly.
  for source in "$REPO"/skills/*; do
    [ -e "$source" ] || continue
    name="$(basename "$source")"
    is_tracked "skills/$name" || continue
    while IFS= read -r -d '' relative; do rm -rf "$REPO/$relative"; done < <(git -C "$REPO" ls-files --others -z -- "skills/$name")
    find "$REPO/skills/$name" -depth -type d -empty -delete 2>/dev/null || true
  done
}

# Detach legacy extension links into this repo without losing other extensions.
# Project-owned package entrypoints stay in the local Pi package; external and
# user extensions are copied outward to the live directory, never into the repo.
migrate_legacy_extensions() {
  local path="$PI_AGENT/extensions" current target staging source name entry destination
  [ -L "$path" ] || return 0
  current="$(physical_dir "$path" || true)"
  target="$(physical_dir "$REPO/extensions")"
  [ "$current" = "$target" ] || return 0

  staging="$(mktemp -d "$PI_AGENT/.extensions-migration.XXXXXX")"
  for source in "$REPO"/extensions/*; do
    [ -e "$source" ] || continue
    name="$(basename "$source")"
    case "$name" in
      me-setup.ts|*.test.*|package.json|package-lock.json|node_modules)
        continue
        ;;
    esac
    cp -R "$source" "$staging/$name"
  done

  echo "↪ migrating non-project extensions from the legacy repo-backed directory"
  rm "$path" # unlink only; do not add a trailing slash
  mkdir -p "$path"
  for entry in "$staging"/*; do
    [ -e "$entry" ] || continue
    destination="$path/$(basename "$entry")"
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      echo "⚠ $destination already exists; retained migration copy at $entry" >&2
      continue
    fi
    name="$(basename "$entry")"
    mv "$entry" "$destination"
    if [ -z "$(git -C "$REPO" ls-files -- "extensions/$name")" ]; then
      rm -rf "$REPO/extensions/$name"
      echo "↪ moved untracked extension $name out of the repo"
    fi
  done
  rmdir "$staging" 2>/dev/null || true
}

# Detach only legacy whole-directory links into this repo. Never copy live files
# back into the repo. Links to other locations and real user directories stay put.
reject_repo_directory_link() {
  local path="$1" current
  [ -L "$path" ] || return 0
  if [ ! -d "$path" ]; then
    echo "✗ $path is not a directory; fix it before installing" >&2
    return 1
  fi
  current="$(physical_dir "$path" || true)"
  if [ -z "$current" ]; then
    echo "✗ $path is a broken symlink; fix it before installing" >&2
    return 1
  elif is_inside_repo "$current"; then
    echo "✗ $path points into this repo: $current" >&2
    echo "  move Pi's package store outside the repo before installing" >&2
    return 1
  fi
  return 0
}

ensure_live_dir() {
  local path="$1" repo_dir="$2" label="$3" current target
  target="$(physical_dir "$repo_dir")"
  if [ -L "$path" ]; then
    current="$(physical_dir "$path" || true)"
    if [ "$current" = "$target" ]; then
      echo "↪ migrating $label directory link to a machine-owned directory"
      rm "$path" # unlink only; do not add a trailing slash
      mkdir -p "$path"
    elif [ -z "$current" ]; then
      echo "✗ $path is a broken symlink; fix it before installing" >&2
      return 1
    elif is_inside_repo "$current"; then
      echo "✗ $path points into this repo at an unexpected location: $current" >&2
      echo "  migrate it manually before installing; external tools must not write into the repo" >&2
      return 1
    else
      echo "· $path points outside this repo; leaving it alone"
    fi
  elif [ -e "$path" ]; then
    if [ ! -d "$path" ]; then
      echo "✗ $path exists but is not a directory" >&2
      return 1
    fi
  else
    mkdir -p "$path"
  fi
}

# Link only repo-owned resources into real user directories. Existing machine
# resources are preserved; name collisions are reported, never overwritten.
link_entry() {
  local source="$1" destination="$2" label="$3" existing
  if [ -L "$destination" ]; then
    existing="$(readlink "$destination")"
    if [ "$existing" = "$source" ]; then
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

link_repo_agents() {
  local source name
  for source in "$REPO"/agents/*.md; do
    [ -f "$source" ] || continue
    name="$(basename "$source")"
    if ! is_tracked "agents/$name"; then
      echo "⚠ untracked repo agent $name; left out of live config"
      continue
    fi
    link_entry "$source" "$PI_AGENT/agents/$name" "agent $name"
  done
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

find_pi_example() {
  local pi_bin pi_real dir candidate npm_root
  pi_bin="$(command -v pi || true)"
  if [ -n "$pi_bin" ]; then
    pi_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$pi_bin" 2>/dev/null || true)"
    if [ -n "$pi_real" ]; then
      dir="$(dirname "$pi_real")"
      for _ in 1 2 3 4 5 6; do
        if [ -f "$dir/examples/extensions/interactive-shell.ts" ]; then
          printf '%s\n' "$dir/examples/extensions/interactive-shell.ts"
          return 0
        fi
        dir="$(dirname "$dir")"
      done
    fi
  fi

  if command -v npm >/dev/null 2>&1; then
    npm_root="$(npm root -g 2>/dev/null || true)"
    candidate="$npm_root/@earendil-works/pi-coding-agent/examples/extensions/interactive-shell.ts"
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  return 1
}

install_interactive_shell() {
  local destination="$PI_AGENT/extensions/interactive-shell.ts" source
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "· interactive-shell.ts already exists; leaving it unchanged"
    return 0
  fi
  source="$(find_pi_example || true)"
  if [ -z "$source" ]; then
    echo "⚠ Pi's interactive-shell example not found; skipped (install Pi's npm package or copy it manually)"
    return 0
  fi
  cp "$source" "$destination"
  echo "✓ interactive-shell.ts copied from the installed Pi example"
}

prepare_local_extension_slots() {
  local name source destination backup backup_base backup_suffix
  for name in me-setup.ts; do
    source="$REPO/extensions/$name"
    destination="$PI_AGENT/extensions/$name"
    if [ -L "$destination" ] && [ "$(readlink "$destination")" = "$source" ]; then
      rm "$destination"
      echo "↪ removed duplicate link for package-owned extension $name"
    elif [ -f "$destination" ] && [ -f "$source" ] && [ "$destination" -ef "$source" ]; then
      # Legacy whole-dir symlink still active: the live entry IS the repo source.
      echo "· $name is the repo source through a legacy link; migration handles it"
    elif [ -e "$destination" ] || [ -L "$destination" ]; then
      if [ -f "$source" ] && [ -f "$destination" ] && cmp -s "$source" "$destination"; then
        backup="$destination.pre-me-pi"
        if [ -e "$backup" ] || [ -L "$backup" ]; then
          backup_base="$backup.$(date +%Y%m%d%H%M%S)"
          backup_suffix=1
          while [ -e "$backup_base.$backup_suffix" ] || [ -L "$backup_base.$backup_suffix" ]; do
            backup_suffix=$((backup_suffix + 1))
          done
          backup="$backup_base.$backup_suffix"
        fi
        mv "$destination" "$backup"
        echo "↪ moved duplicate $name to $backup"
      else
        echo "✗ $destination conflicts with the me-pi package; resolve it before installing" >&2
        return 1
      fi
    fi
  done
}

# Pi updates settings and package stores; fail before any migration if they can write into the repo.
if [ -L "$PI_AGENT/settings.json" ]; then
  echo "✗ $PI_AGENT/settings.json is symlinked; make it a real machine-local file first" >&2
  exit 1
fi
reject_repo_directory_link "$PI_AGENT/npm"
reject_repo_directory_link "$PI_AGENT/git"

migrate_legacy_extensions
migrate_legacy_agent_entries
migrate_legacy_skill_entries
ensure_live_dir "$PI_AGENT/extensions" "$REPO/extensions" "extensions"
prepare_local_extension_slots
ensure_live_dir "$PI_AGENT/agents" "$REPO/agents" "agents"
ensure_live_dir "$AGENTS_HOME/skills" "$REPO/skills" "skills"
link_repo_agents
link_repo_skills
link_entry "$REPO/APPEND_SYSTEM.md" "$PI_AGENT/APPEND_SYSTEM.md" "APPEND_SYSTEM.md"
link_entry "$REPO/CODING_STANDARDS.md" "$AGENTS_HOME/CODING_STANDARDS.md" "shared coding standards"
link_entry "$REPO/specs/delegate.md" "$AGENTS_HOME/DELEGATION.md" "delegation guide"
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

if ! command -v pi >/dev/null 2>&1; then
  echo "✗ pi is required to register this rig and its packages" >&2
  exit 1
fi
pi install "$REPO/extensions"
pi install npm:pi-web-access@0.33.0
node - "$PI_AGENT/settings.json" <<'NODE'
const fs = require("node:fs");
const settingsPath = process.argv[2];
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
let foundWebAccess = false;
const packages = [];
for (const entry of settings.packages ?? []) {
  const source = typeof entry === "string" ? entry : entry?.source;
  const isWebAccess = typeof source === "string" && /^npm:pi-web-access(?:@|$)/.test(source);
  if (!isWebAccess) {
    packages.push(entry);
    continue;
  }
  if (foundWebAccess) continue;
  foundWebAccess = true;
  packages.push(typeof entry === "string"
    ? "npm:pi-web-access@0.33.0"
    : { ...entry, source: "npm:pi-web-access@0.33.0" });
}
if (!foundWebAccess) throw new Error("pinned Pi package entry missing after pi install");
settings.packages = packages;
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
echo "✓ pinned pi-web-access package entry"

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
