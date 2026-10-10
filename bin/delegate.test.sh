#!/usr/bin/env bash
# Smoke test for bin/delegate using a fake pi (PI_BIN). No API cost.
# Usage: bin/delegate.test.sh
set -euo pipefail

TESTS_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d /tmp/delegate-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# Hermetic delegate repo: a copy of bin/delegate resolves $REPO/agents to
# fixture roles, so tests never depend on the user's real agents/*.md.
mkdir -p "$TMP/dlg/bin" "$TMP/dlg/agents"
cp "$TESTS_DIR/delegate" "$TMP/dlg/bin/delegate"
DELEGATE="$TMP/dlg/bin/delegate"
cat > "$TMP/dlg/agents/worker.md" <<'ROLE'
---
name: worker
description: Generic test worker: read-only
thinking: high
tools: read, grep, find, ls
---
Worker body.
ROLE
cat > "$TMP/dlg/agents/modeled.md" <<'ROLE'
---
name: modeled
description: Role pinning model and thinking
model: fm-provider/fm-model
thinking: low
tools: read, grep, find, ls
---
Modeled body.
ROLE
cat > "$TMP/dlg/agents/differ.md" <<'ROLE'
---
name: differ
description: Reviews the attached diff
thinking: high
tools: read, grep, find, ls
attach_diff: true
---
Differ body.
ROLE

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
out="$(printf 'do a thing\nto: %s\n' "$TMP" | d run worker - -C "$TMP")"
check "sync run prints result" grep -q "TASK-DONE-MARKER" <<<"$out"
check "sync run exit sentinel" grep -q "exit=0" <<<"$out"
run_id="$(ls "$RUNS" | head -1)"
check "run dir session has cost" grep -q '"total"' "$RUNS/$run_id/session/usage.jsonl"
check "task copied" grep -q "do a thing" "$RUNS/$run_id/task.md"
role_file="$RUNS/$run_id/role.md"
check "worker prompt identifies delegated role" grep -Fq "You are a delegated worker, not the coordinator" "$role_file"
check "worker prompt sets context priority" grep -Fq "Task and role constraints take precedence over conflicting project context" "$role_file"
check "worker prompt warns this is not a sandbox" grep -Fq "This is not a sandbox" "$role_file"
if grep -Eq "Coordination AND Delegation sections|Stay the coordinator" "$role_file"; then
  echo "✗ worker prompt includes phantom sections or coordinator instructions"; fails=$((fails+1))
else
  echo "✓ worker prompt omits phantom sections and coordinator instructions"
fi

# ── 2. role resolution ─────────────────────────────────────────────────
if d run nobody /dev/null -C "$TMP" >/dev/null 2>&1; then echo "✗ unknown role rejected"; fails=$((fails+1)); else echo "✓ unknown role rejected"; fi

# ── 3. model/thinking precedence (frontmatter only; no settings) ────────
latest_args() { echo "$RUNS/$(ls -t "$RUNS" | head -1)/session/args"; }
d run modeled - -C "$TMP" <<< "fm check" >/dev/null
check "frontmatter model passed" grep -Fxq "fm-provider/fm-model" "$(latest_args)"
check "frontmatter thinking passed" grep -Fxq "low" "$(latest_args)"
d run modeled - -C "$TMP" -m cli/model <<< "m flag" >/dev/null
check "-m overrides frontmatter model" grep -Fxq "cli/model" "$(latest_args)"
check "-m keeps frontmatter thinking" grep -Fxq "low" "$(latest_args)"
d run modeled - -C "$TMP" -T max <<< "T flag" >/dev/null
check "-T overrides frontmatter thinking" grep -Fxq "max" "$(latest_args)"
check "-T keeps frontmatter model" grep -Fxq "fm-provider/fm-model" "$(latest_args)"
# Pi settings must never influence the model choice.
mkdir -p "$TMP/home/.pi/agent"
echo '{"defaultModel":"settings-model","subagents":{"defaultModel":"x"}}' > "$TMP/home/.pi/agent/settings.json"
HOME="$TMP/home" d run worker - -C "$TMP" <<< "no model" >/dev/null
if grep -Fxq -- "--model" "$(latest_args)"; then echo "✗ no model -> no --model passed"; fails=$((fails+1)); else echo "✓ no model -> no --model passed"; fi
check "no model: helper default thinking high" grep -Fxq "high" "$(latest_args)"
check "meta records model default" grep -Fxq "model: default" "$(dirname "$(dirname "$(latest_args)")")/meta"

