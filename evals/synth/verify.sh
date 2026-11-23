#!/bin/bash
# Checks one synthetic task's oracle, offline from the npm cache:
#   - its hidden tests fail on the base (fixture plus the task's base/ overlay), or pass on it for `expect: "blocked"`;
#   - the reference (base plus reference/) passes `npm run check` and every hidden test;
#   - the hidden tests are biome-clean.
# Usage: evals/synth/verify.sh <tasks-dir> <task-id>, with <tasks-dir> absolute (the script changes directory). Prints one line ending in `=> yes` or `=> no`; exits 1 on `no`.
set -u
FX=$(cd "$(dirname "$0")/fixture" && pwd)
T=$1/$2
W=$(mktemp -d /tmp/sv.XXXX)
trap 'rm -rf "$W"' EXIT
cp -R "$FX/." "$W"
[ -d "$T/base" ] && cp -R "$T/base/." "$W"
cd "$W" || exit 1
npm ci --prefer-offline --silent >/dev/null 2>&1 || { echo "$2: npm ci failed"; exit 1; }
expect=$(jq -r .expect "$T/meta.json")
hidden=()
for f in "$T"/hidden/*.test.ts; do hidden+=("test/$(basename "$f")"); done
cp "$T"/hidden/*.test.ts test/
TMPDIR=/tmp node --test "${hidden[@]}" >"/tmp/sv-$2-base.log" 2>&1
base=$?
rm -f "${hidden[@]}"
[ -d "$T/reference" ] && cp -R "$T/reference/." "$W"
[ -f "$T/reference-deletes.txt" ] && xargs rm -f <"$T/reference-deletes.txt"
TMPDIR=/tmp npm run check >"/tmp/sv-$2-check.log" 2>&1
check=$?
cp "$T"/hidden/*.test.ts test/
TMPDIR=/tmp node --test "${hidden[@]}" >"/tmp/sv-$2-ref.log" 2>&1
ref=$?
npx biome check "${hidden[@]}" >"/tmp/sv-$2-biome.log" 2>&1
biome=$?
ok=yes
if [ "$expect" = blocked ]; then [ $base -eq 0 ] || ok=no; else [ $base -ne 0 ] || ok=no; fi
[ $check -eq 0 ] && [ $ref -eq 0 ] && [ $biome -eq 0 ] || ok=no
echo "$2 expect=$expect base_hidden_exit=$base ref_check_exit=$check ref_hidden_exit=$ref hidden_biome=$biome => $ok"
[ $ok = yes ]
