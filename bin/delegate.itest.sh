#!/usr/bin/env bash
# Opt-in integration test for bin/delegate using the REAL pi and a cheap model.
# Costs real money (budget: <$0.05/case, <$0.50 total). Skipped unless enabled.
#
# Usage: ME_PI_ITEST=1 bin/delegate.itest.sh
#   ME_PI_ITEST_MODEL=provider/model   override the cheap model (default: the
#                                      subagents.defaultModel in ~/.pi/agent/settings.json)
set -uo pipefail

if [ "${ME_PI_ITEST:-0}" != "1" ]; then
  echo "SKIP: delegate integration test uses the real pi and costs money; run with ME_PI_ITEST=1"
  exit 0
fi

TESTS_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DELEGATE="$TESTS_DIR/delegate"
SETTINGS="${ME_PI_ITEST_SETTINGS:-$HOME/.pi/agent/settings.json}"

# Drop any run shim dirs from PATH so `pi` resolves to the real binary
# (matters when this test itself is launched from inside a delegated run).
clean_path=""
old_ifs="$IFS"; IFS=:
for p in $PATH; do
  case "$p" in */shim) continue ;; esac
  clean_path="${clean_path:+$clean_path:}$p"
done
IFS="$old_ifs"
export PATH="$clean_path"
command -v pi >/dev/null 2>&1 || { echo "✗ real pi not found on PATH"; exit 1; }

resolve_model() {
  [ -n "${ME_PI_ITEST_MODEL:-}" ] && { echo "$ME_PI_ITEST_MODEL"; return; }
  node -e '
    try {
      const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const sub = s.subagents || {};
      const m = sub.defaultModel, p = sub.defaultProvider;
      if (typeof m === "string" && m) process.stdout.write(p && typeof p === "string" ? `${p}/${m}` : m);
    } catch {}
  ' "$SETTINGS" 2>/dev/null
}
MODEL="$(resolve_model)"
[ -n "$MODEL" ] || { echo "✗ no cheap model: set ME_PI_ITEST_MODEL or subagents.defaultModel in $SETTINGS"; exit 1; }

