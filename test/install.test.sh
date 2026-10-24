#!/usr/bin/env bash
# Hermetic install regression test: all HOME/package writes stay under /tmp.
# Usage: test/install.test.sh
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
// Deterministic Pi interactive-shell fixture.
export const exampleMarker = "temporary pi interactive-shell";
EXAMPLE
cat > "$FAKE_ROOT/examples/extensions/handoff.ts" <<'EXAMPLE'
// Deterministic Pi handoff fixture.
export const handoffMarker = "temporary pi handoff";
EXAMPLE

cat > "$FAKE_BIN/pi" <<'PI'
#!/usr/bin/env bash
set -euo pipefail
command="${1:-}"
settings="$HOME/.pi/agent/settings.json"
case "$command" in
  install|remove)
    [ "$#" -eq 2 ] || {
      echo "fake pi expects: pi $command <source>" >&2
      exit 90
    }
    source="$2"
    printf '%s %s\n' "$command" "$source" >> "$ME_PI_TEST_PI_LOG"
    node - "$settings" "$command" "$source" <<'NODE'
const fs = require("node:fs");
const [settingsPath, command, requestedSource] = process.argv.slice(2);
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
const sourceOf = entry => typeof entry === "string" ? entry : entry?.source;
settings.packages ??= [];
if (command === "install") {
  if (!settings.packages.some(entry => sourceOf(entry) === requestedSource)) {
    settings.packages.push(requestedSource);
  }
} else {
  const packages = settings.packages.filter(entry => sourceOf(entry) !== requestedSource);
  if (packages.length === settings.packages.length) process.exit(1);
  settings.packages = packages;
}
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
    ;;
  list)
    [ "$#" -eq 1 ] || {
      echo "fake pi expects: pi list" >&2
      exit 90
    }
    printf '%s\n' list >> "$ME_PI_TEST_PI_LOG"
    node - "$settings" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const settingsPath = process.argv[2];
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
for (const entry of settings.packages ?? []) {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (!source) continue;
  console.log(`  ${source}${typeof entry === "object" ? " (filtered)" : ""}`);
  if (path.isAbsolute(source) && fs.existsSync(source)) console.log(`    ${path.resolve(source)}`);
}
NODE
    ;;
  *)
    echo "fake pi only supports: pi install|remove <source> and pi list" >&2
    exit 90
    ;;
esac
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

assert_packages_registered() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [settingsPath, repoRoot] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const sources = (settings.packages ?? []).map(entry =>
  typeof entry === "string" ? entry : entry?.source,
);
if (sources.filter(source => source === repoRoot).length !== 1) process.exit(1);
if (sources.includes(`${repoRoot}/extensions`)) process.exit(1);
if (sources.filter(source => source === "npm:pi-web-access@0.38.0").length !== 1) process.exit(1);
if (sources.includes("https://github.com/earendil-works/pi-claude-code")) process.exit(1);
NODE
}

assert_package_source_registered() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [settingsPath, expectedSource] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const sources = (settings.packages ?? []).map(entry =>
  typeof entry === "string" ? entry : entry?.source,
);
if (sources.filter(source => source === expectedSource).length !== 1) process.exit(1);
NODE
}

assert_settings_preserved() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [settingsPath, repoRoot] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const packages = settings.packages ?? [];
const sources = packages.map(entry => typeof entry === "string" ? entry : entry?.source);
const externalObject = packages.find(entry => entry?.source === "npm:external-object@4.5.6");
if (settings.theme !== "light" || settings.machinePreference !== "keep-this") process.exit(1);
if (settings.lastChangelogVersion !== "test-version") process.exit(1);
if (sources.filter(source => source === repoRoot).length !== 1) process.exit(1);
if (sources.includes(`${repoRoot}/extensions`)) process.exit(1);
if (sources.filter(source => source === "npm:pi-web-access@0.38.0").length !== 1) process.exit(1);
if (sources.includes("https://github.com/earendil-works/pi-claude-code")) process.exit(1);
if (sources.filter(source => source === "npm:external-string@1.2.3").length !== 1) process.exit(1);
if (!externalObject || externalObject.config?.keep !== true) process.exit(1);
NODE
}

assert_invocation_logs() {
  local expected="$TMP/expected-pi.log" expected_rtk="$TMP/expected-rtk.log"
  printf '%s\n' \
    "install $FIXTURE" \
    "list" \
    "install npm:pi-web-access@0.38.0" \
    "install $FIXTURE" \
    "list" \
    "install npm:pi-web-access@0.38.0" > "$expected"
  printf '%s\n' \
    "init --global --agent pi" \
    "init --global --agent pi" > "$expected_rtk"
  cmp -s "$expected" "$PI_LOG" && cmp -s "$expected_rtk" "$RTK_LOG"
}

