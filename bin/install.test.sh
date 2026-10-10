#!/usr/bin/env bash
# Hermetic install regression test: all HOME/package writes stay under /tmp.
# Usage: bin/install.test.sh
set -euo pipefail

TESTS_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO="$(cd "$TESTS_DIR/.." && pwd -P)"
TMP="$(mktemp -d /tmp/install-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# Fixture Git operations must not load the user's signing policy or hooks.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

FIXTURE="$TMP/rig"
mkdir -p "$FIXTURE"
FIXTURE="$(cd "$FIXTURE" && pwd -P)"
# Test the candidate working tree, not the previous commit; deleted tracked
# files stay absent. Untracked user files are not installer-owned resources.
python3 - "$SOURCE_REPO" "$FIXTURE" <<'PY'
import os
import shutil
import subprocess
import sys

source, fixture = sys.argv[1:]
tracked = subprocess.check_output(["git", "-C", source, "ls-files", "-z"])
for entry in tracked.split(b"\0"):
    if not entry:
        continue
    relative = os.fsdecode(entry)
    original = os.path.join(source, relative)
    if not os.path.lexists(original):
        continue
    destination = os.path.join(fixture, relative)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copy2(original, destination, follow_symlinks=False)
PY
git init -q --template= "$FIXTURE"
git -C "$FIXTURE" config core.hooksPath /dev/null
git -C "$FIXTURE" config commit.gpgsign false
git -C "$FIXTURE" config user.email install-test@example.invalid
git -C "$FIXTURE" config user.name "Install Test"
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -q -m "initial installer fixture"

FAKE_ROOT="$TMP/fake-pi"
FAKE_BIN="$FAKE_ROOT/bin"
PI_LOG="$TMP/pi-install.log"
RTK_LOG="$TMP/rtk-init.log"
NPM_MARKER="$TMP/npm-was-called"
mkdir -p "$FAKE_BIN" "$FAKE_ROOT/examples/extensions"
: > "$PI_LOG"
: > "$RTK_LOG"
cat > "$FAKE_ROOT/examples/extensions/interactive-shell.ts" <<'EXAMPLE'
// Deterministic Pi example fixture.
export const exampleMarker = "temporary pi example";
EXAMPLE

cat > "$FAKE_BIN/pi" <<'PI'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = install ] && [ "$#" -eq 2 ] || {
  echo "fake pi only supports: pi install <source>" >&2
  exit 90
}
source="$2"
printf '%s\n' "$source" >> "$ME_PI_TEST_PI_LOG"
node - "$HOME/.pi/agent/settings.json" "$source" <<'NODE'
const fs = require("node:fs");
const [settingsPath, requestedSource] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const sourceOf = entry => typeof entry === "string" ? entry : entry?.source;
settings.packages ??= [];
if (!settings.packages.some(entry => sourceOf(entry) === requestedSource)) {
  settings.packages.push(requestedSource);
}
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
PI
cat > "$FAKE_BIN/rtk" <<'RTK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$ME_PI_TEST_RTK_LOG"
RTK
cat > "$FAKE_BIN/npm" <<'NPM'
#!/usr/bin/env bash
set -euo pipefail
: > "$ME_PI_TEST_NPM_MARKER"
echo "network-capable npm must not be called by this test" >&2
exit 91
NPM
chmod +x "$FAKE_BIN/pi" "$FAKE_BIN/rtk" "$FAKE_BIN/npm"
TEST_PATH="$FAKE_BIN:$PATH"

checks=0
fails=0
INSTALL_RC=0
check() { # <description> <command...>
  local description="$1"
  shift
  checks=$((checks + 1))
  if "$@" >/dev/null 2>&1; then
    echo "✓ $description"
  else
    echo "✗ $description"
    fails=$((fails + 1))
  fi
}

assert_link() { [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]; }
assert_file_text() { printf '%s\n' "$2" | cmp -s - "$1"; }

assert_disclosed_documents_reachable() {
  python3 - "$1" "$FIXTURE" <<'PY'
from pathlib import Path
import sys

home, fixture = map(Path, sys.argv[1:])
policy = (home / ".pi/agent/AGENTS.md").read_text()
assert "~/.agents/CODING_STANDARDS.md" in policy
document = home / ".agents/CODING_STANDARDS.md"
assert document.is_file()
assert document.read_bytes() == (fixture / "CODING_STANDARDS.md").read_bytes()
PY
}

run_installer() { # <temporary HOME> <output file>
  local home="$1" output="$2"
  if (cd "$TMP" && HOME="$home" \
    PATH="$TEST_PATH" \
    ME_PI_TEST_PI_LOG="$PI_LOG" \
    ME_PI_TEST_RTK_LOG="$RTK_LOG" \
    ME_PI_TEST_NPM_MARKER="$NPM_MARKER" \
    bash "$FIXTURE/install.sh") > "$output" 2>&1; then
    INSTALL_RC=0
  else
    INSTALL_RC=$?
  fi
}

