import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The footer reads Pi settings: keep HOME, TMPDIR and the agent dir in a temp dir, never the real ~/.pi.
const ROOT = mkdtempSync(join(tmpdir(), "footer-test-"));
process.env.HOME = ROOT;
process.env.TMPDIR = ROOT;
process.env.PI_CODING_AGENT_DIR = join(ROOT, "agent");
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

const { default: registerFooter } = await import("../extensions/minimal-footer.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

function mountFooter(settings: object, model: any, footerData: any) {
	let start: any;
	registerFooter({
		on: (_event: string, handler: any) => {
			start = handler;
		},
		getThinkingLevel: () => "medium",
		getSettings: () => settings,
	} as any);
	let footer: any;
	const ctx: any = {
		hasUI: true,
		cwd: ROOT,
		ui: {
			notify() {},
			setFooter: (factory: any) => {
				footer = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s }, footerData);
			},
		},
		sessionManager: { getCwd: () => "/work/me-pi" },
		getContextUsage: () => ({ percent: 12.5, contextWindow: ctx.model.contextWindow }),
		model,
	};
	start({}, ctx);
	return { footer, ctx };
}
const plainData = { onBranchChange: () => () => {}, getGitBranch: () => "main", getExtensionStatuses: () => new Map() };
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000, reasoning: true };

test("the footer shows (auto) on Pi's default and (auto N%) when an override applies to the current model", () => {
	const settings = { compaction: { modelOverrides: { "anthropic/claude-opus-5-5": { reserveTokens: 500_000 } } } };
	const { footer, ctx } = mountFooter(settings, OPUS, plainData);
	assert.match(footer.render(120)[0], /12\.5%\/1\.0M \(auto 50%\) +claude-opus-5-5/);
	// A model switch mid-session re-reads the label for the new model.
	ctx.model = { ...OPUS, id: "other", contextWindow: 200_000 };
	assert.match(footer.render(120)[0], /12\.5%\/200k \(auto\) +other/);
	assert.match(mountFooter({}, OPUS, plainData).footer.render(120)[0], /\(auto\) +claude/);
	// The settings menu's auto-compact toggle changes the session's settings without a reload.
	const live: any = {};
	const toggled = mountFooter(live, OPUS, plainData).footer;
	assert.match(toggled.render(120)[0], /\(auto\)/);
	live.compaction = { enabled: false };
	assert.doesNotMatch(toggled.render(120)[0], /auto/);
	assert.doesNotMatch(mountFooter({ compaction: { enabled: false } }, OPUS, plainData).footer.render(120)[0], /auto/);
});

test("the footer never renders wider than the terminal", () => {
	const settings = { compaction: { modelOverrides: { "anthropic/claude-opus-5-5": { reserveTokens: 500_000 } } } };
	const { footer } = mountFooter(settings, OPUS, plainData);
	for (let width = 1; width <= 120; width++)
		for (const line of footer.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
});

test("the footer re-renders on a branch change and unsubscribes when disposed", () => {
	let start: any;
	registerFooter({
		on: (_event: string, handler: any) => {
			start = handler;
		},
		getThinkingLevel: () => "medium",
		getSettings: () => ({}),
	} as any);
	let footer: any;
	let branchListener: (() => void) | undefined;
	let renders = 0;
	const footerData = {
		onBranchChange: (listener: () => void) => {
			branchListener = listener;
			return () => {
				branchListener = undefined;
			};
		},
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([["other", "other: 1 job"]]),
	};
	start(
		{},
		{
			hasUI: true,
			cwd: ROOT,
			ui: {
				notify() {},
				setFooter: (factory: any) => {
					footer = factory({ requestRender: () => renders++ }, { fg: (_c: string, s: string) => s }, footerData);
				},
			},
			sessionManager: { getCwd: () => "/work/me-pi" },
			getContextUsage: () => ({ percent: 12.5, contextWindow: 1_000_000 }),
			model: { provider: "anthropic", id: "claude-opus-5-5", reasoning: true, contextWindow: 1_000_000 },
		},
	);
	const [line, statuses] = footer.render(120);
	assert.match(line, /^me-pi \(main\) {2}12\.5%\/1\.0M \(auto\) +claude-opus-5-5 • medium$/);
	assert.equal(statuses, "other: 1 job");
	branchListener?.();
	assert.equal(renders, 1);
	footer.dispose();
	assert.equal(branchListener, undefined);
});
