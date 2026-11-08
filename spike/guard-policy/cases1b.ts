/**
 * Step 1b cases, hand-judged, on a fake disk (no real lookups): `node spike/guard-policy/cases1b.ts` exits 1 on any
 * mismatch. The session cwd is the repo `/w/app` on branch `feat`; `/w/lib` is a repo on `main`; `/w/notes` and
 * `~/.agents/skills` are not repos.
 */
import { guard } from "../guard-parser/guard-rules.ts";
import { initShellAst } from "../guard-parser/shell-ast.ts";
import { type Level, type PolicyEnv, policy } from "./policy.ts";

await initShellAst();

const REPOS: Record<string, { branch: string; remotes: Record<string, string> }> = {
	"/w/app": { branch: "feat", remotes: { origin: "git@github.com:me/app.git", local: "../bare.git" } },
	"/w/lib": { branch: "main", remotes: { origin: "https://github.com/me/lib.git" } },
	"/w/det": { branch: "HEAD", remotes: {} },
};
const rootOf = (dir: string) => Object.keys(REPOS).find((r) => dir === r || dir.startsWith(`${r}/`));
const ENV: PolicyEnv = {
	cwd: "/w/app",
	home: "/Users/me",
	branchOf: (d) => (rootOf(d) ? REPOS[rootOf(d)!].branch : undefined),
	repoRootOf: rootOf,
	remoteUrlOf: (d, n) => (rootOf(d) ? REPOS[rootOf(d)!].remotes[n] : undefined),
	fallback: (t, b) => guard.classify(t, () => b),
	parserTmpdir: true,
	operandFix: true,
};

