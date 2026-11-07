/**
 * #78 spike: find every simple command in a bash string with tree-sitter-bash, as argv word lists.
 * Report-only. Not wired into guard.ts. `await initShellAst()` once, then `commands(src)` is synchronous.
 *
 * The parser only *finds* words; callers decide. Each word is tagged:
 * - `literal`: unquoted text with no expansion (escapes decoded: `\-r` is `-r`, `\<newline>` vanishes);
 * - `quoted`: quoted text, possibly joined with literal text, with no expansion (`'a'"b"c`, `$'\t'`);
 * - `expansion`: anything bash would expand (`$x`, `${x}`, `$(…)`, `` `…` ``, `$((…))`, `<(…)`, globs, `~`, braces).
 *   `value` then keeps the expansion's source text; `tmpdirOnly` says the only expansion is a leading `${TMPDIR:?}`.
 */
import { readFileSync } from "node:fs";
import { Language, type Node, Parser } from "web-tree-sitter";

export type WordKind = "literal" | "quoted" | "expansion";
export interface Word {
	value: string;
	kind: WordKind;
	raw: string;
	/** The word's only expansion is `${TMPDIR:?}` at its start (guard's `TMPDIR_REF` rule). */
	tmpdirOnly: boolean;
}

export interface Heredoc {
	/** Delimiter quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`): the body is literal text. */
	quoted: boolean;
	body: string;
}

export interface SimpleCommand {
	argv: Word[];
	/** Basename of a literal or quoted argv[0] (`/usr/bin/env` is `env`); undefined if argv[0] has an expansion. */
	name: string | undefined;
	/** Wrapper names this command was unwrapped from, outermost first; `-c`/`eval`/`trap`/heredoc re-parses too. */
	via: string[];
	/** More arguments arrive at run time (`xargs`, `find -exec … {}`). */
	openArgs: boolean;
	/** Runs elsewhere or later (`ssh`, `watch` bodies): found additively, never settles anything. */
	remote: boolean;
	/** A command string whose text isn't literal (`bash -c "$X"`, `eval "$cmd"`): unknowable statically. */
	dynamicBody?: string;
	redirects: { op: string; target: Word | undefined }[];
	heredocs: Heredoc[];
	/** `NAME=value` prefixes on this command (`GIT_DIR=x git …`), by name. */
	assignments: string[];
	/** Source offset of the top-level command this one came from (a re-parsed string takes its command's offset). */
	at: number;
	/** Found by re-parsing a string (`sh -c`, `eval`, `trap`, a heredoc or here-string body): its words aren't the outer
	 * command's text, so the outer command's variable bindings don't apply to them. */
	reparsed: boolean;
	/** Runs whenever the script runs, in this shell (a top-level sequence item; see `certain`). */
	certain: boolean;
	/** Source ranges that run only after this command succeeded (the rest of its `&&` chain). */
	after: [number, number][];
}

export const LIMITS = { maxSource: 100_000, maxDepth: 6, maxCommands: 5_000 };

let parser: Parser | undefined;
// Offset of the top-level command being walked; commands found in re-parsed strings take it.
let currentAt = 0;

export async function initShellAst(
	wasmPath = new URL("./vendor/tree-sitter-bash.wasm", import.meta.url),
): Promise<void> {
	if (parser) return;
	await Parser.init();
	const bash = await Language.load(readFileSync(wasmPath));
	const p = new Parser();
	p.setLanguage(bash);
	parser = p;
}

class Bail extends Error {}

/**
 * Shell variables a command assigns, with every value it could hold: each `NAME=value` (plain, prefix, `export`/`local`)
 * and each `for NAME in …` word. A name maps to null when its value can't be known from the text: an array or `+=`,
 * a `for` without `in`, `read`/`mapfile`/`getopts`/`printf -v`/`unset` naming it, or more `NAME=` in the text than
 * parsed assignments (one inside a `trap` or `eval` string). `opaque`: the command can bind names the text doesn't show
 * (`eval`, `source`, `.`, `((…))`, `let`, `declare -n`, `${!x}`); then nothing resolves. Null on a parse failure.
 */
