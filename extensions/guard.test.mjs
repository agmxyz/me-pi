import assert from "node:assert/strict";
import test from "node:test";

const { default: registerGuard, classify } = await import("./guard.ts");

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
		["rm -rf $TMPDIR/x", onFeature, "recursive rm"],
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
		// History rewrites and other discards.
		["git commit --amend --no-edit", onFeature, "history rewrite (commit --amend)"],
		["git rebase -i HEAD~3", onFeature, "history rewrite (rebase)"],
		["git filter-repo --path x", onFeature, "history rewrite (filter-repo)"],
		["git switch -f main", onFeature, "discard changes (git switch)"],
		["git stash drop", onFeature, "git stash drop"],
		["git stash clear", onFeature, "git stash clear"],
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
		["git push -o ci.skip origin feature/x", onMain],
		["git rebase --continue", onMain],
		["git commit -m 'fix'", onMain],
		["git stash", onMain],
		["git stash pop", onMain],
		["git switch feature/y", onMain],
		["git checkout main", onFeature],
		["rmdir empty-dir", onMain],
	]) {
		assert.equal(classify(command, branch), undefined, `expected allowed: ${command}`);
	}
});

function setup() {
	let handler;
	let command;
	registerGuard({
		on: (_event, h) => {
			handler = h;
		},
		registerCommand: (_name, definition) => {
			command = definition;
		},
	});
	return { handler, command };
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
