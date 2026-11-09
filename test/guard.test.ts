import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type PolicyEnv, policy } from "../packages/pi-workers/extensions/guard-policy.ts";
import { initShell } from "../packages/pi-workers/extensions/guard-shell.ts";
import { isolate } from "./helpers/isolate.ts";

const { default: registerGuard, registerGuard: registerWith } = await import(
	"../packages/pi-workers/extensions/guard.ts"
);
await initShell();
const { classify, workerRisk, gitTreeWrite, PROTECTED_BRANCHES } = await import(
	"../packages/pi-workers/extensions/guard-regex.ts"
);

const onMain = () => "main";
const onFeature = () => "feature/x";

// 0.1.3's regex verdicts (`classify`, now the parse-failure fallback): rows it asks on, with its label.
const FLAGGED: [string, () => string, string][] = [
	["git push origin main", onFeature, "push to main/master"],
	["git push -u origin master", onFeature, "push to main/master"],
	["git push origin HEAD:main", onFeature, "push to main/master"],
	["git push origin feature/x:refs/heads/main", onFeature, "push to main/master"],
	["git push", onMain, "push to main/master"],
	["git push origin", onMain, "push to main/master"],
	["git push origin HEAD", onMain, "push to main/master"],
	["git push origin main 2>&1 | tail", onFeature, "push to main/master"],
	["git push --all origin", onFeature, "push to main/master"],
	["git push --delete origin main", onFeature, "push to main/master"],
	["git -C /some/path push origin main", onFeature, "push to main/master"],
	["rtk proxy git push origin main", onFeature, "push to main/master"],
	["GIT_SSH_COMMAND='ssh -i k' git push origin main", onFeature, "push to main/master"],
	["git push origin feature/x && git push origin main", onFeature, "push to main/master"],
	// Quotes, subshells, and `sh -c` must not hide the branch.
	['bash -c "git push origin main"', onFeature, "push to main/master"],
	["sh -c 'git push origin main'", onFeature, "push to main/master"],
	["(git push origin main)", onFeature, "push to main/master"],
	["echo $(git push origin main)", onFeature, "push to main/master"],
	['git push origin "main"', onFeature, "push to main/master"],
	["git push origin 'master'", onFeature, "push to main/master"],
	// A bare push from another directory targets an unknown branch.
	["cd ../other && git push", onFeature, "push after changing directory or branch (target unknown)"],
	["git -C ../other push", onFeature, "push after changing directory or branch (target unknown)"],
	["git push --force origin feature/x", onFeature, "force push"],
	["git push -f", onFeature, "force push"],
	["git push --force-with-lease origin feature/x", onFeature, "force push"],
	["git push origin +feature/x", onFeature, "force push"],
	["git reset --hard HEAD~1", onFeature, "git reset --hard"],
	["git clean -fdx", onFeature, "git clean -f"],
	["git checkout -- src/a.ts", onFeature, "discard changes (git checkout)"],
	["git checkout .", onFeature, "discard changes (git checkout)"],
	["git restore src/a.ts", onFeature, "discard changes (git restore)"],
	["git restore --staged --worktree src/a.ts", onFeature, "discard changes (git restore)"],
	["git branch -D old", onFeature, "git branch -D"],
	["git branch --delete --force old", onFeature, "git branch -D"],
	["rm -rf src", onFeature, "recursive rm"],
	["rm -rf dist src", onFeature, "recursive rm"],
	["rm -rf dist/../src", onFeature, "recursive rm"],
	["rm -rf *", onFeature, "recursive rm"],
	["rm -rf $DIR", onFeature, "recursive rm"],
	["rm -rf ~", onFeature, "recursive rm"],
	["rm -rf /tmp/", onFeature, "recursive rm"],
	["rm -rf /tmp/*", onFeature, "recursive rm"],
	["rm -rf /var/folders/*", onFeature, "recursive rm"],
	['rm -rf "$TMPDIR"/*', onFeature, "recursive rm"],
	["rm -rf $TMPDIR/x", onFeature, "recursive rm"],
	["rm -rf /tmp/a*", onFeature, "recursive rm"],
	["rm -rf /tmp/x/../../etc", onFeature, "recursive rm"],
	["rm -rf /tmpx", onFeature, "recursive rm"],
	["rm -rf dist2", onFeature, "recursive rm"],
	["rm -rf dist*", onFeature, "recursive rm"],
	[`rm -rf "\${TMPDIR:?}"/*`, onFeature, "recursive rm"],
	["rm -rf /var/folders/ab/cd/T/x*", onFeature, "recursive rm"],
	// A redirect containing `&` or `|` does not end rm's arguments; later words are still targets (#88).
	...[
		"rm -rf dist 2>&1 /Users",
		`rm -rf "\${TMPDIR:?}/x" &>/dev/null /Users`,
		"rm -rf dist >| log /Users",
		"rm -rf dist &>>log /Users",
		"rm -rf dist >&2 /Users",
		"rm -rf dist 2>&1 ~",
		`rm -rf "\${TMPDIR:?}/x" 2>/dev/null /Users`,
		"rm -rf dist &> log /Users",
		"rm -rf dist >|log /Users",
		"rm -rf dist 2>&- /Users",
		'rm -rf dist ">" /Users',
		// A redirect glued to a temp root: rm gets the root (`/tmp/`).
		"rm -rf /tmp/&>/dev/null",
		"rm -rf /tmp/&>>log",
		`rm -rf "\${TMPDIR:?}/"&>/dev/null`,
		`rm -rf \${TMPDIR:?}/&>/dev/null`,
		"rm -rf /var/folders/ab/cd/T/&>/dev/null",
		"rm -rf /tmp/>/dev/null",
		"rm -rf /tmp/>&2",
		// A redirect glued to the recursive flag: rm still gets `-rf`.
		"rm -rf&>/dev/null /Users",
		"rm -f --recursive&>/dev/null /Users",
		"rm -R&>x /Users",
		"rm -rf>/dev/null /Users",
		"rm -r>log /Users",
	].map((command) => [command, onFeature, "recursive rm"]),
	// `${TMPDIR:?}` only catches an unset TMPDIR, not one the command rebinds first (#77).
	...[
		`TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`,
		`export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`export TMPDIR=/ && rm -rf "\${TMPDIR:?}/Users"`,
		`\\export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`builtin export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`declare -x TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`f() { local TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"; }; f`,
		`typeset TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`read TMPDIR <<< /; rm -rf "\${TMPDIR:?}/Users"`,
		`printf -v TMPDIR /; rm -rf "\${TMPDIR:?}/Users"`,
		// A quote-split prefix (`TMP""DIR=/ rm`) is a failing command, not an assignment; builtins take it.
		`export TMP''DIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`declare -x TM"P"DIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`export TMP""DIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`env TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`,
		`/usr/bin/env TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`,
		`env -i rm -rf "\${TMPDIR:?}/Users"`,
		`sudo rm -rf "\${TMPDIR:?}/Users"`,
		`/usr/bin/sudo rm -rf "\${TMPDIR:?}/Users"`,
		// Privilege wrappers may reset the environment; they rebind TMPDIR wherever they appear.
		`doas true; rm -rf "\${TMPDIR:?}/Users"`,
		`su -l x; rm -rf "\${TMPDIR:?}/Users"`,
		`runuser -u x true; rm -rf "\${TMPDIR:?}/Users"`,
		`pkexec true; rm -rf "\${TMPDIR:?}/Users"`,
		`unset TMPDIR; rm -rf "\${TMPDIR:?}/Users"`,
		`set -a; . ./vars; rm -rf "\${TMPDIR:?}/Users"`,
		`set -a && source vars && rm -rf "\${TMPDIR:?}/Users"`,
		`source ./vars; rm -rf "\${TMPDIR:?}/Users"`,
		`. ./vars; rm -rf "\${TMPDIR:?}/Users"`,
		`cd /tmp/x && . vars && rm -rf "\${TMPDIR:?}/Users"`,
		// `.` followed by a redirect still sources.
		`.>/dev/null ./v; rm -rf "\${TMPDIR:?}/Users"`,
		`.>>x ./v; rm -rf "\${TMPDIR:?}/Users"`,
		`.>|x ./v; rm -rf "\${TMPDIR:?}/Users"`,
		`bash -c 'TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"'`,
		`z=TMP; z+=DIR=/; ((z)); rm -rf "\${TMPDIR:?}/Users"`,
		`e{xport,} TMP{DIR,}=/; rm -rf "\${TMPDIR:?}/Users"`,
		`$x TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`rm -rf "\${TMPDIR:?}/x" "\${TMPDIR:?}/$y"`,
		`git commit -m "x" <<< "$(export TMPDIR=/)"; rm -rf "\${TMPDIR:?}/Users"`,
	].map((command) => [command, onFeature, "recursive rm"]),
	["git push -o ci.skip origin", onMain, "push to main/master"],
	["git push --repo=origin main", onFeature, "push to main/master"],
	["/bin/rm -rf src", onFeature, "recursive rm"],
	["find . -name x -exec rm -rf {} \\;", onFeature, "recursive rm"],
	["find . -name x -print0 | xargs -0 rm -rf", onFeature, "recursive rm"],
	// The branch is read before the command runs; switching first hides the target.
	["git checkout main && git push", onFeature, "push after changing directory or branch (target unknown)"],
	["git switch main; git push origin HEAD", onFeature, "push after changing directory or branch (target unknown)"],
	// Other spellings of a command position.
	["/usr/bin/git push origin main", onFeature, "push to main/master"],
	['bash -lc "git push origin main"', onFeature, "push to main/master"],
	['zsh -c "git push origin main"', onFeature, "push to main/master"],
	['eval "git push origin main"', onFeature, "push to main/master"],
	["env -i git push origin main", onFeature, "push to main/master"],
	["if true; then git push origin main; fi", onFeature, "push to main/master"],
	["nohup git push origin main", onFeature, "push to main/master"],
	["{ git push origin main; }", onFeature, "push to main/master"],
	["bash <<EOF\ngit push origin main\nEOF", onFeature, "push to main/master"],
	["git commit -F - <<EOF && git push origin main\nmsg\nEOF", onFeature, "push to main/master"],
	// A python/node heredoc stays scanned unless its body is plain text to the interpreter.
	["python3 - <<EOF\n$(rm -rf ~)\nEOF", onFeature, "recursive rm"],
	["python3 - <<\\EOF\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["python3 - <<'EOF' | sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["python3 - <<'EOF' 2>&1 | bash\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	[`eval "$(python3 - <<'EOF'\nrm -rf ~\nEOF\n)"`, onFeature, "recursive rm"],
	["source <(node - <<'EOF'\nrm -rf ~\nEOF\n)", onFeature, "recursive rm"],
	["python3 - <<'EOF'\nprint(1)\nEOF\nrm -rf ~", onFeature, "recursive rm"],
	["python3 - <<'EOF' && rm -rf ~\nprint(1)\nEOF", onFeature, "recursive rm"],
	// Only an opening program heredoc counts: not one inside quotes or another heredoc, piped on, or a written file.
	["echo \"\npython3 - <<'EOF'\n$(rm -rf ~)\nEOF\n\"", onFeature, "recursive rm"],
	["wc -l <<X\npython3 - <<'EOF'\n$(rm -rf ~)\nEOF\nX", onFeature, "recursive rm"],
	["cat <<'X'\npython3 - <<'EOF'\nX\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["(\npython3 - <<'EOF'\nrm -rf ~\nEOF\n) | /bin/sh", onFeature, "recursive rm"],
	["cat > notes.md <<'EOF'\nrm -rf src\nEOF", onFeature, "recursive rm"],
	["cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nchmod +x r*.sh && ./r*.sh", onFeature, "recursive rm"],
	["cat > Makefile <<'EOF'\nx:\n\trm -rf ~\nEOF\nmake x", onFeature, "recursive rm"],
	["sudo python3 - <<'EOF'\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["ssh h python3 - <<'EOF'\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["pythonx - <<'EOF'\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["python3 - <<'EOF'\nrm -rf ~\nEOFX\nrm -rf ~", onFeature, "recursive rm"],
	["bash <<'EOF'\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["cat > run.sh <<'EOF' && sh run.sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["cat > x <<EOF\n$(rm -rf ~)\nEOF", onFeature, "recursive rm"],
	["tee x <<'EOF' | sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	// The body ends where bash ends it, and the rest of the command must not run the output or the file.
	["bash <<X && python3 - <<'EOF'\nrm -rf ~\nX\nprint(1)\nEOF", onFeature, "recursive rm"],
	["python3 - <<'EOF'\nEOF\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["cat > f <<'EOF'\n\nEOF\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["python3 - <<'EOF'X\nprint(1)\nEOFX\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["python3 - <<'EOF'\r\nprint(1)\r\nEOF\r\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["python3 - <<'EOF' \\\n| sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["python3 - <<'EOF'\nrm -rf ~", onFeature, "recursive rm"],
	[`eval "$(\npython3 - <<'EOF'\nrm -rf ~\nEOF\n)"`, onFeature, "recursive rm"],
	["(python3 - <<'EOF'\nrm -rf ~\nEOF\n) | sh", onFeature, "recursive rm"],
	["for i in 1; do\npython3 - <<'EOF'\nrm -rf ~\nEOF\ndone | bash", onFeature, "recursive rm"],
	["python3 - <<'EOF' > >(sh)\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["python3 - <<'EOF' > r.sh && sh r.sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nbash run.sh", onFeature, "recursive rm"],
	["cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nchmod +x run.sh && ./run.sh", onFeature, "recursive rm"],
	["python3 - <<'EOF' > out.sh\nrm -rf ~\nEOF\n. ./out.sh", onFeature, "recursive rm"],
	["python3 - <<'EOF' && rm -rf ~\nprint(1)\nEOF", onFeature, "recursive rm"],
	// Only an opening program heredoc counts: not one inside quotes or another heredoc, piped on, or a written file.
	["echo \"\npython3 - <<'EOF'\n$(rm -rf ~)\nEOF\n\"", onFeature, "recursive rm"],
	["wc -l <<X\npython3 - <<'EOF'\n$(rm -rf ~)\nEOF\nX", onFeature, "recursive rm"],
	["cat <<'X'\npython3 - <<'EOF'\nX\nrm -rf ~\nEOF", onFeature, "recursive rm"],
	["(\npython3 - <<'EOF'\nrm -rf ~\nEOF\n) | /bin/sh", onFeature, "recursive rm"],
	["cat > notes.md <<'EOF'\nrm -rf src\nEOF", onFeature, "recursive rm"],
	["cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nchmod +x r*.sh && ./r*.sh", onFeature, "recursive rm"],
	["cat > Makefile <<'EOF'\nx:\n\trm -rf ~\nEOF\nmake x", onFeature, "recursive rm"],
	["python3 - <<'EOF'\nx = 1\nEOF\ngit push -f origin main", onFeature, "force push"],
	// History rewrites and other discards.
	["git commit --amend --no-edit", onFeature, "history rewrite (commit --amend)"],
	["git rebase -i HEAD~3", onFeature, "history rewrite (rebase)"],
	["git filter-repo --path x", onFeature, "history rewrite (filter-repo)"],
	["git switch -f main", onFeature, "discard changes (git switch)"],
	["git stash drop", onFeature, "git stash drop"],
	["git stash clear", onFeature, "git stash clear"],
	// Nested commands and command substitution inside a message still run.
	['git log --format="$(git push origin main)"', onFeature, "push to main/master"],
	['git commit -m "$(git push origin main)"', onFeature, "push to main/master"],
	['git commit -m "\x60rm -rf src\x60"', onFeature, "recursive rm"],
	["rm -R src", onFeature, "recursive rm"],
	["rm --recursive src", onFeature, "recursive rm"],
	['sh -c "rm -rf x"', onFeature, "recursive rm"],
	["find . -name x | xargs rm -rf", onFeature, "recursive rm"],
];

test("flags pushes to main/master, history rewrites, discards, and recursive rm", () => {
	for (const [command, branch, label] of FLAGGED) assert.equal(classify(command, branch), label, command);
});

/**
 * Every FLAGGED row 0.1.3 asked on that the 3-case policy allows, with the policy reason. Judged on a fake disk: the
 * cwd `/w/repo` is a repo on the row's branch with a network origin, nothing else is a repo. Every other FLAGGED row
 * still asks (or is ask-if-dirty), and every ALLOWED row still allows.
 */
const NOW_ALLOWED: [string, string][] = [
	["git branch -D old", "branch -D: recoverable from the reflog (workers still block it)"],
	["git branch --delete --force old", "branch -D: recoverable from the reflog (workers still block it)"],
	["git commit --amend --no-edit", "commit --amend: recoverable from the reflog (workers still block it)"],
	["git rebase -i HEAD~3", "rebase: recoverable from the reflog (workers still block it)"],
	["git filter-repo --path x", "filter-repo: a local history rewrite (workers still block it)"],
	["python3 - <<\\EOF\nrm -rf ~\nEOF", "a quoted heredoc fed to python is Python source, not shell"],
	["cat > notes.md <<'EOF'\nrm -rf src\nEOF", "a heredoc written to a file that nothing runs is text"],
];
// Rows the policy alone allowed that ask again since 0.1.3's ask needs a proof (S1 covers a heredoc only when read by
// `cat`/`tee`/`git` or a directly run `python`/`node`): `sudo python3 - <<'EOF'`, `ssh h python3 - <<'EOF'`,
// `pythonx - <<'EOF'`.

test("the 3-case policy keeps every 0.1.3 row except the ones it deliberately allows", () => {
	const repo = "/w/repo";
	const inRepo = (d: string) => d === repo || d.startsWith(`${repo}/`);
	const env = (branch: string): PolicyEnv => ({
		cwd: repo,
		home: "/Users/me",
		branch: () => branch,
		branchOf: (d) => (inRepo(d) ? branch : undefined),
		repoRootOf: (d) => (inRepo(d) ? repo : null),
		remoteUrlOf: (d, n) => (inRepo(d) && n === "origin" ? "git@github.com:me/repo.git" : undefined),
		isCheckoutRef: (d, n) => (inRepo(d) ? /^(?:main|master|feature\/[\w-]+|other|HEAD)$/.test(n) : undefined),
	});
	const allowed = new Set<string>();
	for (const [command, branch] of FLAGGED)
		if (policy(command, env(branch())).verdict === "allow") allowed.add(JSON.stringify(command));
	assert.deepEqual([...allowed].sort(), NOW_ALLOWED.map(([c]) => JSON.stringify(c)).sort());
	for (const [command, branch] of ALLOWED)
		assert.equal(policy(command, env(branch())).verdict, "allow", `expected allowed: ${command}`);
});

// Rows 0.1.3 allows.
const ALLOWED: [string, () => string][] = [
	["git push", onFeature],
	["git push -u origin feature/x", onFeature],
	["git push origin HEAD", onFeature],
	["git push origin main-fix", onFeature],
	["gh pr create --fill", onMain],
	["git reset HEAD~1", onMain],
	["git reset --soft HEAD~1", onMain],
	["git clean -n", onMain],
	["git clean -fn", onMain],
	["git checkout feature/x", onMain],
	["git checkout -b feature/y", onMain],
	["git restore --staged src/a.ts", onMain],
	["git branch -d merged", onMain],
	["git log --grep push", onMain],
	["grep 'git push origin main' README.md", onMain],
	['echo "rm -rf /"', onMain],
	['git commit -m "rm -rf old dir"', onMain],
	['git commit -m "fix: then rm -rf src"', onMain],
	["git commit -am 'cd x && git push origin main'", onMain],
	['git commit --message="handle --amend"', onMain],
	["git commit -m 'git reset --hard was wrong' && git push", onFeature],
	["rm notes.txt", onMain],
	["rm -f notes.txt", onMain],
	["rm -rf dist", onMain],
	["rm -r -f build node_modules ./coverage", onMain],
	["rm -rf /tmp/me-pi-test", onMain],
	[`rm -rf "\${TMPDIR:?}/x"`, onMain],
	[`cd /tmp/x && rm -rf "\${TMPDIR:?}/x"`, onMain],
	["rm -rf dist 2>/dev/null", onMain],
	["rm -rf dist 2> /dev/null", onMain],
	["rm -rf dist > log", onMain],
	["rm -rf dist 2>&1 | tail -2", onMain],
	["rm -rf dist >/dev/null 2>&1", onMain],
	[`rm -rf "\${TMPDIR:?}/x" 2>/dev/null || true`, onMain],
	["rm -rf dist && echo ok", onMain],
	["rm -rf dist &>/dev/null", onMain],
	["rm -rf dist >| log", onMain],
	["rm -rf node_modules dist 2>&1", onMain],
	["rm -rf dist &> log", onMain],
	["rm -rf dist |& tail", onMain],
	["rm -rf /tmp/x/*", onMain],
	["rm -rf dist/a..b", onMain],
	["rm -rf /var/folders/ab/cd/T/me-pi-x", onMain],
	["git push -o ci.skip origin feature/x", onMain],
	["git rebase --continue", onMain],
	["git commit -m 'fix'", onMain],
	["git stash", onMain],
	["git stash pop", onMain],
	["git switch feature/y", onMain],
	["git checkout main", onFeature],
	["rmdir empty-dir", onMain],
	[`git commit -m "$(cat <<'EOF'\nfix: git push origin main and rm -rf src\nEOF\n)"`, onFeature],
	// An opening quoted heredoc fed to python or node is a program: shell words in its strings are text.
	["cd /tmp/x && python3 - <<'EOF'\ns = '[\"rm -rf /tmp/x/$y\", onFeature]'\nEOF", onFeature],
	[`python3 - <<'EOF'\nprint("\`rm -rf ~\`")\nEOF`, onFeature],
	["node - <<'EOF'\nconst c = `git push -f origin main`;\nEOF", onFeature],
	['python - <<"EOF"\nrm -rf ~\nEOF', onFeature],
	["/usr/bin/python3 <<-'EOF'\n\trm -rf ~\n\tEOF\nnode --test x 2>&1", onFeature],
	["python3 - <<'EOF'\nprint(1)\nEOF\nnode --test x 2>&1 | grep ok", onFeature],
	["cd /tmp/x && python3 - <<'EOF'\nrm -rf ~\nEOF\nnpx biome check --write . && npm test", onFeature],
	["python3 - <<-'EOF'\n\trm -rf ~\n\tEOF", onFeature],
	// A blank line inside the body does not end it.
	["python3 - <<'EOF'\np = 1\n\nprint('rm -rf ~')\nEOF", onFeature],
];

test("allows feature pushes, PRs, and routine commands", () => {
	for (const [command, branch] of ALLOWED)
		assert.equal(classify(command, branch), undefined, `expected allowed: ${command}`);
});

test("workerRisk blocks commands that move an implement worker off its branch or reach shared state", () => {
	for (const command of [
		"git push origin x",
		"git push . HEAD:main",
		"git -C x worktree add",
		"git commit -nm x",
		"git commit --no-verify -m x",
		"gh pr list",
		"git config core.hooksPath x",
		"git config --unset user.name",
		"git remote set-url origin x",
		"git remote -v",
		"git update-ref refs/heads/main x",
		"git symbolic-ref HEAD x",
		"git branch -M x",
		"git branch --move a b",
		"git tag -d v1",
		"git tag --force v1",
		"./install.sh",
		"bash install.sh",
		"sh -x ./install.sh",
		"/abs/install.sh",
		"x/install.sh",
		"cd .. && ./install.sh",
		"bash -- install.sh",
		"bash --noprofile install.sh",
		"bash -n install.sh && ./install.sh",
		"bash -n install.sh && bash install.sh",
		"bash -n -c './install.sh'",
		"bash --noprofile -c './install.sh'",
		"pi install ./x",
		"pi config",
		"git symbolic-ref -d HEAD",
		". ./install.sh",
		"source install.sh",
		"bash <<EOF\n./install.sh\nEOF",
		"git commit -F - <<EOF && git push\nmsg\nEOF",
		"git switch other",
		"git switch -c other",
		"git checkout other",
		"git checkout -- a.ts",
		"git merge main",
		"git cherry-pick abc123",
		"git stash",
		"git stash pop",
		"git stash drop",
		"git pull",
		"git pull --rebase origin main",
		"cd x && git checkout main",
	]) {
		assert.ok(workerRisk(command), `expected blocked: ${command}`);
	}
	for (const command of [
		"npm run check --prefix extensions",
		"test/install.test.sh",
		'git commit -m "mention git push"',
		"git commit -m 'run ./install.sh'",
		"grep 'gh ' file",
		"git config --get user.name",
		"git config user.name",
		"git config --list --show-origin",
		"git config get user.name",
		"git branch -d old",
		"git log --oneline main..HEAD",
		"git merge-base main HEAD",
		"git stash list",
		"git stash show -p",
		'git commit -m "merge and stash notes"',
		"git tag v1",
		"cat install.sh",
		"bash -n install.sh",
		"bash -n install.sh test/install.test.sh",
		"bash -n ./install.sh && cmp -s README.md <(git show HEAD:README.md)",
		"pi --version",
		"git symbolic-ref -q HEAD",
		"git symbolic-ref --short HEAD",
		"git config --bool core.bare",
		"git config --type bool --get core.bare",
		"git config --type=int core.x",
		`git commit -m "$(cat <<'EOF'\ninstall.sh: link\ngit push is blocked\nEOF\n)"`,
		"git commit -F - <<EOF\nrun ./install.sh then gh pr list\nEOF",
	]) {
		assert.equal(workerRisk(command), undefined, `expected allowed: ${command}`);
	}
});

test("an implement worker's git in a fresh mktemp repo passes; leaving it or pointing git elsewhere does not", (t) => {
	const role = process.env.ME_PI_ROLE;
	t.after(() => {
		if (role === undefined) delete process.env.ME_PI_ROLE;
		else process.env.ME_PI_ROLE = role;
	});
	process.env.ME_PI_ROLE = "implement";
	const fresh = [
		'DIR=$(mktemp -d) && cd "$DIR" && git init -q source && cd source && git config user.email t@example.com && git remote add origin "$DIR/origin.git" && git push origin HEAD',
		"D=$(mktemp -d -t hooks); cd $D; git init -q --bare origin.git && git clone -q origin.git work && cd work && git push",
		`T=$(mktemp -d) && cd "\${T}" && git init -q && git commit -q --allow-empty -m x && git reset --hard`,
	];
	for (const command of fresh) {
		assert.equal(workerRisk(command), undefined, command);
		assert.equal(classify(command, onMain), undefined, command);
	}
	for (const command of [
		'DIR=$(mktemp -d) && cd "$DIR" && cd /repo && git push',
		'DIR=$(mktemp -d) && cd "$DIR" && git clone -q /repo work && cd work && git push',
		'DIR=$(mktemp -d) && cd "$DIR" && cd .. && git config user.name x',
		'DIR=$(mktemp -d) && cd "$DIR" && git -C ~/repo push',
		'DIR=$(mktemp -d) && cd "$DIR" && GIT_DIR=x git config user.name x',
		'DIR=$(mktemp -d) && cd "$DIR" && DIR=/repo && cd "$DIR" && git push',
		'DIR=$(mktemp -d) && cd "$DIR" && cd "$HOME" && git config user.name x',
		'cd "$DIR" && git config user.name x',
		'V=$(mktemp -d) && cd "$V" && cd - && git push --force origin main',
		'V=$(mktemp -d) && cd "$V" && cd && cd fun/me-pi && git push --force origin main',
		'V=$(mktemp -d) && cd "$V" && pushd work && popd && git config user.name x',
		'V=$(mktemp -d ./t.XXXX) && cd "$V" && git config user.name x',
	])
		assert.ok(workerRisk(command), command);
	delete process.env.ME_PI_ROLE;
	assert.ok(classify(fresh[2], onMain), "the main session's guard never exempts temp repos");
});

test("gitTreeWrite names checkout-writing git subcommands and passes reads", () => {
	for (const [command, sub] of [
		["git add -A", "add"],
		["git rm a.ts", "rm"],
		["git mv a b", "mv"],
		["git commit -m x", "commit"],
		["git merge x", "merge"],
		["git rebase main", "rebase"],
		["git reset HEAD~1", "reset"],
		["git restore --staged a", "restore"],
		["git checkout x", "checkout"],
		["git switch -c goal/x", "switch"],
		["git stash", "stash"],
		["git stash pop", "stash"],
		["git stash list && git stash drop", "stash"],
		["git cherry-pick abc", "cherry-pick"],
		["git revert HEAD", "revert"],
		["git am < p.mbox", "am"],
		["git apply p.diff", "apply"],
		["git pull", "pull"],
		["git clean -fd", "clean"],
		["git update-index --assume-unchanged a", "update-index"],
		["git read-tree HEAD", "read-tree"],
		["git checkout-index -a -f", "checkout-index"],
		["git sparse-checkout set src", "sparse-checkout"],
		["git submodule update --init", "submodule"],
		["git update-ref refs/heads/x HEAD", "update-ref"],
		["git symbolic-ref HEAD refs/heads/x", "symbolic-ref"],
		["git branch -f goal/x HEAD~1", "branch"],
		["git branch --force goal/x main", "branch"],
		["git branch -m old new", "branch"],
		["git branch -M new", "branch"],
		["git branch --move old new", "branch"],
		["git branch -d old", "branch"],
		["git branch -D old", "branch"],
		["git branch --delete old", "branch"],
		["git -C /repo commit -m x", "commit"],
		["rtk git add .", "add"],
		["git status && git commit -m x", "commit"],
		['git log --format="$(git reset --hard)"', "reset"],
	]) {
		assert.equal(gitTreeWrite(command), sub, command);
	}
	for (const command of [
		"git log --oneline",
		"git log --oneline -5",
		"git blame README.md",
		"git grep foo",
		"git status --porcelain",
		"git diff main..HEAD",
		"git show HEAD",
		"git branch --show-current",
		"git branch",
		"git branch -a",
		"git branch new-topic",
		"git fetch origin",
		"git tag v1",
		"git rev-parse HEAD",
		"git merge-base main HEAD",
		"git stash list",
		"git stash show -p stash@{0}",
		"grep 'git commit' README.md",
		'echo "git add -A"',
		"npm run check --prefix extensions",
	]) {
		assert.equal(gitTreeWrite(command), undefined, `expected allowed: ${command}`);
	}
});

test("PROTECTED_BRANCHES is main and master", () => {
	assert.deepEqual([...PROTECTED_BRANCHES].sort(), ["main", "master"]);
});

function setup(register: (pi: any) => void = registerGuard) {
	let handler: any;
	let command: any;
	const events = [];
	register({
		on: (_event, h) => {
			handler = h;
		},
		registerCommand: (_name, definition) => {
			command = definition;
		},
		events: { emit: (...event) => events.push(event) },
	});
	return { handler, command, events };
}

test("confirms with UI, blocks without UI or on refusal", async () => {
	const { handler } = setup();
	const event = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } };
	const cwd = process.cwd();

	const headless = await handler(event, { cwd, hasUI: false });
	assert.equal(headless?.block, true);
	assert.match(headless.reason, /push to main\/master/);

	assert.equal(await handler(event, { cwd, hasUI: true, ui: { confirm: async () => true } }), undefined);
	assert.equal((await handler(event, { cwd, hasUI: true, ui: { confirm: async () => false } }))?.block, true);
	assert.equal(await handler({ ...event, input: { command: "git status" } }, { cwd, hasUI: false }), undefined);
	assert.equal(await handler({ ...event, toolName: "read", input: { path: "x" } }, { cwd, hasUI: false }), undefined);
});

test("/guard toggles enforcement for the session", async () => {
	const { handler, command } = setup();
	const notes = [];
	const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify: (message) => notes.push(message) } };
	const push = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } };

	await command.handler("off", ctx);
	assert.equal(notes.pop(), "guard off");
	assert.equal(await handler(push, ctx), undefined);

	await command.handler("", ctx);
	assert.equal(notes.pop(), "guard off");

	await command.handler("on", ctx);
	assert.equal(notes.pop(), "guard on");
	assert.equal((await handler(push, ctx))?.block, true);

	await command.handler("maybe", ctx);
	assert.equal(notes.pop(), "usage: /guard [on|off]");
});

// A scratch repo on a feature branch with a network origin; HOME points into the scratch dir.
function scratchRepo(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "guard-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	isolate(t, root);
	const repo = join(root, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	const env = { ...process.env };
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, stdio: "pipe" });
	git("init", "-q", "-b", "feat");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
	writeFileSync(join(repo, "src", "a.ts"), "a\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	git("remote", "add", "origin", "git@github.com:me/app.git");
	return { root, repo, git };
}

const bash = (command: string) => ({ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command } });

test("asks about discarding work only when the tree has uncommitted changes there", async (t) => {
	const { repo } = scratchRepo(t);
	const { handler } = setup();
	const ctx = { cwd: repo, hasUI: false };
	for (const command of ["git reset --hard", "git checkout -- src", "git clean -fd src", "rm -rf src"])
		assert.equal(await handler(bash(command), ctx), undefined, `clean tree: ${command}`);
	mkdirSync(join(repo, "node_modules"));
	writeFileSync(join(repo, "node_modules", "x.js"), "x\n");
	assert.equal(await handler(bash("git checkout -- node_modules"), ctx), undefined, "ignored files count as clean");
	assert.equal(
		(await handler(bash("git clean -fdX"), ctx))?.block,
		true,
		"clean -X deletes ignored files: they count",
	);
	writeFileSync(join(repo, "src", "a.ts"), "changed\n");
	for (const command of ["git reset --hard", "git checkout -- src"])
		assert.equal((await handler(bash(command), ctx))?.block, true, `dirty tree: ${command}`);
	// A repo under the OS temp dir is still a repo: its dirty tree asks (the temp rule doesn't override it).
	assert.equal((await handler(bash("rm -rf src"), ctx))?.block, true, "dirty: rm inside a repo under the temp dir");
	assert.equal(await handler(bash("git checkout -- other"), ctx), undefined, "only the affected paths count");
	writeFileSync(join(repo, "src", "new.ts"), "n\n");
	assert.equal((await handler(bash("git clean -fd src"), ctx))?.block, true, "untracked files count for clean");
	assert.equal((await handler(bash("git stash drop"), ctx))?.block, true, "a stash drop always asks");
	assert.equal((await handler(bash("rm -rf /Users/nobody-guard-test/.pi"), ctx))?.block, true, "case 1");
	assert.equal((await handler(bash("git push --force origin feat"), ctx))?.block, true, "case 3");
	assert.equal(await handler(bash("git push"), ctx), undefined, "a feature-branch push");
	assert.equal(await handler(bash("git commit --amend --no-edit"), ctx), undefined, "history rewrites are allowed");
});

test("workers block every finding and the history rewrites the main session allows", async (t) => {
	const { repo } = scratchRepo(t);
	const saved = { run: process.env.ME_PI_RUN, role: process.env.ME_PI_ROLE };
	t.after(() => {
		for (const [k, v] of [
			["ME_PI_RUN", saved.run],
			["ME_PI_ROLE", saved.role],
		] as const)
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
	});
	process.env.ME_PI_RUN = "1";
	process.env.ME_PI_ROLE = "implement";
	const { handler } = setup();
	const confirm = async () => true;
	const ctx = { cwd: repo, hasUI: true, ui: { confirm } };
	for (const command of [
		"git commit --amend --no-edit",
		"git rebase -i HEAD~1",
		"git branch -D x",
		"git filter-repo --path x",
	]) {
		const r = await handler(bash(command), ctx);
		assert.equal(r?.block, true, command);
		assert.match(r.reason, /workers/, command);
	}
	assert.equal(
		(await handler(bash("rm -rf /Users/nobody-guard-test/x"), ctx))?.block,
		true,
		"a worker never gets a confirm dialog",
	);
	assert.equal(await handler(bash("git reset --hard"), ctx), undefined, "clean tree: nothing to lose");
	writeFileSync(join(repo, "src", "a.ts"), "changed\n");
	assert.equal((await handler(bash("git reset --hard"), ctx))?.block, true, "dirty tree blocks");
});

test("a policy that throws fails closed on that command; guard keeps working", async (t) => {
	const { repo } = scratchRepo(t);
	const boom = () => {
		throw new Error("boom");
	};
	const { handler } = setup((pi) => registerWith(pi, undefined, boom));
	const ctx = { cwd: repo, hasUI: false };
	assert.match((await handler(bash("echo hi"), ctx))?.reason ?? "", /guard could not judge this command \(boom\)/);
	const both = (await handler(bash("rm -rf /Users/nobody-guard-test/x"), ctx))?.reason ?? "";
	assert.match(both, /^Blocked \(recursive rm; guard could not judge this command \(boom\)\)/, "both reasons show");
});

test("a parser that never loads counts as failed after the timeout", async () => {
	const { handler } = setup((pi) => registerWith(pi, () => new Promise(() => {}), undefined, 20));
	const notes: string[] = [];
	const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify: (m: string) => notes.push(m) } };
	assert.equal(await handler(bash("git status"), ctx), undefined);
	assert.match(notes[0] ?? "", /not loaded after 20 ms/);
});

test("a missing web-tree-sitter runtime is a load failure: guard and delegate still import", () => {
	// A fresh process, so nothing is loaded yet: guard.ts and delegate-worker.ts must import without the runtime, and
	// initShell must reject (guard then falls back) instead of the import failing.
	const ext = new URL("../packages/pi-workers/extensions/", import.meta.url).href;
	const probe = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`await import(${JSON.stringify(`${ext}guard.ts`)});
			 await import(${JSON.stringify(`${ext}delegate-worker.ts`)});
			 const { initShell, parseShell } = await import(${JSON.stringify(`${ext}guard-shell.ts`)});
			 await initShell(undefined, "web-tree-sitter-not-installed").then(() => console.log("loaded"), (e) => console.log(e.message));
			 console.log("ready", parseShell("true").ok);`,
		],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(probe.status, 0, probe.stderr);
	assert.match(probe.stdout, /cannot load the bash parser \(web-tree-sitter-not-installed/);
	assert.match(probe.stdout, /ready false/);
});

test("a parser that fails to load falls back to 0.1.3's rules and warns once, in workers too", async (t) => {
	const saved = process.env.ME_PI_RUN;
	t.after(() => {
		if (saved === undefined) delete process.env.ME_PI_RUN;
		else process.env.ME_PI_RUN = saved;
	});
	process.env.ME_PI_RUN = "1";
	const { handler } = setup((pi) => registerWith(pi, () => Promise.reject(new Error("no wasm"))));
	const notes: string[] = [];
	const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify: (m: string) => notes.push(m) } };
	assert.match((await handler(bash("git rebase -i HEAD~2"), ctx))?.reason ?? "", /delegate workers can't run this/);
	assert.equal(await handler(bash("git status"), ctx), undefined);
	assert.equal(notes.length, 1);
});

test("a parser that fails to load falls back to 0.1.3's rules and warns once", async () => {
	const { handler } = setup((pi) => registerWith(pi, () => Promise.reject(new Error("no wasm"))));
	const notes: [string, string][] = [];
	const ui = { notify: (m: string, level: string) => notes.push([m, level]), confirm: async () => false };
	const ctx = { cwd: process.cwd(), hasUI: true, ui };
	const heredoc = "cat > notes.md <<'EOF'\nrm -rf src\nEOF";
	assert.match((await handler(bash(heredoc), ctx))?.reason ?? "", /recursive rm/, "0.1.3 asks on heredoc text");
	assert.equal((await handler(bash("git commit --amend"), ctx))?.block, true, "0.1.3 asks on amend");
	assert.equal(await handler(bash("git status"), ctx), undefined);
	assert.equal(notes.length, 1, "one warning per session");
	assert.equal(notes[0][1], "warning");
	assert.match(notes[0][0], /no wasm/);
});

test("the user's false-alarm heredoc and #93's redirected push", async (t) => {
	const { repo, git } = scratchRepo(t);
	const { handler } = setup();
	const ctx = { cwd: repo, hasUI: false };
	const heredoc =
		"cd /tmp/gv && cat > q.mjs <<'EOF'\nconsole.log(`rm -rf '/tmp/x/ > /../../../Users'`);\nEOF\nnode q.mjs";
	assert.equal(await handler(bash(heredoc), ctx), undefined);
	assert.equal(await handler(bash("git push origin 2>&1"), ctx), undefined, "feature branch");
	git("checkout", "-q", "-b", "main");
	assert.match((await handler(bash("git push origin 2>&1"), ctx))?.reason ?? "", /main\/master/, "#93 on main");
});

test("live ~ rows: with a HOME outside every temp dir, ~ and $PWD after cd ~ are case 1", async (t) => {
	const { repo } = scratchRepo(t);
	// isolate() puts HOME under the OS temp dir, where ~ is a temp path; point it at a non-temp, nonexistent dir for
	// the code under test (isolate restores the real HOME after the test). Nothing runs; guard only reads git.
	process.env.HOME = "/Users/nobody-guard-home";
	const { handler } = setup();
	const ctx = { cwd: repo, hasUI: false };
	for (const command of [
		"rm -rf ~",
		"rm -rf ~/.pi/agent/x",
		"find ~ -delete",
		"find -x ~ -delete",
		"cd ~ && rm -rf ~+/Documents",
		`cd ~ && rm -rf "$PWD/Documents"`,
		"cd ~ && find ~+/Documents -delete",
		"D=-delete; find ~ $D",
	])
		assert.equal((await handler(bash(command), ctx))?.block, true, command);
	assert.equal(await handler(bash(`rm -rf "\${TMPDIR:?}/x"`), ctx), undefined, "a temp cleanup still passes");
	assert.equal(await handler(bash("find ~ -name x"), ctx), undefined, "find without -delete deletes nothing");
});
