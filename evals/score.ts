/** Scores a coordinator's Pi session log (JSONL) against a routing scenario's expectations. */

export interface Call {
	turn: number;
	name: string;
	args: any;
	/** Absent when the session ended before the tool returned. */
	result?: { text: string; isError: boolean; details?: any };
}

export interface Transcript {
	turns: { prompt: string; replies: string[] }[];
	calls: Call[];
	/** Pi-estimated spend; an estimate, not the provider's counter. */
	coordinatorCost: number;
	workerCost: number;
	/** Coordinator turns that ended on a provider error. */
	errors: string[];
}

const textOf = (content: any): string =>
	Array.isArray(content) ? content.map((c) => (c?.type === "text" ? c.text : "")).join("") : "";

export function parseSession(jsonl: string): Transcript {
	const t: Transcript = { turns: [], calls: [], coordinatorCost: 0, workerCost: 0, errors: [] };
	const byId = new Map<string, Call>();
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line);
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (m.role === "user") t.turns.push({ prompt: textOf(m.content), replies: [] });
		else if (m.role === "assistant") {
			const turn = Math.max(0, t.turns.length - 1);
			t.coordinatorCost += m.usage?.cost?.total ?? 0;
			if (m.stopReason === "error") t.errors.push(m.errorMessage || "provider error");
			for (const c of m.content ?? []) {
				if (c.type === "toolCall") {
					const call: Call = { turn, name: c.name, args: c.arguments ?? {} };
					t.calls.push(call);
					byId.set(c.id, call);
				} else if (c.type === "text" && c.text.trim()) t.turns[turn]?.replies.push(c.text);
			}
		} else if (m.role === "toolResult") {
			const call = byId.get(m.toolCallId);
			if (call) call.result = { text: textOf(m.content), isError: !!m.isError, details: m.details };
			if (m.toolName === "delegate") t.workerCost += m.usage?.cost?.total ?? 0;
		}
	}
	return t;
}

export interface DelegateMatch {
	role?: string;
	web?: boolean;
	background?: boolean;
	rebuttal?: boolean;
	minRuns?: number;
	/** Whether any run names a model or a thinking level. */
	named?: boolean;
}

/** One expectation; exactly one key besides `id`. Counts are `n` or `[min, max]`. */
export type Assertion = { id: string } & (
	| { skill: string }
	| { delegate: DelegateMatch; count: number | [number, number] }
	| { noTool: string }
	| { maxOwnRead: number }
	| { inline: true }
	| { noRerun: string }
	| { diffByPath: true }
	| { reply: string; turn?: number }
	| { maxReplyWords: number; turn: number }
);

export interface Verdict {
	id: string;
	result: "pass" | "fail" | "unknown";
	evidence: string;
}

const accepted = (c: Call) => c.name === "delegate" && c.result !== undefined && !c.result.isError;
const roleOf = (c: Call) => c.args.role ?? "general";
const namedRuns = (c: Call): string[] =>
	(c.args.runs ?? [])
		.filter((r: any) => r?.model !== undefined || r?.thinking !== undefined)
		.map((r: any) => [r.model, r.thinking].filter(Boolean).join(":"));
