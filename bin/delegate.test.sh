#!/usr/bin/env bash
# Smoke test for bin/delegate using a fake pi (PI_BIN). No API cost.
# Usage: bin/delegate.test.sh
set -euo pipefail

TESTS_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DELEGATE="$TESTS_DIR/delegate"
TMP="$(mktemp -d /tmp/delegate-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

RUNS="$TMP/runs"
WTS="$TMP/wt"
FAKE_PI="$TMP/fake-pi"

fails=0
check() { # <name> <command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "✓ $name"
  else
    echo "✗ $name"; fails=$((fails + 1))
  fi
}

# Fake pi: parses --session-dir/--session-id/--session, honours ME_PI_TEST_* knobs,
# writes a cost record, prints a final marker.
cat > "$FAKE_PI" <<'FAKE'
#!/usr/bin/env bash
set -uo pipefail
prev=""
for arg in "$@"; do
  case "$prev" in
    --session-dir) session_dir="$arg" ;;
    --session-id|--session) session_id="$arg" ;;
  esac
  prev="$arg"
done
[ -n "${session_dir:-}" ] || { echo "no session dir" >&2; exit 90; }
[ -n "${session_id:-}" ] || { echo "no session id" >&2; exit 90; }
mkdir -p "$session_dir"
cost="${ME_PI_TEST_COST:-0}"
printf '{"message":{"usage":{"cost":{"total":%s}}}}\n' "$cost" > "$session_dir/usage.jsonl"
if [ "${ME_PI_TEST_CHECK_SHIM:-0}" = "1" ]; then
  resolved_pi="$(command -v pi || true)"
  case "$resolved_pi" in
    */shim/pi) : ;;
    *) echo "shim missing: got $resolved_pi" >&2; exit 63 ;;
  esac
fi
if [ -n "${ME_PI_TEST_FAIL_IF_CWD:-}" ] && [ "$PWD" = "$ME_PI_TEST_FAIL_IF_CWD" ]; then
  echo "child ran in forbidden cwd: $PWD" >&2
  exit 96
fi
[ -n "${ME_PI_TEST_SLEEP:-}" ] && sleep "$ME_PI_TEST_SLEEP"
echo "TASK-DONE-MARKER"
exit "${ME_PI_TEST_EXIT:-0}"
FAKE
chmod +x "$FAKE_PI"

export PATH_FAKE="PI_BIN=$FAKE_PI"
d() { PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$RUNS" ME_PI_WT_ROOT="$WTS" "$DELEGATE" "$@"; }

# ── 1. sync run, success ────────────────────────────────────────────────
out="$(printf 'do a thing\nto: %s\n' "$TMP" | d run reviewer - -C "$TMP")"
check "sync run prints result" grep -q "TASK-DONE-MARKER" <<<"$out"
check "sync run exit sentinel" grep -q "exit=0" <<<"$out"
run_id="$(ls "$RUNS" | head -1)"
check "run dir session has cost" grep -q '"total"' "$RUNS/$run_id/session/usage.jsonl"
check "task copied" grep -q "do a thing" "$RUNS/$run_id/task.md"

# ── 2. role resolution ─────────────────────────────────────────────────
if d run nobody /dev/null -C "$TMP" >/dev/null 2>&1; then echo "✗ unknown role rejected"; fails=$((fails+1)); else echo "✓ unknown role rejected"; fi

# ── 3. nested pi blocked via shim ──────────────────────────────────────
ME_PI_TEST_CHECK_SHIM=1 d run reviewer - -C "$TMP" <<< "shim check" > "$TMP/shim.out" 2>&1 || true
grep -q "TASK-DONE-MARKER" "$TMP/shim.out" && echo "✓ shim enforced (fake pi saw shim)" || { echo "✗ shim enforced"; fails=$((fails+1)); }

# ── 4. background run + wait ───────────────────────────────────────────
printf 'bg task\n' > "$TMP/task-b.md"
bg_id="$(ME_PI_TEST_SLEEP=2 PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$RUNS" ME_PI_WT_ROOT="$WTS" "$DELEGATE" run reviewer "$TMP/task-b.md" -b -C "$TMP")"
[ -n "$bg_id" ] || { echo "✗ bg id printed"; fails=$((fails+1)); }
d wait "$bg_id" > "$TMP/wait.out" 2>&1
check "wait prints result" grep -q "TASK-DONE-MARKER" "$TMP/wait.out"
check "wait exit sentinel" grep -q "exit=0" "$TMP/wait.out"