# ── 4. nested pi + delegate blocked via shim ───────────────────────────
ME_PI_TEST_CHECK_SHIM=1 d run worker - -C "$TMP" <<< "shim check" > "$TMP/shim.out" 2>&1 || true
grep -q "TASK-DONE-MARKER" "$TMP/shim.out" && echo "✓ shim enforced (fake pi saw shim)" || { echo "✗ shim enforced"; fails=$((fails+1)); }
# nested `delegate` itself must also be shadowed and refuse (exit 64)
rc=0; PATH="$RUNS/$(ls "$RUNS" | tail -1)/shim:$PATH" delegate run worker - -C "$TMP" <<< x >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 64 ] && echo "✓ nested delegate refuses" || { echo "✗ nested delegate refuses (rc=$rc)"; fails=$((fails+1)); }

# ── 4. background run + wait ───────────────────────────────────────────
printf 'bg task\n' > "$TMP/task-b.md"
bg_id="$(ME_PI_TEST_SLEEP=2 d run worker "$TMP/task-b.md" -b -C "$TMP")"
[ -n "$bg_id" ] || { echo "✗ bg id printed"; fails=$((fails+1)); }
d wait "$bg_id" > "$TMP/wait.out" 2>&1
check "wait prints result" grep -q "TASK-DONE-MARKER" "$TMP/wait.out"
check "wait exit sentinel" grep -q "exit=0" "$TMP/wait.out"

# ── 5. timeout cap ─────────────────────────────────────────────────────
ME_PI_TEST_SLEEP=30 d run worker - -C "$TMP" -t 2 < /dev/null > "$TMP/timeout.out" 2>&1 || true
grep -q "stopped early: timeout" "$TMP/timeout.out" && echo "✓ timeout enforced" || { echo "✗ timeout enforced"; fails=$((fails+1)); }
timeout_id="$(ls -t "$RUNS" | head -1)"
grep -q "^timeout$" "$RUNS/$timeout_id/why" || { echo "✗ timeout why file"; fails=$((fails+1)); }

# ── 6. cost cap ────────────────────────────────────────────────────────
ME_PI_TEST_SLEEP=30 ME_PI_TEST_COST=5 d run worker - -C "$TMP" -t 60 -c 0.5 < /dev/null > "$TMP/cost.out" 2>&1 || true
grep -q "stopped early: cost-cap" "$TMP/cost.out" && echo "✓ cost cap enforced" || { echo "✗ cost cap enforced"; fails=$((fails+1)); }

# ── 7. kill ────────────────────────────────────────────────────────────
bg2="$(ME_PI_TEST_SLEEP=60 PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$RUNS" ME_PI_WT_ROOT="$WTS" "$DELEGATE" run worker "$TMP/task-b.md" -b -C "$TMP")"
sleep 1
d kill "$bg2" >/dev/null 2>&1 && echo "✓ kill accepted" || { echo "✗ kill accepted"; fails=$((fails+1)); }
sleep 2
d ls | grep -q "$bg2" && echo "✓ ls lists killed run" || { echo "✗ ls lists killed run"; fails=$((fails+1)); }