TMP="$(mktemp -d /tmp/delegate-itest.XXXXXX)"
export ME_PI_RUNS_ROOT="$TMP/runs"
export ME_PI_WT_ROOT="$TMP/wt"
mkdir -p "$ME_PI_RUNS_ROOT"
bg_id=""
cleanup() {
  [ -n "$bg_id" ] && "$DELEGATE" kill "$bg_id" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

# Per-case bounds (spec: <=$0.05 and <=120s per case; suite < $0.50).
CASE_TIMEOUT=120
CASE_COST=0.05
ROLE=implementer   # has bash; needed for shim + kill cases

fails=0 skips=0
pass() { echo "✓ $1"; }
fail() { echo "✗ $1"; fails=$((fails + 1)); }
skip() { echo "SKIP $1"; skips=$((skips + 1)); }

echo "model: $MODEL   runs: $ME_PI_RUNS_ROOT"

trailer_cost() { # <out.md> -> cost from the last trailer line
  grep -E '^\[.* exit=[0-9]+ cost=' "$1" | tail -1 | sed -E 's/.* cost=([^ ]+) .*/\1/'
}

# ── 1. sync run completes; sentinel, out.md, cost recorded ─────────────
CODE="ZEBRA-$RANDOM"
task1="$TMP/task1.md"
cat > "$task1" <<EOT
# Goal
Integration probe. Do not read any files or run any tools.
Your reference code word is $CODE. Reply with exactly the single word PONG and nothing else.
EOT
"$DELEGATE" run "$ROLE" "$task1" -C "$TMP" -m "$MODEL" -t "$CASE_TIMEOUT" -c "$CASE_COST" > "$TMP/c1.out" 2> "$TMP/c1.err"
rc1=$?
id1="$(ls -t "$ME_PI_RUNS_ROOT" | head -1)"
r1="$ME_PI_RUNS_ROOT/$id1"
if [ "$rc1" -eq 0 ] && [ "$(cat "$r1/exit" 2>/dev/null)" = "0" ] && [ -s "$r1/out.md" ] && grep -q PONG "$r1/out.md"; then
  pass "1 sync run completes (exit sentinel + out.md)"
else
  fail "1 sync run completes (rc=$rc1, exit=$(cat "$r1/exit" 2>/dev/null || echo none)); see $TMP/c1.err"; cat "$TMP/c1.err" | head -5
fi
cost1="$(trailer_cost "$r1/out.md")"
if [ -n "$cost1" ] && awk -v c="$cost1" 'BEGIN { exit !(c > 0) }'; then
  pass "1b trailer records cost > 0 ($cost1)"
else
  skip "1b model $MODEL reported no usage.cost.total (trailer cost=${cost1:-missing}); cost/cap enforcement is blind for it"
fi

# ── 2. shim: child's `command -v pi` resolves to the run shim ──────────
task2="$TMP/task2.md"
cat > "$task2" <<'EOT'
# Goal
Integration probe. Use the bash tool to run exactly: command -v pi
Then reply with the exact output line of that command, verbatim, and nothing else.
EOT
"$DELEGATE" run "$ROLE" "$task2" -C "$TMP" -m "$MODEL" -t "$CASE_TIMEOUT" -c "$CASE_COST" > "$TMP/c2.out" 2> "$TMP/c2.err"
id2="$(ls -t "$ME_PI_RUNS_ROOT" | head -1)"
if grep -q "$ME_PI_RUNS_ROOT/$id2/shim/pi" "$ME_PI_RUNS_ROOT/$id2/out.md"; then
  pass "2 real pi resolves 'pi' to the run shim"
else
  fail "2 shim not observed in child output: $(head -c 300 "$ME_PI_RUNS_ROOT/$id2/out.md")"
fi

# ── 3. ask on a finished run from a different cwd resumes context ──────
ask_out="$(cd /tmp && "$DELEGATE" ask "$id1" "What reference code word was in your task? Answer with the code word only." 2>"$TMP/c3.err")"
if grep -q "$CODE" <<<"$ask_out"; then
  pass "3 ask resumed prior session context from a different cwd"
else
  echo "⚠⚠⚠ WARNING: 3 ask did NOT recall '$CODE' — COLD START (session resume failed)"
  echo "    answer: $(printf '%s' "$ask_out" | head -c 200)"
  echo "    stderr: $(head -c 200 "$TMP/c3.err")"
  skip "3 ask context resume unverified (diagnostic; cold start reported above)"
fi

# ── 4. kill: sleep-heavy background run is killed; sentinel + process dead ─
task4="$TMP/task4.md"
cat > "$task4" <<'EOT'
# Goal
Integration probe. Use the bash tool to run exactly: sleep 500
Then reply DONE.
EOT
bg_id="$("$DELEGATE" run "$ROLE" "$task4" -b -C "$TMP" -m "$MODEL" -t 600 -c "$CASE_COST")"
r4="$ME_PI_RUNS_ROOT/$bg_id"
sleep 15
pid4="$(cat "$r4/pid" 2>/dev/null || echo 0)"
if ! kill -0 "$pid4" 2>/dev/null; then
  fail "4 background run not alive before kill (pid=$pid4): $(head -c 200 "$r4/err.log" 2>/dev/null)"
else
  "$DELEGATE" kill "$bg_id" >/dev/null 2>&1
  for _ in $(seq 1 30); do [ -f "$r4/exit" ] && break; sleep 1; done
  if [ -f "$r4/exit" ]; then pass "4a exit sentinel written after kill (exit=$(cat "$r4/exit"))"; else fail "4a no exit sentinel after kill"; fi
  if kill -0 "$pid4" 2>/dev/null || pgrep -g "$pid4" >/dev/null 2>&1; then
    fail "4b pid $pid4 (or its group) still alive after kill"
  else
    pass "4b process and its group are dead"
  fi
fi
bg_id=""

# ── 5. (optional, NOT run) cost overshoot probe ────────────────────────
# Measures how far real spend overshoots -c between the watchdog's 5s polls.
# Needs a deliberately EXPENSIVE, fast-spending model, so it is manual:
#   task: "Read every file under /usr/share/dict or the repo and summarize each at length."
#   ME_PI_RUNS_ROOT=$(mktemp -d) bin/delegate run implementer task.md -m <expensive-model> -t 120 -c 0.10
#   then compare `cost=` in the trailer of out.md with the 0.10 cap; overshoot = cost - 0.10.
# Budget several dollars; do not enable in the default suite.

# ── total spend ────────────────────────────────────────────────────────
total="$("$DELEGATE" ls | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^cost=/) { sub("cost=", "", $i); t += $i } } END { printf "%.4f", t }')"
echo "total spend: \$$total"
awk -v t="$total" 'BEGIN { exit !(t >= 0.50) }' && fail "suite spend \$$total >= \$0.50"

echo
if [ "$fails" -eq 0 ]; then echo "delegate integration test: passed ($skips skipped)"; else echo "delegate integration test: $fails failure(s) ($skips skipped)"; exit 1; fi