# ── 5. timeout cap ─────────────────────────────────────────────────────
ME_PI_TEST_SLEEP=30 d run reviewer - -C "$TMP" -t 2 > "$TMP/timeout.out" 2>&1 || true
grep -q "stopped early: timeout" "$TMP/timeout.out" && echo "✓ timeout enforced" || { echo "✗ timeout enforced"; fails=$((fails+1)); }
timeout_id="$(ls -t "$RUNS" | head -1)"
grep -q "^timeout$" "$RUNS/$timeout_id/why" || { echo "✗ timeout why file"; fails=$((fails+1)); }

# ── 6. cost cap ────────────────────────────────────────────────────────
ME_PI_TEST_SLEEP=30 ME_PI_TEST_COST=5 d run reviewer - -C "$TMP" -t 60 -c 0.5 > "$TMP/cost.out" 2>&1 || true
grep -q "stopped early: cost-cap" "$TMP/cost.out" && echo "✓ cost cap enforced" || { echo "✗ cost cap enforced"; fails=$((fails+1)); }

# ── 7. kill ────────────────────────────────────────────────────────────
bg2="$(ME_PI_TEST_SLEEP=60 PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$RUNS" ME_PI_WT_ROOT="$WTS" "$DELEGATE" run reviewer "$TMP/task-b.md" -b -C "$TMP")"
sleep 1
d kill "$bg2" >/dev/null 2>&1 && echo "✓ kill accepted" || { echo "✗ kill accepted"; fails=$((fails+1)); }
sleep 2
d ls | grep -q "$bg2" && echo "✓ ls lists killed run" || { echo "✗ ls lists killed run"; fails=$((fails+1)); }

# ── 8. worktree creation ───────────────────────────────────────────────
git init -q "$TMP/repo" 2>/dev/null
git -C "$TMP/repo" commit -q --allow-empty -m init
printf 'wt task\n' > "$TMP/task-wt.md"
# Fake pi fails if cwd is the -C dir; success proves the child ran in the worktree.
ME_PI_TEST_FAIL_IF_CWD="$TMP/repo" d run reviewer "$TMP/task-wt.md" -w -C "$TMP/repo" > "$TMP/wt.out" 2>&1 || true
ls "$WTS" | grep -q "^repo-" && echo "✓ worktree created" || { echo "✗ worktree created"; fails=$((fails+1)); }
# child ran inside the worktree: the fake pi only succeeds when cwd != -C dir
check "child cwd is the worktree" grep -q "exit=0" <<<"$(cat "$TMP/wt.out")"

# ── 9. ask ─────────────────────────────────────────────────────────────
d ask "$bg_id" "status?" 2>/dev/null | grep -q "TASK-DONE-MARKER" && echo "✓ ask resumes session" || { echo "✗ ask resumes session"; fails=$((fails+1)); }

# ── 10. child failure propagates ───────────────────────────────────────
ME_PI_TEST_EXIT=3 d run reviewer - -C "$TMP" > "$TMP/fail.out" 2>&1 && { echo "✗ nonzero child exit propagates"; fails=$((fails+1)); } || echo "✓ nonzero child exit propagates"

echo
if [ "$fails" -eq 0 ]; then echo "delegate smoke test: all passed"; else echo "delegate smoke test: $fails failure(s)"; exit 1; fi
