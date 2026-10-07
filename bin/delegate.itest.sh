#!/usr/bin/env bash
# Paid integration test for bin/delegate using the REAL pi and a live model.
# Do not run without explicit user authorization for this invocation; it spends money.
# Budget target: <$0.05/case, <$0.50 total; watchdog polling can overshoot.
# Skipped unless enabled.
#
# Usage after authorization: ME_PI_ITEST=1 bin/delegate.itest.sh
#   ME_PI_ITEST_MODEL=provider/model   override the configured model (default:
#                                      subagents.defaultModel in ~/.pi/agent/settings.json)
set -uo pipefail

if [ "${ME_PI_ITEST:-0}" != "1" ]; then
  echo "SKIP: paid real-Pi/model test requires explicit user authorization and ME_PI_ITEST=1"
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
[ -n "$MODEL" ] || { echo "✗ no integration-test model: set ME_PI_ITEST_MODEL or subagents.defaultModel in $SETTINGS"; exit 1; }

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

# ── 3. ask persists the complete role addendum in the session transcript ─
ask_rc=0
(cd /tmp && "$DELEGATE" ask "$id1" "Reply DONE." > "$TMP/c3.out" 2>"$TMP/c3.err") || ask_rc=$?
if [ "$ask_rc" -eq 0 ] && node - "$r1/session" "$r1/role.md" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [sessionDir, rolePath] = process.argv.slice(2);
const files = fs.readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).sort();
if (files.length === 0) throw new Error("no persisted session JSONL");
const entries = files.flatMap((name) => fs.readFileSync(path.join(sessionDir, name), "utf8")
  .split("\n").filter(Boolean).map((line) => JSON.parse(line)));
const latestSystem = entries.filter((entry) => entry.type === "message" && entry.message?.role === "system").at(-1);
const addendum = latestSystem?.message?.sections?.addendum;
if (typeof addendum !== "string") throw new Error("latest system message has no addendum");
const role = fs.readFileSync(rolePath, "utf8").trimEnd();
if (!addendum.includes(role)) throw new Error("latest addendum does not contain the full role.md");
if (!addendum.includes("**Output contract**")) throw new Error("latest addendum lost the role output contract");
NODE
then
  pass "3 ask transcript retains full role addendum and output contract"
else
  fail "3 ask transcript missing role addendum/output contract (rc=$ask_rc): $(head -c 300 "$TMP/c3.err")"
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

# ── 6. harvest round-trip: -w implementer writes a file; harvest applies it ─
REPO6="$TMP/repo6"
git init -q "$REPO6" && git -C "$REPO6" config user.email t@t && git -C "$REPO6" config user.name t
printf 'seed\n' > "$REPO6/seed.txt"
git -C "$REPO6" add seed.txt && git -C "$REPO6" commit -q -m init
HCODE="HARVEST-$RANDOM"
task6="$TMP/task6.md"
cat > "$task6" <<EOT
# Goal
Integration probe. Skip the usual method steps: do NOT read any skill files and do not run tests.
Use the write tool to create the file harvest-probe.txt in your working directory containing exactly the single line: $HCODE
Then reply with exactly: DONE
EOT
"$DELEGATE" run "$ROLE" "$task6" -w -C "$REPO6" -m "$MODEL" -t "$CASE_TIMEOUT" -c "$CASE_COST" > "$TMP/c6.out" 2> "$TMP/c6.err"
id6="$(ls -t "$ME_PI_RUNS_ROOT" | head -1)"
wt6="$(sed -n 's/^wt: //p' "$ME_PI_RUNS_ROOT/$id6/meta")"
if [ -f "$wt6/harvest-probe.txt" ] && grep -q "$HCODE" "$wt6/harvest-probe.txt" && [ ! -e "$REPO6/harvest-probe.txt" ]; then
  pass "6a -w child wrote into the worktree, main checkout untouched"
else
  fail "6a child did not write harvest-probe.txt in worktree ($wt6): $(head -c 200 "$ME_PI_RUNS_ROOT/$id6/out.md")"
fi
if "$DELEGATE" harvest "$id6" > "$TMP/c6.harvest" 2>&1 && grep -q "$HCODE" "$REPO6/harvest-probe.txt" 2>/dev/null; then
  pass "6b harvest applied the patch to the main checkout"
else
  fail "6b harvest did not land the file in $REPO6: $(head -c 300 "$TMP/c6.harvest")"
fi
[ "$(git -C "$REPO6" rev-list --count HEAD)" = 1 ] && [ -d "$wt6" ] && pass "6c harvest did not commit; worktree kept" || fail "6c harvest committed or removed the worktree"

# ── total spend ────────────────────────────────────────────────────────
total="$("$DELEGATE" ls | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^cost=/) { sub("cost=", "", $i); t += $i } } END { printf "%.4f", t }')"
echo "total spend: \$$total"
awk -v t="$total" 'BEGIN { exit !(t >= 0.50) }' && fail "suite spend \$$total >= \$0.50"

echo
if [ "$fails" -eq 0 ]; then echo "delegate integration test: passed ($skips skipped)"; else echo "delegate integration test: $fails failure(s) ($skips skipped)"; exit 1; fi
