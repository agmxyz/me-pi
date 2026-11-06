import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const workers = JSON.parse(readFileSync(new URL("../packages/pi-goblins/package.json", import.meta.url), "utf8"));
const workerExtensions = ["extensions/delegate.ts", "extensions/guard.ts", "extensions/skill.ts"];
const compatibility = JSON.parse(readFileSync(new URL("../extensions/package.json", import.meta.url), "utf8"));

test("the root manifest is the private setup and loads the pi-goblins extensions", () => {
	assert.equal(root.name, "me-pi");
	assert.equal(root.private, true);
	assert.ok(root.description);
	assert.equal(root.license, "MIT");
	assert.equal(root.version, workers.version);
	assert.equal(root.repository, "https://github.com/agmxyz/me-pi");
	assert.deepEqual(root.keywords, ["pi-package"]);
	assert.equal(root.devDependencies["@earendil-works/pi-coding-agent"], "1.5.0");
	assert.deepEqual(root.pi, {
		extensions: workerExtensions,
		skills: [],
		changelogPath: "packages/pi-goblins/CHANGELOG.md",
	});
	assert.ok(existsSync(new URL(`../${root.pi.changelogPath}`, import.meta.url)));
	for (const entrypoint of root.pi.extensions) {
		assert.equal(
			readFileSync(new URL(`../${entrypoint}`, import.meta.url), "utf8")
				.split("\n")
				.at(-2),
			`export { default } from "../packages/pi-goblins/${entrypoint}";`,
		);
	}
});

test("the pi-goblins manifest declares only the three public Pi extensions", () => {
	assert.equal(workers.name, "@agmxyz/pi-goblins");
	assert.notEqual(workers.private, true);
	assert.match(workers.version, /^\d+\.\d+\.\d+$/);
	assert.ok(workers.description);
	assert.equal(workers.license, "MIT");
	assert.deepEqual(workers.repository, {
		type: "git",
		url: "git+https://github.com/agmxyz/me-pi.git",
		directory: "packages/pi-goblins",
	});
	assert.ok(workers.keywords.includes("pi-package"));
	assert.deepEqual(workers.publishConfig, { access: "public" });
	assert.deepEqual(workers.pi, { extensions: workerExtensions });
	assert.deepEqual(workers.peerDependencies, root.peerDependencies);
	assert.deepEqual(workers.peerDependenciesMeta, root.peerDependenciesMeta);
	assert.deepEqual(workers.engines, root.engines);
	for (const entrypoint of workers.pi.extensions) {
		assert.ok(existsSync(new URL(`../packages/pi-goblins/${entrypoint}`, import.meta.url)), `${entrypoint} exists`);
	}
});

test("the pi-goblins tarball holds the package, not the author's setup", () => {
	const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: fileURLToPath(new URL("../packages/pi-goblins/", import.meta.url)),
		encoding: "utf8",
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	const files: string[] = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path);
	const docs = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "docs/delegate.md"];
	for (const file of [...workers.pi.extensions, ...docs]) assert.ok(files.includes(file), `${file} is published`);
	assert.deepEqual(
		files.filter((file) => !docs.includes(file) && !/^extensions\/[\w-]+\.ts$/.test(file)),
		[],
	);
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