# ── 7b. watchdog survives caller death ─────────────────────────────────
# Coordinator = a process group we kill right after launch. The watchdog must be
# in its own session, still enforce -t, write the sentinel, and stay killable.
coord_out="$TMP/coord.id"
perl -MPOSIX -e 'setsid; exec @ARGV' -- bash -c 'ME_PI_TEST_SLEEP=60 PI_BIN="$1" ME_PI_RUNS_ROOT="$2" ME_PI_WT_ROOT="$3" "$4" run worker "$5" -b -t 4 -C "$6" > "$7"; kill -KILL 0' _ "$FAKE_PI" "$RUNS" "$WTS" "$DELEGATE" "$TMP/task-b.md" "$TMP" "$coord_out" 2>/dev/null || true
wd_id="$(cat "$coord_out")"
sleep 1
wd_pid="$(cat "$RUNS/$wd_id/watchdog.pid" 2>/dev/null || echo 0)"
kill -0 "$wd_pid" 2>/dev/null && echo "✓ watchdog alive after coordinator death" || { echo "✗ watchdog alive after coordinator death"; fails=$((fails+1)); }
[ "$(ps -o pgid= -p "$wd_pid" 2>/dev/null | tr -d ' ')" = "$wd_pid" ] && echo "✓ watchdog leads its own process group" || { echo "✗ watchdog leads its own process group"; fails=$((fails+1)); }
for _ in $(seq 1 20); do [ -f "$RUNS/$wd_id/exit" ] && break; sleep 1; done
[ -f "$RUNS/$wd_id/exit" ] && grep -q '^timeout$' "$RUNS/$wd_id/why" && grep -q "$wd_id exit=" "$RUNS/$wd_id/out.md" && echo "✓ orphaned watchdog enforces timeout + writes sentinel" || { echo "✗ orphaned watchdog enforces timeout + writes sentinel"; fails=$((fails+1)); }
bg3="$(ME_PI_TEST_SLEEP=60 PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$RUNS" ME_PI_WT_ROOT="$WTS" "$DELEGATE" run worker "$TMP/task-b.md" -b -C "$TMP")"
sleep 1
d kill "$bg3" >/dev/null 2>&1
d wait "$bg3" > "$TMP/wait3.out" 2>&1 || true
grep -q "exit=" "$TMP/wait3.out" && [ -f "$RUNS/$bg3/exit" ] && echo "✓ kill of detached run writes sentinel via watchdog" || { echo "✗ kill of detached run writes sentinel via watchdog"; fails=$((fails+1)); }

# ── 8. worktree creation ───────────────────────────────────────────────
git init -q "$TMP/repo" 2>/dev/null
git -C "$TMP/repo" commit -q --allow-empty -m init
printf 'wt task\n' > "$TMP/task-wt.md"
# Fake pi fails if cwd is the -C dir; success proves the child ran in the worktree.
ME_PI_TEST_FAIL_IF_CWD="$TMP/repo" d run worker "$TMP/task-wt.md" -w -C "$TMP/repo" > "$TMP/wt.out" 2>&1 || true
ls "$WTS" | grep -q "^repo-" && echo "✓ worktree created" || { echo "✗ worktree created"; fails=$((fails+1)); }
# child ran inside the worktree: the fake pi only succeeds when cwd != -C dir
check "child cwd is the worktree" grep -q "exit=0" <<<"$(cat "$TMP/wt.out")"

# ── 9. ask ─────────────────────────────────────────────────────────────
d ask "$bg_id" "status?" > "$TMP/ask.out" 2>/dev/null
check "ask resumes session" grep -q "TASK-DONE-MARKER" "$TMP/ask.out"
ask_id="$(d run modeled - -b -C "$TMP" <<< "ask model" )"
d wait "$ask_id" >/dev/null 2>&1
d ask "$ask_id" "status?" >/dev/null 2>&1
check "ask preserves run model" grep -Fxq "fm-provider/fm-model" "$RUNS/$ask_id/session/args"
check "ask keeps read-only tools" grep -Fxq "read,grep,find,ls" "$RUNS/$bg_id/session/args"
check "ask uses original run cwd" grep -Fxq "$(sed -n 's/^cwd: //p' "$RUNS/$bg_id/meta")" "$RUNS/$bg_id/session/cwd"
check "ask appends full role file" grep -Fxq "$RUNS/$bg_id/role.md" "$RUNS/$bg_id/session/args"
check "ask adds follow-up instruction" grep -Fxq "This is a follow-up, not a restart. Do not redo the original task; honor its original task and output contract." "$RUNS/$bg_id/session/args"

# ── 10. child failure propagates ───────────────────────────────────────
ME_PI_TEST_EXIT=3 d run worker - -C "$TMP" < /dev/null > "$TMP/fail.out" 2>&1 && { echo "✗ nonzero child exit propagates"; fails=$((fails+1)); } || echo "✓ nonzero child exit propagates"

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

# ── 14. sync run keeps supervision when its caller dies ───────────────────
# The caller (e.g. a bash tool with a short timeout) kills the foreground
# `delegate run` and its whole process group. Watchdog, -t, sentinel survive.
SK="$TMP/runs-sk"
perl -MPOSIX -e 'setsid; exec @ARGV' -- env HOME="$TMP/home" ME_PI_TEST_SLEEP=60 PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$SK" ME_PI_WT_ROOT="$WTS" \
  "$DELEGATE" run worker "$TMP/task-b.md" -t 4 -C "$TMP" > "$TMP/sk.out" 2>&1 &
