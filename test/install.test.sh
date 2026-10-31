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
for relative in (
    "skills/implement-me-pi/SKILL.md",
    "skills/implement-spec-me-pi/SKILL.md",
):
    original = os.path.join(source, relative)
    if not os.path.isfile(original):
        continue
    destination = os.path.join(fixture, relative)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copy2(original, destination)
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
    if [ -n "${ME_PI_TEST_PI_FAIL_INSTALL:-}" ] && [ "$command" = install ] && [ "$source" = "$ME_PI_TEST_PI_FAIL_INSTALL" ]; then
      echo "✗ injected fixture failure: refusing to register $source" >&2
      exit 75
    fi
    node - "$settings" "$command" "$source" <<'NODE'
const fs = require("node:fs");
const [settingsPath, command, requestedSource] = process.argv.slice(2);
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
const sourceOf = entry => typeof entry === "string" ? entry : entry?.source;
const sourceIdentity = source => {
  if (typeof source !== "string" || !source.startsWith("npm:")) return source;
  const packageName = source.slice("npm:".length);
  const versionSeparator = packageName.startsWith("@")
    ? packageName.indexOf("@", packageName.indexOf("/") + 1)
    : packageName.indexOf("@");
  return `npm:${versionSeparator < 0 ? packageName : packageName.slice(0, versionSeparator)}`;
};
settings.packages ??= [];
if (command === "install") {
  const existingIndex = settings.packages.findIndex(entry =>
    sourceIdentity(sourceOf(entry)) === sourceIdentity(requestedSource),
  );
  if (existingIndex < 0) {
    settings.packages.push(requestedSource);
  } else if (sourceOf(settings.packages[existingIndex]) !== requestedSource) {
    const existing = settings.packages[existingIndex];
    settings.packages[existingIndex] = typeof existing === "string"
      ? requestedSource
      : { ...existing, source: requestedSource };
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
  local description="$1" output
  shift
  checks=$((checks + 1))
  output="$TMP/check-$checks.out"
  if "$@" >"$output" 2>&1; then
    echo "✓ $description"
  else
    echo "✗ $description"
    while IFS= read -r line; do printf '  %s\n' "$line"; done < "$output"
    fails=$((fails + 1))
  fi
}

assert_link() { [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]; }
assert_skill_links() {
  local agent_dir="$1" repo_root="$2"
  assert_link "$agent_dir/skills/implement-me-pi" "$repo_root/skills/implement-me-pi" &&
    assert_link "$agent_dir/skills/implement-spec-me-pi" "$repo_root/skills/implement-spec-me-pi"
}
SKILL_LOADER_RUN=0
run_skill_loader() { # <home> <agent dir> <mode> <project...>; disable package installation/network while probing resource discovery.
  local home="$1" agent_dir="$2" mode="$3" project settings="$2/settings.json" backup status=0
  shift 3
  SKILL_LOADER_RUN=$((SKILL_LOADER_RUN + 1))
  backup="$TMP/skill-settings-$SKILL_LOADER_RUN.json"
  cp "$settings" "$backup"
  node - "$settings" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const settings = JSON.parse(fs.readFileSync(path, "utf8"));
settings.packages = [];
fs.writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
NODE
  rm -f "$NPM_MARKER"
  for project in "$@"; do
    HOME="$home" PI_CODING_AGENT_DIR="$agent_dir" PATH="$TEST_PATH" \
      node "$SOURCE_REPO/test/fixtures/user-skill-discovery-harness.mjs" "$project" $mode || { status=1; break; }
  done
  cp "$backup" "$settings"
  rm -f "$backup"
  if [ -e "$NPM_MARKER" ]; then status=1; fi
  return "$status"
}
assert_skill_discovery() {
  run_skill_loader "$1" "$2" "" "${@:3}"
}
assert_renamed_pilot_collision() {
  run_skill_loader "$1" "$2" "--renamed-pilot-collision" "${@:3}"
}
assert_file_text() { printf '%s\n' "$2" | cmp -s - "$1"; }
assert_file_lacks_text() { ! grep -Fq -- "$2" "$1"; }

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
if (sources.filter(source => source === "npm:pi-web-access").length !== 1) process.exit(1);
if (sources.some(source => source?.startsWith("npm:pi-web-access@"))) process.exit(1);
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
if (sources.filter(source => source === "npm:pi-web-access").length !== 1) process.exit(1);
if (sources.some(source => source?.startsWith("npm:pi-web-access@"))) process.exit(1);
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
    "install npm:pi-web-access" \
    "install $FIXTURE" \
    "list" \
    "install npm:pi-web-access" > "$expected"
  printf '%s\n' \
    "init --global --agent pi" \
    "init --global --agent pi" > "$expected_rtk"
  cmp -s "$expected" "$PI_LOG" && cmp -s "$expected_rtk" "$RTK_LOG"
}

