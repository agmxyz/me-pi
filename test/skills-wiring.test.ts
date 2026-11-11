import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const skillsRoot = join(root, "skills");
const pinnedUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(tree|blob)\/[0-9a-f]{7,40}\//;

function markdownFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return markdownFiles(path);
		return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
	});
}

function frontmatterLines(source) {
	const lines = source.split("\n");
	if (lines[0] !== "---") return undefined;
	const end = lines.indexOf("---", 1);
	return end === -1 ? undefined : lines.slice(1, end);
}

function creditUrls(lines) {
	const urls = [];
	let inMetadata = false;
	let creditsIndent = -1;
	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		const indent = line.length - line.trimStart().length;
		if (indent === 0) {
			inMetadata = line === "metadata:";
			creditsIndent = -1;
			continue;
		}
		if (creditsIndent !== -1 && indent <= creditsIndent) creditsIndent = -1;
		if (inMetadata && creditsIndent === -1 && /^\s+credits:$/.test(line)) {
			creditsIndent = indent;
			continue;
		}
		const url = creditsIndent === -1 ? undefined : /url: "?(\S+?)"?$/.exec(line)?.[1];
		if (url) urls.push(url);
	}
	return urls;
}

function relativeLinks(source) {
	const links = [];
	for (const match of source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		const target = match[1];
		if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
		links.push({ target, path: target.split("#")[0] });
	}
	return links;
}

/** Returns one message per mechanical wiring problem across every skill directory under `skillsDir`. */
function validateSkills(skillsDir) {
	const problems = [];
	for (const skill of readdirSync(skillsDir)) {
		const skillDir = join(skillsDir, skill);
		if (!statSync(skillDir).isDirectory()) continue;
		const skillFile = join(skillDir, "SKILL.md");
		if (!existsSync(skillFile)) {
			problems.push(`${skill}: missing SKILL.md`);
			continue;
		}
		const frontmatter = frontmatterLines(readFileSync(skillFile, "utf8"));
		if (!frontmatter) {
			problems.push(`${skill}: SKILL.md has no --- frontmatter block`);
		} else {
			const name = frontmatter.map((line) => /^name: (.+)$/.exec(line)?.[1]).find(Boolean);
			if (name !== skill)
				problems.push(`${skill}: frontmatter name ${JSON.stringify(name ?? null)} differs from directory name`);
			for (const url of creditUrls(frontmatter)) {
				if (!pinnedUrl.test(url)) problems.push(`${skill}: metadata.credits url ${url} is not pinned to a commit`);
			}
		}
		for (const file of markdownFiles(skillDir)) {
			for (const link of relativeLinks(readFileSync(file, "utf8"))) {
				if (!existsSync(resolve(dirname(file), link.path))) {
					problems.push(`${skill}: ${relative(skillDir, file)} links to missing file ${link.target}`);
				}
			}
		}
	}
	return problems;
}

async function withSkillsCopy(fn) {
	const temp = await mkdtemp(join(tmpdir(), "me-pi-skills-wiring."));
	const saved = {
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	};
	try {
		const home = join(temp, "home");
		const tmp = join(temp, "tmp");
		const agentDir = join(temp, "agent");
		await Promise.all([mkdir(home), mkdir(tmp), mkdir(agentDir)]);
		process.env.HOME = home;
		process.env.TMPDIR = tmp;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const skills = join(temp, "skills");
		await cp(skillsRoot, skills, { recursive: true });
		await fn(skills);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(temp, { recursive: true, force: true });
	}
}

async function replaceInFile(path, from, to) {
	const source = await readFile(path, "utf8");
	assert.ok(source.includes(from), `${path} lacks ${from}`);
	await writeFile(path, source.replace(from, to));
}

function assertOneProblem(problems, ...parts) {
	assert.equal(problems.length, 1, problems.join("\n"));
	for (const part of parts) assert.ok(problems[0].includes(part), `${problems[0]} lacks ${part}`);
}

test("every skill under skills/ is mechanically wired", () => {
	assert.ok(readdirSync(skillsRoot).length > 0);
	assert.deepEqual(validateSkills(skillsRoot), []);
});

test("a frontmatter name that differs from the directory fails", async () => {
	await withSkillsCopy(async (skills) => {
		await replaceInFile(join(skills, "implement-me-pi/SKILL.md"), "name: implement-me-pi\n", "name: implement-pi\n");
		assertOneProblem(validateSkills(skills), "implement-me-pi:", "implement-pi");
	});
});

test("a relative Markdown link to a missing file fails", async () => {
	await withSkillsCopy(async (skills) => {
		await replaceInFile(join(skills, "ticket-readiness/SKILL.md"), "](RUBRIC.md)", "](RUBRICS.md#checks)");
		assertOneProblem(validateSkills(skills), "ticket-readiness:", "RUBRICS.md");
	});
});

const implementCreditUrl = "https://github.com/mattpocock/skills/tree/4ae2317/skills/engineering/implement";
const unpinnedImplementCreditUrl = implementCreditUrl.replace("/tree/4ae2317/", "/tree/main/");

test("a credits url not pinned to a commit fails", async () => {
	await withSkillsCopy(async (skills) => {
		await replaceInFile(
			join(skills, "implement-me-pi/SKILL.md"),
			`"${implementCreditUrl}"`,
			`"${unpinnedImplementCreditUrl}"`,
		);
		assertOneProblem(validateSkills(skills), "implement-me-pi:", unpinnedImplementCreditUrl);
	});
});

test("an unpinned credits url after a blank line or trailing whitespace fails", async () => {
	await withSkillsCopy(async (skills) => {
		const skillFile = join(skills, "implement-me-pi/SKILL.md");
		await replaceInFile(skillFile, "metadata:\n  credits:\n", "metadata: \n\n  credits:\t\n");
		await replaceInFile(skillFile, `url: "${implementCreditUrl}"\n`, `url: "${unpinnedImplementCreditUrl}"  \n`);
		assertOneProblem(validateSkills(skills), "implement-me-pi:", unpinnedImplementCreditUrl);
	});
});

test("renaming ticket-readiness/RUBRIC.md fails", async () => {
	await withSkillsCopy(async (skills) => {
		await rename(join(skills, "ticket-readiness/RUBRIC.md"), join(skills, "ticket-readiness/RUBRIC-old.md"));
		assertOneProblem(validateSkills(skills), "ticket-readiness:", "RUBRIC.md");
	});
});

test("a new skill with a broken link in a nested file fails with no list to update", async () => {
	await withSkillsCopy(async (skills) => {
		const skill = join(skills, "new-skill");
		await mkdir(join(skill, "docs"), { recursive: true });
		await writeFile(
			join(skill, "SKILL.md"),
			"---\nname: new-skill\ndescription: Fixture.\n---\n\nSee [guide](docs/guide.md).\n",
		);
		await writeFile(
			join(skill, "docs/guide.md"),
			"# Guide\n\nSee [missing](../missing/notes.md) and [top](#guide).\n",
		);
		assertOneProblem(validateSkills(skills), "new-skill:", "docs/guide.md", "../missing/notes.md");
	});
});
