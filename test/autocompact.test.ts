import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The command writes Pi settings: keep HOME, TMPDIR and the agent dir in a temp dir, never the real ~/.pi.
const ROOT = mkdtempSync(join(tmpdir(), "autocompact-test-"));
const AGENT = join(ROOT, "agent");
const PROJECT = join(ROOT, "project");
Object.assign(process.env, { HOME: ROOT, TMPDIR: ROOT, PI_CODING_AGENT_DIR: AGENT });
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
const {
	compactionLabel,
	parseRequest,
	reserveTokensFor,
	setModelReserve,
	writeGlobalReserve,
	default: register,
} = await import("../extensions/autocompact.ts");

const GLOBAL = join(AGENT, "settings.json");
const PROJECT_FILE = join(PROJECT, ".pi", "settings.json");
const OPUS = { provider: "anthropic", id: "claude-opus", contextWindow: 1_000_000 };
const KEY = "anthropic/claude-opus";

function reset(global?: object, project?: object) {
	rmSync(AGENT, { recursive: true, force: true });
	rmSync(PROJECT, { recursive: true, force: true });
	mkdirSync(AGENT, { recursive: true });
	mkdirSync(join(PROJECT, ".pi"), { recursive: true });
	if (global) writeFileSync(GLOBAL, JSON.stringify(global));
	if (project) writeFileSync(PROJECT_FILE, JSON.stringify(project));
}
const readGlobal = () => JSON.parse(readFileSync(GLOBAL, "utf8"));
// The session's settings as Pi loaded them at startup: a snapshot, not re-read from disk.
const sessionSettings = () => SettingsManager.create(PROJECT, AGENT).getSettings();

async function run(
	args: string,
	opts: { model?: any; idle?: boolean; choose?: string; settings?: any; reloadError?: string } = {},
) {
	let command: any;
	const settings = opts.settings ?? sessionSettings();
	const registerCommand = (_name: string, c: any) => {
		command = c;
	};
	register({ registerCommand, getSettings: () => settings } as any);
	const notes: { message: string; type: string }[] = [];
	const selects: string[][] = [];
	let reloads = 0;
	await command.handler(args, {
		cwd: PROJECT,
		hasUI: true,
		model: "model" in opts ? opts.model : OPUS,
		isIdle: () => opts.idle ?? true,
		isProjectTrusted: () => true,
		ui: {
			notify: (message: string, type = "info") => notes.push({ message, type }),
			select: async (_title: string, options: string[]) => {
				selects.push(options);
				return opts.choose;
			},
		},
		reload: async () => {
			reloads++;
			if (opts.reloadError) throw new Error(opts.reloadError);
		},
	});
	return { text: notes.map((n) => n.message).join("\n"), types: notes.map((n) => n.type), selects, reloads };
}

test("a percentage becomes the reserve that puts Pi's threshold there", () => {
	assert.equal(reserveTokensFor(1_000_000, 50), 500_000);
	assert.equal(reserveTokensFor(200_000, 80), 40_000);
	assert.equal(reserveTokensFor(272_000, 35), 176_800);
	assert.equal(reserveTokensFor(100_003, 50), 50_002);
});

test("only whole numbers 35 to 80, auto, or nothing are accepted", () => {
	assert.deepEqual(parseRequest(" 35 "), { kind: "set", percent: 35 });
	assert.deepEqual(parseRequest("80"), { kind: "set", percent: 80 });
	assert.deepEqual(parseRequest("auto"), { kind: "auto" });
	assert.deepEqual(parseRequest(""), { kind: "show" });
	for (const bad of ["34", "81", "50.5", "50%", "-50", "fifty", "50 reload", "AUTO"])
		assert.deepEqual(parseRequest(bad), { kind: "invalid" }, bad);
});

test("an out-of-range value, no model, or no window is refused and writes nothing", async () => {
	reset();
	for (const [args, opts, pattern] of [
		["90", {}, /Usage: \/autocompact \[35-80\|auto\]/],
		["50", { model: undefined }, /No model selected/],
		["50", { model: { ...OPUS, contextWindow: 0 } }, /reports no context window/],
	] as const) {
		const result = await run(args, opts);
		assert.match(result.text, pattern);
		assert.deepEqual(result.types, ["error"]);
	}
	assert.throws(() => readFileSync(GLOBAL), /ENOENT/);
});

