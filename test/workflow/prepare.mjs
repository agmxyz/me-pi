import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const BASE_SHA = "94f8b71a4820a35f899ffe2131a85b6eece5bbaf";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const GUIDELINES_PATH = join(HERE, "candidate/prompt-guidelines.json");
const SKILL_PATH = join(HERE, "candidate/implement-goal/SKILL.md");
const FIXTURE_PATH = join(HERE, "fixture");
const SCRATCH_MARKER = ".delegate-workflow-scratch.json";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const under = (root, path) => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

function candidateGuidelines() {
	const guidelines = JSON.parse(readFileSync(GUIDELINES_PATH, "utf8"));
	if (!Array.isArray(guidelines) || guidelines.some((line) => typeof line !== "string" || !line.trim())) {
		throw new Error(`${GUIDELINES_PATH} must be a non-empty array of strings`);
	}
	const words = guidelines.join(" ").trim().split(/\s+/).length;
	if (words > 240) throw new Error(`candidate inline guidelines exceed 240 words (${words})`);
	return guidelines;
}

function archiveBase(repoRoot, destination) {
	git(repoRoot, "cat-file", "-e", `${BASE_SHA}^{commit}`);
	mkdirSync(destination, { recursive: true });
	const archive = execFileSync("git", ["archive", "--format=tar", BASE_SHA], {
		cwd: repoRoot,
		maxBuffer: 128 * 1024 * 1024,
	});
	execFileSync("tar", ["-xf", "-", "-C", destination], { input: archive, maxBuffer: 128 * 1024 * 1024 });
}

