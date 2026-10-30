#!/usr/bin/env bash
# Install me-pi: link repo-owned policy and skills into live Pi/agent directories, then register packages.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd -P)"
PI_AGENT="$HOME/.pi/agent"

if ! command -v pi >/dev/null 2>&1; then
  echo "✗ pi is required to register this rig and its packages" >&2
  exit 1
fi

# Refuse a policy collision before creating directories or changing Pi/RTK state.
POLICY_SOURCE="$REPO/GLOBAL_AGENTS.md"
POLICY_DESTINATION="$PI_AGENT/AGENTS.md"
if [ -e "$POLICY_DESTINATION" ] || [ -L "$POLICY_DESTINATION" ]; then
  if [ ! -L "$POLICY_DESTINATION" ] || [ "$(readlink "$POLICY_DESTINATION")" != "$POLICY_SOURCE" ]; then
    echo "✗ $POLICY_DESTINATION already exists and is not a link to $POLICY_SOURCE; left unchanged. Move it aside (or merge it into GLOBAL_AGENTS.md) and re-run ./install.sh." >&2
    exit 1
  fi
fi

SKILLS_SOURCE="$REPO/skills"
SKILLS_DESTINATION="$PI_AGENT/skills"
# This checks literal destination paths only; Pi's loader remains authoritative for frontmatter-name collisions elsewhere.
GLOBAL_SKILLS_DESTINATION="$HOME/.agents/skills"
if [ -L "$SKILLS_DESTINATION" ]; then
  echo "✗ $SKILLS_DESTINATION is a link; refusing to add skill pointers through it." >&2
  exit 1
elif [ -e "$SKILLS_DESTINATION" ] && [ ! -d "$SKILLS_DESTINATION" ]; then
  echo "✗ $SKILLS_DESTINATION exists and is not a directory; left unchanged." >&2
  exit 1
fi

for skill in implement-me-pi implement-spec-me-pi; do
  source="$SKILLS_SOURCE/$skill"
  destination="$SKILLS_DESTINATION/$skill"
  global_name="$GLOBAL_SKILLS_DESTINATION/$skill"
  if [ ! -d "$source" ] || [ ! -f "$source/SKILL.md" ]; then
    echo "✗ repo skill source is missing: $source/SKILL.md" >&2
    exit 1
  fi
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    if [ ! -L "$destination" ] || [ "$(readlink "$destination")" != "$source" ]; then
      echo "✗ $destination already exists and is not a link to $source; left unchanged. Resolve the collision explicitly and re-run ./install.sh." >&2
      exit 1
    fi
  fi
  if [ -e "$global_name" ] || [ -L "$global_name" ]; then
    echo "✗ user skill name collision at $global_name; left unchanged. Preserve and resolve the existing skill separately before re-running ./install.sh." >&2
    exit 1
  fi
done

link_policy() {
  if [ -L "$POLICY_DESTINATION" ] && [ "$(readlink "$POLICY_DESTINATION")" = "$POLICY_SOURCE" ]; then
    echo "✓ global AGENTS.md"
  else
    ln -s "$POLICY_SOURCE" "$POLICY_DESTINATION"
    echo "✓ global AGENTS.md"
  fi
}

install_skill_pointer() {
  local skill="$1" source="$SKILLS_SOURCE/$1" destination="$SKILLS_DESTINATION/$1"
  if [ -L "$destination" ] && [ "$(readlink "$destination")" = "$source" ]; then
    echo "✓ skill $skill"
  else
    ln -s "$source" "$destination"
    echo "✓ skill $skill"
  fi
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

# Copies a Pi example once; later runs never overwrite it (it may hold local edits) but report
# when it differs from the installed Pi's example, e.g. after a Pi upgrade.
install_pi_example() {
  local name="$1" destination="$PI_AGENT/extensions/$1" source
  source="$(find_pi_example "$name" || true)"
  if [ -z "$source" ]; then
    echo "⚠ Pi's $name example not found; skipped (copy it manually)"
  elif [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
    cp "$source" "$destination"
    echo "✓ $name copied from the installed Pi example"
  elif cmp -s "$source" "$destination"; then
    echo "✓ $name matches the installed Pi example"
  else
    echo "⚠ $name differs from the installed Pi example (Pi upgrade or local edits); left unchanged. To update: cp $(printf '%q %q' "$source" "$destination")"
  fi
}

mkdir -p "$PI_AGENT/extensions" "$SKILLS_DESTINATION"
link_policy
install_skill_pointer implement-me-pi
install_skill_pointer implement-spec-me-pi

# Register the root Pi package first. The old extensions-directory source has a
# separate identity, so remove it only after the root registration succeeds.
pi install "$REPO"
configured_packages="$(pi list)"
if printf '%s\n' "$configured_packages" | grep -Fq -- "$REPO/extensions"; then
  pi remove "$REPO/extensions"
fi
pi install npm:pi-web-access

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
