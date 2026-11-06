/**
 * skill — a `Skill` tool that loads a skill's instructions by name.
 *
 * Pi has no Skill tool: it lists skills in the system prompt and expects the model to `read`
 * the SKILL.md file. This tool is named `Skill` (not `skill`) to match the wording those skills
 * use, letting them work without modification. It serves Pi-discovered skills from
 * `before_agent_start`; model-disabled skills are refused.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

// Same escaping Pi applies to skill metadata in the system prompt, so a crafted name or path
// cannot break out of the wrapper tag.
function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export default function (pi: ExtensionAPI) {
	let skills: Skill[] = [];
	pi.on("before_agent_start", async (event) => {
		skills = event.systemPromptOptions.skills ?? [];
	});

	pi.registerTool({
		name: "Skill",
		label: "Skill",
		description:
			"Load a skill's full instructions by name (a skill from the available skills list). Use when instructions say to call the Skill tool with a skill name, or when a task matches a listed skill.",
		promptSnippet: "Load a listed skill's full instructions by name",
		parameters: {
			type: "object",
			properties: { name: { type: "string", description: "Skill name from the available skills list, e.g. tdd" } },
			required: ["name"],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params: any) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
			const skill = skills.find((s) => s.name === params.name);
			if (!skill) {
				const available = skills.filter((s) => !s.disableModelInvocation).map((s) => escapeXml(s.name));
				return fail(`unknown skill "${params.name}" (available: ${available.join(", ") || "none"})`);
			}
			if (skill.disableModelInvocation) {
				return fail(`skill "${skill.name}" is user-invoked only; the user starts it with /skill:${skill.name}`);
			}
			let body: string;
			try {
				body = readFileSync(skill.filePath, "utf8").replace(FRONTMATTER, "").trim();
			} catch (err: any) {
				return fail(`skill "${skill.name}" not readable: ${skill.filePath} (${err?.code ?? err})`);
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">\nReferences are relative to ${escapeXml(skill.baseDir)}.\n\n${body}\n</skill>`,
					},
				],
				details: { name: skill.name, path: skill.filePath },
			};
		},
	});
}