expect_installer() { # <description> <expected rc> <temporary HOME> <output file>
  local description="$1" expected="$2"
  run_installer "$3" "$4"
  check "$description (exit $expected)" test "$INSTALL_RC" -eq "$expected"
}

assert_settings_seeded() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [settingsPath, repoExtensions] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const sources = (settings.packages ?? []).map(entry =>
  typeof entry === "string" ? entry : entry?.source,
);
if (settings.theme !== "dark") process.exit(1);
if (sources.filter(source => source === repoExtensions).length !== 1) process.exit(1);
if (sources.filter(source => source === "npm:pi-web-access@0.38.0").length !== 1) process.exit(1);
NODE
}

assert_settings_preserved() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [settingsPath, repoExtensions] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const packages = settings.packages ?? [];
const sources = packages.map(entry => typeof entry === "string" ? entry : entry?.source);
const externalObject = packages.find(entry => entry?.source === "npm:external-object@4.5.6");
if (settings.theme !== "light" || settings.machinePreference !== "keep-this") process.exit(1);
if (settings.lastChangelogVersion !== "test-version") process.exit(1);
if (sources.filter(source => source === repoExtensions).length !== 1) process.exit(1);
if (sources.filter(source => source === "npm:pi-web-access@0.38.0").length !== 1) process.exit(1);
if (sources.filter(source => source === "npm:external-string@1.2.3").length !== 1) process.exit(1);
if (!externalObject || externalObject.config?.keep !== true) process.exit(1);
NODE
}

assert_invocation_logs() {
  local expected="$TMP/expected-pi.log" expected_rtk="$TMP/expected-rtk.log"
  printf '%s\n' \
    "$FIXTURE/extensions" \
    "npm:pi-web-access@0.38.0" \
    "$FIXTURE/extensions" \
    "npm:pi-web-access@0.38.0" > "$expected"
  printf '%s\n' \
    "init --global --agent pi" \
    "init --global --agent pi" > "$expected_rtk"
  cmp -s "$expected" "$PI_LOG" && cmp -s "$expected_rtk" "$RTK_LOG"
}

HOME_FRESH="$TMP/home-fresh"
PI_AGENT="$HOME_FRESH/.pi/agent"
AGENTS_HOME="$HOME_FRESH/.agents"
mkdir -p "$HOME_FRESH/.local/bin"
expect_installer "fresh install succeeds" 0 "$HOME_FRESH" "$TMP/fresh.out"

if [ "$INSTALL_RC" -ne 0 ]; then
  echo "--- fresh installer output ---"
  printf '%s\n' "$(<"$TMP/fresh.out")"
  echo "install smoke test: $fails failure(s) across $checks check(s)"
  exit 1
fi

for source in "$FIXTURE"/skills/*; do
  [ -d "$source" ] || continue
  name="$(basename "$source")"
  check "fresh owned skill link $name" assert_link "$AGENTS_HOME/skills/$name" "$source"
done
check "fresh global AGENTS link" assert_link "$PI_AGENT/AGENTS.md" "$FIXTURE/GLOBAL_AGENTS.md"
check "fresh coding standards link" assert_link "$AGENTS_HOME/CODING_STANDARDS.md" "$FIXTURE/CODING_STANDARDS.md"
check "fresh disclosed documents reachable from installed policies" assert_disclosed_documents_reachable "$HOME_FRESH"
check "fresh delegate helper link" assert_link "$HOME_FRESH/.local/bin/delegate" "$FIXTURE/bin/delegate"
check "settings seeded and packages registered" assert_settings_seeded "$PI_AGENT/settings.json" "$FIXTURE/extensions"
check "interactive-shell example copied" cmp -s "$PI_AGENT/extensions/interactive-shell.ts" "$FAKE_ROOT/examples/extensions/interactive-shell.ts"
check "RTK setup invoked with Pi agent" grep -Fxq "init --global --agent pi" "$RTK_LOG"
check "npm fallback not invoked" test ! -e "$NPM_MARKER"

# Add machine-owned state and a skill collision before the idempotent reinstall.
node - "$PI_AGENT/settings.json" <<'NODE'
const fs = require("node:fs");
const settingsPath = process.argv[2];
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
settings.theme = "light";
settings.machinePreference = "keep-this";
settings.lastChangelogVersion = "test-version";
settings.packages.push(
  "npm:external-string@1.2.3",
  { source: "npm:external-object@4.5.6", config: { keep: true } },
);
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
printf '%s\n' 'credential sentinel: never overwrite' > "$PI_AGENT/auth.json"
printf '%s\n' 'external extension sentinel' > "$PI_AGENT/extensions/external-extension.ts"
mkdir -p "$AGENTS_HOME/skills/external-skill"
printf '%s\n' 'external skill sentinel' > "$AGENTS_HOME/skills/external-skill/SKILL.md"
# Keep one non-owned entry at an owned skill name to exercise collision safety.
COLLISION_SKILL="$(basename "$(ls -d "$FIXTURE"/skills/*/ | head -n1)")"
rm "$AGENTS_HOME/skills/$COLLISION_SKILL"
mkdir -p "$AGENTS_HOME/skills/$COLLISION_SKILL"
printf '%s\n' 'user-owned collision sentinel' > "$AGENTS_HOME/skills/$COLLISION_SKILL/SKILL.md"

