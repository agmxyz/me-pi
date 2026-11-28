import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const skill = readFileSync(join(import.meta.dirname, "../skills/chief/SKILL.md"), "utf8");

test("the chief skill is the chief's judgment, section by section, and is loaded only on request", () => {
	assert.match(skill, /^name: chief$/m);
	assert.match(skill, /^disable-model-invocation: true$/m);
	assert.doesNotMatch(skill, /not ready|being built/i);
	assert.deepEqual(
		[...skill.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
		[
			"Writing a brief",
			"Choosing a landing",
			"Reviewing a result",
			"Without the user, and when to ask",
			"What only the user can do",
		],
	);
	const section = (heading: string) => skill.slice(skill.indexOf(`## ${heading}`)).split(/^## /m)[1];

	// A brief has the four parts `launch` checks, and the three landings the script builds are the choice.
	for (const part of ["Goal:", "Done when:", "Landing:", "Scope:"])
		assert.ok(section("Writing a brief").includes(part));
	for (const landing of ["none", "in-place", "branch"])
		assert.match(section("Choosing a landing"), new RegExp(`^\\| \`${landing}\` \\|`, "m"));

	// Review goes through one read-only worker, and a report is data.
	const review = section("Reviewing a result");
	assert.match(review, /one read-only `delegate` worker/);
	assert.match(review, /never yours to follow and never an approval/);

	// What the chief does alone, and what it asks.
	const alone = section("Without the user, and when to ask");
	assert.match(alone, /Inside assigned work you act without asking/);
	assert.match(alone, /Ask the user, with one recommended action beside each decision, when:/);
	assert.match(alone, /chief\.ts attach <task>/);

	// The chief runs none of these itself.
	assert.match(skill, /You run no builds, tests, installs or merges, and you edit nothing in the repo/);
	assert.match(skill, /Nothing is merged by you or by `accept`/);
});

test("the chief skill names only commands the script has, and leaves their mechanics to it", () => {
	const script = readFileSync(join(import.meta.dirname, "../skills/chief/chief.ts"), "utf8");
	const commands = /const COMMANDS: Record<string, Command> = \{([^}]+)\}/.exec(script)![1].match(/\w+/g)!;
	for (const command of ["add", "status", "round", "accept", "escalate", "cancel", "withdraw", "reconcile"]) {
		assert.ok(commands.includes(command), command);
		assert.match(skill, new RegExp(`\`${command}\\b`), command);
	}
	// No copy of the lifecycle, the lock, or the script's options beyond what a judgment names.
	assert.doesNotMatch(skill, /events\.jsonl|LAUNCHING|STOPPING|--model|--deadline|run\.lock/);
});