function patchCandidate(packageRoot, guidelines) {
	const delegatePath = join(packageRoot, "extensions/delegate.ts");
	const original = readFileSync(delegatePath, "utf8");
	const startMarker = "export const PROMPT_GUIDELINES = [";
	const endMarker = "\n];\n\n// ESRCH means gone; EPERM means alive under another user.";
	const start = original.indexOf(startMarker);
	const end = original.indexOf(endMarker, start);
	if (start < 0 || end < 0 || original.indexOf(startMarker, start + 1) >= 0) {
		throw new Error(`could not find one bounded PROMPT_GUIDELINES array in ${delegatePath}`);
	}
	const replacement = `${startMarker}\n${guidelines.map((line) => `\t${JSON.stringify(line)},`).join("\n")}\n];`;
	writeFileSync(delegatePath, `${original.slice(0, start)}${replacement}${original.slice(end + 3)}`);

	const manifestPath = join(packageRoot, "extensions/package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!manifest.pi || !Array.isArray(manifest.pi.extensions)) throw new Error(`${manifestPath} has no pi.extensions manifest`);
	if (manifest.pi.skills !== undefined) throw new Error(`${manifestPath} already declares pi.skills; base no longer matches T1`);
	manifest.pi.skills = ["./skills"];
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	const skillDir = join(packageRoot, "extensions/skills/implement-goal");
	mkdirSync(skillDir, { recursive: true });
	cpSync(SKILL_PATH, join(skillDir, "SKILL.md"));
}

function createProbe(agentDir) {
	const extensionDir = join(agentDir, "extensions");
	mkdirSync(extensionDir, { recursive: true });
	const probePath = join(extensionDir, "workflow-probe.mjs");
	writeFileSync(
		probePath,
		`import { writeFileSync } from "node:fs";\n\nexport default function (pi) {\n\tpi.registerCommand("workflow-probe", {\n\t\tdescription: "Offline harness probe; writes only tool names to the scratch directory.",\n\t\thandler: async () => {\n\t\t\tconst names = pi.getAllTools().map((tool) => tool.name);\n\t\t\twriteFileSync(process.env.ME_PI_WORKFLOW_PROBE_RESULT, JSON.stringify(names));\n\t\t},\n\t});\n}\n`,
	);
	return probePath;
}

function writeAgent(agentDir, packageRoot, globalPolicy, { probe = false } = {}) {
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	writeFileSync(join(agentDir, "AGENTS.md"), globalPolicy);
	writeFileSync(
		join(agentDir, "delegate.json"),
		`${JSON.stringify({ version: 3, scout: { models: [], thinking: "low" }, worker: { models: [], thinking: "max" } }, null, 2)}\n`,
	);
	const settings = { packages: [join(packageRoot, "extensions")] };
	if (probe) settings.extensions = [createProbe(agentDir)];
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function makeGoal(goalPath, arm) {
	cpSync(FIXTURE_PATH, goalPath, { recursive: true });
	git(goalPath, "init", "-q", "--template=", "-b", `goal/workflow-${arm}`);
	git(goalPath, "config", "user.name", "Workflow Fixture");
	git(goalPath, "config", "user.email", "workflow-fixture@example.invalid");
	git(goalPath, "config", "commit.gpgsign", "false");
	git(goalPath, "config", "core.hooksPath", "/dev/null");
	mkdirSync(join(goalPath, ".git/info"), { recursive: true });
	writeFileSync(join(goalPath, ".git/info/exclude"), "\n.workflow/\n");
	git(goalPath, "add", "-A");
	git(goalPath, "commit", "-q", "-m", "fixture: start scratch workflow goal");
	if (git(goalPath, "status", "--porcelain")) throw new Error(`scratch goal is not clean: ${goalPath}`);
	return git(goalPath, "rev-parse", "HEAD");
}

function responseFor(child, id, command, timeoutMs = 20_000) {
	return new Promise((resolvePromise, reject) => {
		const onRecord = (record) => {
			if (record?.type !== "response" || record.id !== id) return;
			clearTimeout(timer);
			child.removeListener("workflow-rpc-record", onRecord);
			child.removeListener("workflow-rpc-error", onError);
			if (!record.success) reject(new Error(`Pi RPC ${command.type} failed: ${record.error ?? "unknown error"}`));
			else resolvePromise(record);
		};
		const onError = (error) => {
			clearTimeout(timer);
			child.removeListener("workflow-rpc-record", onRecord);
			reject(error);
		};
		const timer = setTimeout(() => {
			child.removeListener("workflow-rpc-record", onRecord);
			child.removeListener("workflow-rpc-error", onError);
			reject(new Error(`Pi RPC ${command.type} timed out`));
		}, timeoutMs);
		child.on("workflow-rpc-record", onRecord);
		child.once("workflow-rpc-error", onError);
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
	});
}

async function verifyArm(piBin, scratchRoot, arm, packageRoot, skillExpected) {
	const agentDir = join(scratchRoot, "agents", `discovery-${arm}`);
	const goalPath = join(scratchRoot, "goals", arm);
	const probeResult = join(agentDir, "probe-tools.json");
	const version = spawnSync(piBin, ["--version"], {
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "", HOME: homedir() },
	});
	if (version.error) throw version.error;
	if (version.status !== 0 || version.stdout.trim() !== "1.3.0") {
		throw new Error(`package discovery requires Pi 1.3.0; got ${version.stdout.trim() || version.stderr.trim() || version.status}`);
	}
	writeAgent(agentDir, packageRoot, readFileSync(join(packageRoot, "GLOBAL_AGENTS.md"), "utf8"), { probe: true });
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: homedir(),
		TMPDIR: scratchRoot,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		ME_PI_WORKFLOW_PROBE_RESULT: probeResult,
	};
	const child = spawn(piBin, ["--mode", "rpc", "--no-session", "--no-mcp", "--offline"], {
		cwd: goalPath,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.once("error", (error) => child.emit("workflow-rpc-error", error));
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr = `${stderr}${chunk}`.slice(-8000);
	});
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		try {
			child.emit("workflow-rpc-record", JSON.parse(line));
		} catch (error) {
			child.emit("workflow-rpc-parse-error", error);
		}
	});
	try {
		const commands = await responseFor(child, `commands-${arm}`, { type: "get_commands" });
		const skill = commands.data?.commands?.find((item) => item.name === "skill:implement-goal");
		if (Boolean(skill) !== skillExpected) {
			throw new Error(`${arm}: implement-goal discovery was ${skill ? "present" : "absent"}, expected ${skillExpected}`);
		}
		if (skillExpected && (skill.source !== "skill" || skill.sourceInfo?.origin !== "package")) {
			throw new Error(`${arm}: skill was not discovered from the candidate Pi package manifest`);
		}
		const prompted = await responseFor(child, `probe-${arm}`, { type: "prompt", message: "/workflow-probe" });
		if (prompted.data?.disposition !== "handled") throw new Error(`${arm}: offline tool probe unexpectedly invoked the model`);
		const names = JSON.parse(readFileSync(probeResult, "utf8"));
		const delegateCount = names.filter((name) => name === "delegate").length;
		if (delegateCount !== 1) throw new Error(`${arm}: expected exactly one registered delegate tool, found ${delegateCount}`);
		return {
			piVersion: version.stdout.trim(),
			skill: skillExpected ? { discovered: true, source: skill.source, origin: skill.sourceInfo.origin, path: skill.sourceInfo.path } : { discovered: false },
			delegateTools: delegateCount,
			modelInvoked: false,
		};
	} catch (error) {
		throw new Error(`${error.message}${stderr ? `\nPi stderr:\n${stderr}` : ""}`);
	} finally {
		lines.close();
		child.stdin.end();
		if (child.exitCode === null) {
			const exit = await new Promise((resolvePromise) => {
				const timeout = setTimeout(() => {
					child.kill("SIGTERM");
					resolvePromise(undefined);
				}, 10_000);
				child.once("close", (code) => {
					clearTimeout(timeout);
					resolvePromise(code);
				});
			});
			if (exit === undefined) throw new Error(`Pi RPC process did not stop cleanly (${child.pid})`);
			if (exit !== 0) throw new Error(`Pi RPC exited ${exit}${stderr ? `: ${stderr}` : ""}`);
		}
	}
}

