import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const compatibility = JSON.parse(readFileSync(new URL("../extensions/package.json", import.meta.url), "utf8"));

test("the root manifest declares only the three public Pi extensions", () => {
	assert.equal(root.name, "me-pi");
	assert.notEqual(root.private, true);
	assert.ok(root.description);
	assert.equal(root.license, "MIT");
	assert.equal(root.repository, "https://github.com/0bmario/me-pi");
	assert.deepEqual(root.keywords, ["pi-package"]);
	assert.deepEqual(root.pi, {
		extensions: ["extensions/delegate.ts", "extensions/guard.ts", "extensions/skill.ts"],
	});
	for (const entrypoint of root.pi.extensions) {
		assert.ok(existsSync(new URL(`../${entrypoint}`, import.meta.url)), `${entrypoint} exists`);
	}
});

test("the installed extensions-directory manifest is a private forwarding shim", () => {
	assert.equal(compatibility.private, true);
	assert.deepEqual(compatibility.pi.extensions, ["./delegate.ts", "./guard.ts", "./skill.ts"]);
	assert.deepEqual(compatibility.scripts, { check: "npm run check --prefix .." });
	assert.deepEqual(compatibility.peerDependencies, root.peerDependencies);
	assert.deepEqual(compatibility.peerDependenciesMeta, root.peerDependenciesMeta);
	assert.equal(root.scripts.check.includes("npm test"), true);
	assert.equal(existsSync(new URL("../package-lock.json", import.meta.url)), true);
	assert.equal(existsSync(new URL("../extensions/package-lock.json", import.meta.url)), false);
});
