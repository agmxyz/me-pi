import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scopeWorkerPrompt } from "../extensions/delegate-worker.ts";

const POLICY = readFileSync(new URL("../GLOBAL_AGENTS.md", import.meta.url), "utf8");
const headings = (text: string) => text.split("\n").filter((line) => line.startsWith("## "));
const scoped = (implement: boolean) => {
	const options = { contextFiles: [{ content: POLICY }] };
	scopeWorkerPrompt(options, { implement });
	return headings(options.contextFiles[0].content);
};

test("scopeWorkerPrompt keeps exactly the sections each worker kind may use from the real GLOBAL_AGENTS.md", () => {
	const all = headings(POLICY);
	const coordinatorOnly = all.filter((h) => h.includes("(coordinator only)"));
	const implementToo = all.filter((h) => h.includes("(coordinator and implement only)"));
	// A renamed marker would make the filter keep the section silently; both kinds must exist.
	assert.ok(coordinatorOnly.length > 0, "GLOBAL_AGENTS.md has a (coordinator only) section");
	assert.ok(implementToo.length > 0, "GLOBAL_AGENTS.md has a (coordinator and implement only) section");
	const shared = all.filter((h) => !coordinatorOnly.includes(h) && !implementToo.includes(h));
	assert.ok(shared.length > 0);
	assert.deepEqual(scoped(false), shared);
	assert.deepEqual(
		scoped(true),
		all.filter((h) => !coordinatorOnly.includes(h)),
	);
});