export async function prepareScratch({ repoRoot = REPO_ROOT, piBin = "pi", scratchRoot } = {}) {
	const absoluteRepo = realpathSync(resolve(repoRoot));
	const requestedRoot = scratchRoot ? resolve(scratchRoot) : mkdtempSync(join(tmpdir(), "me-pi-delegate-workflow-"));
	mkdirSync(requestedRoot, { recursive: true });
	const root = realpathSync(requestedRoot);
	if (under(absoluteRepo, root) || under(root, absoluteRepo)) {
		throw new Error(`scratch path must be separate from the checkout: ${root}`);
	}
	if (readdirSync(root).length !== 0) throw new Error(`scratch root must be empty: ${root}`);
	const guidelines = candidateGuidelines();
	const armRoots = {};
	for (const arm of ["a", "b"]) {
		const packageRoot = join(root, "packages", arm);
		archiveBase(absoluteRepo, packageRoot);
		if (arm === "b") patchCandidate(packageRoot, guidelines);
		armRoots[arm] = packageRoot;
	}
	const globalPolicy = readFileSync(join(armRoots.a, "GLOBAL_AGENTS.md"), "utf8");
	const goalShas = {};
	for (const arm of ["a", "b"]) {
		for (const kind of ["agents", "sessions", "goals"]) mkdirSync(join(root, kind, arm), { recursive: true });
		writeAgent(join(root, "agents", arm), armRoots[arm], globalPolicy);
		goalShas[arm] = makeGoal(join(root, "goals", arm), arm);
	}
	const discovery = {};
	for (const arm of ["a", "b"]) {
		discovery[arm] = await verifyArm(piBin, root, arm, armRoots[arm], arm === "b");
	}
	const result = {
		format: "delegate-workflow-scratch-v1",
		base: BASE_SHA,
		piVersion: "1.3.0",
		packages: { a: armRoots.a, b: armRoots.b },
		goals: { a: join(root, "goals/a"), b: join(root, "goals/b") },
		goalBase: goalShas,
		agentDirs: { a: join(root, "agents/a"), b: join(root, "agents/b") },
		sessionDirs: { a: join(root, "sessions/a"), b: join(root, "sessions/b") },
		delegateConfig: { a: join(root, "agents/a/delegate.json"), b: join(root, "agents/b/delegate.json") },
		discovery,
		liveComparison: "UNRUN: requires explicit approval for temporary auth symlinks",
	};
	writeFileSync(join(root, SCRATCH_MARKER), `${JSON.stringify(result, null, 2)}\n`);
	writeFileSync(join(root, "artifact-index.json"), `${JSON.stringify(result, null, 2)}\n`);
	return { root, ...result };
}

async function main() {
	const piIndex = process.argv.indexOf("--pi-bin");
	const piBin = piIndex >= 0 ? process.argv[piIndex + 1] : "pi";
	if (piIndex >= 0 && !piBin) throw new Error("--pi-bin requires a command path");
	const prepared = await prepareScratch({ piBin });
	console.log(`Scratch root: ${prepared.root}`);
	console.log(`Baseline arm A package: ${prepared.packages.a}`);
	console.log(`Candidate arm B package: ${prepared.packages.b}`);
	console.log(`Scratch goals: ${prepared.goals.a} and ${prepared.goals.b}`);
	console.log(`Pi 1.3.0 discovery: skill package origin=${prepared.discovery.b.skill.origin}; delegate tools=${prepared.discovery.a.delegateTools}/${prepared.discovery.b.delegateTools}; model invoked=no`);
	console.log("Live comparison: UNRUN; adoption remains blocked pending explicit auth-symlink approval.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
