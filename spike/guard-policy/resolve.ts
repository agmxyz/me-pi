/**
 * What an expanding word could become, read from the command's own text, so policy.ts asks on an unknown only where
 * it could land in one of its three cases.
 *
 * `resolveWord` gives the word's possible values, or `undefined` (anything). A value may start with a marker:
 * - `TEMP`: a fresh `mktemp` path (`T=$(mktemp -d)`), which nothing else names;
 * - `TMPROOT`: the session's temp dir (`${TMPDIR:?}`, `${TMPDIR:-/tmp}`, `$TMPDIR`), when the command can't rebind it;
 * - `NOTMP`: what `$TMPDIR` gives if TMPDIR is unset (an empty string: `$TMPDIR/x` is `/x`);
 * - `HOME`: the home directory (`~`, `$HOME`), outside every repo;
 * - `PWD`: the working directory at that point (`$PWD`);
 * - `ENV:name`: the session's value of a variable the command doesn't (surely) bind.
 * An unquoted glob character in the source is kept as `GLOBCH` + the character, so callers can tell `$T/*` (a glob)
 * from `"$T/*"` (a literal star).
 * A variable resolves to every value the command gives it when every binding surely ran before the use; one bound by
 * `read`, as an array, in a way the text hides (`eval`, `source`, `((…))`), or in a new shell is unknown. Unquoted
 * glob characters stay in the value (policy.ts judges the directory they glob in); a value that would split is unknown.
 */
import type { Bindings, Word } from "../guard-parser/shell-ast.ts";

export const TEMP = "\u0000TEMP";
export const TMPROOT = "\u0000TMPROOT";
export const NOTMP = "\u0000NOTMP";
export const HOME = "\u0000HOME";
export const PWD = "\u0000PWD";
export const ENV = "\u0000ENV:";
export const GLOBCH = "\u0001";
const MAX_DEPTH = 4;
const MAX_VALUES = 64;

export interface Scope {
	b: Bindings | null;
	/** Nothing in the command can rebind TMPDIR before its use (policy.ts `tmpdirStable`). */
	tmpdirStable: boolean;
}

