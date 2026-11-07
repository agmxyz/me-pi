/**
 * Synthetic policy cases, hand-judged: `node spike/guard-policy/cases.ts` exits 1 on any mismatch. Branch feature/x
 * unless given.
 */
import { initShellAst } from "../guard-parser/shell-ast.ts";
import { type Level, policy } from "./policy.ts";

await initShellAst();

export const CASES: { command: string; want: Level; branch?: string }[] = [
	// Case 1: catastrophic rm.
	{ command: "rm -rf ~", want: "ask" },
	{ command: "rm -rf /", want: "ask" },
	{ command: "rm -rf /Users/me/x", want: "ask" },
	{ command: "rm -rf .", want: "ask" },
	{ command: "rm -rf .git", want: "ask" },
	{ command: "rm -rf *", want: "ask" },
	{ command: 'rm -rf "$HOME/.cache/x"', want: "ask" },
	{ command: "rm -rf ../other", want: "ask" },
	// Temp and build stay allowed.
	{ command: "rm -rf dist node_modules", want: "allow" },
	{ command: "rm -rf /tmp/x", want: "allow" },
	{ command: "T=$(mktemp -d); trap 'rm -rf \"$T\"' EXIT; echo hi", want: "allow" },
	{ command: 'T="$(mktemp -d /tmp/me.XXXXXX)" && cd "$T" && rm -rf repo', want: "allow" },
	{ command: 'd=$(mktemp -d) && rm -rf "$d"', want: "allow" },
	{ command: 'for d in dist build; do rm -rf "$d"; done', want: "allow" },
	// Unknown expansions that could reach case 1 still ask.
	{ command: 'rm -rf "$X"', want: "ask" },
	{ command: 'rm -rf "$T"; T=$(mktemp -d)', want: "ask" },
	{ command: "rm -rf $T; T=$(mktemp -d)", want: "ask" },
	{ command: 'T=$(mktemp -d); eval "$S"; rm -rf "$T"', want: "ask" },
	{ command: 'T=$(mktemp -d); read T; rm -rf "$T"', want: "ask" },
	{ command: 'T=$(mktemp -d); rm -rf "$T/.."', want: "ask" },
	{ command: 'for d in dist ~; do rm -rf "$d"; done', want: "ask" },
	// Unquoted mktemp path: guard's TMPDIR model (no blanks in TMPDIR) applies.
	{ command: "T=$(mktemp -d); rm -rf $T/*", want: "allow" },
	// Case 2: in-repo work.
	{ command: "rm -rf src", want: "ask-if-dirty" },
	{ command: "git reset --hard", want: "ask-if-dirty" },
	{ command: "git clean -fd", want: "ask-if-dirty" },
	{ command: "git checkout -- .", want: "ask-if-dirty" },
	{ command: "git restore x", want: "ask-if-dirty" },
	{ command: "git stash drop", want: "ask-if-dirty" },
	// Case 3: remote history.
	{ command: "git push --force origin feat", want: "ask" },
	{ command: "git push origin main", want: "ask" },
	{ command: "git push", want: "ask", branch: "main" },
	{ command: "git push", want: "allow" },
	{ command: "cd /x && git push", want: "ask" },
	{ command: "cd /x && git push origin feat", want: "allow" },
	{ command: 'B=main; git push origin "$B"', want: "ask" },
	{ command: 'B=feat; git push origin "$B"', want: "allow" },
	{ command: 'git push origin "$B"', want: "ask" },
	// Dropped: reflog recovers these.
	{ command: "git commit --amend --no-edit", want: "allow" },
	{ command: "git rebase main", want: "allow" },
	{ command: "git branch -D old", want: "allow" },
	// Text only.
	{ command: "git commit -m 'rm -rf / and git push --force'", want: "allow" },
	{ command: "herdr agent prompt w3:p1 'did git reset --hard; rm -rf ~'", want: "allow" },
	{ command: "cat > notes.md <<'EOF'\nrm -rf ~\nEOF", want: "allow" },
	// A written file that is then run is a program.
	{ command: "cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nbash run.sh", want: "ask" },
	// Git sub-command and command-name expansions.
	{ command: 'for s in status log; do git "$s"; done', want: "allow" },
	{ command: 'export X="$1"; rm -rf "$X"', want: "ask" },
	{ command: '\\export T=/; rm -rf "${TMPDIR:?}/x"', want: "ask" },
	{ command: 'for s in status push; do git "$s"; done', want: "ask" },
	{ command: 'git "$S"', want: "ask" },
	{ command: 'T=$(mktemp -d); git -C "$T" init -q && git -C "$T" push origin feat', want: "allow" },
	{ command: 'T=$(mktemp -d); git clone -q x "$T" && git -C "$T" push', want: "ask" },
	{ command: "git checkout -b feat && git push -u origin HEAD", want: "allow" },
	{ command: "git checkout -b main && git push", want: "ask" },
	{ command: "git checkout feat && git push", want: "ask" },
	// TMPDIR forms and session variables.
	{ command: 'rm -rf "${TMPDIR:?}/me-pi-x"', want: "allow" },
	// guard's rules: no glob in a temp entry name, and only plain text around ${TMPDIR:?}.
	{ command: 'rm -rf "${TMPDIR:-/tmp}"/me-pi-*', want: "ask" },
	{ command: "rm -rf $TMPDIR/x", want: "ask" },
	{ command: 'rm -rf "${TMPDIR:?}"', want: "ask" },
	{ command: "L=$TMPDIR/me; rm -rf $L/live", want: "ask" },
	{ command: 'rm -rf "$X"', want: "ask" },
	{ command: 'rm -rf "$PWD/node_modules"', want: "allow" },
	{ command: 'rm -rf "$PWD/src"', want: "ask-if-dirty" },
	{ command: "cd ~/proj && rm -rf src", want: "ask-if-dirty" },
	{ command: 'T=$(mktemp -d) && cd "$T" && rm -rf src', want: "allow" },
	{ command: "cd /tmp && rm -rf fakehome", want: "allow" },
	{ command: "cd /tmp && rm -rf ../x", want: "ask" },
	{ command: "(cd /tmp); rm -rf src", want: "ask-if-dirty" },
	{ command: "S=/tmp/sx; rm -rf $S/t*/base", want: "allow" },
	{ command: "~/.local/bin/herdr agent list", want: "allow" },
	{ command: "L=$TMPDIR/x; $L/measure.sh", want: "allow" },
	{ command: "L=$TMPDIR/x; $L/rm -rf ~", want: "ask" },
	{ command: '"$D"/git push --force', want: "ask" },
	{ command: "$CMD -rf ~", want: "ask" },
	{ command: "CMD=rm; $CMD -rf ~", want: "ask" },
	{ command: 'c="git push --force"; bash -c "$c"', want: "ask" },
	{ command: 'c="ls -la"; bash -c "$c"', want: "allow" },
	{ command: 'eval "$X"', want: "ask" },
	// Spike-corpus rows the first draft missed.
	{ command: "rm -rf /tmp/x/{..,y}/z", want: "ask" },
	{ command: "d=$(mktemp -d) && sh -c 'rm -rf \"$d\"/x'", want: "ask" },
	{ command: 'OLDPWD=$(mktemp -d) && cd src && rm -rf "$OLDPWD"', want: "ask" },
	{ command: 'PWD=$(mktemp -d) && cd ~/proj && rm -rf "$PWD"', want: "ask" },
	{ command: 'd=$(mktemp -d) && printf -vd / && rm -rf "$d"/etc', want: "ask" },
	{ command: 'false && d=$(mktemp -d); rm -rf "$d"', want: "ask" },
	{ command: 'args=(-rf /Users); rm "${args[@]}"', want: "ask" },
	{ command: 'X=$(mktemp -d) rm -rf "$X"', want: "ask" },
	{ command: 'if true; then T=$(mktemp -d); fi; rm -rf "$T"', want: "ask" },
	{ command: 'cd /x && t=$(mktemp -d) && rm -rf "$t"', want: "allow" },
	{ command: 'cd /x && t=$(mktemp -d) && mkdir "$t/a"; rm -rf "$t"', want: "ask" },
	{ command: 'true || t=$(mktemp -d) && rm -rf "$t"', want: "ask" },
	{ command: 'T=$(mktemp -d); f() { T=/; }; f; rm -rf "$T"', want: "ask" },
	{ command: 'T=$(mktemp -d); (( T = 0 )); rm -rf "$T"', want: "ask" },
	{ command: 'T=$(mktemp -d); . ./env.sh; rm -rf "$T"', want: "ask" },
	{ command: "T=$(mktemp -d)\ncat > x.js <<'EOF'\nconst source = 1; eval(x)\nEOF\nrm -rf \"$T\"", want: "allow" },
	{ command: 'd=$(mktemp -d) && tar -x -C "$d" && cd "$d" && npm pack 2>&1 | tail -30; rm -rf "$d"', want: "allow" },
	{ command: 'echo x | d=$(mktemp -d); rm -rf "$d"', want: "ask" },
	// Parse failure fails closed.
	{ command: "rm -rf ~ )", want: "ask" },
];

let bad = 0;
for (const c of CASES) {
	const v = policy(c.command, c.branch ?? "feature/x");
	if (v.verdict !== c.want) {
		bad++;
		console.log(`FAIL want ${c.want} got ${v.verdict}: ${JSON.stringify(c.command)}`);
		for (const f of v.findings) console.log(`     ${f.level} ${f.rule}: ${f.detail}`);
	}
}
console.log(`${CASES.length - bad}/${CASES.length} cases ok`);
if (bad) process.exitCode = 1;