test("a threshold under the 60,000-token floor is refused with the reason", async () => {
	reset({ theme: "dark" });
	const result = await run("40", { model: { provider: "local", id: "small", contextWindow: 128_000 } });
	assert.match(result.text, /Not set: 40% of local\/small's 128,000-token window is 51,200 tokens, under the 60,000/);
	assert.deepEqual(readGlobal(), { theme: "dark" });
	// 50% of the same window is 64,000 tokens, over the floor.
	assert.match(
		(await run("50", { model: { provider: "local", id: "small", contextWindow: 128_000 } })).text,
		/Saved 50%/,
	);
});

test("setting a value keeps every other key, including keepRecentTokens in the same entry", async () => {
	reset({
		theme: "dark",
		compaction: {
			enabled: true,
			modelOverrides: { [KEY]: { keepRecentTokens: 30_000 }, "x/y": { reserveTokens: 1 } },
		},
	});
	const result = await run("50", { idle: false });
	assert.deepEqual(readGlobal(), {
		theme: "dark",
		compaction: {
			enabled: true,
			modelOverrides: { [KEY]: { keepRecentTokens: 30_000, reserveTokens: 500_000 }, "x/y": { reserveTokens: 1 } },
		},
	});
	assert.match(result.text, new RegExp(`Saved 50% for ${KEY} in ${GLOBAL}\\.`));
	assert.match(result.text, /compacts at 50% \(above 500,000 of 1,000,000 tokens\), from the override in/);
	assert.match(
		result.text,
		/Not active yet: this session still compacts at 98% \(above 983,616 of 1,000,000 tokens\)/,
	);
	assert.match(result.text, /ends running background delegate jobs/);
	assert.deepEqual(result.selects, [], "no reload offer while the agent is busy");
});

test("auto removes only reserveTokens, and drops the entry once it is empty", async () => {
	reset({ compaction: { modelOverrides: { [KEY]: { keepRecentTokens: 30_000, reserveTokens: 500_000 } } } });
	await run("auto", { idle: false });
	assert.deepEqual(readGlobal(), { compaction: { modelOverrides: { [KEY]: { keepRecentTokens: 30_000 } } } });
	reset({ compaction: { enabled: true, modelOverrides: { [KEY]: { reserveTokens: 500_000 } } } });
	const result = await run("auto", { idle: false });
	assert.deepEqual(readGlobal(), { compaction: { enabled: true, modelOverrides: {} } });
	assert.match(result.text, /Removed the anthropic\/claude-opus override/);
	assert.match(result.text, /from Pi's default \(no override\)/);
	const again = await run("auto", { idle: false });
	assert.match(again.text, /has no override in/);
	assert.match(again.text, /Active now\./);
});

test("a value already saved and active is reported as active and offers no reload", async () => {
	reset({ compaction: { modelOverrides: { [KEY]: { reserveTokens: 500_000 } } } });
	const result = await run("50");
	assert.match(result.text, /^50% for anthropic\/claude-opus was already saved in /);
	assert.match(result.text, /Active now\./);
	assert.deepEqual(result.selects, []);
	assert.equal(result.reloads, 0);
});

test("when idle, the reload is offered with No first, and runs only on Yes", async () => {
	reset();
	const declined = await run("50");
	assert.deepEqual(declined.selects, [["No, apply on the next /reload", "Yes, reload now"]]);
	assert.equal(declined.reloads, 0);
	assert.match(declined.text, /Not active yet/);
	reset();
	const accepted = await run("50", { choose: "Yes, reload now" });
	assert.equal(accepted.reloads, 1);
	assert.match(accepted.text, /Saved 50%[\s\S]*Reloading to make it active\.$/);
	assert.doesNotMatch(accepted.text, /Not active yet/);
	// Saved earlier but declined: asking again offers the reload again.
	const again = await run("50", { settings: {} });
	assert.match(again.text, /^50% for anthropic\/claude-opus was already saved in .*\.\n/);
	assert.doesNotMatch(again.text, /already at/);
	assert.match(again.text, /Not active yet: this session still compacts at 98%/);
	assert.equal(again.selects.length, 1);
	// A bare /autocompact only reports.
	assert.deepEqual((await run("")).selects, []);
	const failed = await run("auto", {
		choose: "Yes, reload now",
		reloadError: "Wait for compaction to finish before reloading.",
	});
	assert.match(failed.text, /Reload failed, so it is not active yet: Wait for compaction to finish/);
});

test("a project override wins, and the reply says the global value does not apply here", async () => {
	reset({}, { compaction: { modelOverrides: { [KEY]: { reserveTokens: 300_000 } } } });
	const result = await run("50");
	assert.equal(readGlobal().compaction.modelOverrides[KEY].reserveTokens, 500_000);
	assert.match(result.text, new RegExp(`compacts at 70% \\(above 700,000 .*from the override in ${PROJECT_FILE}`));
	assert.match(result.text, /overrides this model, so the global value does not apply in this project/);
	assert.match(result.text, /Active now\./, "the session already runs the project value");
	assert.deepEqual(result.selects, []);
});

test("with no argument it reports the model, window, threshold and source without writing", async () => {
	reset({ compaction: { reserveTokens: 100_000 } });
	const result = await run("");
	assert.match(
		result.text,
		new RegExp(
			`^anthropic/claude-opus compacts at 90% \\(above 900,000 of 1,000,000 tokens\\), from compaction\\.reserveTokens in ${GLOBAL} `,
		),
	);
	assert.match(result.text, /Active now\./);
	assert.deepEqual(readGlobal(), { compaction: { reserveTokens: 100_000 } });
});

test("a malformed settings entry is reported, not overwritten", async () => {
	reset({ compaction: { modelOverrides: { [KEY]: 5 } } });
	const result = await run("50", { settings: {} });
	assert.match(result.text, /modelOverrides\["anthropic\/claude-opus"\] in settings\.json is not an object/);
	assert.deepEqual(readGlobal(), { compaction: { modelOverrides: { [KEY]: 5 } } });
	assert.equal(setModelReserve({}, KEY, undefined), false);
});

test("the footer label is auto on the default and names the percentage when moved", () => {
	assert.equal(compactionLabel({}, OPUS), "auto");
	assert.equal(compactionLabel({ compaction: { modelOverrides: { "x/y": { reserveTokens: 1 } } } }, OPUS), "auto");
	assert.equal(
		compactionLabel({ compaction: { modelOverrides: { [KEY]: { reserveTokens: 500_000 } } } }, OPUS),
		"auto 50%",
	);
	assert.equal(compactionLabel({ compaction: { reserveTokens: 400_000 } }, OPUS), "auto 60%");
	assert.equal(compactionLabel({ compaction: { enabled: false } }, OPUS), undefined);
	assert.equal(compactionLabel({}, undefined), "auto");
});

test("a write that succeeds is reported even when reading the result back fails", async () => {
	reset({}, { compaction: { reserveTokens: "x" } });
	const result = await run("50", { settings: {} });
	assert.equal(readGlobal().compaction.modelOverrides[KEY].reserveTokens, 500_000);
	assert.match(
		result.text,
		/^Saved 50% for anthropic\/claude-opus[\s\S]*Could not read the resulting threshold: Invalid compaction\.reserveTokens/,
	);
});

test("the reply says when auto-compaction is off", async () => {
	reset({ compaction: { enabled: false } });
	const result = await run("50", { idle: false });
	assert.match(result.text, /Auto-compaction is off \(compaction\.enabled is false\)\./);
});

test("a settings file with a BOM is read, and a later Pi save from the session keeps the override", async () => {
	reset();
	writeFileSync(GLOBAL, `\uFEFF${JSON.stringify({ theme: "dark" })}`);
	const session = SettingsManager.create(PROJECT, AGENT);
	await run("50", { idle: false });
	assert.deepEqual(readGlobal(), {
		theme: "dark",
		compaction: { modelOverrides: { [KEY]: { reserveTokens: 500_000 } } },
	});
	session.setCompactionEnabled(false);
	await session.flush();
	assert.deepEqual(readGlobal(), {
		theme: "dark",
		compaction: { modelOverrides: { [KEY]: { reserveTokens: 500_000 } }, enabled: false },
	});
});

test("a reserve not below the window is described as compacting on every turn", async () => {
	reset({ compaction: { reserveTokens: 1_500_000 } });
	const result = await run("");
	assert.match(
		result.text,
		/compacts on every turn \(its reserve of 1,500,000 tokens is not below its 1,000,000-token window\), from compaction\.reserveTokens/,
	);
	// No negative number or "0% (above" in the reply; the settings path is left out, since its random temp suffix can hold "-<digit>".
	assert.doesNotMatch(result.text.replaceAll(ROOT, "<root>"), /-\d|0% \(above/);
	assert.equal(compactionLabel({ compaction: { reserveTokens: 1_500_000 } }, OPUS), "auto every turn");
	assert.equal(compactionLabel({ compaction: { reserveTokens: 1_000_000 } }, OPUS), "auto every turn");
});

test("an ordinary reserveTokens in the project file is named as the source", async () => {
	reset({}, { compaction: { reserveTokens: 100_000 } });
	assert.match((await run("")).text, new RegExp(`from compaction\\.reserveTokens in ${PROJECT_FILE} `));
});

test("the write fails loudly when Pi's lock does not run the update, and writes nothing", async () => {
	reset({ theme: "dark" });
	const manager: any = SettingsManager.create(PROJECT, AGENT);
	manager.storage = { withLock: () => undefined };
	await assert.rejects(writeGlobalReserve(manager, KEY, 500_000), /settings lock returned without running the update/);
	manager.storage = {};
	await assert.rejects(writeGlobalReserve(manager, KEY, 500_000), /no settings storage to lock/);
	// An async lock is awaited, so its result is reported, not lost.
	let written: string | undefined;
	manager.storage = {
		withLock: async (_scope: string, fn: (current: string | undefined) => string | undefined) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			written = fn("{}");
		},
	};
	assert.equal(await writeGlobalReserve(manager, KEY, 500_000), true);
	assert.deepEqual(JSON.parse(written!), { compaction: { modelOverrides: { [KEY]: { reserveTokens: 500_000 } } } });
	assert.deepEqual(readGlobal(), { theme: "dark" });
});
