import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const compatibility = JSON.parse(readFileSync(new URL("../extensions/package.json", import.meta.url), "utf8"));

test("the root manifest declares only the three public Pi extensions", () => {
	assert.equal(root.name, "me-pi");
	assert.notEqual(root.private, true);
	assert.ok(root.description);
	assert.equal(root.license, "MIT");
	assert.equal(root.repository, "https://github.com/0bmario/me-pi");
	assert.deepEqual(root.keywords, ["pi-package"]);
	assert.equal(root.devDependencies["@earendil-works/pi-coding-agent"], "1.3.0");
	assert.deepEqual(root.pi, {
		extensions: ["extensions/delegate.ts", "extensions/guard.ts", "extensions/skill.ts"],
		skills: [],
	});
	for (const entrypoint of root.pi.extensions) {
		assert.ok(existsSync(new URL(`../${entrypoint}`, import.meta.url)), `${entrypoint} exists`);
	}
});

test("the package check uses read-only lint and formatter writes are explicit", () => {
	assert.match(root.scripts.check, /npm run lint/);
	assert.doesNotMatch(root.scripts.check, /--write/);
	assert.doesNotMatch(root.scripts.lint, /--write/);
	assert.equal(root.scripts.fix, "biome check --error-on-warnings --write .");

	const repository = fileURLToPath(new URL("../", import.meta.url));
	const fixture = join(repository, "test", `package-lint-fixture-${randomUUID()}.ts`);
	const bytes = Buffer.from("const value={answer:42}\n");
	writeFileSync(fixture, bytes);
	try {
		const [executable, ...lintArgs] = root.scripts.lint.split(" ");
		assert.equal(executable, "biome");
		assert.equal(lintArgs.at(-1), ".");
		const result = spawnSync(join(repository, "node_modules/.bin", executable), [...lintArgs.slice(0, -1), fixture], {
			cwd: repository,
			encoding: "utf8",
		});
		assert.ifError(result.error);
		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(`${result.stdout}\n${result.stderr}`, /Formatter would have printed/);
		assert.deepEqual(readFileSync(fixture), bytes);
	} finally {
		rmSync(fixture, { force: true });
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