assert_single_install_logs() {
  local expected="$TMP/expected-single-pi.log" expected_rtk="$TMP/expected-single-rtk.log"
  printf '%s\n' "install $FIXTURE" "list" "install npm:pi-web-access" > "$expected"
  printf '%s\n' "init --global --agent pi" > "$expected_rtk"
  cmp -s "$expected" "$PI_LOG" && cmp -s "$expected_rtk" "$RTK_LOG"
}

HOME_FRESH="$TMP/home-fresh"
PI_AGENT="$HOME_FRESH/.pi/agent"
AGENTS_HOME="$HOME_FRESH/.agents"
ORIGINAL_IMPLEMENT="$AGENTS_HOME/skills/implement/SKILL.md"
ORIGINAL_IMPLEMENT_SPEC="$AGENTS_HOME/skills/implement-spec/SKILL.md"
PRESERVED_PILOT="$HOME_FRESH/preserved-pilot/implement-spec-me-pi.pilot-bak"
PRESERVED_PILOT_SKILL='---
name: implement-spec-me-pi
description: Complete isolated pilot backup fixture.
disable-model-invocation: true
---

Synthetic pilot backup; preserve every file.'
PRESERVED_PILOT_REFERENCE='Reference material from the isolated pilot.'
PRESERVED_PILOT_SCRIPT='#!/usr/bin/env bash
printf "%s\\n" "pilot fixture"'
mkdir -p "$PI_AGENT" "$(dirname "$ORIGINAL_IMPLEMENT")" "$(dirname "$ORIGINAL_IMPLEMENT_SPEC")" "$PRESERVED_PILOT/references" "$PRESERVED_PILOT/scripts"
cat > "$ORIGINAL_IMPLEMENT" <<'SKILL'
---
name: implement
description: Isolated fixture for the existing implement skill.
disable-model-invocation: true
---

Original implement fixture; preserve this content.
SKILL
cat > "$ORIGINAL_IMPLEMENT_SPEC" <<'SKILL'
---
name: implement-spec
description: Isolated fixture for the existing implement-spec skill.
disable-model-invocation: true
---

Original implement-spec fixture; preserve this content.
SKILL
printf '%s\n' "$PRESERVED_PILOT_SKILL" > "$PRESERVED_PILOT/SKILL.md"
printf '%s\n' "$PRESERVED_PILOT_REFERENCE" > "$PRESERVED_PILOT/references/plan.md"
printf '%s\n' "$PRESERVED_PILOT_SCRIPT" > "$PRESERVED_PILOT/scripts/verify.sh"
node - "$PI_AGENT/settings.json" <<'NODE'
const fs = require("node:fs");
const settingsPath = process.argv[2];
fs.writeFileSync(settingsPath, `${JSON.stringify({ packages: ["npm:@gotgenes/pi-anthropic-auth", "npm:pi-web-access@0.38.0"] }, null, 2)}\n`);
NODE

expect_installer "install leaves existing auth packages alone" 0 "$HOME_FRESH" "$TMP/fresh.out"

if [ "$INSTALL_RC" -ne 0 ]; then
  echo "--- fresh installer output ---"
  printf '%s\n' "$(<"$TMP/fresh.out")"
  echo "install smoke test: $fails failure(s) across $checks check(s)"
  exit 1
fi

