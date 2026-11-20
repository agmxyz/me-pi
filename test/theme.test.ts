import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const theme = JSON.parse(readFileSync(new URL("../themes/me.json", import.meta.url), "utf8"));
const builtIn = JSON.parse(
	readFileSync(
		new URL(
			"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
			import.meta.url,
		),
		"utf8",
	),
);

/** The lightness of an OKHSL colour, following variable references. */
function lightness(color: string): number {
	const value = theme.vars[color] ?? color;
	const match = String(value).match(/^okhsl\(\S+ \S+ ([\d.]+)%\)$/);
	assert.ok(match, `${color} is an okhsl colour`);
	return Number(match[1]);
}

test("the me theme assigns every colour role Pi's dark theme has", () => {
	assert.equal(theme.name, "me");
	assert.deepEqual(Object.keys(theme.colors).sort(), Object.keys(builtIn.colors).sort());
});

test("the me theme steps text down by role: reply, tool output, facts, hints, thinking label", () => {
	const ladder = ["text", "toolOutput", "muted", "dim", "thinkingText"].map((role) => lightness(theme.colors[role]));
	for (let step = 1; step < ladder.length; step++)
		assert.ok(ladder[step - 1] - ladder[step] >= 8, `step ${step} is visible: ${ladder.join(" > ")}`);
});

test("a heading does not share the warning colour, which marks a slow command", () => {
	assert.notEqual(theme.colors.mdHeading, theme.colors.warning);
});
