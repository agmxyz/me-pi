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
printf '%s\n' "$@" > "$session_dir/args"
printf '%s\n' "$PWD" > "$session_dir/cwd"
cost="${ME_PI_TEST_COST:-0}"
printf '{"message":{"usage":{"cost":{"total":%s}}}}\n' "$cost" > "$session_dir/usage.jsonl"
if [ "${ME_PI_TEST_CHECK_SHIM:-0}" = "1" ]; then
  resolved_pi="$(command -v pi || true)"
  resolved_delegate="$(command -v delegate || true)"
  case "$resolved_pi" in */shim/pi) : ;; *) echo "shim missing: got $resolved_pi" >&2; exit 63 ;; esac
  case "$resolved_delegate" in */shim/delegate) : ;; *) echo "delegate shim missing: got $resolved_delegate" >&2; exit 63 ;; esac
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

d() { HOME="$TMP/home" PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$RUNS" ME_PI_WT_ROOT="$WTS" "$DELEGATE" "$@"; }
# fake pi must not resolve the shim as itself when invoked by name inside runs
export PI_BIN="$FAKE_PI"

# ── 1. sync run, success ────────────────────────────────────────────────
out="$(printf 'do a thing\nto: %s\n' "$TMP" | d run reviewer - -C "$TMP")"
check "sync run prints result" grep -q "TASK-DONE-MARKER" <<<"$out"
check "sync run exit sentinel" grep -q "exit=0" <<<"$out"
run_id="$(ls "$RUNS" | head -1)"
check "run dir session has cost" grep -q '"total"' "$RUNS/$run_id/session/usage.jsonl"
check "task copied" grep -q "do a thing" "$RUNS/$run_id/task.md"
role_file="$RUNS/$run_id/role.md"
check "worker prompt identifies delegated role" grep -Fq "You are a delegated worker, not the coordinator" "$role_file"
check "worker prompt sets context priority" grep -Fq "Task and role constraints take precedence over conflicting project context" "$role_file"
check "worker prompt warns this is not a sandbox" grep -Fq "This is not a sandbox" "$role_file"
check "worker prompt includes concise reporting and docs rule" grep -Fq "When reporting or writing docs, be concise and terse" "$role_file"
check "worker prompt expands for safety risks" grep -Fq "wrong action, security issue, or irreversible mistake" "$role_file"
if grep -Eq "Coordination AND Delegation sections|Stay the coordinator" "$role_file"; then
  echo "✗ worker prompt includes phantom sections or coordinator instructions"; fails=$((fails+1))
else
  echo "✓ worker prompt omits phantom sections and coordinator instructions"
fi

# ── 2. role resolution ─────────────────────────────────────────────────
if d run nobody /dev/null -C "$TMP" >/dev/null 2>&1; then echo "✗ unknown role rejected"; fails=$((fails+1)); else echo "✓ unknown role rejected"; fi

# ── 3. settings override resolves model and thinking ────────────────────
mkdir -p "$TMP/home/.pi/agent"
cat > "$TMP/home/.pi/agent/settings.json" <<'JSON'
{
  "subagents": {
    "agentOverrides": {
      "reviewer": { "model": "test-model", "defaultProvider": "test-provider", "thinking": "minimal" }
    },
    "defaultThinking": "max"
  }
}
JSON
override_out="$(HOME="$TMP/home" d run reviewer - -C "$TMP" <<< "override check")"
override_id="$(ls -t "$RUNS" | head -1)"
check "settings override model passed" grep -Fxq "test-provider/test-model" "$RUNS/$override_id/session/args"
check "settings override thinking passed" grep -Fxq "minimal" "$RUNS/$override_id/session/args"
# -m remains higher precedence than the live settings override.
flag_out="$(HOME="$TMP/home" d run reviewer - -C "$TMP" -m cli/model <<< "flag check")"
flag_id="$(ls -t "$RUNS" | head -1)"
check "-m overrides settings model" grep -Fxq "cli/model" "$RUNS/$flag_id/session/args"
check "-m keeps frontmatter thinking" grep -Fxq "high" "$RUNS/$flag_id/session/args"
# Explicit -T thinking overrides settings/frontmatter.
flag_thinking_out="$(HOME="$TMP/home" d run reviewer - -C "$TMP" -m openai-codex/gpt-6-luna -T max <<< "thinking flag check")"
flag_thinking_id="$(ls -t "$RUNS" | head -1)"
check "-T overrides settings thinking" grep -Fxq "max" "$RUNS/$flag_thinking_id/session/args"

# ── 4. nested pi + delegate blocked via shim ───────────────────────────
ME_PI_TEST_CHECK_SHIM=1 d run reviewer - -C "$TMP" <<< "shim check" > "$TMP/shim.out" 2>&1 || true
grep -q "TASK-DONE-MARKER" "$TMP/shim.out" && echo "✓ shim enforced (fake pi saw shim)" || { echo "✗ shim enforced"; fails=$((fails+1)); }
# nested `delegate` itself must also be shadowed and refuse (exit 64)
rc=0; PATH="$RUNS/$(ls "$RUNS" | tail -1)/shim:$PATH" delegate run reviewer - -C "$TMP" <<< x >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 64 ] && echo "✓ nested delegate refuses" || { echo "✗ nested delegate refuses (rc=$rc)"; fails=$((fails+1)); }