check "fresh global AGENTS link" assert_link "$PI_AGENT/AGENTS.md" "$FIXTURE/GLOBAL_AGENTS.md"
check "both repo skills linked once at user level" assert_skill_links "$PI_AGENT" "$FIXTURE"
mkdir -p "$TMP/target-project-one" "$TMP/target-project-two"
check "real Pi discovers repo skills and existing originals from two projects" assert_skill_discovery "$HOME_FRESH" "$PI_AGENT" "$TMP/target-project-one" "$TMP/target-project-two"
check "preserved pilot backup remains outside discovered roots" test -d "$PRESERVED_PILOT" -a ! -e "$AGENTS_HOME/skills/implement-spec-me-pi.pilot-bak" -a ! -L "$AGENTS_HOME/skills/implement-spec-me-pi.pilot-bak"
check "preserved pilot SKILL remains intact" assert_file_text "$PRESERVED_PILOT/SKILL.md" "$PRESERVED_PILOT_SKILL"
check "preserved pilot reference remains intact" assert_file_text "$PRESERVED_PILOT/references/plan.md" "$PRESERVED_PILOT_REFERENCE"
check "preserved pilot support script remains intact" assert_file_text "$PRESERVED_PILOT/scripts/verify.sh" "$PRESERVED_PILOT_SCRIPT"
check "existing implement original remains unchanged" assert_file_text "$ORIGINAL_IMPLEMENT" $'---\nname: implement\ndescription: Isolated fixture for the existing implement skill.\ndisable-model-invocation: true\n---\n\nOriginal implement fixture; preserve this content.'
check "existing implement-spec original remains unchanged" assert_file_text "$ORIGINAL_IMPLEMENT_SPEC" $'---\nname: implement-spec\ndescription: Isolated fixture for the existing implement-spec skill.\ndisable-model-invocation: true\n---\n\nOriginal implement-spec fixture; preserve this content.'
check "root package registered and pinned web-access source migrated" assert_packages_registered "$PI_AGENT/settings.json" "$FIXTURE"
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
check "repeat preserves machine settings, package identity, and unrelated packages" assert_settings_preserved "$PI_AGENT/settings.json" "$FIXTURE"
check "repeat preserves credential contents" assert_file_text "$PI_AGENT/auth.json" 'credential sentinel: never overwrite'
check "repeat preserves external extension" assert_file_text "$PI_AGENT/extensions/external-extension.ts" 'external extension sentinel'
check "repeat preserves external skill" assert_file_text "$AGENTS_HOME/skills/external-skill/SKILL.md" 'external skill sentinel'
check "repeat keeps both repo skill links idempotent" assert_skill_links "$PI_AGENT" "$FIXTURE"
check "repeat preserves pilot SKILL" assert_file_text "$PRESERVED_PILOT/SKILL.md" "$PRESERVED_PILOT_SKILL"
check "repeat preserves pilot reference" assert_file_text "$PRESERVED_PILOT/references/plan.md" "$PRESERVED_PILOT_REFERENCE"
check "repeat preserves pilot support script" assert_file_text "$PRESERVED_PILOT/scripts/verify.sh" "$PRESERVED_PILOT_SCRIPT"
check "repeat preserves implement original" assert_file_text "$ORIGINAL_IMPLEMENT" $'---\nname: implement\ndescription: Isolated fixture for the existing implement skill.\ndisable-model-invocation: true\n---\n\nOriginal implement fixture; preserve this content.'
check "repeat preserves implement-spec original" assert_file_text "$ORIGINAL_IMPLEMENT_SPEC" $'---\nname: implement-spec\ndescription: Isolated fixture for the existing implement-spec skill.\ndisable-model-invocation: true\n---\n\nOriginal implement-spec fixture; preserve this content.'
check "repeat retains interactive-shell contents" cmp -s "$PI_AGENT/extensions/interactive-shell.ts" "$FAKE_ROOT/examples/extensions/interactive-shell.ts"
check "repeat retains handoff contents" cmp -s "$PI_AGENT/extensions/handoff.ts" "$FAKE_ROOT/examples/extensions/handoff.ts"
check "repeat retains global AGENTS link" assert_link "$PI_AGENT/AGENTS.md" "$FIXTURE/GLOBAL_AGENTS.md"
check "repeat preserves existing Anthropic auth package" assert_package_source_registered "$PI_AGENT/settings.json" "npm:@gotgenes/pi-anthropic-auth"
check "Pi and RTK stubs invoked without auth extension changes" assert_invocation_logs
check "npm fallback remains unused" test ! -e "$NPM_MARKER"