sk_fg=$!
for _ in $(seq 1 50); do ls "$SK"/*/lstart >/dev/null 2>&1 && break; sleep 0.1; done
sk_id="$(ls "$SK" 2>/dev/null | head -1)"
sleep 0.5
kill -KILL -- "-$sk_fg" 2>/dev/null || true
wait "$sk_fg" 2>/dev/null || true
sk_pi="$(cat "$SK/$sk_id/pid" 2>/dev/null || echo 0)"
kill -0 "$sk_pi" 2>/dev/null && [ ! -f "$SK/$sk_id/exit" ] && echo "✓ sync worker survives foreground kill" || { echo "✗ sync worker survives foreground kill"; fails=$((fails+1)); }
grep -q "delegate wait $sk_id" "$TMP/sk.out" && echo "✓ sync run announces its id before blocking" || { echo "✗ sync run announces its id before blocking"; fails=$((fails+1)); }
for _ in $(seq 1 20); do [ -f "$SK/$sk_id/exit" ] && break; sleep 1; done
[ -f "$SK/$sk_id/exit" ] && grep -q '^timeout$' "$SK/$sk_id/why" 2>/dev/null && grep -q "$sk_id exit=" "$SK/$sk_id/out.md" && echo "✓ sync run: timeout + sentinel after foreground kill" || { echo "✗ sync run: timeout + sentinel after foreground kill"; fails=$((fails+1)); }
kill -0 "$sk_pi" 2>/dev/null && { echo "✗ timed-out sync worker is dead"; fails=$((fails+1)); } || echo "✓ timed-out sync worker is dead"
kill -KILL -- "-$sk_pi" 2>/dev/null || true

# ── 15. ask refuses unfinished runs ────────────────────────────────────────
live_id="$(ME_PI_TEST_SLEEP=60 d run worker "$TMP/task-b.md" -b -C "$TMP")"
rm -f "$RUNS/$live_id/session/args"
rc=0; d ask "$live_id" "finish now" > "$TMP/ask-live.out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] && grep -Fq "run $live_id has not finished (no exit sentinel)" "$TMP/ask-live.out" && echo "✓ ask refuses unfinished run" || { echo "✗ ask refuses unfinished run (rc=$rc)"; fails=$((fails+1)); }
[ ! -f "$RUNS/$live_id/session/args" ] && echo "✓ refused ask spawns no pi" || { echo "✗ refused ask spawns no pi"; fails=$((fails+1)); }
d kill "$live_id" >/dev/null 2>&1 || true

# ── 16. role in meta ───────────────────────────────────────────────────────
check "meta records role" grep -Fxq "role: worker" "$RUNS/$run_id/meta"
check "meta diff_sha none for plain roles" grep -Fxq "diff_sha: none" "$RUNS/$run_id/meta"

# ── 17. roles listing + unknown role error ─────────────────────────────────
d roles > "$TMP/roles.out" 2>&1 || true
check "roles lists name and description" grep -Fxq "worker — Generic test worker: read-only [model: default, thinking: high]" "$TMP/roles.out"
check "roles lists second role" grep -Fxq "differ — Reviews the attached diff [model: default, thinking: high]" "$TMP/roles.out"
d run nobody /dev/null -C "$TMP" > "$TMP/unknown.out" 2>&1 || true
check "unknown role lists available roles" grep -Fq "available: differ, modeled, worker" "$TMP/unknown.out"
d --help > "$TMP/help.out" 2>&1 || true
check "usage mentions roles" grep -q "delegate roles" "$TMP/help.out"
awk '/^---$/{n++; next} n==1' "$TESTS_DIR/../agents/reviewer.md" | grep -Fxq "attach_diff: true" && echo "✓ real reviewer role declares attach_diff" || { echo "✗ real reviewer role declares attach_diff"; fails=$((fails+1)); }

DR="$TMP/dr"; DRUNS="$TMP/runs-dr"
dd() { HOME="$TMP/home" PI_BIN="$FAKE_PI" ME_PI_RUNS_ROOT="$DRUNS" ME_PI_WT_ROOT="$WTS" "$DELEGATE" "$@"; }
git init -q "$DR"; git -C "$DR" config user.email t@t; git -C "$DR" config user.name t
mkdir -p "$DR/sub"
printf 'one\n```\ntwo\n' > "$DR/a.txt"; printf 'ignored.txt\n' > "$DR/.gitignore"; printf 's\n' > "$DR/sub/s.txt"
git -C "$DR" add .; git -C "$DR" commit -q -m init
rc=0; dd run differ - -C "$DR" <<< "review" > "$TMP/dr-clean.out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] && grep -Fq "nothing to review: working tree matches HEAD" "$TMP/dr-clean.out" && [ -z "$(ls "$DRUNS" 2>/dev/null)" ] && echo "✓ attach_diff role refuses clean tree, no run dir" || { echo "✗ attach_diff role refuses clean tree (rc=$rc)"; fails=$((fails+1)); }

printf 'one\n```\nTWO\n' > "$DR/a.txt"; printf 'untracked-content\n' > "$DR/u.txt"; printf 'secret-ignored\n' > "$DR/ignored.txt"
idx_before="$(shasum < "$DR/.git/index")"
git -C "$DR" add a.txt
idx_staged="$(shasum < "$DR/.git/index")"

rc=0; dd run differ - -C "$DR" <<< "review this" > "$TMP/dr-run.out" 2>&1 || rc=$?
dr_id="$(ls "$DRUNS" | head -1)"; dr_task="$DRUNS/$dr_id/task.md"
[ "$rc" -eq 0 ] && echo "✓ attach_diff run succeeds" || { echo "✗ attach_diff run succeeds (rc=$rc)"; cat "$TMP/dr-run.out"; fails=$((fails+1)); }
check "task keeps original text" grep -Fxq "review this" "$dr_task"
check "task has diff section heading" grep -Fxq "## Diff (working tree vs HEAD, auto-attached)" "$dr_task"
check "diff includes untracked file" grep -Fq "+untracked-content" "$dr_task"
if grep -q "secret-ignored" "$dr_task"; then echo "✗ diff excludes ignored file"; fails=$((fails+1)); else echo "✓ diff excludes ignored file"; fi
check "meta records role" grep -Fxq "role: differ" "$DRUNS/$dr_id/meta"
h1="$(sed -n 's/^diff_sha: //p' "$DRUNS/$dr_id/meta")"
check "meta diff_sha is sha256 hex" grep -Eq '^diff_sha: [0-9a-f]{64}$' "$DRUNS/$dr_id/meta"
fence_line="$(grep -m1 -E '^`{3,}diff$' "$dr_task" || true)"; fence="${fence_line%diff}"
[ "${#fence}" -ge 4 ] && echo "✓ fence outgrows backtick runs in the diff" || { echo "✗ fence outgrows backtick runs (fence=$fence)"; fails=$((fails+1)); }
attached_sha="$(awk -v f="$fence" 'on && $0 == f { exit } on { print } $0 == f "diff" { on = 1 }' "$dr_task" | shasum -a 256 | cut -d' ' -f1)"
[ "$attached_sha" = "$h1" ] && echo "✓ attached diff bytes hash to diff_sha" || { echo "✗ attached diff bytes hash to diff_sha"; fails=$((fails+1)); }

# -w: the diff comes from the origin checkout, computed before the worktree exists.
rm -rf "${DRUNS:?}"/*
rc=0; ME_PI_TEST_FAIL_IF_CWD="$(cd -P "$DR" && pwd -P)" dd run differ - -w -C "$DR" <<< "wt review" > "$TMP/dr-wt.out" 2>&1 || rc=$?
drw_id="$(ls "$DRUNS" | head -1)"
[ "$rc" -eq 0 ] && grep -Fq "+untracked-content" "$DRUNS/$drw_id/task.md" && grep -Fxq "diff_sha: $h1" "$DRUNS/$drw_id/meta" && echo "✓ -w attaches the origin's diff" || { echo "✗ -w attaches the origin's diff (rc=$rc)"; fails=$((fails+1)); }

printf 'changed again\n' >> "$DR/u.txt"
git init -q "$TMP/unborn"; printf 'x\n' > "$TMP/unborn/f.txt"
mkdir -p "$TMP/notgit"

echo
if [ "$fails" -eq 0 ]; then echo "delegate smoke test: all passed"; else echo "delegate smoke test: $fails failure(s)"; exit 1; fi
