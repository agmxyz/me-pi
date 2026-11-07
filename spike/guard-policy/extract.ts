/**
 * Extracts every `bash` tool call's `command` from Pi session files, with the session's cwd and whether it ran in a
 * worker. Output stays OUTSIDE the repo (real commands may hold private data): `/tmp/guard-measure/commands.json`,
 * mode 0600, deduped by exact text with counts.
 *
 * Reads only `~/.pi/agent/sessions/**\/*.jsonl` (session files, delegate worker `run-0/session.jsonl`, subagent
 * transcripts). Never auth or credential files.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export const OUT_DIR = "/tmp/guard-measure";
export const COMMANDS_FILE = join(OUT_DIR, "commands.json");

export interface Extracted {
	command: string;
	count: number;
	/** Distinct cwds the command ran in (first 5). */
	cwds: string[];
	/** Ran in a delegate worker or subagent at least once. */
	worker: boolean;
	main: boolean;
}

function* jsonlFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) yield* jsonlFiles(p);
		else if (name.endsWith(".jsonl")) yield p;
	}
}

/** Every `{type: "toolCall", name: "bash", arguments: {command}}` anywhere in a record, with its call id. */
function* bashCalls(v: unknown): Generator<[string, string | undefined]> {
	if (Array.isArray(v)) for (const x of v) yield* bashCalls(x);
	else if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		const args = o.arguments as Record<string, unknown> | undefined;
		if (o.type === "toolCall" && o.name === "bash" && typeof args?.command === "string")
			yield [args.command, typeof o.id === "string" ? o.id : undefined];
		else for (const x of Object.values(o)) yield* bashCalls(x);
	}
}

export function extract(root = join(homedir(), ".pi/agent/sessions")) {
	const byText = new Map<string, Extracted>();
	const stats = { files: 0, workerFiles: 0, badLines: 0, calls: 0, repeatedIds: 0 };
	const seen = new Set<string>();
	// A subagent transcript can repeat calls its session file already holds; count each (file, call id) once.
	for (const file of jsonlFiles(root)) {
		stats.files++;
		const rel = relative(root, file);
		const worker = /(?:^|\/)run-\d+\/session\.jsonl$|subagent-artifacts\//.test(rel);
		if (worker) stats.workerFiles++;
		let cwd = "";
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let rec: Record<string, unknown>;
			try {
				rec = JSON.parse(line);
			} catch {
				stats.badLines++;
				continue;
			}
			if (typeof rec.cwd === "string") cwd = rec.cwd;
			for (const [command, id] of bashCalls(rec)) {
				// The same call (same id and text) recorded in two files is one call.
				const key = id === undefined ? undefined : `${id}\0${command}`;
				if (key !== undefined && seen.has(key)) {
					stats.repeatedIds++;
					continue;
				}
				if (key !== undefined) seen.add(key);
				stats.calls++;
				const e = byText.get(command) ?? { command, count: 0, cwds: [], worker: false, main: false };
				e.count++;
				if (cwd && !e.cwds.includes(cwd) && e.cwds.length < 5) e.cwds.push(cwd);
				if (worker) e.worker = true;
				else e.main = true;
				byText.set(command, e);
			}
		}
	}
	return { stats, commands: [...byText.values()] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
	chmodSync(OUT_DIR, 0o700);
	const { stats, commands } = extract();
	writeFileSync(COMMANDS_FILE, JSON.stringify({ stats, commands }), { mode: 0o600 });
	console.log(JSON.stringify({ ...stats, unique: commands.length }));
}