HOME_FRESH="$TMP/home-fresh"
PI_AGENT="$HOME_FRESH/.pi/agent"
AGENTS_HOME="$HOME_FRESH/.agents"
mkdir -p "$PI_AGENT"
node - "$PI_AGENT/settings.json" <<'NODE'
const fs = require("node:fs");
const settingsPath = process.argv[2];
fs.writeFileSync(settingsPath, `${JSON.stringify({ packages: ["npm:@gotgenes/pi-anthropic-auth"] }, null, 2)}\n`);
NODE

expect_installer "install leaves existing auth packages alone" 0 "$HOME_FRESH" "$TMP/fresh.out"

if [ "$INSTALL_RC" -ne 0 ]; then
  echo "--- fresh installer output ---"
  printf '%s\n' "$(<"$TMP/fresh.out")"
  echo "install smoke test: $fails failure(s) across $checks check(s)"
  exit 1
fi

check "fresh global AGENTS link" assert_link "$PI_AGENT/AGENTS.md" "$FIXTURE/GLOBAL_AGENTS.md"
check "root package registered without Claude auth extension" assert_packages_registered "$PI_AGENT/settings.json" "$FIXTURE"
check "existing Anthropic auth package remains registered" assert_package_source_registered "$PI_AGENT/settings.json" "npm:@gotgenes/pi-anthropic-auth"
check "interactive-shell example copied" cmp -s "$PI_AGENT/extensions/interactive-shell.ts" "$FAKE_ROOT/examples/extensions/interactive-shell.ts"
check "handoff example copied" cmp -s "$PI_AGENT/extensions/handoff.ts" "$FAKE_ROOT/examples/extensions/handoff.ts"
check "RTK setup invoked with Pi agent" grep -Fxq "init --global --agent pi" "$RTK_LOG"
check "npm fallback not invoked" test ! -e "$NPM_MARKER"

# Add machine-owned state before the idempotent reinstall.
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

expect_installer "repeat install succeeds" 0 "$HOME_FRESH" "$TMP/repeat.out"
check "repeat preserves machine settings and unrelated packages" assert_settings_preserved "$PI_AGENT/settings.json" "$FIXTURE"
check "repeat preserves credential contents" assert_file_text "$PI_AGENT/auth.json" 'credential sentinel: never overwrite'
check "repeat preserves external extension" assert_file_text "$PI_AGENT/extensions/external-extension.ts" 'external extension sentinel'
check "repeat preserves external skill" assert_file_text "$AGENTS_HOME/skills/external-skill/SKILL.md" 'external skill sentinel'
check "repeat retains interactive-shell contents" cmp -s "$PI_AGENT/extensions/interactive-shell.ts" "$FAKE_ROOT/examples/extensions/interactive-shell.ts"
check "repeat retains handoff contents" cmp -s "$PI_AGENT/extensions/handoff.ts" "$FAKE_ROOT/examples/extensions/handoff.ts"
check "repeat retains global AGENTS link" assert_link "$PI_AGENT/AGENTS.md" "$FIXTURE/GLOBAL_AGENTS.md"
check "repeat preserves existing Anthropic auth package" assert_package_source_registered "$PI_AGENT/settings.json" "npm:@gotgenes/pi-anthropic-auth"
check "Pi and RTK stubs invoked without auth extension changes" assert_invocation_logs
check "npm fallback remains unused" test ! -e "$NPM_MARKER"

# Upgrade a previous extensions-directory registration, including a filtered object.
HOME_UPGRADE="$TMP/home-upgrade"
UPGRADE_AGENT="$HOME_UPGRADE/.pi/agent"
mkdir -p "$UPGRADE_AGENT"
node - "$UPGRADE_AGENT/settings.json" "$FIXTURE/extensions" <<'NODE'
const fs = require("node:fs");
const [settingsPath, oldSource] = process.argv.slice(2);
const settings = {
  theme: "light",
  machinePreference: "keep-this",
  lastChangelogVersion: "test-version",
  packages: [
    { source: oldSource, extensions: ["./guard.ts"] },
    "npm:@gotgenes/pi-anthropic-auth@1.2.3",
    "npm:external-string@1.2.3",
    { source: "npm:external-object@4.5.6", config: { keep: true } },
  ],
};
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
: > "$PI_LOG"
printf '%s\n' \
  "install $FIXTURE" \
  "list" \
  "remove $FIXTURE/extensions" \
  "install npm:pi-web-access@0.38.0" > "$TMP/expected-upgrade-pi.log"
