import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

const { ModelSetPicker, matching } = await import("./delegate-picker.ts");

const KEYS = {
	enter: "\r",
	esc: "\x1b",
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	backspace: "\x7f",
	save: "\x13",
};
const fg = (_color, text) => `\x1b[31m${text}\x1b[39m`;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
const model = (id, input = 1) => ({ id, name: id.split("/").pop(), cost: { input, output: input * 5 } });
const MODELS = [
	model("anthropic/claude-haiku-5-5", 0.1),
	model("anthropic/claude-sonnet-5-5", 2),
	model("anthropic/claude-opus-5-5", 4),
	model("openrouter/anthropic/claude-haiku-5.5", 0.05),
	...Array.from({ length: 30 }, (_, i) => model(`other/model-${i}`)),
];

function picker(chosen = []) {
	let result = "pending";
	const p = new ModelSetPicker(MODELS, chosen, fg, (ids) => {
		result = ids;
	});
	p.focused = true;
	const type = (...inputs) => {
		for (const input of inputs) for (const ch of KEYS[input] ? [KEYS[input]] : [...input]) p.handleInput(ch);
	};
	return { p, type, result: () => result };
}

test("typing filters like /model; enter adds in order, the first is the scout model; ctrl+s saves", () => {
	const { p, type, result } = picker();
	type("sonnet", "enter");
	type("backspace", "backspace", "backspace", "backspace", "backspace", "backspace");
	type("anthropic/claude haiku", "enter");
	const screen = p.render(120).map(strip);
	assert.equal(screen[1], "Set: 1. claude-sonnet-5-5 (scout)  2. claude-haiku-5-5");
	assert.match(
		screen.find((l) => l.includes("→")),
		/^→ \[2\] anthropic\/claude-haiku-5-5 {2}\$0\.1\/\$0\.5 per M$/,
	);
	type("save");
	assert.deepEqual(result(), ["anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"]);
});

test("models that contain the typed words come first, then fuzzy matches", () => {
	const ids = (q) => matching(MODELS, q).map((m) => m.id);
	assert.deepEqual(ids("opus").slice(0, 2), ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"]);
	assert.deepEqual(ids("haiku 5").slice(0, 2), [
		"anthropic/claude-haiku-5-5",
		"openrouter/anthropic/claude-haiku-5.5",
	]);
	assert.equal(ids("  ").length, MODELS.length);
});

test("enter on a chosen model removes it; arrows move; esc cancels", () => {
	const { p, type, result } = picker(["anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5"]);
	assert.match(strip(p.render(120)[1]), /^Set: 1\. claude-haiku-5-5 \(scout\) {2}2\. claude-opus-5-5$/);
	type("enter"); // The first row, haiku: removed.
	assert.match(strip(p.render(120)[1]), /^Set: 1\. claude-opus-5-5 \(scout\)$/);
	type("down", "enter"); // Sonnet: added after opus.
	assert.match(strip(p.render(120)[1]), /^Set: 1\. claude-opus-5-5 \(scout\) {2}2\. claude-sonnet-5-5$/);
	type("up", "up");
	assert.match(strip(p.render(200).find((l) => strip(l).startsWith("→"))), /other\/model-29/, "up wraps to the end");
	type("esc");
	assert.equal(result(), null);
});

test("no match says so; a long list shows a window and the position; lines fit the width", () => {
	const { p, type, result } = picker();
	assert.match(strip(p.render(120).at(-2)), /^ {2}1\/34$/);
	assert.equal(p.render(120).filter((l) => /\[( |\d+)\]/.test(strip(l))).length, 10);
	for (const width of [12, 40]) for (const line of p.render(width)) assert.ok(visibleWidth(line) <= width, line);
	type("zzzz");
	assert.ok(p.render(120).map(strip).includes("  no model matches"));
	type("enter", "save"); // Enter with no match does nothing.
	assert.deepEqual(result(), []);
});

test("a set model that is not available has its own row, so Enter can remove it", () => {
	const { p, type, result } = picker(["gone/model-x", "anthropic/claude-haiku-5-5"]);
	assert.match(strip(p.render(120).find((l) => strip(l).startsWith("→"))), /^→ \[1\] gone\/model-x {2}unavailable$/);
	type("enter", "save");
	assert.deepEqual(result(), ["anthropic/claude-haiku-5-5"]);
});

test("the search box shows the cursor only when focused; cursor keys keep the highlight", () => {
	const { p, type } = picker();
	assert.ok(p.render(80).some((l) => l.includes(CURSOR_MARKER)));
	p.focused = false;
	assert.ok(!p.render(80).some((l) => l.includes(CURSOR_MARKER)));
	p.focused = true;
	type("down", "down", "left");
	assert.match(strip(p.render(120).find((l) => strip(l).startsWith("→"))), /claude-opus-5-5/);
});
