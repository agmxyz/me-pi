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
	{ command: "(cd /tmp); rm -rf src", want: "ask" }, // a subshell cd: the cwd after it is not read,
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