export const CASES: { command: string; want: Level; why: string }[] = [
	// Decision 1: bare push after cd to a literal path.
	{ command: "cd /w/app && git push", want: "allow", why: "1: branch feat" },
	{ command: "cd /w/lib && git push -q", want: "ask", why: "1: branch main" },
	{ command: "cd /w/notes && git push", want: "ask", why: "1: not a repo" },
	{ command: "cd /w/det && git push", want: "ask", why: "1: detached HEAD" },
	{ command: 'cd "$D" && git push', want: "ask", why: "1: path not literal" },
	{ command: "cd /w/app && git checkout main && git push", want: "ask", why: "1: switched after the disk read" },
	{ command: "git -C /w/lib push", want: "ask", why: "1: -C to main" },
	{ command: "git -C /w/app push", want: "allow", why: "1: -C to feat" },
	{ command: "cd /w/app && git push --force", want: "ask", why: "3: force push to a network remote" },
	// Decision 2: parse failure falls back to 0.1.3.
	{ command: "rm -rf ~ )", want: "ask", why: "2: 0.1.3 asks (recursive rm)" },
	{ command: "echo ( x", want: "allow", why: "2: 0.1.3 allows" },
	// Decision 3: TMPDIR rebinding read from the parse.
	{ command: 'x=$?; rm -rf "${TMPDIR:?}/me-x"', want: "allow", why: "3: $? is no rebinding" },
	{ command: 'echo "$(date)"; rm -rf "${TMPDIR:?}/me-x"', want: "allow", why: "3: $(...) is no rebinding" },
	{ command: 'TMPDIR=/ rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: prefix assignment" },
	{ command: 'export TMPDIR=/; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: export" },
	{ command: 'unset TMPDIR; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: unset (then :? stops; still asks)" },
	{ command: 'read TMPDIR; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: read" },
	{ command: 'printf -v TMPDIR /; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: printf -v" },
	{ command: '. ./vars; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: source" },
	{ command: 'eval "$S"; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: eval" },
	{ command: "env TMPDIR=/ bash -c 'rm -rf \"${TMPDIR:?}/x\"'", want: "ask", why: "3: env TMPDIR=" },
	{ command: 'TMP""DIR=/ x; \\export TMPDIR=/; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: spelled export" },
	{ command: 'z=TMPDIR=/; a[z]=1; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: arithmetic subscript" },
	{ command: 'declare -n r=TMPDIR; r=/; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: nameref" },
	{ command: 'f() { TMPDIR=/; }; f; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3: assignment in a function" },
	{ command: 'rm -rf "$TMPDIR/x"', want: "ask", why: "3 kept: $TMPDIR without :? may be /" },
	{ command: 'rm -rf "${TMPDIR:?}"/me-*', want: "ask", why: "3 kept: glob in a temp entry name" },
	// Decision 4: repo roots from disk.
	{ command: "rm -rf src", want: "ask-if-dirty", why: "4: in the session repo" },
	{ command: "rm -rf /w/app/skills/x", want: "ask-if-dirty", why: "4: absolute path into a repo" },
	{
		command: "cd /tmp && rm -rf /w/app/skills/x",
		want: "ask-if-dirty",
		why: "4: absolute path into a repo, from /tmp",
	},
	{ command: "rm -rf /w/app", want: "ask", why: "4: the repo root" },
	{ command: "rm -rf /w/app/.git", want: "ask", why: "4: .git" },
	{ command: "rm -rf /w/notes/old", want: "ask", why: "4: not in a repo" },
	{ command: "cd ~/.agents/skills && rm -rf caveman", want: "ask", why: "4: not in a repo (the user's example)" },
	{ command: "cd /w/lib && rm -rf build", want: "allow", why: "4: build dir in a repo" },
	{ command: "rm -rf /w/app/node_modules", want: "allow", why: "4: build dir at the repo root" },
	{ command: "rm -rf dist", want: "allow", why: "guard: build dir" },
	{ command: "cd /w/notes && rm -rf dist", want: "ask", why: "4: build-dir name outside a repo" },
	{ command: "cd /; rm -rf dist", want: "ask", why: "4: /dist is not a project build dir" },
	{ command: 'sudo rm -rf "${TMPDIR:?}/Users"', want: "ask", why: "3 kept: privilege wrapper (#77 rows)" },
	{ command: 'doas true; rm -rf "${TMPDIR:?}/x"', want: "ask", why: "3 kept: privilege wrapper (#77 rows)" },
	{ command: 'env -i rm -rf "${TMPDIR:?}/Users"', want: "ask", why: "3 kept: env option" },
	{ command: "rm -rf /w/app/*", want: "ask", why: "4: glob of the repo root" },
	{ command: "rm -rf /w/app/src/*", want: "ask-if-dirty", why: "4: glob inside the repo" },
	{ command: "rm -rf ~/x", want: "ask", why: "4: home is not a repo" },
	{ command: 'cd "$D" && rm -rf src', want: "ask", why: "4: unknown cwd" },
	{
		command: "cd /tmp && rm -rf d && mkdir d && cd d && true; cd /tmp && rm -rf d",
		want: "allow",
		why: "absolute cd resets an unknown cwd",
	},
	{ command: 'cd "$D"; cd y && rm -rf d', want: "ask", why: "relative cd from an unknown cwd" },
	{ command: "cd x && true; cd y && rm -rf d", want: "ask-if-dirty", why: "cd x surely ran: x/y is in the repo" },
	{ command: "rm -rf /tmp/x", want: "allow", why: "guard: temp" },
	{ command: "rm -rf /tmp/*", want: "ask", why: "guard: glob at a temp root" },
	{ command: "rm -rf /tmp/a*", want: "ask", why: "guard: glob in a temp entry name" },
	{ command: "rm -rf /tmp/x/*", want: "allow", why: "guard: glob inside a temp entry" },
	{ command: "rm -rf /tmp/x/{..,y}/z", want: "ask", why: "guard: .. never resolved away" },
	{ command: 'rm -rf "${TMPDIR:?}/$n"', want: "ask", why: "unknown entry name may be empty" },
	{ command: "GIT_DIR=/x git push origin HEAD", want: "ask", why: "1: GIT_DIR points elsewhere" },
	{ command: "cd /w/app && GIT_DIR=/x git push", want: "ask", why: "1: GIT_DIR points elsewhere" },
	{ command: 'T=$(mktemp -d) && rm -rf "$T"', want: "allow", why: "fresh temp" },
	// Decision 5: local remotes.
	{ command: "git push ../bare.git main", want: "allow", why: "5: local path" },
	{ command: "git push --force /tmp/r.git HEAD", want: "allow", why: "5: local path, forced" },
	{ command: "git push file:///tmp/r.git main", want: "allow", why: "5: file://" },
	{ command: "git push local main", want: "allow", why: "5: remote name with a local URL" },
	{ command: "git push -f local", want: "allow", why: "5: forced to a local-URL remote" },
	{ command: "git push origin main", want: "ask", why: "5: network remote" },
	{ command: "git push nope main", want: "ask", why: "5: unknown remote name" },
	{ command: "git remote add o ../r.git && git push o main", want: "allow", why: "5: added in the command" },
	{
		command:
			't=$(mktemp -d) && cd "$t" && git init -q r && cd r && git remote add up ../up.git && git push up main',
		want: "allow",
		why: "5: #964 shape",
	},
	{ command: "git push main", want: "allow", why: "a remote named `main`; pushes feat (as 0.1.3)" },
	{ command: "git push nope", want: "allow", why: "unknown remote, current branch feat: not case 3" },
	{ command: "cd /w/lib && git push nope", want: "ask", why: "5: unknown remote name, branch main" },
	{ command: "cd /w/lib && git push", want: "ask", why: "5: default remote, branch main" },
	{ command: "git push --force", want: "ask", why: "5: default remote, forced" },
	{ command: 'B=x; git push origin "$B"', want: "allow", why: "resolved refspec x" },
	{ command: 'git push origin "$B"', want: "ask", why: "unknown refspec" },
	// The #2625 fix.
	{ command: 'rm "$A/x" "$B/x"', want: "allow", why: "fix: a quoted $X/… is no option" },
	{ command: 'rm $A "$B/x"', want: "ask", why: "fix: an unquoted $A could be -r" },
];

let bad = 0;
for (const c of CASES) {
	const v = policy(c.command, "feat", ENV);
	if (v.verdict !== c.want) {
		bad++;
		console.log(`FAIL want ${c.want} got ${v.verdict} (${c.why}): ${JSON.stringify(c.command)}`);
		for (const f of v.findings) console.log(`     ${f.level} ${f.rule}: ${f.detail}`);
	}
}
console.log(`${CASES.length - bad}/${CASES.length} step-1b cases ok`);
if (bad) process.exitCode = 1;