// `$(mktemp)`, `$(mktemp -d)`, `$(mktemp -d -t name)`, `$(mktemp -d /tmp/x.XXXXXX)`, `$(mktemp -d "${TMPDIR:-/tmp}/x.XXX")`.
const MKTEMP = /^\$\(\s*mktemp((?:\s+(?:-[dqu]+|--directory|-t\s+[\w.-]+|"?[^\s"()]*X{3,}[\w.-]*"?))*)\s*\)$/;
// A template under a temp root keeps the result a fresh temp path; a bare name is relative to the working directory.
const TEMP_TEMPLATE =
	/^"?(?:\/tmp\/|\/private\/tmp\/|\$\{?TMPDIR(?::[-?][^}]*)?\}?\/|\/var\/folders\/)[^/\s]*X{3,}[\w.-]*"?$/;

export function resolveWord(w: Word, s: Scope, usedAt: number): string[] | undefined {
	if (w.kind !== "expansion") return [w.value];
	return resolveRaw(w.raw, s, usedAt, 0);
}

/** Resolves a word's source text: quotes, `$NAME`, `${NAME}`, TMPDIR forms, a leading `~`, globs, literal characters. */
function resolveRaw(raw: string, s: Scope, usedAt: number, depth: number): string[] | undefined {
	if (depth > MAX_DEPTH) return undefined;
	const mk = MKTEMP.exec(raw.replace(/^"(.*)"$/s, "$1"));
	if (mk) {
		const template = mk[1].split(/\s+/).find((a) => /X{3,}/.test(a));
		return template === undefined || TEMP_TEMPLATE.test(template) ? [TEMP] : undefined;
	}
	let values = [""];
	let i = 0;
	let dq = false;
	const append = (pieces: string[]) => {
		const next: string[] = [];
		for (const v of values) for (const p of pieces) next.push(v + p);
		values = next;
		return next.length <= MAX_VALUES;
	};
	if (raw === "~" || raw.startsWith("~/")) {
		values = [HOME];
		i = 1;
	}
	while (i < raw.length) {
		const ch = raw[i];
		if (ch === '"') {
			dq = !dq;
			i++;
			continue;
		}
		if (ch === "'" && !dq) {
			const end = raw.indexOf("'", i + 1);
			if (end < 0) return undefined;
			if (!append([raw.slice(i + 1, end)])) return undefined;
			i = end + 1;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= raw.length) return undefined;
			if (!append([raw[i + 1]])) return undefined;
			i += 2;
			continue;
		}
		if (ch === "$") {
			const rest = raw.slice(i);
			const tmp = /^\$\{TMPDIR(?::\?[^}]*|:-\/tmp\/?)\}/.exec(rest);
			if (!tmp && /^\$\{TMPDIR:/.test(rest)) return undefined;
			const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(rest);
			let pieces: string[] | undefined;
			let len: number;
			if (tmp) {
				// `${TMPDIR:?}` stops the command if unset; `${TMPDIR:-/tmp}` falls back to a temp root.
				pieces = !s.tmpdirStable ? undefined : tmp[0].includes(":-") ? [TMPROOT, "/tmp"] : [TMPROOT];
				len = tmp[0].length;
			} else if (m) {
				pieces = resolveName(m[1] ?? m[2], s, usedAt, depth);
				len = m[0].length;
			} else return undefined; // `$(…)`, `${x%/}`, `$1`, `$@`, `$$`
			if (!pieces) return undefined;
			// Unquoted: a value with blanks splits (a session value may, too).
			if (!dq && pieces.some((p) => /\s/.test(p) || p.startsWith(ENV))) return undefined;
			if (!append(pieces)) return undefined;
			i += len;
			continue;
		}
		if (ch === "`") return undefined;
		// Unquoted glob characters are marked (policy.ts judges what they glob in); braces are expanded by policy.ts.
		if (!append([!dq && /[*?[{},]/.test(ch) ? GLOBCH + ch : ch])) return undefined;
		i++;
	}
	if (dq) return undefined;
	return values;
}

function resolveName(name: string, s: Scope, usedAt: number, depth: number): string[] | undefined {
	const b = s.b;
	if (b?.opaque) return undefined;
	const bound = b?.values.has(name) ?? false;
	if (!bound) {
		if (name === "HOME") return [HOME];
		if (name === "PWD") return [PWD];
		if (name === "TMPDIR") return s.tmpdirStable ? [TMPROOT, NOTMP] : undefined;
		return [`${ENV}${name}`];
	}
	const ws = b!.values.get(name);
	if (!ws) return undefined;
	// A use before the first binding, or where a binding may not have run, can see the session's value.
	const before = (b!.firstAt.get(name) ?? 0) > usedAt;
	const ranges = b!.conditional.get(name);
	const maybeUnbound = before || (ranges !== undefined && !ranges.some(([a, e]) => usedAt >= a && usedAt < e));
	if (before) return [`${ENV}${name}`];
	const out: string[] = maybeUnbound ? [`${ENV}${name}`] : [];
	for (const w of ws) {
		const r = w.kind === "expansion" ? resolveRaw(w.raw, s, usedAt, depth + 1) : [w.value];
		if (!r) return undefined;
		out.push(...r);
	}
	return out;
}

/**
 * Expands unquoted brace alternatives (`a/{b,c}/d`, marked by `GLOBCH`); undefined for ranges, nesting, or too many.
 * Marked `,` outside braces and unmatched braces become plain text.
 */
export function expandBraces(v: string): string[] | undefined {
	const m = /\u0001\{((?:(?!\u0001[{}])[\s\S])*)\u0001\}/.exec(v);
	if (!m) return [v.replace(/\u0001([{},])/g, "$1")];
	if (!m[1].includes("\u0001,")) return /\.\./.test(m[1]) ? undefined : expandBraces(v.replace(m[0], `{${m[1]}}`));
	const out: string[] = [];
	for (const alt of m[1].split("\u0001,")) {
		const r = expandBraces(v.slice(0, m.index) + alt + v.slice(m.index + m[0].length));
		if (!r) return undefined;
		out.push(...r);
		if (out.length > MAX_VALUES) return undefined;
	}
	return out;
}