expect_installer "upgrade from extensions package succeeds" 0 "$HOME_UPGRADE" "$TMP/upgrade.out"
check "upgrade registers root and removes old filtered source" assert_settings_preserved "$UPGRADE_AGENT/settings.json" "$FIXTURE"
check "upgrade preserves the pinned Anthropic auth package" assert_package_source_registered "$UPGRADE_AGENT/settings.json" "npm:@gotgenes/pi-anthropic-auth@1.2.3"
check "upgrade invokes no auth extension install or removal" cmp -s "$TMP/expected-upgrade-pi.log" "$PI_LOG"
expect_installer "repeat upgrade succeeds" 0 "$HOME_UPGRADE" "$TMP/upgrade-repeat.out"
check "repeat upgrade remains idempotent and preserves unrelated state" assert_settings_preserved "$UPGRADE_AGENT/settings.json" "$FIXTURE"
check "repeat upgrade preserves the pinned Anthropic auth package" assert_package_source_registered "$UPGRADE_AGENT/settings.json" "npm:@gotgenes/pi-anthropic-auth@1.2.3"
printf '%s\n' \
  "install $FIXTURE" \
  "list" \
  "install npm:pi-web-access@0.38.0" >> "$TMP/expected-upgrade-pi.log"
check "repeat upgrade invokes no auth extension install or removal" cmp -s "$TMP/expected-upgrade-pi.log" "$PI_LOG"
check "upgrade never invokes npm fallback" test ! -e "$NPM_MARKER"

# Missing pi must fail before any link is created.
HOME_NOPI="$TMP/home-no-pi"
mkdir -p "$HOME_NOPI"
cp "$PI_LOG" "$TMP/pi-before-no-pi.log"
NO_PI_BIN="$TMP/no-pi-bin"
mkdir -p "$NO_PI_BIN"
for tool in bash git dirname basename mkdir ln cp rm readlink realpath head cat; do
  ln -sf "$(command -v $tool)" "$NO_PI_BIN/$tool"
done
saved_path="$TEST_PATH"
TEST_PATH="$NO_PI_BIN"
expect_installer "missing pi refused" 1 "$HOME_NOPI" "$TMP/no-pi.out"
TEST_PATH="$saved_path"
check "missing pi explains requirement" grep -Fq 'pi is required' "$TMP/no-pi.out"
check "missing pi creates no live directories" test ! -e "$HOME_NOPI/.pi"
check "refusal invokes no package install" cmp -s "$TMP/pi-before-no-pi.log" "$PI_LOG"
check "no network-capable npm invocation" test ! -e "$NPM_MARKER"

# An existing AGENTS.md is preserved; packages still install, but the run fails loudly.
sentinel='user global AGENTS sentinel'
for kind in file link; do
  HOME_SHARED="$TMP/home-agents-$kind"
  destination="$HOME_SHARED/.pi/agent/AGENTS.md"
  mkdir -p "$HOME_SHARED/.pi/agent"
  if [ "$kind" = file ]; then
    printf '%s\n' "$sentinel" > "$destination"
  else
    target="$TMP/user-agents-$kind.md"
    printf '%s\n' "$sentinel" > "$target"
    ln -s "$target" "$destination"
  fi
  expect_installer "global AGENTS $kind collision fails" 1 "$HOME_SHARED" "$TMP/agents-$kind.out"
  check "global AGENTS $kind collision preserves contents" assert_file_text "$destination" "$sentinel"
  check "global AGENTS $kind collision reported at the end" grep -Eq "^✗ Incomplete: .*AGENTS.md.*policy is NOT active" "$TMP/agents-$kind.out"
  check "global AGENTS $kind collision still registers root packages" assert_packages_registered "$HOME_SHARED/.pi/agent/settings.json" "$FIXTURE"
  if [ "$kind" = file ]; then
    check "global AGENTS file collision remains a regular file" test ! -L "$destination"
  else
    check "global AGENTS link collision retains its target" assert_link "$destination" "$target"
  fi
done
check "shared-document collision checks invoke no network npm" test ! -e "$NPM_MARKER"

# A Pi upgrade changes the bundled example: the copy is kept and the drift reported with the fix.
printf '%s\n' '// upgraded Pi handoff' > "$FAKE_ROOT/examples/extensions/handoff.ts"
printf '%s\n' '// locally edited handoff' > "$PI_AGENT/extensions/handoff.ts"
expect_installer "install after a Pi example changed succeeds" 0 "$HOME_FRESH" "$TMP/drift.out"
check "changed example left unchanged" assert_file_text "$PI_AGENT/extensions/handoff.ts" '// locally edited handoff'
# The source path is resolved (/tmp may become /private/tmp), so match its resolved form.
check "changed example reported with the update command" grep -Fq "handoff.ts differs from the installed Pi example (Pi upgrade or local edits); left unchanged. To update: cp $(printf '%q %q' "$(realpath "$FAKE_ROOT")/examples/extensions/handoff.ts" "$PI_AGENT/extensions/handoff.ts")" "$TMP/drift.out"
check "unchanged example reported as matching" grep -Fq "interactive-shell.ts matches the installed Pi example" "$TMP/drift.out"

echo
if [ "$fails" -eq 0 ]; then
  echo "install smoke test: all $checks checks passed"
else
  echo "install smoke test: $fails failure(s) across $checks check(s)"
  exit 1
fi