# ── 4. background run + wait ───────────────────────────────────────────
printf 'bg task\n' > "$TMP/task-b.md"
bg_id="$(ME_PI_TEST_SLEEP=2 d run reviewer "$TMP/task-b.md" -b -C "$TMP")"
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

# ── 7b. watchdog survives caller death ─────────────────────────────────
# Coordinator = a process group we kill right after launch. The watchdog must be
# in its own session, still enforce -t, write the sentinel, and stay killable.
coord_out="$TMP/coord.id"
perl -MPOSIX -e 'setsid; exec @ARGV' -- bash -c 'ME_PI_TEST_SLEEP=60 PI_BIN="$1" ME_PI_RUNS_ROOT="$2" ME_PI_WT_ROOT="$3" "$4" run reviewer "$5" -b -t 4 -C "$6" > "$7"; kill -KILL 0' _ "$FAKE_PI" "$RUNS" "$WTS" "$DELEGATE" "$TMP/task-b.md" "$TMP" "$coord_out" 2>/dev/null || true
wd_id="$(cat "$coord_out")"
sleep 1
wd_pid="$(cat "$RUNS/$wd_id/watchdog.pid" 2>/dev/null || echo 0)"
kill -0 "$wd_pid" 2>/dev/null && echo "✓ watchdog alive after coordinator death" || { echo "✗ watchdog alive after coordinator death"; fails=$((fails+1)); }
[ "$(ps -o pgid= -p "$wd_pid" 2>/dev/null | tr -d ' ')" = "$wd_pid" ] && echo "✓ watchdog leads its own process group" || { echo "✗ watchdog leads its own process group"; fails=$((fails+1)); }
for _ in $(seq 1 20); do [ -f "$RUNS/$wd_id/exit" ] && break; sleep 1; done
[ -f "$RUNS/$wd_id/exit" ] && grep -q '^timeout$' "$RUNS/$wd_id/why" && grep -q "$wd_id exit=" "$RUNS/$wd_id/out.md" && echo "✓ orphaned watchdog enforces timeout + writes sentinel" || { echo "✗ orphaned watchdog enforces timeout + writes sentinel"; fails=$((fails+1)); }
bg3="$(ME_PI_TEST_SLEEP=60 PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$RUNS" ME_PI_WT_ROOT="$WTS" "$DELEGATE" run reviewer "$TMP/task-b.md" -b -C "$TMP")"
sleep 1
d kill "$bg3" >/dev/null 2>&1
d wait "$bg3" > "$TMP/wait3.out" 2>&1 || true
grep -q "exit=" "$TMP/wait3.out" && [ -f "$RUNS/$bg3/exit" ] && echo "✓ kill of detached run writes sentinel via watchdog" || { echo "✗ kill of detached run writes sentinel via watchdog"; fails=$((fails+1)); }

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
d ask "$bg_id" "status?" > "$TMP/ask.out" 2>/dev/null
check "ask resumes session" grep -q "TASK-DONE-MARKER" "$TMP/ask.out"
check "ask preserves run model" grep -Fxq "$(sed -n 's/^model: //p' "$RUNS/$bg_id/meta")" "$RUNS/$bg_id/session/args"
check "ask keeps read-only tools" grep -Fxq "read,grep,find,ls" "$RUNS/$bg_id/session/args"
check "ask uses original run cwd" grep -Fxq "$(sed -n 's/^cwd: //p' "$RUNS/$bg_id/meta")" "$RUNS/$bg_id/session/cwd"
check "ask appends full role file" grep -Fxq "$RUNS/$bg_id/role.md" "$RUNS/$bg_id/session/args"
check "ask adds follow-up instruction" grep -Fxq "This is a follow-up, not a restart. Do not redo the original task; honor its original task and output contract." "$RUNS/$bg_id/session/args"

