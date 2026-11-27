// Watch: background work the model started (a sweep, a long build) shows as one footer status line, and the
// model is woken once when it ends. The model registers the work with the `watch` tool: the pid of the wrapper
// shell, and optionally a progress file (one line per finished item), an item total, and an exit file the
// wrapper writes `$?` to. A 30 s timer checks the process table (no tokens); a pid that is gone or was reused
// (its start time changed) has ended. Watches live in session entries, so they survive /reload and resume.
// It runs only `ps -o lstart= -p <pid>`, reads only sizes, mtimes, newline counts, one integer and a stream's
// tail, and never signals a process. Off outside the TUI, including delegate workers: no tool, no timer. With a
// `stream` (a Pi JSON event stream the run writes), the footer also shows the run's last tool call, read from a
// bounded tail; that text goes to the footer only, never into a message or an entry. Design: docs/watch/design.md.
import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const KEY = "watch";
const MAX_WATCHES = 3;
const MAX_LABEL = 24;
const INTERVAL_MS = 30_000;
const PS_TIMEOUT_MS = 2_000;
/**
 * The most of a stream one check reads. A stream is mostly `message_update` lines, each repeating the whole
 * partial message (up to a few 100 KB), and one long turn can put over 2 MB between two tool calls. A check reads
 * only what was appended since the previous one, and at most this much of the file's end.
 */
export const STREAM_MAX_READ = 8 * 1024 * 1024;
const MAX_TOOL_NAME = 24;
const MAX_TOOL_ARG = 40;

/** What `ps` says about a pid: alive with its start time, gone, or not known (ps failed or timed out). */
export type Ps = { lstart: string } | "gone" | { error: string };
/** One check of a watch: the process table, and the exit file's integer when it holds one. */
export type Observation = { ps: Ps; exit?: number };
/** Where a check leaves a watch; `misses` counts checks in a row that found the pid gone with no exit status. */
export type Assessment =
	| { state: "running"; misses: number }
	| { state: "finished"; exit: number }
	| { state: "died" }
	| { state: "unknown"; reason: string; misses: number };

/** A watch as stored in its session entry. An ended one holds its end; `notified` is set before the wake. */
type Watch = {
	label: string;
	pid: number;
	lstart: string;
	since: number;
	progress?: string;
	stream?: string;
	total?: number;
	exitFile?: string;
	state: "running" | "finished" | "died";
	exit?: number;
	endedAt?: number;
	count?: number;
	notified?: boolean;
};
type Dropped = { label: string; dropped: true };
/** A tool call read from a stream: footer text only. */
export type ToolCall = { name: string; arg?: string };
/**
 * What only this session's checks know, never stored: the miss count, whether the first miss came from the
 * check on session_start (the work ended while no Pi watched), an unknown reason, the progress read, and the
 * stream's last tool call (its text is taken from the stream, so it never leaves the footer).
 */
type Live = {
	misses: number;
	missedAtStart?: boolean;
	unknown?: string;
	count?: number;
	mtime?: number;
	progressError?: string;
	/** `seenAt` is unset when the call's age is unknown; `stale` when a newer call may have gone unread. */
	tool?: ToolCall & { seenAt?: number; stale?: boolean };
	/** A capped read found no call and none is known: there may be one before the bytes read. */
	toolUnknown?: boolean;
	streamRead?: number;
	streamError?: string;
};

/** The rule for a watch's next state from one check; the only place that decides running, finished or died. */
export function assess(watch: { lstart: string; misses: number }, observation: Observation): Assessment {
	const { ps, exit } = observation;
	if (typeof ps === "object" && "error" in ps) return { state: "unknown", reason: ps.error, misses: watch.misses };
	if (ps !== "gone" && ps.lstart === watch.lstart) return { state: "running", misses: 0 };
	// The wrapper writes its exit file before it exits, so a gone pid with one finished, even on the second check.
	if (exit !== undefined) return { state: "finished", exit };
	// One miss can be the moment between the job's exit and the wrapper's `echo $? > exit`.
	const misses = watch.misses + 1;
	return misses >= 2 ? { state: "died" } : { state: "running", misses };
}

/**
 * `ps -o lstart= -p <pid>` with fixed argv, no shell, the C locale, UTC (so a Pi restored under another TZ
 * reads the same start time) and a 2 s timeout. Exit 1 with no output is a gone pid.
 */
