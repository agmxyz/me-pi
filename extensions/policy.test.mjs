import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const readDocument = (path) => readFileSync(join(REPO_ROOT, path), "utf8");

test("authorization requires current-turn approval for remote, destructive, and secret operations", () => {
	const policy = readDocument("GLOBAL_AGENTS.md");
	const section = policy.slice(policy.indexOf("## Authorization"));
	assert.match(section, /Explicit approval in the current user turn/);
	for (const operation of ["`main`/`master`", "`gh pr merge|close`", "`gh pr create`", "`git reset --hard`", "`git clean`", "`git branch -D`", "`.env*`", "`~/.pi/agent/auth.json`"]) {
		assert.ok(section.includes(operation), `missing ${operation}`);
	}
	assert.match(section, /never implies pushing to `main`\/`master`, merge, or destructive reset/);
});