# ── 10. child failure propagates ───────────────────────────────────────
ME_PI_TEST_EXIT=3 d run reviewer - -C "$TMP" > "$TMP/fail.out" 2>&1 && { echo "✗ nonzero child exit propagates"; fails=$((fails+1)); } || echo "✓ nonzero child exit propagates"

# ── 11. ls shows cwd ───────────────────────────────────────────────────
d ls | grep -q "$TMP" && echo "✓ ls shows cwd column" || { echo "✗ ls shows cwd column"; fails=$((fails+1)); }

# ── 12. harvest (fixture: real git repo + worktree + synthetic run dir) ─
H="$TMP/h"; HRUNS="$H/runs"; HWTS="$H/wt"
mkdir -p "$HRUNS" "$HWTS"
hd() { HOME="$TMP/home" PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$HRUNS" ME_PI_WT_ROOT="$HWTS" "$DELEGATE" "$@"; }
git init -q "$H/main"
git -C "$H/main" config user.email t@t; git -C "$H/main" config user.name t
printf 'one\ntwo\nthree\n' > "$H/main/a.txt"
git -C "$H/main" add a.txt; git -C "$H/main" commit -q -m init
mkrun() { # <id> <wt> <origin> — synthetic finished run dir
  mkdir -p "$HRUNS/$1"
  printf 'cwd: %s\nwt: %s\norigin: %s\n' "$2" "$2" "$3" > "$HRUNS/$1/meta"
  echo 0 > "$HRUNS/$1/exit"
}
git -C "$H/main" worktree add -q --detach "$HWTS/w1" HEAD
mkrun r-ok "$HWTS/w1" "$H/main"
printf 'one\nTWO\nthree\n' > "$HWTS/w1/a.txt"
printf 'brand new\n' > "$HWTS/w1/new.txt"
hd harvest r-ok > "$TMP/h1.out" 2>&1 && rc=0 || rc=$?
[ "$rc" -eq 0 ] && grep -q "a.txt" "$TMP/h1.out" && echo "✓ harvest succeeds and prints what it applied" || { echo "✗ harvest succeeds (rc=$rc)"; cat "$TMP/h1.out"; fails=$((fails+1)); }
check "harvest applied edit to main checkout" grep -q '^TWO$' "$H/main/a.txt"
check "harvest applied new file to main checkout" test -f "$H/main/new.txt"
[ -z "$(git -C "$H/main" log --format=%H HEAD..HEAD)" ] && [ "$(git -C "$H/main" rev-list --count HEAD)" = 1 ] && echo "✓ harvest did not commit" || { echo "✗ harvest did not commit"; fails=$((fails+1)); }
check "harvest keeps worktree" test -d "$HWTS/w1"

# conflict: main diverges from what the worktree patch expects → refuse, apply nothing
git -C "$H/main" checkout -q -- a.txt; rm -f "$H/main/new.txt"
git -C "$H/main" worktree add -q --detach "$HWTS/w2" HEAD
mkrun r-conflict "$HWTS/w2" "$H/main"
printf 'one\nW2\nthree\n' > "$HWTS/w2/a.txt"
printf 'other\n' > "$HWTS/w2/b.txt"
printf 'one\nMAIN\nthree\n' > "$H/main/a.txt"
hd harvest r-conflict > "$TMP/h2.out" 2>&1 && rc=0 || rc=$?
[ "$rc" -ne 0 ] && echo "✓ harvest refuses conflicting patch" || { echo "✗ harvest refuses conflicting patch"; fails=$((fails+1)); }
[ ! -e "$H/main/b.txt" ] && grep -q '^MAIN$' "$H/main/a.txt" && echo "✓ conflict leaves main untouched (no partial apply)" || { echo "✗ conflict leaves main untouched"; fails=$((fails+1)); }
git -C "$H/main" checkout -q -- a.txt

# refusals: missing worktree, unregistered dir, no exit sentinel, unknown id
mkrun r-gone "$HWTS/nope" "$H/main"
hd harvest r-gone >/dev/null 2>&1 && { echo "✗ harvest refuses missing worktree"; fails=$((fails+1)); } || echo "✓ harvest refuses missing worktree"
mkdir -p "$HWTS/plain"; git init -q "$HWTS/plain"; printf 'x\n' > "$HWTS/plain/x.txt"
mkrun r-unreg "$HWTS/plain" "$H/main"
hd harvest r-unreg >/dev/null 2>&1 && { echo "✗ harvest refuses unregistered worktree"; fails=$((fails+1)); } || echo "✓ harvest refuses unregistered worktree"
[ ! -e "$H/main/x.txt" ] || { echo "✗ unregistered worktree leaked"; fails=$((fails+1)); }
mkrun r-live "$HWTS/w2" "$H/main"; rm "$HRUNS/r-live/exit"
hd harvest r-live >/dev/null 2>&1 && { echo "✗ harvest refuses unfinished run"; fails=$((fails+1)); } || echo "✓ harvest refuses unfinished run"
hd harvest nonexistent >/dev/null 2>&1 && { echo "✗ harvest refuses unknown run"; fails=$((fails+1)); } || echo "✓ harvest refuses unknown run"

# ── 13. prune ──────────────────────────────────────────────────────────
rm -rf "$HRUNS"/*
git -C "$H/main" worktree add -q --detach "$HWTS/old" HEAD
git -C "$H/main" worktree add -q --detach "$HWTS/fresh" HEAD
git -C "$H/main" worktree add -q --detach "$HWTS/livewt" HEAD
mkrun p-old "$HWTS/old" "$H/main";     touch -t 200001010000 "$HRUNS/p-old/exit"
mkrun p-fresh "$HWTS/fresh" "$H/main"
mkrun p-running "$HWTS/livewt" "$H/main"; rm "$HRUNS/p-running/exit"
touch -t 200001010000 "$HRUNS/p-running"
mkrun p-alive "$HWTS/livewt" "$H/main"; touch -t 200001010000 "$HRUNS/p-alive/exit"
sleep 60 & alive_pid=$!
echo "$alive_pid" > "$HRUNS/p-alive/pid"

hd prune --dry-run > "$TMP/p1.out" 2>&1
grep -q "would prune p-old" "$TMP/p1.out" && echo "✓ dry-run lists old run" || { echo "✗ dry-run lists old run"; fails=$((fails+1)); }
[ -d "$HRUNS/p-old" ] && [ -d "$HWTS/old" ] && echo "✓ dry-run removes nothing" || { echo "✗ dry-run removes nothing"; fails=$((fails+1)); }
hd prune > "$TMP/p2.out" 2>&1
[ ! -d "$HRUNS/p-old" ] && [ ! -d "$HWTS/old" ] && echo "✓ prune removes old finished run + its worktree" || { echo "✗ prune removes old run + worktree"; cat "$TMP/p2.out"; fails=$((fails+1)); }
git -C "$H/main" worktree list | grep -q "/old" && { echo "✗ prune unregisters worktree"; fails=$((fails+1)); } || echo "✓ prune unregisters worktree"
[ -d "$HRUNS/p-fresh" ] && [ -d "$HWTS/fresh" ] && echo "✓ prune keeps recent run" || { echo "✗ prune keeps recent run"; fails=$((fails+1)); }
[ -d "$HRUNS/p-running" ] && echo "✓ prune keeps run without exit sentinel" || { echo "✗ prune keeps run without exit sentinel"; fails=$((fails+1)); }
[ -d "$HRUNS/p-alive" ] && [ -d "$HWTS/livewt" ] && grep -q "skip p-alive" "$TMP/p2.out" && echo "✓ prune refuses run with live pid" || { echo "✗ prune refuses run with live pid"; fails=$((fails+1)); }
kill "$alive_pid" 2>/dev/null || true
hd prune --days 0 > "$TMP/p3.out" 2>&1 || true
[ ! -d "$HRUNS/p-alive" ] && [ -d "$HRUNS/p-running" ] && echo "✓ prune after pid death removes run; --days honoured" || { echo "✗ prune after pid death"; cat "$TMP/p3.out"; fails=$((fails+1)); }
hd prune --days x >/dev/null 2>&1 && { echo "✗ prune rejects bad --days"; fails=$((fails+1)); } || echo "✓ prune rejects bad --days"

echo
if [ "$fails" -eq 0 ]; then echo "delegate smoke test: all passed"; else echo "delegate smoke test: $fails failure(s)"; exit 1; fi
