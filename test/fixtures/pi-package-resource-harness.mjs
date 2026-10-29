// Scratch Pi package resource-discovery fixture: no model calls; not runtime or installer code.
import { mkdir } from "node:fs/promises";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const [source, filter, assertion] = process.argv.slice(2);
const agentDir = getAgentDir();
if (!source || !agentDir) throw new Error("Pass a local package source and PI_CODING_AGENT_DIR");
await mkdir(agentDir, { recursive: true });

const cwd = agentDir;
const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
await packageManager.installAndPersist(source);
if (filter === "guard-only") {
	settingsManager.setPackages([{ source, extensions: ["extensions/guard.ts"] }]);
} else if (filter === "delegate-only") {
	settingsManager.setPackages([{ source, extensions: ["extensions/delegate.ts"] }]);
}
await settingsManager.flush();

const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
await resourceLoader.reload();
const result = resourceLoader.getExtensions();
const skillResult = resourceLoader.getSkills();
if (assertion === "assert-delegate") {
	if (process.env.ME_PI_RUN) {
		throw new Error("delegate tool registration probe must run outside worker mode");
	}
	const delegate = result.extensions.find((extension) => extension.path.endsWith("/extensions/delegate.ts"));
	if (!delegate?.tools.has("delegate")) throw new Error("delegate extension did not register its tool");
}
console.log(
	JSON.stringify({
		agentDir,
		extensions: result.extensions.map((extension) => ({
			path: extension.path,
			tools: [...extension.tools.keys()],
		})),
		errors: result.errors,
		warnings: result.warnings ?? [],
		skills: skillResult.skills.map((skill) => ({ name: skill.name, path: skill.filePath })),
		skillDiagnostics: skillResult.diagnostics,
	}),
);
