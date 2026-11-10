import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HOME } from "../packages/pi-workers/extensions/delegate-config.ts";
import { commandWanders, expandHome } from "../packages/pi-workers/extensions/delegate-fence.ts";

test("expandHome expands only ~ and ~/", () => {
	assert.equal(expandHome("~"), HOME);
	assert.equal(expandHome("~/x"), join(HOME, "x"));
	for (const kept of ["~user/x", "a/~/b", "/abs/~/x", "rel/x", "~x"]) assert.equal(expandHome(kept), kept);
});

test("commandWanders: a later cd, a git -C among several commands, or an expanded directory", () => {
	for (const command of [
		"git status && cd ../wt && git commit -m x",
		"git fetch; cd .. ; git worktree remove y",
		"cd a && cd b && git add -A",
		"(cd ../wt && git commit -m x)",
		"cd a && git add -A && popd",
		"git status\ncd ../wt",
		"git -C /free status && git commit -m x",
		"git commit -m x; git -C /free status",
		'cd "$WT" && git commit -m x',
		"cd $(pwd)/wt && git add -A",
		"git -C `pwd` commit -m x",
	])
		assert.equal(commandWanders(command), true, command);
	for (const command of [
		"cd a && git add -A",
		"pushd a; git add -A",
		"git commit -m x",
		"git -C a commit",
		"abcd x",
		"",
	])
		assert.equal(commandWanders(command), false, command);
});
