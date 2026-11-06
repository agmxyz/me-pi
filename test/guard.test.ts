import assert from "node:assert/strict";
import test from "node:test";

const {
	default: registerGuard,
	classify,
	workerRisk,
	gitTreeWrite,
	PROTECTED_BRANCHES,
} = await import("../packages/pi-workers/extensions/guard.ts");

const onMain = () => "main";
const onFeature = () => "feature/x";

test("flags pushes to main/master, history rewrites, discards, and recursive rm", () => {
	for (const [command, branch, label] of [
		["git push origin main", onFeature, "push to main/master"],
		["git push -u origin master", onFeature, "push to main/master"],
		["git push origin HEAD:main", onFeature, "push to main/master"],
		["git push origin feature/x:refs/heads/main", onFeature, "push to main/master"],
		["git push", onMain, "push to main/master"],
		["git push origin", onMain, "push to main/master"],
		["git push origin HEAD", onMain, "push to main/master"],
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
		// An expansion right below a temp root may be empty or hold `..`.
		["rm -rf /tmp/$x", onFeature, "recursive rm"],
		[`rm -rf "/tmp/\${name}/"`, onFeature, "recursive rm"],
		[`rm -rf "\${TMPDIR:?}/$n"`, onFeature, "recursive rm"],
		["rm -rf /tmp/`echo x`", onFeature, "recursive rm"],
		["rm -rf /tmp/x/$y", onFeature, "recursive rm"],
		["rm -rf /tmp/a*", onFeature, "recursive rm"],
		["rm -rf /tmp/x/../../etc", onFeature, "recursive rm"],
		["rm -rf /tmpx", onFeature, "recursive rm"],
		["rm -rf dist2", onFeature, "recursive rm"],
		["rm -rf dist*", onFeature, "recursive rm"],
		[`rm -rf "\${TMPDIR:?}"/*`, onFeature, "recursive rm"],
		["rm -rf /var/folders/ab/cd/T/x*", onFeature, "recursive rm"],
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
	]) {
		assert.equal(classify(command, branch), label, command);
	}
});

test("allows feature pushes, PRs, and routine commands", () => {
	for (const [command, branch] of [
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
		["rm -rf dist 2>/dev/null", onMain],
		["rm -rf dist 2> /dev/null", onMain],
		["rm -rf dist > log", onMain],
		["rm -rf /tmp/x/*", onMain],
		["rm -rf dist/a..b", onMain],
		["rm -rf /var/folders/ab/cd/T/me-pi-x", onMain],
		["rm -rf /tmp/me-pi-$$", onMain],
		["git push -o ci.skip origin feature/x", onMain],
		["git rebase --continue", onMain],
		["git commit -m 'fix'", onMain],
		["git stash", onMain],
		["git stash pop", onMain],
		["git switch feature/y", onMain],
		["git checkout main", onFeature],
		["rmdir empty-dir", onMain],
		[`git commit -m "$(cat <<'EOF'\nfix: git push origin main and rm -rf src\nEOF\n)"`, onFeature],
	]) {
		assert.equal(classify(command, branch), undefined, `expected allowed: ${command}`);
	}
});

test("recursive rm of $TMPDIR/… passes only while TMPDIR names a temp directory the command keeps", (t) => {
	const saved = process.env.TMPDIR;
	t.after(() => {
		if (saved === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = saved;
	});
	const entries = ['rm -rf "$TMPDIR/x"', "rm -rf $TMPDIR/x", `rm -rf "\${TMPDIR}/x"`, 'rm -rf "$TMPDIR"/x'];
	for (const tmpdir of ["/tmp", "/private/tmp/", "/var/folders/ab/cd/T/", "/var/folders/ab/cd/T/job-1"]) {
		process.env.TMPDIR = tmpdir;
		for (const command of [...entries, 'rm -rf "$TMPDIR/a/b"', `cd "$TMPDIR" && rm -rf "$TMPDIR/x"`])
			assert.equal(classify(command, onMain), undefined, `TMPDIR=${tmpdir}: ${command}`);
		for (const command of [
			"rm -rf $TMPDIR",
			'rm -rf "$TMPDIR/"',
			'rm -rf "$TMPDIR"/*',
			'rm -rf "$TMPDIR/$n"',
			'rm -rf "$TMPDIR/../x"',
			'TMPDIR=/ rm -rf "$TMPDIR/x"',
			'unset TMPDIR; rm -rf "$TMPDIR/x"',
			'export TMPDIR=/; rm -rf "$TMPDIR/x"',
			`env -i bash -c 'rm -rf "$TMPDIR/x"'`,
			'sudo rm -rf "$TMPDIR/x"',
		])
			assert.equal(classify(command, onMain), "recursive rm", `TMPDIR=${tmpdir}: ${command}`);
	}
	for (const tmpdir of [undefined, "", "/", "/home/me", "/tmp/../etc"]) {
		if (tmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = tmpdir;
		for (const command of entries)
			assert.equal(classify(command, onMain), "recursive rm", `TMPDIR=${tmpdir}: ${command}`);
		assert.equal(
			classify(`rm -rf "\${TMPDIR:?}/x"`, onMain),
			undefined,
			`\${TMPDIR:?} fails instead of expanding to /x`,
		);
	}
});

test("recursive rm of a mktemp -d directory the command creates passes; reassigning or emptying it does not", () => {
	for (const command of [
		'd=$(mktemp -d) && rm -rf "$d"',
		'd=$(mktemp -d); rm -rf "$d"',
		`tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT`,
		'd=$(mktemp -d -t me) && cd "$d" && touch x && rm -rf "$d"/*',
		'd=$(mktemp -d) && rm -rf "$d/x"',
		`d=$(mktemp -d); rm -rf "\${d:?}"/x`,
		`d=$(mktemp -d)\nrm -rf "\${d}"`,
	])
		assert.equal(classify(command, onMain), undefined, `expected allowed: ${command}`);
	for (const command of [
		'rm -rf "$d"',
		'd=$(mktemp -d); d=/; rm -rf "$d"',
		'd=$(mktemp -d) && read d && rm -rf "$d"',
		'd=$(mktemp -d) && for d in /x; do rm -rf "$d"; done',
		"d=$(mktemp -d) && rm -rf $d",
		// A failed mktemp leaves d empty, so a path below it is a path below /.
		'd=$(mktemp -d); rm -rf "$d"/*',
		'd=$(mktemp -d); rm -rf "$d/x"',
		'd=$(mktemp -d) && rm -rf "$d/x" || rm -rf "$d/y"',
		// A nested shell does not see d.
		`d=$(mktemp -d) && sh -c 'rm -rf "$d"/x'`,
		'd=$(mktemp -d) && rm -rf "$d/"',
		'd=$(mktemp -d) && rm -rf "$d/.."',
		'd=$(mktemp -d) && rm -rf "$d/$y"',
		'd=$(mktemp -d ./t.XXXX) && rm -rf "$d"',
		'x=1; d=$(mktemp -d) && rm -rf "$d"',
	])
		assert.equal(classify(command, onMain), "recursive rm", command);
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

function setup() {
	let handler: any;
	let command: any;
	const events = [];
	registerGuard({
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
