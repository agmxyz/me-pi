#!/usr/bin/env bash
# Install me-pi: link repo-owned policy into live Pi/agent directories and register packages.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd -P)"
PI_AGENT="$HOME/.pi/agent"

if ! command -v pi >/dev/null 2>&1; then
  echo "✗ pi is required to register this rig and its packages" >&2
  exit 1
fi

# The global policy link. An existing file or other link is preserved and reported; the run
# continues (packages still install) but exits non-zero, because the policy is not active.
POLICY_PROBLEM=""
link_policy() {
  local source="$REPO/GLOBAL_AGENTS.md" destination="$PI_AGENT/AGENTS.md"
  if [ -L "$destination" ] && [ "$(readlink "$destination")" = "$source" ]; then
    echo "✓ global AGENTS.md"
  elif [ -e "$destination" ] || [ -L "$destination" ]; then
    POLICY_PROBLEM="$destination already exists and is not a link to $source; left unchanged, so the me-pi policy is NOT active. Move it aside (or merge it into GLOBAL_AGENTS.md) and re-run ./install.sh."
    echo "✗ $POLICY_PROBLEM" >&2
  else
    ln -s "$source" "$destination"
    echo "✓ global AGENTS.md"
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

mkdir -p "$PI_AGENT/extensions"
link_policy

# Register the root Pi package first. The old extensions-directory source has a
# separate identity, so remove it only after the root registration succeeds.
pi install "$REPO"
configured_packages="$(pi list)"
if printf '%s\n' "$configured_packages" | grep -Fq -- "$REPO/extensions"; then
  pi remove "$REPO/extensions"
fi
pi install npm:pi-web-access@0.38.0

# Install the replacement first; keep the old extension if installation fails.
pi install https://github.com/earendil-works/pi-claude-code
# Remove each registered source exactly as listed, pinned (`@version`) or not.
configured_packages="$(pi list)"
old_auth_sources="$(printf '%s\n' "$configured_packages" | awk -v old="npm:@gotgenes/pi-anthropic-auth" \
  '$1 == old || index($1, old "@") == 1 { print $1 }')"
while IFS= read -r source; do
  [ -n "$source" ] && pi remove "$source"
done <<< "$old_auth_sources"

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
if [ -n "$POLICY_PROBLEM" ]; then
  echo "✗ Incomplete: $POLICY_PROBLEM" >&2
  exit 1
fi
echo "Done. Restart pi sessions to load the updated rig."