expect_installer "repeat install succeeds" 0 "$HOME_FRESH" "$TMP/repeat.out"
check "repeat preserves seeded and unrelated settings/packages" assert_settings_preserved "$PI_AGENT/settings.json" "$FIXTURE/extensions"
check "repeat preserves credential contents" assert_file_text "$PI_AGENT/auth.json" 'credential sentinel: never overwrite'
check "repeat preserves external extension" assert_file_text "$PI_AGENT/extensions/external-extension.ts" 'external extension sentinel'
check "repeat preserves external skill" assert_file_text "$AGENTS_HOME/skills/external-skill/SKILL.md" 'external skill sentinel'
check "repeat preserves skill collision" assert_file_text "$AGENTS_HOME/skills/$COLLISION_SKILL/SKILL.md" 'user-owned collision sentinel'
check "collision remains a real directory" test ! -L "$AGENTS_HOME/skills/$COLLISION_SKILL"
check "repeat retains interactive-shell contents" cmp -s "$PI_AGENT/extensions/interactive-shell.ts" "$FAKE_ROOT/examples/extensions/interactive-shell.ts"
for source in "$FIXTURE"/skills/*; do
  [ -d "$source" ] || continue
  name="$(basename "$source")"
  [ "$name" = "$COLLISION_SKILL" ] && continue
  check "repeat retains owned skill link $name" assert_link "$AGENTS_HOME/skills/$name" "$source"
done
check "repeat retains global AGENTS link" assert_link "$PI_AGENT/AGENTS.md" "$FIXTURE/GLOBAL_AGENTS.md"
check "repeat retains coding standards link" assert_link "$AGENTS_HOME/CODING_STANDARDS.md" "$FIXTURE/CODING_STANDARDS.md"
check "repeat disclosed documents remain reachable" assert_disclosed_documents_reachable "$HOME_FRESH"
check "repeat retains delegate helper link" assert_link "$HOME_FRESH/.local/bin/delegate" "$FIXTURE/bin/delegate"
check "Pi and RTK stubs invoked deterministically" assert_invocation_logs
check "npm fallback remains unused" test ! -e "$NPM_MARKER"

# Missing pi must fail before any link is created.
HOME_NOPI="$TMP/home-no-pi"
mkdir -p "$HOME_NOPI"
NO_PI_BIN="$TMP/no-pi-bin"
mkdir -p "$NO_PI_BIN"
for tool in bash git dirname basename mkdir ln cp readlink realpath head cat; do
  ln -sf "$(command -v $tool)" "$NO_PI_BIN/$tool"
done
saved_path="$TEST_PATH"
TEST_PATH="$NO_PI_BIN"
expect_installer "missing pi refused" 1 "$HOME_NOPI" "$TMP/no-pi.out"
TEST_PATH="$saved_path"
check "missing pi explains requirement" grep -Fq 'pi is required' "$TMP/no-pi.out"
check "missing pi creates no live directories" test ! -e "$HOME_NOPI/.pi" -a ! -e "$HOME_NOPI/.agents"
check "refusal invokes no package install" assert_invocation_logs
check "no network-capable npm invocation" test ! -e "$NPM_MARKER"

# Shared documentation uses the same per-file collision policy as other resources.
for document in standards; do
  name=CODING_STANDARDS.md
  sentinel='user coding standards sentinel'
  for kind in file link; do
    HOME_SHARED="$TMP/home-$document-$kind"
    destination="$HOME_SHARED/.agents/$name"
    mkdir -p "$HOME_SHARED/.agents"
    if [ "$kind" = file ]; then
      printf '%s\n' "$sentinel" > "$destination"
    else
      target="$TMP/user-$document-$kind.md"
      printf '%s\n' "$sentinel" > "$target"
      ln -s "$target" "$destination"
    fi
    expect_installer "$document $kind collision install succeeds" 0 "$HOME_SHARED" "$TMP/$document-$kind.out"
    check "$document $kind collision preserves contents" assert_file_text "$destination" "$sentinel"
    check "$document $kind collision reported" grep -Eq "$name.*left unchanged" "$TMP/$document-$kind.out"
    if [ "$kind" = file ]; then
      check "$document file collision remains a regular file" test ! -L "$destination"
    else
      check "$document link collision retains its target" assert_link "$destination" "$target"
    fi
  done
done
check "shared-document collision checks invoke no network npm" test ! -e "$NPM_MARKER"

echo
if [ "$fails" -eq 0 ]; then
  echo "install smoke test: all $checks checks passed"
else
  echo "install smoke test: $fails failure(s) across $checks check(s)"
  exit 1
fi