# A failing root registration is not rolled back: the policy and skill pointers created before
# `pi install` remain, later steps do not run, and pre-existing user state stays untouched.
HOME_PARTIAL="$TMP/home-partial-registration"
PARTIAL_AGENT="$HOME_PARTIAL/.pi/agent"
PARTIAL_SETTINGS="$PARTIAL_AGENT/settings.json"
PARTIAL_SETTINGS_BACKUP="$TMP/partial-settings-before.json"
mkdir -p "$PARTIAL_AGENT/extensions" "$HOME_PARTIAL/.agents/skills/external-skill"
node - "$PARTIAL_SETTINGS" <<'NODE'
const fs = require("node:fs");
const settingsPath = process.argv[2];
fs.writeFileSync(settingsPath, `${JSON.stringify({
  theme: "light",
  machinePreference: "keep-this",
  lastChangelogVersion: "test-version",
  packages: [
    "npm:@gotgenes/pi-anthropic-auth",
    "npm:external-string@1.2.3",
    { source: "npm:external-object@4.5.6", config: { keep: true } },
  ],
}, null, 2)}\n`);
NODE
printf '%s\n' 'credential sentinel: never overwrite' > "$PARTIAL_AGENT/auth.json"
printf '%s\n' 'external extension sentinel' > "$PARTIAL_AGENT/extensions/external-extension.ts"
printf '%s\n' 'external skill sentinel' > "$HOME_PARTIAL/.agents/skills/external-skill/SKILL.md"
cp "$PARTIAL_SETTINGS" "$PARTIAL_SETTINGS_BACKUP"
: > "$PI_LOG"
: > "$RTK_LOG"
rm -f "$NPM_MARKER"
ME_PI_TEST_PI_FAIL_INSTALL="$FIXTURE"
export ME_PI_TEST_PI_FAIL_INSTALL
expect_installer "failing root registration exits nonzero" 75 "$HOME_PARTIAL" "$TMP/partial-registration.out"
unset ME_PI_TEST_PI_FAIL_INSTALL
printf '%s\n' "install $FIXTURE" > "$TMP/expected-partial-failure-pi.log"
check "failed registration reports the injected failure" grep -Fq "injected fixture failure: refusing to register $FIXTURE" "$TMP/partial-registration.out"
check "failed registration reports no misleading Done" assert_file_lacks_text "$TMP/partial-registration.out" "Done."
check "failed registration retains created global policy link" assert_link "$PARTIAL_AGENT/AGENTS.md" "$FIXTURE/GLOBAL_AGENTS.md"
check "failed registration retains created skill links" assert_skill_links "$PARTIAL_AGENT" "$FIXTURE"
check "failed registration stops after the attempted root install" cmp -s "$TMP/expected-partial-failure-pi.log" "$PI_LOG"
check "failed registration invokes no RTK setup" test ! -s "$RTK_LOG"
check "failed registration copies no Pi examples" test ! -e "$PARTIAL_AGENT/extensions/interactive-shell.ts" -a ! -e "$PARTIAL_AGENT/extensions/handoff.ts"
check "failed registration leaves pre-existing settings untouched" cmp -s "$PARTIAL_SETTINGS_BACKUP" "$PARTIAL_SETTINGS"
check "failed registration preserves credential contents" assert_file_text "$PARTIAL_AGENT/auth.json" 'credential sentinel: never overwrite'
check "failed registration preserves external extension" assert_file_text "$PARTIAL_AGENT/extensions/external-extension.ts" 'external extension sentinel'
check "failed registration preserves external skill" assert_file_text "$HOME_PARTIAL/.agents/skills/external-skill/SKILL.md" 'external skill sentinel'
check "failed registration leaves npm fallback unused" test ! -e "$NPM_MARKER"

