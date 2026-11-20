import assert from "node:assert/strict";
import test from "node:test";
import register from "../extensions/hide-thinking-label.ts";

test("the hidden-thinking label is emptied at session start, only where there is a UI", () => {
	const handlers: Record<string, (event: unknown, ctx: any) => void> = {};
	register({
		on(name: string, handler: any) {
			handlers[name] = handler;
		},
	} as any);
	const labels: string[] = [];
	const ui = { setHiddenThinkingLabel: (label: string) => labels.push(label) };
	handlers.session_start({}, { hasUI: true, ui });
	assert.deepEqual(labels, [""]);
	handlers.session_start({}, { hasUI: false, ui });
	assert.deepEqual(labels, [""]);
});