export function runPs(pid: number): Promise<Ps> {
	return new Promise((done) => {
		execFile(
			"ps",
			["-o", "lstart=", "-p", String(pid)],
			{ env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: PS_TIMEOUT_MS },
			(err, stdout, stderr) => {
				const out = stdout.trim();
				if (!err && out) return done({ lstart: out.replace(/\s+/g, " ") });
				const code = (err as (Error & { code?: unknown; killed?: boolean }) | null)?.code;
				if (code === 1 && !out) return done("gone");
				if (err && (err as { killed?: boolean }).killed) return done({ error: "ps timed out" });
				done({ error: (stderr.trim() || err?.message || "ps printed nothing").split("\n")[0] });
			},
		);
	});
}

/** The integer the wrapper wrote, or undefined when there is no file yet or it holds no integer. */
function readExit(path: string): number | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	return /^-?\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

/** The progress file's newline count and mtime; undefined until the file exists. Its content is never kept. */
function readProgress(path: string): { count: number; mtime: number } | undefined {
	let bytes: Buffer;
	let mtime: number;
	try {
		mtime = statSync(path).mtimeMs;
		bytes = readFileSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	let count = 0;
	for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) count++;
	return { count, mtime };
}

/**
 * The last `tool_execution_start` in a Pi JSON event stream from byte `from` on, reading at most `maxBytes` of the
 * file's end. Also `next`, where the following read starts (the start of a half-written last line), and `skipped`
 * when the cap left bytes after `from` unread, and `rewritten` when the file is shorter than `from`. No tool when the file is missing or the bytes hold none. A line cut
 * by the read's start, a half-written last line and a line that is not JSON are skipped. Only the tool's name and
 * one short argument are kept, sanitised and capped. Anything but a regular file throws.
 */
export function readLastTool(
	path: string,
	from = 0,
	maxBytes = STREAM_MAX_READ,
): { tool?: ToolCall; next: number; skipped?: boolean; rewritten?: boolean } {
	let fd: number;
	try {
		// Non-blocking, so a FIFO given as the stream cannot hang the check; only a regular file is read.
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { next: 0 };
		throw err;
	}
	let bytes: Buffer;
	let begin: number;
	let start: number;
	let skipped: boolean;
	let rewritten: boolean;
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("not a regular file");
		// A stream that shrank was rewritten: read it again from its end.
		rewritten = from > stat.size;
		const resume = rewritten ? 0 : from;
		begin = Math.max(resume, stat.size - maxBytes);
		skipped = begin > resume;
		// One byte before `begin` tells whether the first line starts exactly there.
		start = Math.max(0, begin - 1);
		bytes = Buffer.alloc(stat.size - start);
		let read = 0;
		while (read < bytes.length) {
			const n = readSync(fd, bytes, read, bytes.length - read, start + read);
			if (n === 0) break;
			read += n;
		}
		bytes = bytes.subarray(0, read);
	} finally {
		closeSync(fd);
	}
	// Complete lines only: from the first line that starts in the bytes read to the last newline.
	const first = begin === 0 ? 0 : bytes.indexOf(10) + 1;
	// One line longer than the read, cut at both ends: nothing to parse, and the next read starts after it.
	if (begin > 0 && first === 0) return { next: start + bytes.length, skipped, rewritten };
	const end = bytes.lastIndexOf(10) + 1;
	const marker = Buffer.from('"tool_execution_start"');
	for (let at = end ? bytes.lastIndexOf(marker, end - 1) : -1; at !== -1; ) {
		const lineStart = bytes.lastIndexOf(10, at) + 1;
		if (lineStart < first) break;
		const tool = parseToolStart(bytes.subarray(lineStart, bytes.indexOf(10, at)).toString("utf8"));
		if (tool) return { tool, next: start + end, skipped, rewritten };
		if (lineStart === 0) break;
		at = bytes.lastIndexOf(marker, lineStart - 1);
	}
	return { next: start + end, skipped, rewritten };
}

