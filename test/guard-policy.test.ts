import assert from "node:assert/strict";
import test from "node:test";
import { type Level, type PolicyEnv, policy } from "../packages/pi-workers/extensions/guard-policy.ts";
import { initShell } from "../packages/pi-workers/extensions/guard-shell.ts";

await initShell();

interface Case {
	command: string;
	want: Level;
	branch?: string;
	why?: string;
}

/**
 * A fake disk. `/w/repo` (the step-1 session cwd) is a repo on the case's branch with a network `origin`; `/w/app` (the
 * step-1b cwd) is on `feat` with a network `origin` and a local `local` remote; `/w/lib` is on `main`; `/w/det` is
 * detached; everything else (`/w/notes`, `~/.agents/skills`, `~/proj`) is in no repo.
 */
function fakeEnv(cwd: string, branch: string): PolicyEnv {
	const repos: Record<string, { branch: string; remotes: Record<string, string> }> = {
		"/w/repo": { branch, remotes: { origin: "git@github.com:me/repo.git" } },
		"/w/app": { branch: "feat", remotes: { origin: "git@github.com:me/app.git", local: "../bare.git" } },
		"/w/lib": { branch: "main", remotes: { origin: "https://github.com/me/lib.git" } },
		"/w/det": { branch: "HEAD", remotes: {} },
	};
	const rootOf = (dir: string) => Object.keys(repos).find((r) => dir === r || dir.startsWith(`${r}/`));
	return {
		cwd,
		home: "/Users/me",
		branch: () => repos[cwd]?.branch,
		branchOf: (d) => {
			const r = rootOf(d);
			return r ? repos[r].branch : undefined;
		},
		repoRootOf: (d) => rootOf(d) ?? null,
		remoteUrlOf: (d, n) => {
			const r = rootOf(d);
			return r ? repos[r].remotes[n] : undefined;
		},
	};
}

function judge(cases: Case[], cwd: string, defaultBranch: string) {
	const bad: string[] = [];
	for (const c of cases) {
		const v = policy(c.command, fakeEnv(cwd, c.branch ?? defaultBranch));
		if (v.verdict !== c.want)
			bad.push(
				`want ${c.want} got ${v.verdict}${c.why ? ` (${c.why})` : ""}: ${JSON.stringify(c.command)}\n  ${v.findings
					.map((f) => `${f.level} ${f.rule}: ${f.detail}`)
					.join("\n  ")}`,
			);
	}
	assert.deepEqual(bad, [], `${bad.length} of ${cases.length} cases wrong`);
}

// Hand-judged cases from the measured prototype, step 1 (branch feature/x unless given). Two changed under the user's
// step-1b decisions, as commented.
const STEP1: Case[] = [
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
	{ command: `\\export T=/; rm -rf "\${TMPDIR:?}/x"`, want: "ask" },
	{ command: 'for s in status push; do git "$s"; done', want: "ask" },
	{ command: 'git "$S"', want: "ask" },
	{ command: 'T=$(mktemp -d); git -C "$T" init -q && git -C "$T" push origin feat', want: "allow" },
	{ command: 'T=$(mktemp -d); git clone -q x "$T" && git -C "$T" push', want: "ask" },
	{ command: "git checkout -b feat && git push -u origin HEAD", want: "allow" },
	{ command: "git checkout -b main && git push", want: "ask" },
	{ command: "git checkout feat && git push", want: "ask" },
	// TMPDIR forms and session variables.
	{ command: `rm -rf "\${TMPDIR:?}/me-pi-x"`, want: "allow" },
	// guard's rules: no glob in a temp entry name, and only plain text around ${TMPDIR:?}.
	{ command: `rm -rf "\${TMPDIR:-/tmp}"/me-pi-*`, want: "ask" },
	{ command: "rm -rf $TMPDIR/x", want: "ask" },
	{ command: `rm -rf "\${TMPDIR:?}"`, want: "ask" },
	{ command: "L=$TMPDIR/me; rm -rf $L/live", want: "ask" },
	{ command: 'rm -rf "$X"', want: "ask" },
	{ command: 'rm -rf "$PWD/node_modules"', want: "allow" },
	{ command: 'rm -rf "$PWD/src"', want: "ask-if-dirty" },
	{ command: "cd ~/proj && rm -rf src", want: "ask" }, // decision 4: ~/proj is in no repo,
	{ command: 'T=$(mktemp -d) && cd "$T" && rm -rf src', want: "allow" },
	{ command: "cd /tmp && rm -rf fakehome", want: "allow" },
	{ command: "cd /tmp && rm -rf ../x", want: "ask" },
	{ command: "(cd /tmp); rm -rf src", want: "ask-if-dirty" }, // round 8: a subshell cd never moves rm; both dirs are judged and the repo one is case 2
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
	{ command: `args=(-rf /Users); rm "\${args[@]}"`, want: "ask" },
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
	// Parse failure: 0.1.3's regex verdict (decision 2), which asks here.
	{ command: "rm -rf ~ )", want: "ask" },
];