# The installer checks literal destination paths, not every discovered skill's frontmatter name.
# A renamed pilot under .agents/skills passes path preflight but must remain a visible real-loader collision.
HOME_RENAMED="$TMP/home-renamed-pilot"
RENAMED_AGENT="$HOME_RENAMED/.pi/agent"
RENAMED_PILOT="$HOME_RENAMED/.agents/skills/implement-spec-me-pi.pilot-bak"
RENAMED_PILOT_CONTENT=$'---\nname: implement-spec-me-pi\ndescription: Renamed isolated pilot collision fixture.\ndisable-model-invocation: true\n---\n\nPreserve this complete renamed pilot.'
mkdir -p "$RENAMED_AGENT" "$HOME_RENAMED/.agents/skills/implement" "$HOME_RENAMED/.agents/skills/implement-spec" "$RENAMED_PILOT/references" "$RENAMED_PILOT/scripts" "$TMP/target-project-three" "$TMP/target-project-four"
cp "$ORIGINAL_IMPLEMENT" "$HOME_RENAMED/.agents/skills/implement/SKILL.md"
cp "$ORIGINAL_IMPLEMENT_SPEC" "$HOME_RENAMED/.agents/skills/implement-spec/SKILL.md"
printf '%s\n' "$RENAMED_PILOT_CONTENT" > "$RENAMED_PILOT/SKILL.md"
printf '%s\n' 'Renamed pilot reference must remain intact.' > "$RENAMED_PILOT/references/plan.md"
printf '%s\n' '#!/usr/bin/env bash' 'echo preserve' > "$RENAMED_PILOT/scripts/verify.sh"
: > "$PI_LOG"
: > "$RTK_LOG"
expect_installer "renamed pilot with duplicate frontmatter is outside literal-path preflight" 0 "$HOME_RENAMED" "$TMP/renamed-pilot.out"
check "renamed pilot still yields a real-loader collision from two projects" assert_renamed_pilot_collision "$HOME_RENAMED" "$RENAMED_AGENT" "$TMP/target-project-three" "$TMP/target-project-four"
check "renamed pilot source remains intact" assert_file_text "$RENAMED_PILOT/SKILL.md" "$RENAMED_PILOT_CONTENT"
check "renamed pilot supporting files remain intact" test -f "$RENAMED_PILOT/references/plan.md" -a -f "$RENAMED_PILOT/scripts/verify.sh"

# An already-correct policy link is accepted without blocking package setup.
HOME_PRELINK="$TMP/home-prelink"
PRELINK_AGENT="$HOME_PRELINK/.pi/agent"
mkdir -p "$PRELINK_AGENT"
ln -s "$FIXTURE/GLOBAL_AGENTS.md" "$PRELINK_AGENT/AGENTS.md"
: > "$PI_LOG"
: > "$RTK_LOG"
expect_installer "existing correct global AGENTS link succeeds" 0 "$HOME_PRELINK" "$TMP/prelink.out"
check "existing correct global AGENTS link remains valid" assert_link "$PRELINK_AGENT/AGENTS.md" "$FIXTURE/GLOBAL_AGENTS.md"
check "existing correct global AGENTS link registers packages" assert_packages_registered "$PRELINK_AGENT/settings.json" "$FIXTURE"
check "existing correct global AGENTS link permits normal Pi and RTK setup" assert_single_install_logs

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
  "install npm:pi-web-access" > "$TMP/expected-upgrade-pi.log"
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
  "install npm:pi-web-access" >> "$TMP/expected-upgrade-pi.log"
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

# A policy collision fails before creating extensions/settings or invoking Pi/RTK.
: > "$PI_LOG"
: > "$RTK_LOG"
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
  check "global AGENTS $kind collision is reported during preflight" grep -Fq "$destination already exists and is not a link to $FIXTURE/GLOBAL_AGENTS.md" "$TMP/agents-$kind.out"
  check "global AGENTS $kind collision creates no settings file" test ! -e "$HOME_SHARED/.pi/agent/settings.json"
  check "global AGENTS $kind collision creates no extensions directory" test ! -e "$HOME_SHARED/.pi/agent/extensions"
  check "global AGENTS $kind collision invokes neither Pi nor RTK" test ! -s "$PI_LOG" -a ! -s "$RTK_LOG"
  if [ "$kind" = file ]; then
    check "global AGENTS file collision remains a regular file" test ! -L "$destination"
  else
    check "global AGENTS link collision retains its target" assert_link "$destination" "$target"
  fi