const described = (c: Call) => [roleOf(c), ...namedRuns(c)].join(" ");
const edits = (c: Call) =>
	c.name === "edit" ||
	c.name === "write" ||
	(c.name === "codemode" && /tools\.(edit|write)\(/.test(c.args.code ?? ""));
const DIFF = /\S+\.(?:diff|patch)\b/;
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

function matches(c: Call, m: DelegateMatch): boolean {
	if (m.role !== undefined && roleOf(c) !== m.role) return false;
	for (const flag of ["web", "background", "rebuttal"] as const)
		if (m[flag] !== undefined && !!c.args[flag] !== m[flag]) return false;
	if (m.named !== undefined && namedRuns(c).length > 0 !== m.named) return false;
	return m.minRuns === undefined || (c.args.runs?.length ?? 0) >= m.minRuns;
}

const verdict = (id: string, ok: boolean, evidence: string): Verdict => ({
	id,
	result: ok ? "pass" : "fail",
	evidence,
});

export function check(t: Transcript, a: Assertion): Verdict {
	if ("skill" in a) {
		const hit = t.calls.some((c) => c.name === "Skill" && c.args.name === a.skill);
		return verdict(a.id, hit, hit ? `Skill ${a.skill}` : `no Skill ${a.skill} call`);
	}
	if ("delegate" in a) {
		const [min, max] = typeof a.count === "number" ? [a.count, a.count] : a.count;
		const hits = t.calls.filter((c) => accepted(c) && matches(c, a.delegate));
		const pending = t.calls.some((c) => c.name === "delegate" && !c.result);
		const ok = hits.length >= min && hits.length <= max;
		if (!ok && pending) return { id: a.id, result: "unknown", evidence: "a delegate call never returned" };
		return verdict(a.id, ok, `${hits.length} matching (${min}–${max}): ${hits.map(described).join(", ") || "none"}`);
	}
	if ("noTool" in a) {
		const n = t.calls.filter((c) => c.name === a.noTool).length;
		return verdict(a.id, n === 0, `${n} ${a.noTool} calls`);
	}
	if ("maxOwnRead" in a) {
		const own = t.calls.filter((c) => c.name !== "delegate" && c.name !== "Skill" && c.result);
		const top = own.reduce<Call | undefined>(
			(b, c) => (!b || c.result!.text.length > b.result!.text.length ? c : b),
			undefined,
		);
		const size = top?.result?.text.length ?? 0;
		return verdict(a.id, size <= a.maxOwnRead, top ? `largest ${top.name} result ${size} chars` : "no own reads");
	}
	if ("inline" in a) {
		const own = t.calls.filter(edits).length;
		const impl = t.calls.filter((c) => accepted(c) && roleOf(c) === "implement").length;
		return verdict(a.id, own > 0 && impl === 0, `${own} own edits, ${impl} implement calls`);
	}
	if ("noRerun" in a) {
		const re = new RegExp(a.noRerun);
		let armed = false;
		for (const c of t.calls) {
			if (accepted(c) && roleOf(c) === "implement" && /check ✓/.test(c.result!.text)) armed = true;
			else if (edits(c)) armed = false;
			else if (armed && c.name === "bash" && re.test(c.args.command ?? ""))
				return verdict(a.id, false, `re-ran after implement ✓: ${short(c.args.command)}`);
		}
		return verdict(a.id, true, "no re-run after implement ✓");
	}
	if ("diffByPath" in a) {
		const reviews = t.calls.filter((c) => accepted(c) && roleOf(c) === "general" && DIFF.test(c.args.task ?? ""));
		const ownReads = t.calls.filter(
			(c) =>
				(c.name === "read" && DIFF.test(c.args.path ?? "")) ||
				(c.name === "bash" && /\b(cat|less|head|tail|sed)\b[^|;&]*\.(diff|patch)\b/.test(c.args.command ?? "")),
		);
		const ok = reviews.length > 0 && ownReads.length === 0;
		const evidence = ownReads.length
			? `read the diff itself: ${short(JSON.stringify(ownReads[0].args))}`
			: `${reviews.length} reviews given a diff path`;
		return verdict(a.id, ok, evidence);
	}
	if ("reply" in a) {
		const text = t.turns[a.turn ?? 0]?.replies.join("\n") ?? "";
		return verdict(a.id, new RegExp(a.reply).test(text), short(text.replace(/\s+/g, " ")));
	}
	const text = t.turns[a.turn]?.replies.at(-1) ?? "";
	const words = text.split(/\s+/).filter(Boolean).length;
	return verdict(a.id, words > 0 && words <= a.maxReplyWords, `${words} words`);
}