// Step 1b: the user decisions; the session cwd is /w/app on feat.
const STEP1B: Case[] = [
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
	{ command: `x=$?; rm -rf "\${TMPDIR:?}/me-x"`, want: "allow", why: "3: $? is no rebinding" },
	{ command: `echo "$(date)"; rm -rf "\${TMPDIR:?}/me-x"`, want: "allow", why: "3: $(...) is no rebinding" },
	{ command: `TMPDIR=/ rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: prefix assignment" },
	{ command: `export TMPDIR=/; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: export" },
	{ command: `unset TMPDIR; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: unset (then :? stops; still asks)" },
	{ command: `read TMPDIR; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: read" },
	{ command: `printf -v TMPDIR /; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: printf -v" },
	{ command: `. ./vars; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: source" },
	{ command: `eval "$S"; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: eval" },
	{ command: `env TMPDIR=/ bash -c 'rm -rf "\${TMPDIR:?}/x"'`, want: "ask", why: "3: env TMPDIR=" },
	{ command: `TMP""DIR=/ x; \\export TMPDIR=/; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: spelled export" },
	{ command: `z=TMPDIR=/; a[z]=1; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: arithmetic subscript" },
	{ command: `declare -n r=TMPDIR; r=/; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: nameref" },
	{ command: `f() { TMPDIR=/; }; f; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3: assignment in a function" },
	{ command: 'rm -rf "$TMPDIR/x"', want: "ask", why: "3 kept: $TMPDIR without :? may be /" },
	{ command: `rm -rf "\${TMPDIR:?}"/me-*`, want: "ask", why: "3 kept: glob in a temp entry name" },
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
	{ command: `sudo rm -rf "\${TMPDIR:?}/Users"`, want: "ask", why: "3 kept: privilege wrapper (#77 rows)" },
	{ command: `doas true; rm -rf "\${TMPDIR:?}/x"`, want: "ask", why: "3 kept: privilege wrapper (#77 rows)" },
	{ command: `env -i rm -rf "\${TMPDIR:?}/Users"`, want: "ask", why: "3 kept: env option" },
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
	{ command: `rm -rf "\${TMPDIR:?}/$n"`, want: "ask", why: "unknown entry name may be empty" },
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
		command: 't=$(mktemp -d) && cd "$t" && git init -q r && cd r && git remote add up ../up.git && git push up main',
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

test("step-1 hand cases: the 3 cases, text that isn't a command, and unknowns", () =>
	judge(STEP1, "/w/repo", "feature/x"));
test("step-1b hand cases: the user's five decisions on a fake disk", () => judge(STEP1B, "/w/app", "feat"));

test("issue rows: a heredoc written to a file is text (#94); a bare push with a redirect still pushes (#93)", () => {
	const heredoc =
		"cd /tmp/gv && cat > q.mjs <<'EOF'\nconsole.log(`rm -rf '/tmp/x/ > /../../../Users'`);\nEOF\nnode q.mjs";
	assert.equal(policy(heredoc, fakeEnv("/w/repo", "feature/x")).verdict, "allow");
	assert.equal(policy("git push origin 2>&1", fakeEnv("/w/repo", "main")).verdict, "ask");
	assert.equal(policy("git push origin 2>&1", fakeEnv("/w/repo", "feature/x")).verdict, "allow");
});

test("a case-2 finding names the repo and paths to check for uncommitted work", () => {
	const env = fakeEnv("/w/app", "feat");
	const check = (command: string) => {
		const v = policy(command, env);
		assert.equal(v.verdict, "ask-if-dirty", command);
		return v.findings.map((f) => f.dirty);
	};
	const whole = { paths: undefined, ignored: false, always: false };
	assert.deepEqual(check("git reset --hard"), [{ repo: "/w/app", ...whole, untracked: false }]);
	assert.deepEqual(check("git switch -f other"), [{ repo: "/w/app", ...whole, untracked: false }]);
	assert.deepEqual(check("git clean -fd src"), [
		{ repo: "/w/app", paths: ["/w/app/src"], untracked: true, ignored: false, always: false },
	]);
	assert.deepEqual(check("git checkout -- a.txt b/c.txt"), [
		{ repo: "/w/app", paths: ["/w/app/a.txt", "/w/app/b/c.txt"], untracked: false, ignored: false, always: false },
	]);
	assert.deepEqual(check("git -C /w/lib restore x"), [
		{ repo: "/w/lib", paths: ["/w/lib/x"], untracked: false, ignored: false, always: false },
	]);
	assert.deepEqual(check("git checkout -- '*.ts'"), [{ repo: "/w/app", ...whole, untracked: false }]);
	assert.deepEqual(check("rm -rf src/x"), [
		{ repo: "/w/app", paths: ["/w/app/src/x"], untracked: true, ignored: false, always: false },
	]);
	assert.deepEqual(check("rm -rf /w/lib/x"), [
		{ repo: "/w/lib", paths: ["/w/lib/x"], untracked: true, ignored: false, always: false },
	]);
	assert.deepEqual(check("rm -rf src/*"), [
		{ repo: "/w/app", paths: ["/w/app/src"], untracked: true, ignored: false, always: false },
	]);
	assert.deepEqual(check("git clean -fdx"), [
		{ repo: "/w/app", paths: undefined, untracked: true, ignored: true, always: false },
	]);
	assert.deepEqual(check("git stash drop"), [
		{ repo: undefined, paths: undefined, untracked: false, ignored: false, always: true },
	]);
});

test("reports what the dropped history rules were, for the worker side", () => {
	const env = fakeEnv("/w/repo", "feature/x");
	for (const command of [
		"git commit --amend --no-edit",
		"git rebase -i HEAD~2",
		"git branch -D old",
		"git filter-repo --force",
	]) {
		const v = policy(command, env);
		assert.equal(v.verdict, "allow", command);
		assert.ok(v.dropped.length > 0, `${command} reports a dropped rule`);
	}
});

test("PR #95 review bypasses: each asks (they were allowed at 00c2e96)", () => {
	const app = fakeEnv("/w/app", "feat");
	const asks = (command: string, env: PolicyEnv = app) => {
		const v = policy(command, env);
		assert.notEqual(v.verdict, "allow", command);
		return v;
	};
	// 1. `~name` is that user's home, `~-` is $OLDPWD: unknown, never a relative path in the repo.
	for (const command of [
		"rm -rf ~mmo",
		"rm -rf ~root",
		"rm -rf ~root/.ssh",
		"rm -rf ~-",
		"rm -rf ~-/x",
		"x=~root; rm -rf $x",
	])
		assert.equal(asks(command).verdict, "ask", command);
	// `~+` is $PWD: a repo-relative path like any other.
	assert.equal(policy("rm -rf ~+/dist", app).verdict, "allow");
	assert.equal(policy("rm -rf ~+", app).verdict, "ask", "~+ is the repo root");
	// 2. Glob characters from an unquoted expansion glob: judged by the directory they glob in, not as a literal name.
	for (const command of [
		"p='src/*'; rm -rf $p",
		"p=src/*; rm -rf $p",
		"p='src/[ab]'; rm -rf $p",
		"p='src/?'; rm -rf $p",
	]) {
		const v = asks(command);
		assert.deepEqual(v.findings[0].dirty?.paths, ["/w/app/src"], command);
	}
	assert.equal(asks("p='*'; rm -rf $p").verdict, "ask", "the repo root, globbed");
	assert.deepEqual(
		asks(`p='src/*'; rm -rf "$p"`).findings[0].dirty?.paths,
		["/w/app/src/*"],
		"quoted: a literal name",
	);
	// 3. git pointed at another repo or work tree: where it acts is unknown, so the dirty check can't be scoped.
	for (const command of [
		"git --git-dir=/w/lib/.git --work-tree=/w/lib reset --hard",
		"git --work-tree=/w/lib checkout -- .",
		"git --git-dir /w/lib/.git reset --hard",
		"GIT_DIR=/w/lib/.git git reset --hard",
		"GIT_WORK_TREE=/w/lib git clean -fd",
		"export GIT_DIR=/w/lib/.git; git reset --hard",
		"env GIT_DIR=/w/lib/.git git reset --hard",
		"git -c core.worktree=/w/lib reset --hard",
		"git -C /w/lib --git-dir=.git reset --hard",
	])
		assert.equal(asks(command).findings[0].dirty?.repo, undefined, command);
	// 4. A new branch named through a variable is resolved; an unknown one asks.
	for (const flag of ["-b", "-B"])
		assert.equal(asks(`B=main; git checkout ${flag} "$B" && git push -u origin HEAD`).verdict, "ask", flag);
	for (const flag of ["-c", "-C"])
		assert.equal(asks(`B=master; git switch ${flag} $B && git push`).verdict, "ask", flag);
	assert.equal(asks(`git checkout -B "$B" && git push -u origin HEAD`).verdict, "ask", "unknown B");
	assert.equal(policy(`B=topic; git checkout -b "$B" && git push -u origin HEAD`, app).verdict, "allow");
	assert.equal(policy("git checkout -b topic && git push -u origin HEAD", app).verdict, "allow");
	// 5. A failed lookup is unknown, never "not protected", "not a repo", or "local".
	const failing: PolicyEnv = {
		...app,
		branch: () => undefined,
		branchOf: () => undefined,
		repoRootOf: () => undefined,
		remoteUrlOf: () => undefined,
	};
	assert.equal(asks("git push origin", failing).verdict, "ask", "the session branch can't be read");
	assert.equal(asks("git push", failing).verdict, "ask");
	assert.equal(asks("cd /w/lib && git push", failing).verdict, "ask", "the cd target's branch can't be read");
	assert.equal(asks("git push local main", failing).verdict, "ask", "a remote whose URL can't be read isn't local");
	assert.equal(asks("rm -rf /tmp/x", failing).verdict, "ask", "even a temp path: a repo there can't be ruled out");
	assert.equal(asks("rm -rf src", failing).verdict, "ask");
	assert.equal(asks("git reset --hard", failing).findings[0].dirty?.repo, undefined, "the repo can't be read");
	assert.equal(policy("git push origin feat", failing).verdict, "allow", "a named feature branch needs no read");
});

test("find -delete is a recursive rm of each start path; find -exec/xargs rm is that rm (PR #95 round 3)", () => {
	// /w/app is the session repo on feat; nothing else is a repo.
	const env = fakeEnv("/w/app", "feat");
	const rows: [Level, string][] = [
		["ask", "find ~ -delete"],
		["ask", "find -L / -delete"],
		["ask", "find / -name core -delete"],
		["ask", 'find "$HOME/x" -delete'],
		["ask", "find ~/.pi/agent -type f -delete"],
		["ask", "find $X -delete"],
		["ask", "find /Users/nobody-guard-test ! -name keep -delete"],
		["ask", "find ~ -exec rm -r {} \\;"],
		["ask", "find ~ -execdir rm -rf {} +"],
		["ask", "find ~ -ok rm -r {} \\;"],
		["ask", "find ~ -okdir rm -rf {} \\;"],
		["ask", "find ~ -print0 | xargs -0 rm -rf"],
		["ask", "find / -name x | xargs rm -r"],
		["ask-if-dirty", "find src -name x -delete"],
		["allow", "find /tmp/x -delete"],
		["allow", "find dist -name '*.map' -delete"],
		["allow", "find node_modules -delete"],
		["allow", 't=$(mktemp -d); find "$t" -delete'],
		["allow", "find ~ -name x"],
		["allow", "find / -name x -print"],
		["allow", "find . -name '*.ts' -exec grep -l x {} +"],
		["allow", "echo 'find ~ -delete'"],
		["ask", "find -delete"],
		["ask", "find . -delete"],
		["ask", "find . -depth -delete"],
		["ask", "find .git -name x -delete"],
		["ask", "find ~ -name x -delete"],
	];
	const bad = rows.filter(([want, command]) => policy(command, env).verdict !== want).map(([w, c]) => `${w}: ${c}`);
	assert.deepEqual(bad, []);
	const v = policy("find src -name '*.pyc' -delete", env);
	assert.deepEqual(v.findings[0].dirty, {
		repo: "/w/app",
		paths: ["/w/app/src"],
		untracked: true,
		ignored: false,
		always: false,
	});
});

test("a find -delete at or above a repo root is case 1 whatever its expression (PR #95 round 4)", () => {
	// Real bash: `find . -type f -delete` at a repo root deletes .git's files too, so history is gone. Proving that an
	// expression spares .git is not attempted: every start at or above a root asks, like `rm -rf .`.
	const atRoot = fakeEnv("/w/app", "feat");
	const inSrc = fakeEnv("/w/app/src", "feat");
	for (const command of [
		"find . -type f -delete",
		"find . ! -name keep -delete",
		`find "$PWD" -type f -delete`,
		"find . -name '*.pyc' -delete",
		"find -type f -delete",
		"find ./ -name x -delete",
		"find /w/app -type f -delete",
		"find /w -name x -delete",
	])
		assert.equal(policy(command, atRoot).verdict, "ask", command);
	for (const command of ["find .. -name x -delete", "find ../ -type f -delete"])
		assert.equal(policy(command, inSrc).verdict, "ask", `from a subdir: ${command}`);
	// A start inside the repo stays case 2 (asks only if src has uncommitted work).
	assert.equal(policy("find src -type f -delete", atRoot).verdict, "ask-if-dirty");
	assert.equal(policy("find . -type f -delete", inSrc).verdict, "ask-if-dirty");
});

test("PR #95 round 5: find options before the start paths, $PWD/~+ after cd, unknown find expressions", () => {
	// /w/app is the session repo on feat; nothing else is a repo; HOME is /Users/me.
	const rows: [string, Level, string][] = [
		["/w/app", "ask", "find ~ $(printf -- -delete)"],
		["/w/app", "ask", "find ~ `echo -delete`"],
		["/w/app", "ask", "D=-delete; find ~ $D"],
		["/w/app", "ask", "find ~ $D"],
		["/w/app", "ask", "X=-exec; find ~ $X rm -rf {} +"],
		["/w/app", "ask", "find -f ~ -delete"],
		["/w/app", "ask", "find -d ~ -delete"],
		["/w/app", "ask", "find -x / -delete"],
		["/w/app", "ask", "find -- ~ -delete"],
		["/w/app", "ask", "find -E ~ -delete"],
		["/w/app", "ask", "find -s / -delete"],
		["/w/app", "ask", "find -O3 ~ -delete"],
		["/w/app", "ask", "find -D tree ~ -delete"],
		["/w/app", "ask", "find -Y ~ -delete"],
		["/w/app", "ask", "find $OPTS ~ -delete"],
		["/w/app", "ask", "cd ~ && rm -rf ~+/Documents"],
		["/w/app", "ask", 'cd ~ && rm -rf "$PWD/Documents"'],
		["/w/app", "ask", "cd ~ && find ~+/Documents -delete"],
		["/w/app", "ask", "cd /w/app && cd ~ && rm -rf ~-/x"],
		["/w/app", "ask", "cd ~ && cd /tmp && rm -rf ~-/Documents"],
		["/w/app", "ask", 'cd ~ && cd /tmp && rm -rf "$OLDPWD/Documents"'],
		["/w/app", "ask", 'cd "$X" && rm -rf "$PWD/y"'],
		["/w/app", "ask-if-dirty", 'rm -rf "$PWD/src"'],
		["/w/app", "ask-if-dirty", "rm -rf ~+/src"],
		["/w/app", "allow", 'rm -rf "$PWD/dist"'],
		["/w/app", "allow", 'cd /tmp/x && rm -rf "$PWD/y"'],
		["/w/app", "ask", "cd /tmp/x && cd /w/app && rm -rf ~-/y"],
		["/w/app", "allow", "find -x /tmp/x -delete"],
		["/w/app", "allow", "find -f /tmp/x -delete"],
		["/w/app", "allow", "find -E dist -name x -delete"],
		["/w/app", "ask", "find ~ $N -name x"],
		["/w/app", "allow", "N=x; find ~ -name $N"],
		["/w/app", "allow", 'find ~ -name "$N" -print'],
		["/w/app", "allow", "find -x ~ -name x"],
		["/w/app", "allow", 'find . -name "$N" -print'],
		["/w/app", "ask", "find ~ -name $N -delete"],
		["/w/app", "ask", "find ~ -name $N"],
	];
	const bad = rows
		.filter(([cwd, want, command]) => policy(command, fakeEnv(cwd, "feat")).verdict !== want)
		.map(([cwd, want, command]) => `${cwd} ${want}: ${command}`);
	assert.deepEqual(bad, []);
});

test("PR #95 round 5: a quoted find start path is one path; only an unknown word find may read as an action asks", () => {
	// Real session commands (shapes): `find "$d" -name x -print` lists files; it must not ask because $d is unknown.
	const rows: [string, Level, string][] = [
		[
			"/w/app",
			"allow",
			"find ~/.config ~/.local/share ~/Library/Application\\ Support -maxdepth 3 -iname '*agy*' -o -maxdepth 3 -iname '*an*'",
		],
		[
			"/w/app",
			"allow",
			"find ~/Library/Application\\ Support/Antigravity ~/.antigravity -maxdepth 4 \\( -iname '*.db' -o -iname '*.sqlite*' \\) -print",
		],
		["/w/app", "allow", "find ~/A\\ B -name x"],
		["/w/app", "ask", "p='~ -delete'; find $p"],
		["/w/app", "ask", "p='x -delete'; find ~ $p"],
		["/w/app", "allow", "p='~/A B'; find \"$p\" -name x"],
		["/w/app", "allow", "find \"$d\" -type f \\( -name '*.jsonl' -o -name '*.ndjson' \\) -print"],
		["/w/app", "allow", "find \"$HOME/Library/Preferences\" -maxdepth 1 -iname '*proton*' -print"],
		["/w/app", "allow", "find \"$d\" -maxdepth 1 -name '*.plist' -print"],
		["/w/app", "allow", "find ~/.config ~/.local/share -maxdepth 3 -iname '*agy*' -print"],
		["/w/app", "allow", "find \"$f\" -type f -name '*.jsonl'"],
		["/w/app", "allow", 'find "$d" -maxdepth 2 -type f -ls'],
		["/w/app", "ask", "find $gd/objects -type f -newermt x"],
		["/w/app", "allow", "gd=.git; find $gd/objects -type f -newermt x"],
		["/w/app", "ask", 'find "$d" -delete'],
		["/w/app", "ask", "find ~ $D"],
		["/w/app", "ask", "find $D ~"],
		["/w/app", "ask", 'find "$d" $X'],
	];
	const bad = rows
		.filter(([cwd, want, command]) => policy(command, fakeEnv(cwd, "feat")).verdict !== want)
		.map(([cwd, want, command]) => `${cwd} ${want}: ${command}`);
	assert.deepEqual(bad, []);
});

test("PR #95 round 6: code the policy can't trace fails closed (git strings, stdin scripts, written scripts, placeholders)", () => {
	// /w/app is the session repo on feat (remotes: origin network, local ../bare.git); HOME is /Users/me.
	const rows: [string, Level, string][] = [
		["/w/app", "ask-if-dirty", "git reset --ha"],
		["/w/app", "ask-if-dirty", "git clean --fo -d"],
		["/w/app", "ask", "git push --fo origin feat"],
		["/w/app", "ask", "git push --mi origin"],
		["/w/app", "ask", "git push origin 'refs/heads/*:refs/heads/*'"],
		["/w/app", "ask", "git push origin '*:*'"],
		["/w/app", "ask", "git push origin '+refs/heads/*:refs/heads/*'"],
		["/w/app", "ask", "git push origin 'refs/heads/m*'"],
		["/w/app", "ask", "git push --all origin"],
		["/w/app", "allow", "git push origin feat"],
		["/w/app", "allow", "git push origin 'refs/tags/*'"],
		["/w/app", "allow", "git status --porcelain"],
		["/w/app", "allow", "git log --oneline -5"],
		["/w/app", "allow", "git -c user.email=a@b commit -m x"],
		["/w/app", "allow", "git -c color.ui=never log"],
		["/w/app", "ask", "git -c alias.x='!rm -rf ~' x"],
		["/w/app", "ask", "git -c alias.x='reset --hard' x"],
		["/w/app", "ask", "git -c core.fsmonitor='rm -rf ~' status"],
		["/w/app", "ask", "git -c core.sshCommand='rm -rf ~' fetch"],
		["/w/app", "ask", "git -c core.pager='rm -rf ~' log"],
		["/w/app", "ask", "git rebase -x 'rm -rf ~' HEAD~1"],
		["/w/app", "ask", "git rebase --exec 'rm -rf ~' HEAD~1"],
		["/w/app", "ask", "git filter-branch --tree-filter 'rm -rf ~' HEAD"],
		["/w/app", "ask", "git filter-branch --index-filter x HEAD"],
		["/w/app", "ask", "git bisect run sh -c 'rm -rf ~'"],
		["/w/app", "ask", "git submodule foreach 'git clean -fdx'"],
		["/w/app", "ask", "git x"],
		["/w/app", "ask", "git st"],
		["/w/app", "allow", "git rebase --continue"],
		["/w/app", "allow", "git rebase -i HEAD~2"],
		["/w/app", "allow", "git bisect start"],
		["/w/app", "allow", "git submodule update --init"],
		["/w/app", "ask", "bash /dev/stdin <<'EOF'\nrm -rf ~\nEOF"],
		["/w/app", "ask", "sh /dev/fd/0 <<'EOF'\nrm -rf ~\nEOF"],
		["/w/app", "ask", ". /dev/stdin <<'EOF'\nrm -rf ~\nEOF"],
		["/w/app", "ask", "source /dev/stdin <<< 'rm -rf ~'"],
		["/w/app", "ask", "bash - <<'EOF'\nrm -rf ~\nEOF"],
		["/w/app", "ask", "bash /proc/self/fd/0 <<'EOF'\nrm -rf ~\nEOF"],
		["/w/app", "allow", "bash /dev/stdin <<'EOF'\necho hi\nEOF"],
		["/w/app", "ask", "cat > a.sh <<'EOF'\nrm -rf ~\nEOF\ncp a.sh b.sh; sh b.sh"],
		["/w/app", "ask", "cat > a.sh <<'EOF'\nrm -rf ~\nEOF\nmv a.sh b.sh && bash b.sh"],
		["/w/app", "ask", "cat > a.sh <<'EOF'\nrm -rf ~\nEOF\nln -s a.sh b && ./b"],
		["/w/app", "ask", "cat > a.sh <<'EOF'\nrm -rf ~\nEOF\nchmod +x a.sh && ./a.sh"],
		["/w/app", "allow", "cat > notes.md <<'EOF'\nrm -rf ~\nEOF"],
		["/w/app", "allow", "cat > a.sh <<'EOF'\necho hi\nEOF\ncp a.sh b.sh; sh b.sh"],
		["/w/app", "ask", "echo ~ | xargs -I{} sh -c 'rm -rf {}'"],
		["/w/app", "ask", "find ~ -maxdepth 1 -exec sh -c 'rm -rf {}' \\;"],
		["/w/app", "ask", "find ~ -execdir sh -c 'rm -rf {}' +"],
		["/w/app", "ask", "ls | xargs -I % sh -c 'rm -rf %'"],
		["/w/app", "ask", "find . -name '*.ts' -exec sh -c 'echo {}' \\;"],
		["/w/app", "ask", "arch -arm64 rm -rf ~"],
		["/w/app", "ask", "script -q /dev/null rm -rf ~"],
		["/w/app", "ask", "csh -c 'rm -rf ~'"],
		["/w/app", "ask", "tcsh -c 'rm -rf ~'"],
		["/w/app", "ask", "fish -c 'rm -rf ~'"],
		["/w/app", "ask", "lockf /tmp/l rm -rf ~"],
		["/w/app", "ask", "chroot / rm -rf ~"],
		["/w/app", "ask", "sandbox-exec -f p.sb rm -rf ~"],
		["/w/app", "ask", "taskpolicy -c utility rm -rf ~"],
		["/w/app", "ask", "caffeinate -i rm -rf ~"],
		["/w/app", "allow", "git push ../bare.git '*:*'"],
	];
	const bad = rows
		.filter(([cwd, want, command]) => policy(command, fakeEnv(cwd, "feat")).verdict !== want)
		.map(([cwd, want, command]) => `${cwd} ${want}: ${command}`);
	assert.deepEqual(bad, []);
});

test("PR #95 round 7: git commands through options, env vars, and config written earlier fail closed", () => {
	// /w/app is the session repo on feat; HOME is /Users/me. Text that only mentions a variable doesn't count.
	const rows: [string, Level, string][] = [
		["/w/app", "ask", "git fetch --upload-pack='rm -rf ~;:' ."],
		["/w/app", "ask", "git fetch --upload='rm -rf ~;:' origin"],
		["/w/app", "ask", "git ls-remote --upload-pack='x' ."],
		["/w/app", "ask", "git clone -u 'x' . /tmp/x"],
		["/w/app", "ask", "git pull -u x origin"],
		["/w/app", "ask", "git push --receive-pack='x' ../bare.git feat"],
		["/w/app", "ask", "git push --rec='x' origin feat"],
		["/w/app", "ask", "git archive --remote=. --exec='x' HEAD"],
		["/w/app", "ask", "git send-pack --exec=x ../r"],
		["/w/app", "ask", "git grep -O'x' foo"],
		["/w/app", "ask", "git grep --open-files-in-pager=x foo"],
		["/w/app", "ask", "git --config-env=core.editor=ED commit"],
		["/w/app", "ask", "git difftool --extcmd=x"],
		["/w/app", "ask", "GIT_EDITOR='rm -rf ~' git commit --edit"],
		["/w/app", "ask", "GIT_SEQUENCE_EDITOR='x' git rebase -i HEAD~2"],
		["/w/app", "ask", "GIT_SSH_COMMAND='x' git fetch"],
		["/w/app", "ask", "GIT_SSH=x git fetch"],
		["/w/app", "ask", "GIT_EXTERNAL_DIFF=x git diff"],
		["/w/app", "ask", "GIT_PAGER=x git log"],
		["/w/app", "ask", "GIT_ASKPASS=x git push origin feat"],
		["/w/app", "ask", "GIT_PROXY_COMMAND=x git fetch"],
		["/w/app", "ask", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=x git log"],
		["/w/app", "ask", "GIT_CONFIG_PARAMETERS=\"'core.pager=x'\" git log"],
		["/w/app", "ask", "GIT_CONFIG_GLOBAL=/tmp/evil git log"],
		["/w/app", "ask", "EDITOR=x git commit"],
		["/w/app", "ask", "VISUAL=x git commit"],
		["/w/app", "ask", "PAGER=x git log"],
		["/w/app", "ask", "env GIT_EDITOR=x git commit"],
		["/w/app", "ask", "env -u HOME GIT_SSH_COMMAND=x git fetch"],
		["/w/app", "ask", "export GIT_EDITOR=x; git commit"],
		["/w/app", "ask", "export GIT_SSH_COMMAND=x && git fetch"],
		["/w/app", "ask", "git config core.editor 'x' && git commit"],
		["/w/app", "ask", "git config --global core.sshCommand x"],
		["/w/app", "ask", "git config --local alias.x '!x'"],
		["/w/app", "ask", "git config --add core.hooksPath x"],
		["/w/app", "ask", "git config set core.pager x"],
		["/w/app", "ask", "git config diff.foo.textconv x"],
		["/w/app", "allow", "git config user.name 'A B'"],
		["/w/app", "allow", "git config --global user.email a@b"],
		["/w/app", "allow", "git config --get core.editor"],
		["/w/app", "allow", "git config core.editor"],
		["/w/app", "allow", "git config --list"],
		["/w/app", "allow", "git config --unset core.editor"],
		["/w/app", "allow", "git config get user.name"],
		["/w/app", "allow", "git push -u origin feat"],
		["/w/app", "allow", "git fetch origin"],
		["/w/app", "allow", "git grep -n foo"],
		["/w/app", "allow", "git log -5"],
		["/w/app", "allow", "GIT_TRACE=1 git status"],
		["/w/app", "allow", "GIT_AUTHOR_NAME=x git commit -m y"],
		["/w/app", "allow", "export FOO=1; git status"],
		["/w/app", "allow", "echo 'GIT_EDITOR=x'; git status"],
		["/w/app", "allow", "git commit -m 'set EDITOR=vim in docs'"],
	];
	const bad = rows
		.filter(([cwd, want, command]) => policy(command, fakeEnv(cwd, "feat")).verdict !== want)
		.map(([cwd, want, command]) => `${cwd} ${want}: ${command}`);
	assert.deepEqual(bad, []);
});

test("PR #95 round 8: state set by an earlier command counts only if it surely ran first (same && chain)", () => {
	// /w/app is the session repo on feat (origin network, local ../bare.git); /tmp/x is a temp dir; disks may be
	// case-insensitive (APFS), so SRC is src and .GIT is .git.
	const rows: [string, Level, string][] = [
		["/w/app", "ask", "git checkout -b topic; git push -u origin HEAD"],
		["/w/app", "ask", "git checkout -b topic & git push -u origin HEAD"],
		["/w/app", "ask", "git checkout -b topic || git push -u origin HEAD"],
		["/w/app", "allow", "git checkout -b topic && git push -u origin HEAD"],
		["/w/app", "ask", 'B=topic & git checkout -b "$B" && git push'],
		["/w/app", "ask", 'T=$(mktemp -d) & rm -rf "$T"'],
		["/w/app", "ask", 'false && T=$(mktemp -d); rm -rf "$T"'],
		["/w/app", "allow", 'T=$(mktemp -d) && rm -rf "$T"'],
		["/w/app", "allow", 'T=$(mktemp -d); rm -rf "$T"'],
		["/w/app", "ask-if-dirty", "cd /tmp/x & rm -rf src"],
		["/w/app", "ask-if-dirty", "cd /tmp/x || rm -rf src"],
		["/w/app", "ask", "cd /tmp/x; rm -rf *"],
		["/w/app", "ask", "cd /tmp/x | rm -rf *"],
		["/w/app", "ask", "(cd /tmp/x); rm -rf *"],
		["/w/app", "ask", "if true; then cd /tmp/x; fi; rm -rf *"],
		["/w/app", "ask", "pushd /tmp/x & rm -rf *"],
		["/w/app", "allow", "cd /tmp/x && rm -rf *"],
		["/w/app", "allow", "cd /tmp/x && cd y && rm -rf z"],
		["/w/app", "ask-if-dirty", "cd /tmp/x; rm -rf src"],
		["/w/app", "ask", "rm -rf /W/App"],
		["/w/app", "ask", "rm -rf .GIT"],
		["/w/app", "ask", "rm -rf src/.Git/x"],
		["/w/app", "ask-if-dirty", "rm -rf SRC"],
		["/w/app", "ask", "git remote add origin /tmp/nowhere; git push --force origin feat"],
		["/w/app", "ask", "false && git remote set-url origin /tmp/x; git push -f origin main"],
		["/w/app", "ask", "git -C /tmp remote add origin /x; git push -f origin feat"],
		["/w/app", "ask", "git remote add up /tmp/r.git & git push -f up main"],
		["/w/app", "allow", "git remote add up /tmp/r.git && git push -f up main"],
		["/w/app", "allow", "git push -f local main"],
		["/w/app", "ask", "git remote set-url local https://x/y.git; git push -f local main"],
		["/w/app", "allow", "git remote set-url local /tmp/z.git && git push -f local main"],
		["/w/app", "ask", "export GIT_EDITOR=x & git commit"],
		["/w/app", "ask", "git config core.editor x; git commit"],
	];
	const bad = rows
		.filter(([cwd, want, command]) => policy(command, fakeEnv(cwd, "feat")).verdict !== want)
		.map(([cwd, want, command]) => `${cwd} ${want}: ${command}`);
	assert.deepEqual(bad, []);
});

test("PR #95 round 9: functions, loops and traps run out of text order; shell options; unknown wrappers", () => {
	// /w/app is the session repo on feat; HOME is /Users/me (Library is under it).
	const rows: [string, Level, string][] = [
		["/w/app", "ask", "f() { rm -rf Library; }; cd ~ && f"],
		["/w/app", "ask", "for i in 1 2; do rm -rf Library; cd ~; done"],
		["/w/app", "ask", "trap 'rm -rf Library' EXIT; cd ~"],
		["/w/app", "ask", "f() { git push; }; git checkout main && f"],
		["/w/app", "ask", "for i in 1 2; do git push; git checkout main; done"],
		["/w/app", "ask", "while true; do rm -rf Library; cd ~; done"],
		["/w/app", "ask", "until false; do rm -rf Library; cd ~; done"],
		["/w/app", "ask", "function g { rm -rf Library; }; cd ~; g"],
		["/w/app", "ask", "trap 'rm -rf Library' INT; cd ~"],
		["/w/app", "ask-if-dirty", "f() { rm -rf src; }; f"],
		["/w/app", "allow", "for f in a b; do echo $f; done"],
		["/w/app", "allow", "f() { echo hi; }; cd /tmp && f"],
		["/w/app", "allow", "for i in 1 2; do rm -rf dist; done"],
		["/w/app", "ask", "bash -s -- x <<'EOF'\nrm -rf ~\nEOF"],
		["/w/app", "ask", "sh -s foo <<EOF\nrm -rf ~\nEOF"],
		["/w/app", "ask", "bash -es <<'EOF'\nrm -rf ~\nEOF"],
		["/w/app", "ask", "bash -O extglob -c 'rm -rf ~'"],
		["/w/app", "ask", "sh +O nullglob -c 'rm -rf ~'"],
		["/w/app", "ask", "bash -o pipefail -c 'rm -rf ~'"],
		["/w/app", "ask", "bash --rcfile x -c 'rm -rf ~'"],
		["/w/app", "ask", "bash --norc -c 'rm -rf ~'"],
		["/w/app", "ask", "bash -euxc 'rm -rf ~'"],
		["/w/app", "ask", "bash --unknown-opt <<'EOF'\necho hi\nEOF"],
		["/w/app", "ask", "bash -Q -c 'echo hi'"],
		["/w/app", "allow", "bash -c 'echo hi'"],
		["/w/app", "allow", "bash -o pipefail -c 'echo hi'"],
		["/w/app", "allow", "bash -s <<'EOF'\necho hi\nEOF"],
		["/w/app", "allow", "bash -n script.sh"],
		["/w/app", "allow", "bash --version"],
		["/w/app", "ask", "busybox rm -rf ~"],
		["/w/app", "ask", "fakeroot rm -rf ~"],
		["/w/app", "ask", "parallel rm -rf ::: ~"],
		["/w/app", "ask", "xcrun rm -rf ~"],
		["/w/app", "ask", "strace -f rm -rf ~"],
		["/w/app", "ask", "nsenter -t 1 rm -rf ~"],
		["/w/app", "ask", "unshare -r rm -rf ~"],
		["/w/app", "ask", "taskset -c 0 rm -rf ~"],
		["/w/app", "ask", "chrt -f 10 rm -rf ~"],
		["/w/app", "ask", "proxychains4 git push -f origin main"],
		["/w/app", "ask", "torsocks git push -f origin main"],
		["/w/app", "ask", "mytool rm -rf ~"],
		["/w/app", "ask", "devbox run git push -f origin main"],
		["/w/app", "ask", "nix-shell -p x --run x rm -rf ~"],
		["/w/app", "allow", "echo rm -rf ~"],
		["/w/app", "allow", "grep -rn 'git push' ."],
		["/w/app", "allow", "man rm"],
		["/w/app", "allow", "which git"],
		["/w/app", "allow", "gh repo view"],
		["/w/app", "allow", "mytool --verbose build"],
		["/w/app", "allow", "parallel echo ::: a b"],
		["/w/app", "allow", "git rm -r --cached extensions/node_modules -q"],
		["/w/app", "allow", "git rm -rf skills"],
		["/w/app", "allow", "git rm -q notes.md"],
		["/w/app", "allow", "find . -name rm -print"],
	];
	const bad = rows
		.filter(([cwd, want, command]) => policy(command, fakeEnv(cwd, "feat")).verdict !== want)
		.map(([cwd, want, command]) => `${cwd} ${want}: ${command}`);
	assert.deepEqual(bad, []);
});