done
check "shared-document collision checks invoke no network npm" test ! -e "$NPM_MARKER"

# Skill file, link, and name collisions refuse the entire install before mutation.
for kind in skill-file skill-link pilot-name; do
  HOME_SKILL_COLLISION="$TMP/home-skill-$kind"
  COLLISION_AGENT="$HOME_SKILL_COLLISION/.pi/agent"
  mkdir -p "$COLLISION_AGENT"
  case "$kind" in
    skill-file)
      collision_path="$COLLISION_AGENT/skills/implement-me-pi"
      other_skill_path="$COLLISION_AGENT/skills/implement-spec-me-pi"
      mkdir -p "$(dirname "$collision_path")"
      printf '%s\n' 'user skill file sentinel' > "$collision_path"
      expected_collision_message="$collision_path already exists and is not a link"
      ;;
    skill-link)
      collision_path="$COLLISION_AGENT/skills/implement-spec-me-pi"
      other_skill_path="$COLLISION_AGENT/skills/implement-me-pi"
      collision_target="$TMP/user-skill-link-sentinel.md"
      mkdir -p "$(dirname "$collision_path")"
      printf '%s\n' 'user skill link sentinel' > "$collision_target"
      ln -s "$collision_target" "$collision_path"
      expected_collision_message="$collision_path already exists and is not a link"
      ;;
    pilot-name)
      collision_path="$HOME_SKILL_COLLISION/.agents/skills/implement-spec-me-pi/SKILL.md"
      other_skill_path="$COLLISION_AGENT/skills/implement-me-pi"
      PILOT_CONTENT=$'---\nname: implement-spec-me-pi\ndescription: Isolated personal pilot collision fixture.\ndisable-model-invocation: true\n---\n\nPersonal pilot source remains intact.'
      mkdir -p "$(dirname "$collision_path")"
      printf '%s\n' "$PILOT_CONTENT" > "$collision_path"
      expected_collision_message="user skill name collision at $(dirname "$collision_path")"
      ;;
  esac
  : > "$PI_LOG"
  : > "$RTK_LOG"
  expect_installer "$kind collision fails before install effects" 1 "$HOME_SKILL_COLLISION" "$TMP/skill-$kind.out"
  check "$kind collision is reported during preflight" grep -Fq "$expected_collision_message" "$TMP/skill-$kind.out"
  check "$kind collision preserves the existing entry" test -e "$collision_path"
  check "$kind collision creates no settings file" test ! -e "$COLLISION_AGENT/settings.json"
  check "$kind collision creates no extensions directory" test ! -e "$COLLISION_AGENT/extensions"
  check "$kind collision creates no other skill pointer" test ! -e "$other_skill_path" -a ! -L "$other_skill_path"
  if [ "$kind" = pilot-name ]; then
    check "pilot name collision creates neither repo skill pointer" test ! -e "$COLLISION_AGENT/skills/implement-me-pi" -a ! -L "$COLLISION_AGENT/skills/implement-me-pi" -a ! -e "$COLLISION_AGENT/skills/implement-spec-me-pi" -a ! -L "$COLLISION_AGENT/skills/implement-spec-me-pi"
  fi
  check "$kind collision creates no global policy link" test ! -e "$COLLISION_AGENT/AGENTS.md" -a ! -L "$COLLISION_AGENT/AGENTS.md"
  check "$kind collision invokes neither Pi nor RTK" test ! -s "$PI_LOG" -a ! -s "$RTK_LOG"
  case "$kind" in
    skill-file) check "skill file collision remains a regular file" test ! -L "$collision_path" ;;
    skill-link) check "skill link collision retains its target" assert_link "$collision_path" "$collision_target" ;;
    pilot-name) check "personal pilot content remains intact" assert_file_text "$collision_path" "$PILOT_CONTENT" ;;
  esac
done
check "skill collision preflight invokes no network npm" test ! -e "$NPM_MARKER"

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