function parseToolStart(line: string): ToolCall | undefined {
	let event: { type?: unknown; toolName?: unknown; args?: Record<string, unknown> };
	try {
		event = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (event?.type !== "tool_execution_start" || typeof event.toolName !== "string") return undefined;
	const name = sanitize(event.toolName, MAX_TOOL_NAME);
	if (!name) return undefined;
	const args = event.args && typeof event.args === "object" ? event.args : {};
	const raw = ["command", "path", "task", "name"].map((key) => args[key]).find((v) => typeof v === "string");
	const arg = typeof raw === "string" ? sanitize(raw, MAX_TOOL_ARG) : undefined;
	return { name, arg: arg || undefined };
}

// Terminal escape sequences, matched by their ECMA-48 shape: CSI (`ESC [` or C1 CSI, parameters, a final byte),
// OSC (`ESC ]` up to BEL or `ESC \`), and other `ESC` sequences. Node's `stripVTControlCharacters` is not used:
// its pattern differs across versions (Node 22 reads `ESC[31mswe BEL` as one sequence and eats "swe").
const ESCAPES = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[ -/]*[0-~]/g;

/** Strip ANSI codes, control and format characters (bidi, zero-width) and newlines; cap at `max`, marking a cut. */
function sanitize(text: string, max: number, mark = "…"): string {
	const chars = [
		...text
			.replace(ESCAPES, "")
			.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
			.replace(/\s+/g, " ")
			.trim(),
	];
	return chars.length <= max ? chars.join("") : chars.slice(0, max - mark.length).join("") + mark;
}

/** A label without ANSI codes, control characters or newlines, capped at 24. */
export function sanitizeLabel(label: string): string {
	return sanitize(label, MAX_LABEL, "");
}

/** `45s`, `23m`, `2h41m`. */
export function duration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

const firstLine = (err: unknown) => (err as Error).message.split("\n")[0];
const ended = (watch: Watch) => watch.state !== "running";
const items = (count: number | undefined, total: number | undefined) =>
	count === undefined ? undefined : total === undefined ? `${count}` : `${count}/${total}`;

/** One watch's part of the footer line. */
function fragment(watch: Watch, live: Live, now: number): string {
	const done = items(watch.count ?? live.count, watch.total);
	if (watch.state === "finished") {
		const glyph = watch.exit === 0 ? "✓" : "✗";
		const age = duration((watch.endedAt ?? now) - watch.since);
		return [`${glyph} ${watch.label} exit ${watch.exit}`, done, age].filter(Boolean).join(" · ");
	}
	if (watch.state === "died") return [`✗ ${watch.label} died, no exit status`, done].filter(Boolean).join(" · ");
	const unknown =
		live.unknown ||
		(live.progressError && `progress: ${live.progressError}`) ||
		(live.streamError && `stream: ${live.streamError}`);
	if (unknown) return `? ${watch.label} unchecked (${unknown})`;
	const last = live.mtime === undefined ? undefined : `last +1 ${duration(now - live.mtime)}`;
	const seen = live.tool?.seenAt;
	const tool = live.toolUnknown
		? ["?"]
		: live.tool && [
				live.tool.stale && "?",
				live.tool.name,
				live.tool.arg,
				seen !== undefined && `${duration(now - seen)} ago`,
			];
	return [
		["⏵", watch.label, done].filter(Boolean).join(" "),
		last,
		tool?.filter(Boolean).join(" "),
		duration(now - watch.since),
	]
		.filter(Boolean)
		.join(" · ");
}

/** The message that wakes the model: `[watch] sweep finished: exit 0, 24/24 items, 3h02m (progress: run/record.jsonl)`. */
function wakeText(watch: Watch): string {
	const what = watch.state === "finished" ? `finished: exit ${watch.exit}` : "died: no exit status";
	const done = items(watch.count, watch.total);
	const parts = [what, done && `${done} items`, duration((watch.endedAt ?? watch.since) - watch.since)];
	const progress = watch.progress ? ` (progress: ${watch.progress})` : "";
	return `[watch] ${watch.label} ${parts.filter(Boolean).join(", ")}${progress}`;
}

function parseEntry(value: unknown): Watch | Dropped | undefined {
	const data = (value ?? {}) as Partial<Watch & Dropped>;
	if (typeof data.label !== "string") return undefined;
	if (data.dropped === true) return { label: data.label, dropped: true };
	if (!Number.isInteger(data.pid) || typeof data.lstart !== "string" || typeof data.since !== "number")
		return undefined;
	if (data.state !== "running" && data.state !== "finished" && data.state !== "died") return undefined;
	return data as Watch;
}

/** The extension, with `ps` and the check interval injectable for tests. */
export function createWatch({ ps = runPs, interval = INTERVAL_MS } = {}) {
	return (pi: ExtensionAPI) => {
		// Label → watch, in registration order. Rebuilt from session entries on every session_start.
		let watches = new Map<string, { watch: Watch; live: Live }>();
		let ui: ExtensionContext["ui"] | undefined;
		let cwd = process.cwd();
		let timer: NodeJS.Timeout | undefined;
		let pending = false;
		// Bumped on shutdown, so a check still awaiting `ps` from the old session does nothing when it returns.
		let generation = 0;

		const render = () => {
			if (!ui) return;
			const now = Date.now();
			const all = [...watches.values()];
			const ordered = [...all.filter(({ watch }) => ended(watch)), ...all.filter(({ watch }) => !ended(watch))];
			const text = ordered.map(({ watch, live }) => fragment(watch, live, now)).join("  ");
			ui.setStatus(KEY, text || undefined);
		};

		const stopTimer = () => {
			clearInterval(timer);
			timer = undefined;
		};
		// The timer runs only while some watch is running.
		const syncTimer = () => {
			const running = [...watches.values()].some(({ watch }) => !ended(watch));
			if (!running) return stopTimer();
			if (timer) return;
			timer = setInterval(() => void check(true), interval);
			timer.unref();
		};

		// Read what the stream gained since the last check. Bytes with no tool call keep the last one seen. A call
		// found in appended bytes is dated from now; one found by the first read (at registration, after /reload)
		// may be of any age, so it shows none. After a capped read with no call, a newer one may have gone unread:
		// the last one stays, marked `?`, without an age. A rewritten stream is read as if for the first time.
		const readStream = (watch: Watch, live: Live) => {
			if (!watch.stream) return;
			try {
				const { tool, next, skipped, rewritten } = readLastTool(watch.stream, live.streamRead);
				if (rewritten) live.tool = undefined;
				const first = live.streamRead === undefined || rewritten;
				if (tool) live.tool = { ...tool, seenAt: first ? undefined : Date.now() };
				else if (skipped && live.tool) live.tool = { ...live.tool, seenAt: undefined, stale: true };
				if (rewritten || live.tool) live.toolUnknown = undefined;
				if (skipped && !live.tool) live.toolUnknown = true;
				live.streamRead = next;
				live.streamError = undefined;
			} catch (err) {
				live.streamError = firstLine(err);
			}
		};

		const observe = async (watch: Watch, live: Live): Promise<Assessment> => {
			// An unreadable progress file is shown, but never keeps the check from seeing the end.
			if (watch.progress) {
				try {
					const progress = readProgress(watch.progress);
					live.count = progress?.count;
					live.mtime = progress?.mtime;
					live.progressError = undefined;
				} catch (err) {
					live.progressError = firstLine(err);
				}
			}
			readStream(watch, live);
			const result = await ps(watch.pid);
			const exit = watch.exitFile ? readExit(watch.exitFile) : undefined;
			return assess({ lstart: watch.lstart, misses: live.misses }, { ps: result, exit });
		};

		// Check every running watch once. An end found while live wakes the model; one found on session_start
		// (it ended while no Pi watched) is only added to the session, for the model to read on the next prompt.
		const check = async (live: boolean) => {
			if (pending) return;
			pending = true;
			const at = generation;
			try {
				for (const [label, entry] of [...watches]) {
					if (ended(entry.watch)) continue;
					let result: Assessment;
					try {
						result = await observe(entry.watch, entry.live);
					} catch (err) {
						result = {
							state: "unknown",
							reason: firstLine(err),
							misses: entry.live.misses,
						};
					}
					if (at !== generation) return;
					// Dropped or replaced while `ps` ran: the result is for a watch that is gone.
					if (watches.get(label) !== entry) continue;
					if (result.state === "running" || result.state === "unknown") {
						if (entry.live.misses === 0 && result.misses === 1) entry.live.missedAtStart = !live;
						entry.live.misses = result.misses;
						entry.live.unknown = result.state === "unknown" ? result.reason : undefined;
						continue;
					}
					const watch: Watch = {
						...entry.watch,
						state: result.state,
						exit: result.state === "finished" ? result.exit : undefined,
						endedAt: Date.now(),
						count: entry.live.count,
						notified: true,
					};
					entry.watch = watch;
					// Marked notified before the wake, so a restore never wakes the model a second time.
					pi.appendEntry(KEY, watch);
					const message = { customType: KEY, content: wakeText(watch), display: true };
					// A death confirmed by the timer whose first miss was on session_start also ended unwatched.
					const wake = live && !(result.state === "died" && entry.live.missedAtStart);
					if (wake) await pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
					else await pi.sendMessage(message);
				}
			} finally {
				if (at === generation) {
					pending = false;
					render();
					syncTimer();
				}
			}
		};

		const restore = (ctx: ExtensionContext) => {
			watches = new Map();
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== KEY) continue;
				const data = parseEntry(entry.data);
				if (!data) continue;
				watches.delete(data.label);
				if ("dropped" in data) continue;
				const live: Live = { misses: 0 };
				watches.set(data.label, { watch: data, live });
			}
			for (const { watch, live } of watches.values()) {
				if (!ended(watch)) readStream(watch, live);
			}
		};

		const drop = (label: string) => {
			watches.delete(label);
			pi.appendEntry(KEY, { label, dropped: true } satisfies Dropped);
		};

		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			ui = ctx.ui;
			cwd = ctx.cwd;
			restore(ctx);
			render();
			pi.registerTool({
				name: KEY,
				label: "Watch",
				description:
					"Watch background work: its wrapper shell's pid, optional progress file (one line per item), item total, exit file (the wrapper writes $? there) and stream (a headless Pi run's JSON event stream; its last tool shows in the footer only). Shows in the footer; a message arrives when it ends. `drop: true` removes a watch.",
				promptGuidelines: [
					"After starting long background work, call `watch` once with the wrapper shell's pid and, when it has them, its progress and exit files, and for a headless Pi run (`pi -p --mode json > file`) that file as `stream`. Don't poll it: a message arrives when it ends.",
				],
				parameters: Type.Object({
					label: Type.String(),
					pid: Type.Optional(Type.Integer({ minimum: 1 })),
					progress: Type.Optional(Type.String()),
					stream: Type.Optional(Type.String()),
					total: Type.Optional(Type.Integer({ minimum: 1 })),
					exitFile: Type.Optional(Type.String()),
					drop: Type.Optional(Type.Boolean()),
				}),
				async execute(_id, params) {
					const label = sanitizeLabel(params.label);
					if (!label) throw new Error("watch: label is empty");
					if (params.drop) {
						if (!watches.has(label)) throw new Error(`watch: no watch named ${label}`);
						drop(label);
						render();
						syncTimer();
						return { content: [{ type: "text", text: `dropped ${label}` }], details: undefined };
					}
					if (params.pid === undefined) throw new Error("watch: pid is required (the wrapper shell's pid)");
					const room = () => {
						const existing = watches.get(label);
						if (existing && !ended(existing.watch)) throw new Error(`watch: ${label} is already watched`);
						const others = [...watches.keys()].filter((name) => name !== label);
						if (others.length >= MAX_WATCHES)
							throw new Error(
								`watch: at most ${MAX_WATCHES} watches; drop one first (watch({ label, drop: true }))`,
							);
					};
					room();
					const exitFile = params.exitFile === undefined ? undefined : resolve(cwd, params.exitFile);
					// An exit file left by an earlier run would read as this run's clean finish.
					if (exitFile && existsSync(exitFile))
						throw new Error(
							`watch: exit file ${params.exitFile} already exists; remove it before the run starts`,
						);
					const found = await ps(params.pid);
					if (found === "gone") throw new Error(`watch: pid ${params.pid} is not running`);
					if ("error" in found) throw new Error(`watch: could not check pid ${params.pid} (${found.error})`);
					// A parallel `watch` call may have taken the label or the last slot while `ps` ran.
					room();
					const watch: Watch = {
						label,
						pid: params.pid,
						lstart: found.lstart,
						since: Date.now(),
						progress: params.progress === undefined ? undefined : resolve(cwd, params.progress),
						stream: params.stream === undefined ? undefined : resolve(cwd, params.stream),
						total: params.total,
						exitFile,
						state: "running",
					};
					watches.delete(label);
					const live: Live = { misses: 0 };
					readStream(watch, live);
					watches.set(label, { watch, live });
					pi.appendEntry(KEY, watch);
					render();
					syncTimer();
					return {
						content: [{ type: "text", text: `watching ${label} (pid ${watch.pid}, started ${found.lstart})` }],
						details: undefined,
					};
				},
			});
			await check(false);
		});

		pi.on("session_shutdown", () => {
			generation++;
			pending = false;
			stopTimer();
			ui = undefined;
		});

		pi.on("session_tree", (_event, ctx) => {
			if (!ui) return;
			restore(ctx);
			render();
			syncTimer();
		});

		// An ended watch leaves the footer on the user's next prompt after its message.
		pi.on("message_start", (event) => {
			if (!ui || event.message.role !== "user") return;
			const done = [...watches.values()].filter(({ watch }) => ended(watch) && watch.notified);
			if (!done.length) return;
			for (const { watch } of done) drop(watch.label);
			render();
		});
	};
}

export default createWatch();