export interface Bindings {
	values: Map<string, Word[] | null>;
	/** Offset of each name's first binding: a use before it sees the session's value. */
	firstAt: Map<string, number>;
	/**
	 * Names some binding of which may not run (`a && t=x`, `if …; then t=x; fi`), with the source ranges where every such
	 * binding has run (the rest of its `&&` chain). A use outside them may see the session's value.
	 */
	conditional: Map<string, [number, number][]>;
	opaque: boolean;
}
export function bindings(src: string): Bindings | null {
	if (!parser) throw new Error("initShellAst() not awaited");
	const tree = parser.parse(src);
	if (!tree) return null;
	try {
		if (tree.rootNode.hasError) return null;
		const values = new Map<string, Word[] | null>();
		const parsedAssignments = new Map<string, number>();
		const firstAt = new Map<string, number>();
		const conditional = new Map<string, [number, number][]>();
		const add = (name: string, ws: Word[] | null, at: number) => {
			if (!firstAt.has(name)) firstAt.set(name, at);
			const prev = values.get(name);
			values.set(name, prev === null || ws === null ? null : [...(prev ?? []), ...ws]);
		};
		const visit = (n: Node) => {
			if (n.type === "variable_assignment") {
				const nameNode = n.childForFieldName("name");
				const name = nameNode?.type === "variable_name" ? nameNode.text : nameNode?.text.replace(/\[.*$/s, "");
				if (name) {
					parsedAssignments.set(name, (parsedAssignments.get(name) ?? 0) + 1);
					const value = n.childForFieldName("value");
					const append = n.children.some((c) => c.type === "+=");
					// `X=1 cmd "$X"`: a prefix assignment binds X for cmd's environment only; `$X` is the old value.
					const prefix = n.parent?.type === "command";
					if (prefix || nameNode?.type !== "variable_name" || append || value?.type === "array")
						add(name, null, n.startIndex);
					else {
						add(name, [value ? word(value) : lit("")], n.startIndex);
						if (!certain(n)) {
							// Several conditional bindings: a use is safe only where all of them ran (kept simple: the first's range).
							if (conditional.has(name)) conditional.set(name, []);
							else conditional.set(name, dominated(n));
						}
					}
				}
			} else if (n.type === "for_statement") {
				const name = n.childForFieldName("variable")?.text;
				const ws = n.children.filter((_, i) => n.fieldNameForChild(i) === "value").map(word);
				if (name) add(name, ws.length ? ws : null, n.startIndex);
			} else if (
				n.type === "c_style_for_statement" ||
				n.type === "arithmetic_expansion" ||
				(n.type === "compound_statement" && n.text.startsWith("((")) ||
				(n.type === "expansion" && n.text.startsWith("${!"))
			) {
				opaque = true;
			} else if (n.type === "declaration_command") {
				// `declare -n`, or an operand that isn't a plain assignment (`export "$n=/"`, `export TMP""DIR=/`).
				if (/^\S+\s+-\w*n/.test(n.text)) opaque = true;
				for (const c of n.namedChildren) {
					if (c.type !== "variable_assignment" && c.type !== "variable_name" && /[$`"'\\{]/.test(c.text))
						opaque = true;
					// `local X`, `declare X`: unset or kept, either way not a value the text shows.
					if (c.type === "variable_name") add(c.text, null, n.startIndex);
				}
			} else if (n.type === "command") {
				// A command that binds names its text doesn't spell out: by name (`eval`, `.`, `let`, `builtin export …`), a
				// name that isn't plain text (`\export`, `e{xport,}`), or a name operand that expands (`read "$n"`, `printf -v "$n"`).
				const nameText = n.childForFieldName("name")?.text ?? "";
				const name = nameText.replace(/^.*\//, "");
				// A name written with quotes, escapes, or braces (`\export`, `e{xport,}`, `ex""port`) may spell a binder; one
				// that only expands a variable (`"$T/run.sh"`) is judged by policy.ts as an unknown command name.
				const spelled = nameText.replace(/^"?\$\{?[A-Za-z_]\w*\}?[\w./-]*"?$/, "x");
				if (OPAQUE_BINDERS.has(name) || /["'\\{}$`]/.test(spelled)) opaque = true;
				const args = n.children.filter((_, i) => n.fieldNameForChild(i) === "argument").map((a) => a.text);
				const binds = NAME_BINDERS.has(name) && (name !== "printf" || /^-v/.test(args[0] ?? ""));
				if (binds && args.some((a) => /[$`]/.test(a))) opaque = true;
				// `read X`, `unset X`, `printf -v X`, `getopts o X`: X's value isn't in the text.
				if (binds)
					for (const a of args)
						for (const m of a.matchAll(/(?:^-v)?([A-Za-z_]\w*)$/g)) add(m[1], null, n.startIndex);
			}
			for (const c of n.children) visit(c);
		};
		let opaque = false;
		visit(tree.rootNode);
		for (const name of values.keys()) {
			const n = name.replace(/\W/g, "");
			const textual = src.match(new RegExp(`(?<![\\w$])${n}\\+?=`, "g"))?.length ?? 0;
			const named = new RegExp(
				String.raw`(?:^|[;&|(\s])(?:read|mapfile|readarray|getopts|unset|printf|declare|typeset|local|export|readonly)\b[^;&|\n]*?(?<![\w$])(?:-\w*v)?${n}(?![\w=])`,
			);
			if (textual > (parsedAssignments.get(name) ?? 0) || named.test(src) || SPECIAL_NAMES.has(name))
				values.set(name, null);
		}
		return { values, firstAt, conditional, opaque };
	} finally {
		tree.delete();
	}
}
/**
 * Whether an assignment always runs before what follows it: every ancestor up to the script is a plain sequence, and
 * in an `&&`/`||` list it is the left-most command (`d=$(mktemp -d) && cd "$d"`; not `false && d=x`). Inside `if`,
 * loops, `case`, subshells, pipelines, or functions it may not run, or not in this shell.
 */
function certain(n: Node): boolean {
	let child = n;
	for (let p = n.parent; p; child = p, p = p.parent) {
		if (p.type === "program") return true;
		if (p.type === "declaration_command" || p.type === "redirected_statement" || p.type === "compound_statement")
			continue;
		if (p.type === "list" && p.firstChild?.id === child.id) continue;
		if (misnested(p, child)) continue;
		return false;
	}
	return false;
}

/**
 * Where a conditional assignment has surely run: the right side of each `&&` it is (part of) the left side of, walking
 * up through `&&` lists only (`a && t=x && b` → `b`). Empty under `||`, `if`, loops, or subshells.
 */
function dominated(n: Node): [number, number][] {
	const out: [number, number][] = [];
	let child = n;
	for (let p = n.parent; p; child = p, p = p.parent) {
		if (p.type === "declaration_command" || p.type === "redirected_statement" || misnested(p, child)) continue;
		if (p.type !== "list") break;
		const op = p.children.find((c) => !c.isNamed)?.type;
		const right = p.lastChild;
		if (p.firstChild?.id === child.id && op === "&&" && right) out.push([right.startIndex, right.endIndex]);
		else if (p.firstChild?.id !== child.id && op !== "&&") break;
	}
	return out;
}

/**
 * tree-sitter-bash nests `a && b 2>&1 | c` as `(a && b) 2>&1 | c`; bash binds `|` tighter: `a && (b 2>&1 | c)`. A bare
 * list can't be a pipeline element in bash, so a list met (from its left part) under a pipeline is this mis-nesting,
 * and its left part runs in the current shell.
 */
function misnested(p: Node, child: Node): boolean {
	if (
		child.type !== "list" &&
		!(child.type === "redirected_statement" && child.childForFieldName("body")?.type === "list")
	)
		return false;
	return p.type === "pipeline" || (p.type === "redirected_statement" && child.type === "list");
}

// Names bash itself sets (`cd` sets PWD and OLDPWD) or whose value changes word splitting or lookup.
const SPECIAL_NAMES = new Set([
	"PWD",
	"OLDPWD",
	"IFS",
	"HOME",
	"PATH",
	"CDPATH",
	"BASH_ENV",
	"ENV",
	"SHELLOPTS",
	"BASHOPTS",
	"GLOBIGNORE",
]);
// Bash features that can bind a name the text doesn't spell out.
const OPAQUE_BINDERS = new Set(["eval", "source", ".", "let", "builtin", "command", "enable", "alias"]);
// Commands whose operands name variables they bind (`read X`, `printf -v X`); an expanding operand hides the name.
const NAME_BINDERS = new Set(["read", "mapfile", "readarray", "getopts", "printf", "unset"]);

/** Every simple command in `src`, including ones unwrapped from wrappers and re-parsed strings; null fails closed. */
export function commands(src: string): SimpleCommand[] | null {
	if (!parser) throw new Error("initShellAst() not awaited");
	try {
		const out: SimpleCommand[] = [];
		currentAt = 0;
		parseScript(src, [], false, 0, out);
		return out;
	} catch (e) {
		if (e instanceof Bail) return null;
		throw e;
	}
}

function parseScript(src: string, via: string[], remote: boolean, depth: number, out: SimpleCommand[]): void {
	if (src.length > LIMITS.maxSource || depth > LIMITS.maxDepth) throw new Bail();
	let tree = parser!.parse(src);
	if (!tree) throw new Bail();
	// tree-sitter-bash 0.25.1 rejects a redirect after a heredoc opener (`cmd <<'EOF' 2>&1 | tail`), which bash accepts.
	// Moving fd redirects before the `<<` keeps bash's meaning (the heredoc is fd 0); used only if that then parses.
	if (tree.rootNode.hasError) {
		const moved = src.replace(
			HEREDOC_THEN_REDIRECTS,
			(_, opener: string, _q, redirs: string) => `${redirs.trim()} ${opener}`,
		);
		const retry = moved !== src ? parser!.parse(moved) : null;
		if (retry && !retry.rootNode.hasError) {
			tree.delete();
			tree = retry;
		} else retry?.delete();
	}
	try {
		if (tree.rootNode.hasError) throw new Bail();
		walk(tree.rootNode, via, remote, depth, out);
	} finally {
		tree.delete();
	}
}

// `<<'EOF' 2>&1 >/dev/null`: an opener followed by fd redirects (`N>&M`, `N>file`, `>>file`, `&>file`).
const HEREDOC_THEN_REDIRECTS =
	/(<<-?[ \t]*(['"]?)\w+\2)((?:[ \t]+(?:\d*>>?&?\d+|\d*>>?[ \t]*[\w./-]+|&>>?[ \t]*[\w./-]+))+)(?=[ \t]*(?:\||&&|\|\||;|$))/gm;

function walk(node: Node, via: string[], remote: boolean, depth: number, out: SimpleCommand[]): void {
	if (node.type === "command") {
		simpleCommand(node, [], via, remote, depth, out);
		return;
	}
	if (node.type === "redirected_statement") {
		const body = node.childForFieldName("body");
		const redirects = node.children.filter((c) => c !== body && isRedirect(c));
		if (body?.type === "command") {
			simpleCommand(body, redirects, via, remote, depth, out);
			return;
		}
		// Extra words after a redirect of a compound command are a syntax error in bash; tree-sitter accepts them.
		for (const r of redirects) if (r.type === "file_redirect" && destinations(r).length > 1) throw new Bail();
	}
	for (const c of node.children) walk(c, via, remote, depth, out);
}

const isRedirect = (n: Node) => ["file_redirect", "heredoc_redirect", "herestring_redirect"].includes(n.type);
const destinations = (r: Node) => r.children.filter((_, i) => r.fieldNameForChild(i) === "destination");

/** One `command` node plus the redirects its `redirected_statement` carries. */
function simpleCommand(
	node: Node,
	outerRedirects: Node[],
	via: string[],
	remote: boolean,
	depth: number,
	out: SimpleCommand[],
): void {
	if (depth === 0) currentAt = node.startIndex;
	const placed: { at: number; end: number; word: Word }[] = [];
	const place = (n: Node) => placed.push({ at: n.startIndex, end: n.endIndex, word: word(n) });
	const redirects: SimpleCommand["redirects"] = [];
	const heredocs: Heredoc[] = [];
	const herestrings: Word[] = [];
	const nested: Node[] = []; // nodes whose own commands run ($(…) in words, assignments, heredoc bodies)
	const redirect = (r: Node) => {
		nested.push(r);
		if (r.type === "file_redirect") {
			const dests = destinations(r);
			const op = r.children.find((c) => !c.isNamed)?.type ?? "?";
			// `>&-`/`<&-` close a descriptor and take no word: tree-sitter lexes `-` into the operator.
			const takes = op === ">&-" || op === "<&-" ? 0 : 1;
			redirects.push({ op, target: takes && dests[0] ? word(dests[0]) : undefined });
			// bash: a redirect takes exactly one word; tree-sitter's `repeat1` swallows the rest, which are arguments.
			for (const d of dests.slice(takes)) place(d);
		} else if (r.type === "herestring_redirect") {
			const w = r.namedChildren.at(-1);
			if (w) herestrings.push(word(w));
			redirects.push({ op: "<<<", target: undefined });
		} else if (r.type === "heredoc_redirect") {
			const start = r.children.find((c) => c.type === "heredoc_start")?.text ?? "";
			const body = r.children.find((c) => c.type === "heredoc_body");
			heredocs.push({ quoted: /["'\\]/.test(start), body: body?.text ?? "" });
			redirects.push({ op: "<<", target: undefined });
			r.children.forEach((c, i) => {
				const field = r.fieldNameForChild(i);
				if (field === "argument") place(c);
				else if (field === "redirect") redirect(c);
			});
		}
	};
	const assignments: string[] = [];
	node.children.forEach((c, i) => {
		const field = node.fieldNameForChild(i);
		if (c.type === "variable_assignment") assignments.push(c.childForFieldName("name")?.text ?? "");
		if (field === "name" || field === "argument") place(c);
		else if (isRedirect(c)) redirect(c);
		if (field !== "redirect" && !isRedirect(c)) nested.push(c);
	});
	for (const r of outerRedirects) redirect(r);
	// tree-sitter drops some words without an ERROR node (`git commit -F - <<EOF`: the `-` is in no node). Any
	// non-blank source text between this command's nodes is taken back as a word if plain, else fails closed.
	const spans = [...node.children, ...outerRedirects].map((c) => [c.startIndex, c.endIndex] as const);
	spans.sort((a, b) => a[0] - b[0]);
	const src = node.tree.rootNode.text;
	for (let i = 1; i < spans.length; i++) {
		const gap = src.slice(spans[i - 1][1], spans[i][0]);
		for (const m of gap.replace(/\\\n/g, "  ").matchAll(/\S+/g)) {
			if (!/^[\w@%+=:,./-]+$/.test(m[0])) throw new Bail();
			const at = spans[i - 1][1] + m.index;
			placed.push({ at, end: at + m[0].length, word: lit(m[0]) });
		}
	}
	placed.sort((a, b) => a.at - b.at);
	// Nodes with no space between them are one bash word (tree-sitter splits `$"…"` into `$` and a string).
	const argv: Word[] = [];
	let prevEnd = -1;
	for (const p of placed) {
		const last = argv.at(-1);
		// `-r\<newline>f` is one word `-rf`: a line continuation joins, tree-sitter splits.
		const glued = p.at === prevEnd || /^(?:\\\n)+$/.test(src.slice(prevEnd, p.at));
		if (last && glued) argv[argv.length - 1] = join(last, p.word);
		else argv.push(p.word);
		prevEnd = p.end;
	}
	// Commands nested in words, assignments, redirect targets, and unquoted heredoc bodies run too.
	for (const n of nested) walk(n, via, remote, depth, out);
	if (depth === 0) currentAt = node.startIndex;
	const flow = depth === 0 ? { certain: certain(node), after: dominated(node) } : { certain: false, after: [] };
	emit(argv, via, remote, depth, out, { redirects, heredocs, herestrings, openArgs: false, assignments, ...flow });
}

interface Stdin {
	assignments: string[];
	redirects: SimpleCommand["redirects"];
	heredocs: Heredoc[];
	herestrings: Word[];
	openArgs: boolean;
	certain: boolean;
	after: [number, number][];
}

function emit(argv: Word[], via: string[], remote: boolean, depth: number, out: SimpleCommand[], io: Stdin): void {
	if (out.length >= LIMITS.maxCommands) throw new Bail();
	if (argv.length === 0) return;
	const name = argv[0].kind === "expansion" ? undefined : argv[0].value.split("/").pop();
	out.push({
		argv,
		name,
		via,
		openArgs: io.openArgs,
		remote,
		redirects: io.redirects,
		heredocs: io.heredocs,
		assignments: io.assignments,
		at: currentAt,
		reparsed: depth > 0,
		certain: io.certain,
		after: io.after,
	});
	if (name === undefined) return;
	for (const step of unwrap(name, argv.slice(1))) {
		const nextVia = [...via, name];
		if (step.kind === "exec")
			emit(step.argv, nextVia, remote || !!step.remote, depth, out, {
				...io,
				openArgs: io.openArgs || !!step.openArgs,
			});
		else if (step.kind === "script") script(step.body, nextVia, remote || !!step.remote, depth, out);
		else if (step.kind === "stdin") {
			// A shell (or ssh) reading its program from stdin: a heredoc or here-string body is that program. An unquoted
			// body is expanded first; its source text is parsed as an approximation (expansions stay expansions).
			const r = remote || !!step.remote;
			for (const h of io.heredocs) parseScript(h.body, nextVia, r, depth + 1, out);
			for (const w of io.herestrings) script([w], nextVia, r, depth, out);
			// No body in sight (`… | bash`, `bash < file`): the program is unknowable here.
			if (!io.heredocs.length && !io.herestrings.length) {
				if (out.length >= LIMITS.maxCommands) throw new Bail();
				out.push({
					argv: [],
					name: undefined,
					via: nextVia,
					openArgs: false,
					remote: r,
					dynamicBody: "<stdin>",
					redirects: [],
					heredocs: [],
					assignments: [],
					at: currentAt,
					reparsed: depth > 0,
					certain: false,
					after: [],
				});
			}
		}
	}
}

/** Re-parses a command string made of words joined by spaces; a non-literal word makes it dynamic. */
function script(words: Word[], via: string[], remote: boolean, depth: number, out: SimpleCommand[]): void {
	if (words.some((w) => w.kind === "expansion")) {
		if (out.length >= LIMITS.maxCommands) throw new Bail();
		out.push({
			argv: words,
			name: undefined,
			via,
			openArgs: false,
			remote,
			dynamicBody: words.map((w) => w.raw).join(" "),
			redirects: [],
			heredocs: [],
			assignments: [],
			at: currentAt,
			reparsed: depth > 0,
			certain: false,
			after: [],
		});
		return;
	}
	parseScript(words.map((w) => w.value).join(" "), via, remote, depth + 1, out);
}

// ---------------------------------------------------------------------------------------------------------------
// Words

const GLOB = /[*?[]/;
const BRACE = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

export function word(node: Node): Word {
	const pieces: { text: string; quoted: boolean; expansion: boolean; tmpdir: boolean }[] = [];
	collect(node, pieces);
	const unquoted = pieces
		.filter((p) => !p.quoted && !p.expansion)
		.map((p) => p.text)
		.join("");
	const first = pieces[0];
	const globby = pieces.some((p) => !p.quoted && !p.expansion && GLOB.test(p.text));
	const tilde = first !== undefined && !first.quoted && !first.expansion && first.text.startsWith("~");
	const brace = node.type === "brace_expression" || BRACE.test(unquoted) || hasBraceAcross(pieces);
	const expansions = pieces.filter((p) => p.expansion);
	const value = pieces.map((p) => p.text).join("");
	const kind: WordKind =
		expansions.length || globby || tilde || brace ? "expansion" : pieces.some((p) => p.quoted) ? "quoted" : "literal";
	const tmpdirOnly =
		kind === "expansion" && !globby && !tilde && !brace && expansions.length === 1 && first?.tmpdir === true;
	return { value, kind, raw: node.text, tmpdirOnly };
}

const RANK: Record<WordKind, number> = { literal: 0, quoted: 1, expansion: 2 };
function join(a: Word, b: Word): Word {
	// `$"…"` is a locale-translated string: the `$` disappears.
	const aValue = a.raw === "$" && b.raw.startsWith('"') ? "" : a.value;
	const aKind = aValue === "" ? "literal" : a.kind;
	return {
		value: aValue + b.value,
		kind: RANK[aKind] >= RANK[b.kind] ? aKind : b.kind,
		raw: a.raw + b.raw,
		tmpdirOnly: aValue === "" ? b.tmpdirOnly : a.tmpdirOnly && b.kind !== "expansion",
	};
}

// `a{b,c}` parses as word `a`, word `{`, word `b,c`, word `}`: check the unquoted text joined in order.
function hasBraceAcross(pieces: { text: string; quoted: boolean; expansion: boolean }[]): boolean {
	return BRACE.test(pieces.map((p) => (p.quoted || p.expansion ? "\0" : p.text)).join(""));
}

const TMPDIR_REF = "${TMPDIR:?}";

function collect(n: Node, out: { text: string; quoted: boolean; expansion: boolean; tmpdir: boolean }[]): void {
	const piece = (text: string, quoted: boolean, expansion = false, tmpdir = false) =>
		out.push({ text, quoted, expansion, tmpdir });
	switch (n.type) {
		case "command_name":
		case "concatenation":
			for (const c of n.children) collect(c, out);
			return;
		case "word":
		case "number":
			if (n.childCount > 0) {
				piece(n.text, false, true);
				return;
			}
			piece(unescapeBare(n.text), false);
			return;
		case "raw_string":
			piece(n.text.slice(1, -1), true);
			return;
		case "ansi_c_string":
			piece(ansiC(n.text.slice(2, -1)), true);
			return;
		case "string":
		case "translated_string": {
			// Text between the quotes is content except the expansions; read it from the source, because tree-sitter
			// sometimes folds content into the closing-quote token (`" "` gives tokens `"` and ` "`).
			const text = n.text;
			const base = n.startIndex;
			const before = out.length;
			let at = n.type === "translated_string" ? 2 : 1;
			const end = text.length - 1;
			for (const c of n.namedChildren) {
				if (c.type === "string_content") continue;
				const s = c.startIndex - base;
				if (s > at) piece(dqUnescape(text.slice(at, s)), true);
				piece(c.text, true, true, c.text === TMPDIR_REF);
				at = c.endIndex - base;
			}
			if (end > at) piece(dqUnescape(text.slice(at, end)), true);
			// An empty string (`""`) still marks the word quoted.
			if (out.length === before) piece("", true);
			return;
		}
		case "expansion":
			piece(n.text, false, true, n.text === TMPDIR_REF);
			return;
		default:
			// simple_expansion, command_substitution, arithmetic_expansion, process_substitution, brace_expression,
			// and anything unrecognised: not literal.
			piece(n.text, false, true);
	}
}

// Unquoted text: `\<newline>` disappears, `\x` is `x`.
const unescapeBare = (s: string) => s.replace(/\\\n/g, "").replace(/\\(.)/gs, "$1");
// Double-quoted text: backslash escapes only `$`, `` ` ``, `"`, `\`, and newline.
const dqUnescape = (s: string) => s.replace(/\\\n/g, "").replace(/\\([$`"\\])/g, "$1");

function ansiC(s: string): string {
	const simple: Record<string, string> = {
		a: "\x07",
		b: "\b",
		e: "\x1b",
		E: "\x1b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
		v: "\v",
		"\\": "\\",
		"'": "'",
		'"': '"',
		"?": "?",
	};
	return s.replace(
		/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs,
		(_, e: string) =>
			simple[e] ??
			(/^x/i.test(e) || /^u/i.test(e)
				? String.fromCodePoint(Number.parseInt(e.slice(1), 16))
				: /^[0-7]/.test(e)
					? String.fromCharCode(Number.parseInt(e, 8) & 0xff)
					: e[0] === "c"
						? String.fromCharCode(e.charCodeAt(1) & 0x1f)
						: `\\${e}`),
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Wrappers: commands that run another command from their arguments. Each entry parses options like the real tool.

export type Step =
	| { kind: "exec"; argv: Word[]; openArgs?: boolean; remote?: boolean }
	| { kind: "script"; body: Word[]; remote?: boolean }
	| { kind: "stdin"; remote?: boolean };

interface OptionSpec {
	/** Short option letters that take a value (`-u root`, `-uroot`). */
	short?: string;
	/** Long options that take a value (`--user root`, `--user=root`). */
	long?: string[];
	/** Treat `-<digits>` as a flag (`nice -5`). */
	numericFlags?: boolean;
}

/** Skips options from `i`; returns the index of the first operand and the options seen (letter or long name → value). */
function options(args: Word[], i: number, spec: OptionSpec): { at: number; seen: Map<string, Word | true> } {
	const seen = new Map<string, Word | true>();
	while (i < args.length) {
		const w = args[i].value;
		if (args[i].kind === "expansion" || !w.startsWith("-") || w === "-") break;
		if (w === "--") return { at: i + 1, seen };
		if (w.startsWith("--")) {
			const [name, value] = w.split(/=(.*)/s);
			if (value === undefined && spec.long?.includes(name)) {
				seen.set(name, args[i + 1] ?? true);
				i += 2;
			} else {
				seen.set(name, value !== undefined ? lit(value) : true);
				i++;
			}
			continue;
		}
		if (spec.numericFlags && /^-\d+$/.test(w)) {
			seen.set(w, true);
			i++;
			continue;
		}
		let consumed = 1;
		for (let j = 1; j < w.length; j++) {
			const letter = w[j];
			if (spec.short?.includes(letter)) {
				if (j + 1 < w.length) seen.set(letter, lit(w.slice(j + 1)));
				else {
					seen.set(letter, args[i + 1] ?? true);
					consumed = 2;
				}
				break;
			}
			seen.set(letter, true);
		}
		i += consumed;
	}
	return { at: i, seen };
}

const lit = (value: string): Word => ({ value, kind: "literal", raw: value, tmpdirOnly: false });
const execFrom = (args: Word[], at: number, extra: Partial<Extract<Step, { kind: "exec" }>> = {}): Step[] =>
	at < args.length ? [{ kind: "exec", argv: args.slice(at), ...extra }] : [];
// `NAME=value` operands (`env PATH="$PATH" node`): the name decides, the value may expand.
const skipAssignments = (args: Word[], at: number) => {
	while (at < args.length && /^[A-Za-z_]\w*=/.test(args[at].raw)) at++;
	return at;
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);

/** A shell's `-c` string, a script file, or stdin. `bash -lc 'x'`, `bash -o pipefail -c 'x'`, `bash --norc -c 'x'`. */
function shell(args: Word[]): Step[] {
	let i = 0;
	let c = false;
	while (i < args.length) {
		const w = args[i].value;
		// An unquoted expansion could split into options (`bash $opts`); a quoted one is a word: the -c string or a file.
		if (args[i].kind === "expansion" && !/^"[^"]*"$/.test(args[i].raw)) return [{ kind: "script", body: [args[i]] }];
		if (args[i].kind === "expansion") break;
		// `bash --version`, `bash -n f` (syntax check only) run nothing.
		if (w === "--version" || w === "--help" || /^-[A-Za-z]*n[A-Za-z]*$/.test(w)) return [];
		if (w === "--" || w === "-") {
			i++;
			break;
		}
		if (/^[-+]o$/.test(w) || ["--rcfile", "--init-file"].includes(w)) i += 2;
		else if (/^[-+][A-Za-z]+$/.test(w)) {
			if (w.startsWith("-") && w.includes("c")) c = true;
			i++;
		} else if (w.startsWith("--")) i++;
		else break;
	}
	if (c) return i < args.length ? [{ kind: "script", body: [args[i]] }] : [];
	return i < args.length ? [] : [{ kind: "stdin" }];
}

export const WRAPPERS: Record<string, (args: Word[]) => Step[]> = {
	sudo: (args) => {
		const { at, seen } = options(args, 0, {
			short: "ughpCDrtUTR",
			long: [
				"--user",
				"--group",
				"--host",
				"--prompt",
				"--close-from",
				"--chdir",
				"--role",
				"--type",
				"--other-user",
				"--command-timeout",
				"--chroot",
			],
		});
		if (seen.has("e") || seen.has("--edit") || seen.has("l") || seen.has("--list")) return [];
		const start = skipAssignments(args, at);
		// `sudo -s cmd …` / `sudo -i cmd …` hand the words to a shell's `-c`.
		if (seen.has("s") || seen.has("i") || seen.has("--shell") || seen.has("--login"))
			return start < args.length ? [{ kind: "script", body: args.slice(start) }] : [{ kind: "stdin" }];
		return execFrom(args, start);
	},
	doas: (args) => {
		const { at, seen } = options(args, 0, { short: "uC" });
		if (seen.has("C")) return [];
		if (seen.has("s")) return [{ kind: "stdin" }];
		return execFrom(args, at);
	},
	su: (args) => suLike(args, false),
	runuser: (args) => suLike(args, true),
	pkexec: (args) => execFrom(args, options(args, 0, { long: ["--user"] }).at),
	env: (args) => {
		const { at, seen } = options(args, 0, {
			short: "uCPS",
			long: ["--unset", "--chdir", "--split-string", "--default-signal", "--ignore-signal", "--block-signal"],
		});
		const split = seen.get("S") ?? seen.get("--split-string");
		const start = skipAssignments(args, at);
		if (split && split !== true) return [{ kind: "script", body: [split, ...args.slice(start)] }];
		return execFrom(args, start);
	},
	timeout: (args) => {
		const { at } = options(args, 0, { short: "sk", long: ["--signal", "--kill-after"] });
		return execFrom(args, at + 1); // the duration
	},
	gtimeout: (args) => WRAPPERS.timeout(args),
	nice: (args) => execFrom(args, options(args, 0, { short: "n", long: ["--adjustment"], numericFlags: true }).at),
	nohup: (args) => execFrom(args, options(args, 0, {}).at),
	time: (args) => execFrom(args, options(args, 0, { short: "of", long: ["--output", "--format"] }).at),
	command: (args) => {
		const { at, seen } = options(args, 0, {});
		return seen.has("v") || seen.has("V") ? [] : execFrom(args, at);
	},
	exec: (args) => execFrom(args, options(args, 0, { short: "a" }).at),
	builtin: (args) => execFrom(args, 0),
	stdbuf: (args) => execFrom(args, options(args, 0, { short: "ioe", long: ["--input", "--output", "--error"] }).at),
	setsid: (args) => execFrom(args, options(args, 0, {}).at),
	ionice: (args) => execFrom(args, options(args, 0, { short: "cnpPu", long: ["--class", "--classdata"] }).at),
	caffeinate: (args) => execFrom(args, options(args, 0, { short: "tw" }).at),
	unbuffer: (args) => execFrom(args, options(args, 0, {}).at),
	rtk: (args) => execFrom(args, args[0]?.value === "proxy" ? 1 : 0),
	xargs: (args) =>
		execFrom(
			args,
			options(args, 0, {
				short: "ILnPsdEaJRS",
				long: ["--max-args", "--max-lines", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--replace"],
			}).at,
			{ openArgs: true },
		),
	find: (args) => {
		const steps: Step[] = [];
		for (let i = 0; i < args.length; i++) {
			if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i].value)) continue;
			const end = args.findIndex((w, j) => j > i && (w.value === ";" || w.value === "+"));
			const stop = end < 0 ? args.length : end;
			steps.push(...execFrom(args.slice(0, stop), i + 1, { openArgs: true }));
			i = stop;
		}
		return steps;
	},
	flock: (args) => {
		const { at, seen } = options(args, 0, { short: "wEc", long: ["--timeout", "--conflict-exit-code", "--command"] });
		const c = seen.get("c") ?? seen.get("--command");
		if (c && c !== true) return [{ kind: "script", body: [c] }];
		return execFrom(args, at + 1); // the lock file
	},
	eval: (args) => (args.length ? [{ kind: "script", body: args }] : []),
	trap: (args) => {
		const { at, seen } = options(args, 0, {});
		if (seen.has("p") || seen.has("l")) return [];
		// `trap ACTION SIG…`; a single operand resets that signal.
		return args.length - at >= 2 && args[at].value !== "-" ? [{ kind: "script", body: [args[at]] }] : [];
	},
	watch: (args) => {
		const { at, seen } = options(args, 0, { short: "nq", long: ["--interval", "--equexit", "--differences"] });
		if (at >= args.length) return [];
		return seen.has("x") || seen.has("--exec")
			? [{ kind: "exec", argv: args.slice(at), remote: true }]
			: [{ kind: "script", body: args.slice(at), remote: true }];
	},
	ssh: (args) => {
		const { at } = options(args, 0, { short: "BbcDEeFIiJLlmOopQRSWw" });
		const rest = args.slice(at + 1); // the host
		return rest.length ? [{ kind: "script", body: rest, remote: true }] : [{ kind: "stdin", remote: true }];
	},
};
for (const name of SHELLS) WRAPPERS[name] = shell;

/** `su [-] [user] -c CMD` / `runuser -u user -- cmd …` (GNU getopt permutes, so `-c` may follow the user). */
function suLike(args: Word[], runuser: boolean): Step[] {
	for (let i = 0; i < args.length; i++) {
		const w = args[i].value;
		if (w === "--") break;
		const glued = /^--(?:session-)?command=(.*)$/s.exec(w);
		if (glued) return [{ kind: "script", body: [lit(glued[1])] }];
		if (w === "--command" || w === "--session-command")
			return args[i + 1] ? [{ kind: "script", body: [args[i + 1]] }] : [];
		// A short cluster with `c` (`-c`, `-lc`, `-cCMD`): the command is the rest of the cluster, or the next word.
		if (/^-[A-Za-z]*c/.test(w) && !w.startsWith("--")) {
			const rest = w.slice(w.indexOf("c") + 1);
			if (rest) return [{ kind: "script", body: [lit(rest)] }];
			return args[i + 1] ? [{ kind: "script", body: [args[i + 1]] }] : [];
		}
	}
	if (!runuser) return [];
	const { at, seen } = options(args, 0, { short: "ugGsw", long: ["--user", "--group", "--supp-group", "--shell"] });
	return seen.has("u") || seen.has("--user") ? execFrom(args, at) : [];
}

function unwrap(name: string, args: Word[]): Step[] {
	return Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name](args) : [];
}
