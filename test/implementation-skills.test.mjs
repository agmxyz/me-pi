import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const entries = [
	["implement-me-pi", readFileSync(join(root, "skills/implement-me-pi/SKILL.md"), "utf8")],
	["implement-spec-me-pi", readFileSync(join(root, "skills/implement-spec-me-pi/SKILL.md"), "utf8")],
];

test("both implementation entrypoints are explicitly user-invoked skills", () => {
	for (const [name, source] of entries) {
		assert.match(source, new RegExp(`^name: ${name}$`, "m"));
		assert.match(source, /^disable-model-invocation: true$/m);
	}
});
