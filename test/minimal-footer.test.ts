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

test("the footer re-renders on a branch change and unsubscribes when disposed", () => {
	let start: any;
	registerFooter({
		on: (_event: string, handler: any) => {
			start = handler;
		},
		getThinkingLevel: () => "medium",
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
		getExtensionStatuses: () => new Map([["delegate", "delegate bg: 1 running"]]),
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
			model: { id: "claude-opus-5-5", reasoning: true },
		},
	);
	const [line, statuses] = footer.render(120);
	assert.match(line, /^me-pi \(main\) {2}12\.5%\/1\.0M \(auto\) +claude-opus-5-5 • medium$/);
	assert.equal(statuses, "delegate bg: 1 running");
	branchListener?.();
	assert.equal(renders, 1);
	footer.dispose();
	assert.equal(branchListener, undefined);
});
