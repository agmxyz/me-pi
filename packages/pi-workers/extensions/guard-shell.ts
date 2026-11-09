/**
 * Bash parsing for guard: the one owner of tree-sitter loading and of reading a command string the way bash would.
 * `await initShell()` once; then `parseShell(src)` is synchronous and reports an unloaded grammar, a syntax error,
 * or a hit limit as `{ ok: false }` (callers fail closed) instead of throwing.
 *
 * The parser only finds words; guard decides. Each argv word is tagged:
 * - `literal`: unquoted text with no expansion (escapes decoded: `\-r` is `-r`, `\<newline>` vanishes);
 * - `quoted`: quoted text, possibly joined with literal text, with no expansion (`'a'"b"c`, `$'\t'`);
 * - `expansion`: anything bash would expand (`$x`, `${x}`, `$(…)`, `` `…` ``, `$((…))`, `<(…)`, globs, `~`, braces);
 *   `value` then keeps the expansion's source text.
 *
 * tree-sitter-bash 0.25.1 misreads some bash; each workaround below says which misread it undoes.
 */

import { readFile } from "node:fs/promises";
// Types only: the runtime is imported inside `load`, so a missing or broken dependency is a load failure guard can
// fall back from, not a module that fails to import (which would take guard, and anything importing it, down).
import type { Node, Parser, Tree } from "web-tree-sitter";

export type WordKind = "literal" | "quoted" | "expansion";
export interface Word {
	value: string;
	kind: WordKind;
	/** The word's source text. */
	raw: string;
}

export interface Heredoc {
	body: string;
	/** The body's source range in the top-level script; only on top-level commands (see `ParsedShell.exact`). */
	span?: [number, number];
	/** The delimiter is quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`): bash expands nothing in the body. */
	literal?: boolean;
}

export interface Redirect {
	op: string;
	/** The redirect's one word; undefined for heredocs, here-strings, and `>&-`/`<&-`. */
	target: Word | undefined;
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
	/** A command string or stdin whose text isn't known (`bash -c "$X"`, `eval "$cmd"`, `… | bash`: `"<stdin>"`). */
	dynamicBody?: string;
	redirects: Redirect[];
	heredocs: Heredoc[];
	/** `NAME=value` prefixes on this command (`GIT_DIR=x git …`), by name. */
	assignments: string[];
	/** Source offset of the top-level command this one came from (a re-parsed string takes its command's offset). */
	at: number;
	/** Source range of that top-level command node (`at` to its end; a re-parsed string takes its command's range). */
	span: [number, number];
	/** Each argv word's source range, for a top-level command emitted as written (not unwrapped, not re-parsed). */
	argvSpans?: [number, number][];
	/** Found by re-parsing a string (`sh -c`, `eval`, `trap`, a heredoc or here-string body): its words aren't the outer
	 * command's text, so the outer command's variable bindings don't apply to them. */
	reparsed: boolean;
	/** The source text this command was parsed from (`src`, or the re-parsed string). */
	script: string;
	/** Runs whenever the script runs, in this shell (a top-level sequence item, or the left-most of an `&&`/`||` list). */
	certain: boolean;
	/** Source ranges that run only after this command succeeded (the rest of its `&&` chain). */
	after: [number, number][];
	/**
	 * May run out of text order: inside a function body (it runs at each call, possibly after later commands), a loop
	 * body (a second pass runs after the rest of the body), or a `trap` string (at a signal or exit). Any state another
	 * command in the script sets may apply to it.
	 */
	outOfOrder: boolean;
}

/**
 * Shell variables the top-level script assigns, with every value each could hold: each `NAME=value` (plain, `export`,
 * `local`) and each `for NAME in …` word. A name maps to null when its value can't be known from the text: a prefix
 * assignment, an array or `+=`, a `for` without `in`, `read`/`mapfile`/`getopts`/`printf -v`/`unset` naming it, a
 * name bash sets itself (`PWD`, `IFS`, …), or more `NAME=` in the text than parsed assignments (one inside a `trap` or
 * `eval` string).
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
	/** The script can bind names its text doesn't show (`eval`, `source`, `.`, `((…))`, `let`, `declare -n`, `${!x}`):
	 * then nothing resolves. */
	opaque: boolean;
}

export type ShellFailure = { ok: false; reason: "not-loaded" | "syntax" | "limit" };
export type ParsedShell =
	| {
			ok: true;
			/** Every simple command, including ones unwrapped from wrappers and re-parsed strings, in source order. */
			commands: SimpleCommand[];
			bindings: Bindings;
			/** Whether any parsed text may rebind TMPDIR (see `tmpdirRebinds`). */
			rebindsTmpdir: boolean;
			/** Source ranges of the top-level script's comments. */
			comments: [number, number][];
			/**
			 * Source ranges of values in plain `NAME=value` statements (not a prefix, not `export`/`local`) that run nothing
			 * themselves (no `$(…)`, backquotes, or `<(…)`): the value is data; where it is used, the bindings carry it.
			 */
			data: [number, number][];
			/**
			 * Whether the top-level offsets (`span`, `argvSpans`, heredoc `span`, `comments`) are offsets into `src`: false when
			 * it parsed only after `parseTree` moved redirects.
			 */
			exact: boolean;
	  }
	| ShellFailure;

const LIMITS = { maxSource: 100_000, maxDepth: 6, maxCommands: 5_000 };
const DEFAULT_WASM = new URL("../vendor/tree-sitter-bash.wasm", import.meta.url);

let parser: Parser | undefined;
let runtimeReady = false;
let loading: Promise<void> | undefined;

/**
 * Loads web-tree-sitter and the bash grammar (default: the vendored one). Resolves at once when loaded; concurrent calls
 * share one load. Rejects on a missing or broken grammar or runtime (`runtime` is the module to import; tests pass a
 * missing one) and stays unloaded, so a later call may retry.
 */
export async function initShell(wasm: URL | string = DEFAULT_WASM, runtime = "web-tree-sitter"): Promise<void> {
	if (parser) return;
	loading ??= load(wasm, runtime).finally(() => {
		loading = undefined;
	});
	await loading;
}

async function load(wasm: URL | string, runtime: string): Promise<void> {
	try {
		const { Language, Parser } = await import(runtime);
		const bytes = await readFile(wasm);
		if (!runtimeReady) {
			await Parser.init();
			runtimeReady = true;
		}
		const bash = await Language.load(bytes);
		const p = new Parser();
		p.setLanguage(bash);
		parser = p;
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		throw new Error(`guard-shell: cannot load the bash parser (${runtime}, ${String(wasm)}): ${why}`, {
			cause: error,
		});
	}
}

class ShellFail extends Error {
	reason: "syntax" | "limit";
	constructor(reason: "syntax" | "limit") {
		super(reason);
		this.reason = reason;
	}
}

/** State of one `parseShell` walk. */
interface Walk {
	out: SimpleCommand[];
	/** Offset of the top-level command being walked; commands found in re-parsed strings take it. */
	at: number;
	/** Its source range. */
	span: [number, number];
	/** Comments, data values, and offset exactness of the top-level script (set by its parse). */
	comments?: [number, number][];
	data?: [number, number][];
	exact?: boolean;
	/** The source text being walked (the top-level script or a re-parsed string). */
	script: string;
	rebinds: boolean;
	bindings: Bindings | undefined;
	/** Walking inside a function body or loop (see `OUT_OF_ORDER`). */
	outOfOrder?: boolean;
}
/** Where a command was found: the wrappers around it, whether it runs remotely, and its re-parse depth. */
interface Frame {
	via: string[];
	remote: boolean;
	depth: number;
	/** Inside a `trap` string (or another body that runs out of text order). */
	outOfOrder?: boolean;
}

/** Parses a bash command string into its simple commands and top-level bindings. */
export function parseShell(src: string): ParsedShell {
	if (!parser) return { ok: false, reason: "not-loaded" };
	const w: Walk = { out: [], at: 0, span: [0, 0], script: src, rebinds: false, bindings: undefined };
	try {
		parseScript(w, src, { via: [], remote: false, depth: 0 });
		return {
			ok: true,
			commands: w.out,
			bindings: w.bindings!,
			rebindsTmpdir: w.rebinds,
			comments: w.comments ?? [],
			data: w.data ?? [],
			exact: w.exact ?? false,
		};
	} catch (error) {
		if (error instanceof ShellFail) return { ok: false, reason: error.reason };
		throw error;
	}
}

/**
 * Whether TMPDIR may be rebound before or while the command runs (guard-policy decision 3): an assignment to it (plain,
 * prefix, `+=`, array, `export`, `declare`/`local`/`typeset`/`readonly`), `unset`, `read`/`mapfile`/`readarray`/
 * `getopts`/`printf -v` naming it, `env` with an option or `TMPDIR=…`, a privilege wrapper (`sudo`, `doas`, `su`,
 * `runuser`, `pkexec`), or anything whose target the text doesn't show: an assignment or binder operand that isn't a
 * plain name (`${z}=1`, `a[z]=1`, `export "$n"=/`, `TMP""DIR=/`), `source`/`.`, `eval`, `((…))`/`let`, `declare -n`,
 * `${!x}`, or a command name that is spelled (`\export`, `e{xport,}`) or expands. Every re-parsed string counts too.
 * True when the text can't be parsed (including an unloaded grammar): unknown fails closed.
 */
export function tmpdirRebinds(src: string): boolean {
	const r = parseShell(src);
	return r.ok ? r.rebindsTmpdir : true;
}

/** Whether `name` runs another command from its arguments (`sudo`, `env`, `xargs`, a shell, …). */
export function isWrapper(name: string): boolean {
	return Object.hasOwn(WRAPPERS, name);
}

export const SHELLS: ReadonlySet<string> = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"mksh",
	"ash",
	"csh",
	"tcsh",
	"fish",
	"oksh",
	"yash",
	"posh",
]);

// ---------------------------------------------------------------------------------------------------------------
// Parsing and walking

// `<<'EOF' 2>&1 >/dev/null`: an opener followed by fd redirects (`N>&M`, `N>file`, `>>file`, `&>file`).
const HEREDOC_THEN_REDIRECTS =
	/(<<-?[ \t]*(['"]?)\w+\2)((?:[ \t]+(?:\d*>>?&?\d+|\d*>>?[ \t]*[\w./-]+|&>>?[ \t]*[\w./-]+))+)(?=[ \t]*(?:\||&&|\|\||;|$))/gm;

/**
 * Parses `src`; null on a parse error. tree-sitter-bash rejects a redirect after a heredoc opener
 * (`cmd <<'EOF' 2>&1 | tail`), which bash accepts: moving the fd redirects before the `<<` keeps bash's meaning (the
 * heredoc is fd 0), and is used only if that then parses. The offsets of such a retry are of the moved text, which
 * differs from `src` only inside the opener line.
 */
function parseTree(src: string): { tree: Tree; moved: boolean } | null {
	const p = parser!;
	const tree = p.parse(src);
	if (!tree) return null;
	if (!tree.rootNode.hasError) return { tree, moved: false };
	tree.delete();
	const moved = src.replace(
		HEREDOC_THEN_REDIRECTS,
		(_, opener: string, _quote: string, redirs: string) => `${redirs.trim()} ${opener}`,
	);
	if (moved === src) return null;
	const retry = p.parse(moved);
	if (retry && !retry.rootNode.hasError) return { tree: retry, moved: true };
	retry?.delete();
	return null;
}

function parseScript(w: Walk, src: string, f: Frame): void {
	if (src.length > LIMITS.maxSource || f.depth > LIMITS.maxDepth) throw new ShellFail("limit");
	const parsed = parseTree(src);
	if (!parsed) throw new ShellFail("syntax");
	const { tree } = parsed;
	if (w.exact === undefined) {
		w.exact = !parsed.moved;
		w.comments = [];
		w.data = [];
		const comments = (n: Node): void => {
			if (n.type === "comment") w.comments!.push([n.startIndex, n.endIndex]);
			const value = n.type === "variable_assignment" ? n.childForFieldName("value") : null;
			if (value && n.parent?.type !== "command" && n.parent?.type !== "declaration_command" && !runsCode(value))
				w.data!.push([value.startIndex, value.endIndex]);
			for (const c of n.children) comments(c);
		};
		comments(tree.rootNode);
	}
	const outer = w.script;
	w.script = src;
	try {
		// The first text parsed is the top-level script; bindings are read from it only.
		w.bindings ??= readBindings(tree.rootNode, src);
		if (!w.rebinds) w.rebinds = rebindsTmpdir(tree.rootNode);
		walk(w, tree.rootNode, f);
	} finally {
		w.script = outer;
		tree.delete();
	}
}

/** Whether a node contains a command or process substitution (code that runs when it is expanded). */
function runsCode(n: Node): boolean {
	if (n.type === "command_substitution" || n.type === "process_substitution") return true;
	return n.children.some(runsCode);
}

const isRedirect = (n: Node) =>
	n.type === "file_redirect" || n.type === "heredoc_redirect" || n.type === "herestring_redirect";
const destinations = (r: Node) => r.children.filter((_, i) => r.fieldNameForChild(i) === "destination");

function walk(w: Walk, node: Node, f: Frame): void {
	if (node.type === "command") {
		simpleCommand(w, node, [], f);
		return;
	}
	if (node.type === "redirected_statement") {
		const body = node.childForFieldName("body");
		const redirects = node.children.filter((c) => c.id !== body?.id && isRedirect(c));
		if (body?.type === "command") {
			simpleCommand(w, body, redirects, f);
			return;
		}
		// `a && cat > f <<EOF`: tree-sitter puts the redirects on the list; bash gives them to its last command.
		let last = body;
		while (last?.type === "list") last = last.lastNamedChild;
		if (body?.type === "list" && last?.type === "command") {
			const target = last;
			const inner = (n: Node): void => {
				if (n.id === target.id) simpleCommand(w, n, redirects, f);
				else if (n.type === "command") simpleCommand(w, n, [], f);
				else if (n.type === "list") for (const c of n.children) inner(c);
				else walk(w, n, f);
			};
			inner(body);
			return;
		}
		// Extra words after a redirect of a compound command are a syntax error in bash; tree-sitter accepts them.
		for (const r of redirects)
			if (r.type === "file_redirect" && destinations(r).length > 1) throw new ShellFail("syntax");
	}
	if (OUT_OF_ORDER.has(node.type) && !w.outOfOrder) {
		w.outOfOrder = true;
		try {
			for (const c of node.children) walk(w, c, f);
		} finally {
			w.outOfOrder = false;
		}
		return;
	}
	for (const c of node.children) walk(w, c, f);
}

interface Io {
	assignments: string[];
	redirects: Redirect[];
	heredocs: Heredoc[];
	herestrings: Word[];
	openArgs: boolean;
	/** Under `xargs -I R` / `find -exec`: the text replaced by run-time input in the command (`{}`). */
	placeholder?: string;
	certain: boolean;
	after: [number, number][];
	/** The written command's argv word ranges (top level only; see `SimpleCommand.argvSpans`). */
	argvSpans?: [number, number][];
}

/** One `command` node plus the redirects its `redirected_statement` carries. */
function simpleCommand(w: Walk, node: Node, outerRedirects: Node[], f: Frame): void {
	const top = (): void => {
		if (f.depth !== 0) return;
		w.at = node.startIndex;
		const ends = [node.endIndex, ...outerRedirects.map((r) => r.endIndex)];
		w.span = [node.startIndex, Math.max(...ends)];
	};
	top();
	const placed: { at: number; end: number; word: Word }[] = [];
	const place = (n: Node) => {
		placed.push({ at: n.startIndex, end: n.endIndex, word: word(n) });
	};
	const redirects: Redirect[] = [];
	const heredocs: Heredoc[] = [];
	const herestrings: Word[] = [];
	const nested: Node[] = []; // nodes whose own commands run ($(…) in words, assignments, unquoted heredoc bodies)
	const redirect = (r: Node): void => {
		nested.push(r);
		if (r.type === "file_redirect") {
			const dests = destinations(r);
			const op = r.children.find((c) => !c.isNamed)?.type ?? "?";
			// `>&-`/`<&-` close a descriptor and take no word: tree-sitter lexes `-` into the operator, then attaches the
			// next word as the destination (`rm -rf src 2>&- /Users` read as rm `-rf src`).
			const takes = op === ">&-" || op === "<&-" ? 0 : 1;
			redirects.push({ op, target: takes && dests[0] ? word(dests[0]) : undefined });
			// bash: a redirect takes exactly one word; tree-sitter's `repeat1` swallows the rest, which are arguments
			// (`rm -rf src 2>&1 /Users`).
			for (const d of dests.slice(takes)) place(d);
		} else if (r.type === "herestring_redirect") {
			const hs = r.namedChildren.at(-1);
			if (hs) herestrings.push(word(hs));
			redirects.push({ op: "<<<", target: undefined });
		} else if (r.type === "heredoc_redirect") {
			const body = r.children.find((c) => c.type === "heredoc_body");
			const start = r.children.find((c) => c.type === "heredoc_start")?.text ?? "";
			heredocs.push({
				body: body?.text ?? "",
				...(f.depth === 0 && body
					? { span: [body.startIndex, body.endIndex] as [number, number], literal: /["'\\]/.test(start) }
					: {}),
			});
			redirects.push({ op: "<<", target: undefined });
			const kids = r.children;
			for (let i = 0; i < kids.length; i++) {
				const field = r.fieldNameForChild(i);
				if (field === "argument") place(kids[i]);
				else if (field === "redirect") redirect(kids[i]);
			}
		}
	};
	const assignments: string[] = [];
	const kids = node.children;
	for (let i = 0; i < kids.length; i++) {
		const c = kids[i];
		const field = node.fieldNameForChild(i);
		if (c.type === "variable_assignment") assignments.push(c.childForFieldName("name")?.text ?? "");
		if (field === "name" || field === "argument") place(c);
		else if (isRedirect(c)) redirect(c);
		if (field !== "redirect" && !isRedirect(c)) nested.push(c);
	}
	for (const r of outerRedirects) redirect(r);
	// tree-sitter drops some words without an ERROR node (`git commit -F - <<EOF`: the `-` is in no node). Non-blank
	// source text between this command's nodes is taken back as a word if plain, else fails closed.
	const spans = [...kids, ...outerRedirects].map((c) => [c.startIndex, c.endIndex] as const);
	spans.sort((a, b) => a[0] - b[0]);
	const text = node.tree.rootNode.text;
	for (let i = 1; i < spans.length; i++) {
		const gap = text.slice(spans[i - 1][1], spans[i][0]);
		for (const m of gap.replace(/\\\n/g, "  ").matchAll(/\S+/g)) {
			if (!/^[\w@%+=:,./-]+$/.test(m[0])) throw new ShellFail("syntax");
			const at = spans[i - 1][1] + m.index;
			placed.push({ at, end: at + m[0].length, word: lit(m[0]) });
		}
	}
	placed.sort((a, b) => a.at - b.at);
	// Nodes with no space between them are one bash word (tree-sitter splits `$"…"` into `$` and a string).
	const argv: Word[] = [];
	const argvSpans: [number, number][] = [];
	let prevEnd = -1;
	for (const p of placed) {
		const last = argv.at(-1);
		// `-r\<newline>f` is one word `-rf`: a line continuation joins, tree-sitter splits.
		const glued = p.at === prevEnd || /^(?:\\\n)+$/.test(text.slice(prevEnd, p.at));
		if (last && glued) {
			argv[argv.length - 1] = join(last, p.word);
			argvSpans[argvSpans.length - 1][1] = p.end;
		} else {
			argv.push(p.word);
			argvSpans.push([p.at, p.end]);
		}
		prevEnd = p.end;
	}
	// Commands nested in words, assignments, redirect targets, and unquoted heredoc bodies run too. A heredoc body is
	// otherwise data (`cat > f <<'EOF'`); only a shell reading stdin re-parses it (see `emit`).
	for (const n of nested) walk(w, n, f);
	top();
	const flow = f.depth === 0 ? { certain: certain(node), after: dominated(node) } : { certain: false, after: [] };
	emit(w, argv, f, { redirects, heredocs, herestrings, openArgs: false, assignments, argvSpans, ...flow });
}

function push(
	w: Walk,
	f: Frame,
	c: Omit<SimpleCommand, "via" | "remote" | "at" | "span" | "reparsed" | "script" | "outOfOrder">,
): void {
	if (w.out.length >= LIMITS.maxCommands) throw new ShellFail("limit");
	const outOfOrder = !!(f.outOfOrder || w.outOfOrder);
	const { argvSpans, ...rest } = c;
	const own = f.depth === 0 && f.via.length === 0 && argvSpans ? { argvSpans } : {};
	w.out.push({
		...rest,
		...own,
		via: f.via,
		remote: f.remote,
		at: w.at,
		span: [w.span[0], w.span[1]],
		reparsed: f.depth > 0,
		script: w.script,
		outOfOrder,
	});
}

/** Node types whose body may run out of text order (see `SimpleCommand.outOfOrder`). */
const OUT_OF_ORDER = new Set([
	"function_definition",
	"for_statement",
	"c_style_for_statement",
	"while_statement",
	"until_statement",
	"select_statement",
]);

/** A command string or stdin whose text is unknowable here. */
function dynamic(w: Walk, f: Frame, argv: Word[], body: string): void {
	push(w, f, {
		argv,
		name: undefined,
		openArgs: false,
		dynamicBody: body,
		redirects: [],
		heredocs: [],
		assignments: [],
		certain: false,
		after: [],
	});
}

function emit(w: Walk, argv: Word[], f: Frame, io: Io): void {
	if (argv.length === 0) return;
	const name = argv[0].kind === "expansion" ? undefined : argv[0].value.split("/").pop();
	push(w, f, {
		argv,
		name,
		openArgs: io.openArgs,
		redirects: io.redirects,
		heredocs: io.heredocs,
		assignments: io.assignments,
		certain: io.certain,
		after: io.after,
		argvSpans: io.argvSpans,
	});
	if (name === undefined) return;
	if (!isWrapper(name)) {
		// A program guard doesn't know that is handed a guarded command name as a plain word (`mytool rm -rf ~`,
		// `devbox run git push -f`) may run it: what follows is judged as a command too (fail closed), unless the program
		// is known to take only text (`echo rm`, `grep git`, `man rm`).
		const k = argv.findIndex(
			(x, i) => i > 0 && x.kind === "literal" && GUARDED_NAMES.has(x.value.split("/").pop() ?? ""),
		);
		// Guard's own commands (`git rm`, `rm -- git`, `find -name rm`) are judged by their own rules, not as wrappers.
		if (k > 0 && !NOT_WRAPPERS.has(name) && !GUARDED_NAMES.has(name) && !textSubcommand(name, argv))
			emit(w, argv.slice(k), { via: [...f.via, name], remote: f.remote, depth: f.depth }, { ...io, openArgs: true });
		return;
	}
	const via = [...f.via, name];
	for (const step of WRAPPERS[name](argv.slice(1))) {
		const inner: Frame = {
			via,
			remote: f.remote || !!step.remote,
			depth: f.depth,
			outOfOrder: f.outOfOrder || (step.kind === "script" && !!step.outOfOrder),
		};
		if (step.kind === "exec")
			emit(w, step.argv, inner, {
				...io,
				openArgs: io.openArgs || !!step.openArgs,
				placeholder: step.placeholder ?? io.placeholder,
			});
		else if (step.kind === "script")
			runString(w, step.body, inner, io.openArgs ? (io.placeholder ?? "{}") : undefined);
		else {
			// A shell option the table doesn't know: where the program comes from is unknown.
			if (step.unknown) {
				dynamic(w, inner, [], "<unknown shell option>");
				continue;
			}
			// A shell (or ssh) reading its program from stdin: a heredoc or here-string body is that program. An unquoted
			// body is expanded first; its source text is parsed as an approximation (expansions stay expansions).
			for (const h of io.heredocs) parseScript(w, h.body, { ...inner, depth: f.depth + 1 });
			for (const hs of io.herestrings) runString(w, [hs], inner);
			// No body in sight (`… | bash`, `bash < file`): the program is unknowable here.
			if (!io.heredocs.length && !io.herestrings.length) dynamic(w, inner, [], "<stdin>");
		}
	}
}

/** Re-parses a command string made of words joined by spaces; a word with an expansion makes it dynamic. */
function runString(w: Walk, words: Word[], f: Frame, placeholder?: string): void {
	if (words.some((x) => x.kind === "expansion")) dynamic(w, f, words, words.map((x) => x.raw).join(" "));
	// Under `xargs -I R` / `find -exec sh -c '… {} …'`, the placeholder is replaced with run-time text before the shell
	// parses the string: what it runs, or on, isn't in the text (`sh -c 'rm -rf {}'`), so it is unknown.
	else if (placeholder !== undefined && words.some((x) => x.value.includes(placeholder)))
		dynamic(w, f, [], `<placeholder> ${words.map((x) => x.raw).join(" ")}`);
	else parseScript(w, words.map((x) => x.value).join(" "), { ...f, depth: f.depth + 1 });
}

// ---------------------------------------------------------------------------------------------------------------
// Control flow

/**
 * Whether a node always runs before what follows it: every ancestor up to the script is a plain sequence, and in an
 * `&&`/`||` list it is the left-most command (`d=$(mktemp -d) && cd "$d"`; not `false && d=x`). Inside `if`, loops,
 * `case`, subshells, pipelines, or functions it may not run, or not in this shell.
 */
function certain(n: Node): boolean {
	let child = n;
	for (let p = n.parent; p; child = p, p = p.parent) {
		// A top-level item ended by `&` runs in a background subshell: nothing it sets (cwd, variables, the branch)
		// reaches the commands after it.
		if (p.type === "program") return child.nextSibling?.type !== "&";
		if (p.type === "declaration_command" || p.type === "redirected_statement" || p.type === "compound_statement")
			continue;
		if (p.type === "list" && p.firstChild?.id === child.id) continue;
		if (misnested(p, child)) continue;
		return false;
	}
	return false;
}

/**
 * Where a conditional node has surely run: the right side of each `&&` it is (part of) the left side of, walking up
 * through `&&` lists only (`a && t=x && b` → `b`). Empty under `||`, `if`, loops, or subshells.
 */
function dominated(n: Node): [number, number][] {
	const out: [number, number][] = [];
	let child = n;
	for (let p = n.parent; p; child = p, p = p.parent) {
		// Inside a backgrounded item (`cd x && a & b`), the `&&` chain still holds for `a`, but nothing reaches `b`.
		if (p.type === "program") break;
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
	const list =
		child.type === "list" ||
		(child.type === "redirected_statement" && child.childForFieldName("body")?.type === "list");
	if (!list) return false;
	return p.type === "pipeline" || (p.type === "redirected_statement" && child.type === "list");
}

// ---------------------------------------------------------------------------------------------------------------
// Bindings and TMPDIR rebinding

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
// Commands that can bind any name the text doesn't spell out.
const OPAQUE_BINDERS = new Set(["eval", "source", ".", "let", "builtin", "command", "enable", "alias"]);
// Commands whose operands name variables they bind (`read X`, `printf -v X`); an expanding operand hides the name.
const NAME_BINDERS = new Set(["read", "mapfile", "readarray", "getopts", "printf", "unset"]);
// Privilege wrappers guard treats as rebinding TMPDIR wherever they appear: they may reset the environment (#77).
const ENV_RESETTERS = new Set(["sudo", "doas", "su", "runuser", "pkexec"]);
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);

const argumentsOf = (n: Node) => n.children.filter((_, i) => n.fieldNameForChild(i) === "argument").map((a) => a.text);
// Constructs that can bind a name nobody can read from the text: arithmetic (`((z))` assigns through z's value),
// `${!x}` indirection.
const hidesTarget = (n: Node) =>
	n.type === "c_style_for_statement" ||
	n.type === "arithmetic_expansion" ||
	(n.type === "compound_statement" && n.text.startsWith("((")) ||
	(n.type === "expansion" && /^\$\{!/.test(n.text));
const declaresNameref = (n: Node) => n.type === "declaration_command" && /^\S+\s+-\w*n/.test(n.text);

function readBindings(root: Node, src: string): Bindings {
	const values = new Map<string, Word[] | null>();
	const parsedAssignments = new Map<string, number>();
	const firstAt = new Map<string, number>();
	const conditional = new Map<string, [number, number][]>();
	let opaque = false;
	const add = (name: string, ws: Word[] | null, at: number) => {
		if (!firstAt.has(name)) firstAt.set(name, at);
		const prev = values.get(name);
		values.set(name, prev === null || ws === null ? null : [...(prev ?? []), ...ws]);
	};
	const visit = (n: Node): void => {
		if (hidesTarget(n) || declaresNameref(n)) opaque = true;
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
						conditional.set(name, conditional.has(name) ? [] : dominated(n));
					}
				}
			}
		} else if (n.type === "for_statement") {
			const name = n.childForFieldName("variable")?.text;
			const ws = n.children.filter((_, i) => n.fieldNameForChild(i) === "value").map(word);
			if (name) add(name, ws.length ? ws : null, n.startIndex);
		} else if (n.type === "declaration_command") {
			for (const c of n.namedChildren) {
				// An operand that isn't a plain assignment (`export "$n=/"`, `export TMP""DIR=/`).
				if (c.type !== "variable_assignment" && c.type !== "variable_name" && /[$`"'\\{]/.test(c.text))
					opaque = true;
				// `local X`, `declare X`: unset or kept, either way not a value the text shows.
				if (c.type === "variable_name") add(c.text, null, n.startIndex);
			}
		} else if (n.type === "command") {
			const nameText = n.childForFieldName("name")?.text ?? "";
			let name = nameText.replace(/^.*\//, "");
			let args = argumentsOf(n);
			// `command`/`builtin` bind only what the command they run binds (`command read X`); an option or a spelled
			// name there stays opaque.
			if ((name === "command" || name === "builtin") && args.length) {
				if (/^-|["'\\{}$`]/.test(args[0])) opaque = true;
				[name, ...args] = args;
				// The parser reads `command export X=…` as plain words, not a declaration: its bindings are unseen.
				if (DECLARERS.has(name)) opaque = true;
			}
			// A name written with quotes, escapes, or braces (`\export`, `e{xport,}`, `ex""port`) may spell a binder; one
			// that only expands a variable (`"$T/run.sh"`) is the policy's unknown command name, not a binder.
			const spelled = nameText.replace(/^"?\$\{?[A-Za-z_]\w*\}?[\w./-]*"?$/, "x");
			if ((OPAQUE_BINDERS.has(name) && name !== "command" && name !== "builtin") || /["'\\{}$`]/.test(spelled))
				opaque = true;
			const binds = NAME_BINDERS.has(name) && (name !== "printf" || /^-v/.test(args[0] ?? ""));
			if (binds && args.some((a) => /[$`]/.test(a))) opaque = true;
			// `read X`, `unset X`, `printf -v X`, `getopts o X`: X's value isn't in the text.
			if (binds)
				for (const a of args) for (const m of a.matchAll(/(?:^-v)?([A-Za-z_]\w*)$/g)) add(m[1], null, n.startIndex);
		}
		for (const c of n.children) visit(c);
	};
	visit(root);
	// A binding the parse didn't see (inside a `trap`/`eval` string) or a binder naming it makes the value unknown.
	for (const name of values.keys()) {
		const id = name.replace(/\W/g, "");
		const textual = src.match(new RegExp(`(?<![\\w$])${id}\\+?=`, "g"))?.length ?? 0;
		const named = new RegExp(
			String.raw`(?:^|[;&|(\s])(?:read|mapfile|readarray|getopts|unset|printf|declare|typeset|local|export|readonly)\b[^;&|\n]*?(?<![\w$])(?:-\w*v)?${id}(?![\w=])`,
		);
		if (textual > (parsedAssignments.get(name) ?? 0) || named.test(src) || SPECIAL_NAMES.has(name))
			values.set(name, null);
	}
	return { values, firstAt, conditional, opaque };
}

const isTmpdir = (t: string) => t.replace(/\[.*$/s, "") === "TMPDIR";

/** Whether one parsed text may rebind TMPDIR (see `tmpdirRebinds`). A `$` or `?` elsewhere is not a rebinding. */
function rebindsTmpdir(root: Node): boolean {
	const hits = (n: Node): boolean => {
		if (hidesTarget(n) || declaresNameref(n)) return true;
		switch (n.type) {
			case "variable_assignment": {
				// A plain name, or `a[N]` with a literal number, names its target; anything else hides it: `${z}=1`, and
				// `a[z]=1`, whose subscript is arithmetic that evaluates z's value recursively (`z=TMPDIR=7` assigns TMPDIR).
				const name = n.childForFieldName("name");
				const text = name?.text ?? "";
				const plain = name?.type === "variable_name" || /^[A-Za-z_]\w*\[\d+\]$/.test(text);
				return !plain || isTmpdir(text);
			}
			case "unset_command":
			case "declaration_command":
				return n.namedChildren.some((c) =>
					c.type === "variable_name"
						? isTmpdir(c.text)
						: c.type !== "variable_assignment" && !/^-\w+$/.test(c.text),
				);
			case "command": {
				const nameText = n.childForFieldName("name")?.text ?? "";
				let name = nameText.replace(/^.*\//, "");
				let args = argumentsOf(n);
				// `command`/`builtin` run the named command or builtin: they rebind only if what they run does
				// (`command export TMPDIR=/`), not for `command echo ok`. An option or an odd name stays opaque.
				if (name === "command" || name === "builtin") {
					if (!args.length) return false;
					if (/^-|["'\\{}$`]/.test(args[0])) return true;
					[name, ...args] = args;
				}
				// A name that isn't plain text may spell a binder (`\export`, `ex""port`, `$CMD`).
				if (/["'\\{}$`]/.test(nameText) || OPAQUE_BINDERS.has(name) || ENV_RESETTERS.has(name)) return true;
				if (NAME_BINDERS.has(name) && (name !== "printf" || /^-v/.test(args[0] ?? "")))
					// Operands naming a variable: TMPDIR, or one that expands (`read "$n"`).
					return args.some((a) => isTmpdir(a.replace(/^-v/, "")) || /[$`"'\\]/.test(a));
				// `env TMPDIR=/ cmd`, `env -u TMPDIR`, or any option (`-i`, `-u`, `-S`, `-C` reset or rewrite the environment).
				if (name === "env") return args.some((a) => /TMP/.test(a) || /^-/.test(a) || /^["']?\$/.test(a));
				// An operand that expands into an assignment.
				if (DECLARERS.has(name)) return args.some((a) => /TMP/.test(a) || /^["']?\$/.test(a));
				return false;
			}
			default:
				return false;
		}
	};
	const visit = (n: Node): boolean => hits(n) || n.children.some(visit);
	return visit(root);
}

// ---------------------------------------------------------------------------------------------------------------
// Words

/** An unquoted glob character (guard-policy shares it). */
export const GLOB = /[*?[]/;
const BRACE = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

interface Piece {
	text: string;
	quoted: boolean;
	expansion: boolean;
}

function word(node: Node): Word {
	const pieces: Piece[] = [];
	collect(node, pieces);
	const plain = pieces.filter((p) => !p.quoted && !p.expansion);
	const first = pieces[0];
	const globby = plain.some((p) => GLOB.test(p.text));
	const tilde = first !== undefined && !first.quoted && !first.expansion && first.text.startsWith("~");
	// `a{b,c}` parses as word `a`, word `{`, word `b,c`, word `}`: check the unquoted text joined in order.
	const brace =
		node.type === "brace_expression" ||
		BRACE.test(plain.map((p) => p.text).join("")) ||
		BRACE.test(pieces.map((p) => (p.quoted || p.expansion ? "\0" : p.text)).join(""));
	const expands = globby || tilde || brace || pieces.some((p) => p.expansion);
	const kind: WordKind = expands ? "expansion" : pieces.some((p) => p.quoted) ? "quoted" : "literal";
	return { value: pieces.map((p) => p.text).join(""), kind, raw: node.text };
}

const lit = (value: string): Word => ({ value, kind: "literal", raw: value });

const RANK: Record<WordKind, number> = { literal: 0, quoted: 1, expansion: 2 };
function join(a: Word, b: Word): Word {
	// `$"…"` is a locale-translated string: the `$` disappears.
	const aValue = a.raw === "$" && b.raw.startsWith('"') ? "" : a.value;
	const aKind = aValue === "" ? "literal" : a.kind;
	return { value: aValue + b.value, kind: RANK[aKind] >= RANK[b.kind] ? aKind : b.kind, raw: a.raw + b.raw };
}

function collect(n: Node, out: Piece[]): void {
	const piece = (text: string, quoted: boolean, expansion = false) => {
		out.push({ text, quoted, expansion });
	};
	switch (n.type) {
		case "command_name":
		case "concatenation":
			for (const c of n.children) collect(c, out);
			return;
		case "word":
		case "number":
			if (n.childCount > 0) piece(n.text, false, true);
			else piece(unescapeBare(n.text), false);
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
				piece(c.text, true, true);
				at = c.endIndex - base;
			}
			if (end > at) piece(dqUnescape(text.slice(at, end)), true);
			// An empty string (`""`) still marks the word quoted.
			if (out.length === before) piece("", true);
			return;
		}
		default:
			// expansion, simple_expansion, command_substitution, arithmetic_expansion, process_substitution,
			// brace_expression, and anything unrecognised: not literal.
			piece(n.text, false, true);
	}
}

// Unquoted text: `\<newline>` disappears, `\x` is `x`.
const unescapeBare = (s: string) => s.replace(/\\\n/g, "").replace(/\\(.)/gs, "$1");
// Double-quoted text: backslash escapes only `$`, `` ` ``, `"`, `\`, and newline.
const dqUnescape = (s: string) => s.replace(/\\\n/g, "").replace(/\\([$`"\\])/g, "$1");

const ANSI_C: Record<string, string> = {
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
function ansiC(s: string): string {
	return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs, (_, e: string) => {
		if (Object.hasOwn(ANSI_C, e)) return ANSI_C[e];
		if (/^[xuU]/.test(e)) return String.fromCodePoint(Number.parseInt(e.slice(1), 16));
		if (/^[0-7]/.test(e)) return String.fromCharCode(Number.parseInt(e, 8) & 0xff);
		if (e[0] === "c") return String.fromCharCode(e.charCodeAt(1) & 0x1f);
		return `\\${e}`;
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Wrappers: commands that run another command from their arguments. Each entry parses options like the real tool.

type Step =
	| { kind: "exec"; argv: Word[]; openArgs?: boolean; remote?: boolean; placeholder?: string }
	| { kind: "script"; body: Word[]; remote?: boolean; outOfOrder?: boolean }
	| { kind: "stdin"; remote?: boolean; unknown?: boolean };

interface OptionSpec {
	/** Short option letters that take a value (`-u root`, `-uroot`). */
	short?: string;
	/** Long options that take a value (`--user root`, `--user=root`). */
	long?: string[];
	/** Treat `-<digits>` as a flag (`nice -5`). */
	numericFlags?: boolean;
}

/** Skips options; returns the index of the first operand and the options seen (letter or long name → value). */
function options(args: Word[], spec: OptionSpec): { at: number; seen: Map<string, Word | true> } {
	const seen = new Map<string, Word | true>();
	let i = 0;
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

const execFrom = (
	args: Word[],
	at: number,
	extra: { openArgs?: boolean; remote?: boolean; placeholder?: string } = {},
): Step[] => (at < args.length ? [{ kind: "exec", argv: args.slice(at), ...extra }] : []);
// `NAME=value` operands (`env PATH="$PATH" node`): the name decides, the value may expand.
function skipAssignments(args: Word[], from: number): number {
	let at = from;
	while (at < args.length && /^[A-Za-z_]\w*=/.test(args[at].raw)) at++;
	return at;
}

/**
 * A shell's program, read with a real option table: `-c` (the first operand is the program), `-s` (stdin is the
 * program, even with operands), `-o`/`+o`/`-O`/`+O`/`--rcfile`/`--init-file` (take the next word), `--`/`-` (end
 * options), other single-letter flags (`-e`, `-x`, `-l`, `-i`, combined `-ec`), and the long flags bash knows. An
 * option outside the table, or an unquoted expansion before the program, leaves where the program comes from unknown:
 * then it is judged as unknown (asks). `bash --version`/`-n` (syntax only) run nothing.
 */
function shell(args: Word[]): Step[] {
	let i = 0;
	let c = false;
	let s = false;
	while (i < args.length) {
		const w = args[i].value;
		// An unquoted expansion could split into options (`bash $opts`); a quoted one is a word: the -c string or a file.
		if (args[i].kind === "expansion" && !/^"[^"]*"$/.test(args[i].raw)) return [{ kind: "script", body: [args[i]] }];
		if (args[i].kind === "expansion") break;
		if (w === "--version" || w === "--help" || /^-[A-Za-z]*n[A-Za-z]*$/.test(w)) return [];
		if (w === "--" || w === "-") {
			i++;
			break;
		}
		if (SHELL_VALUE_OPTS.has(w)) {
			i += 2;
			continue;
		}
		if (/^--[\w-]+$/.test(w)) {
			if (!SHELL_LONG_FLAGS.has(w)) return [{ kind: "stdin", unknown: true }];
			i++;
			continue;
		}
		if (/^[-+][A-Za-z]+$/.test(w)) {
			if (![...w.slice(1)].every((l) => SHELL_FLAG_LETTERS.includes(l))) return [{ kind: "stdin", unknown: true }];
			if (w.startsWith("-") && w.includes("c")) c = true;
			if (w.startsWith("-") && w.includes("s")) s = true;
			i++;
			continue;
		}
		break;
	}
	if (c) return i < args.length ? [{ kind: "script", body: [args[i]] }] : [];
	// `-s`: the program is stdin whatever operands follow (they become $1…).
	if (s) return [{ kind: "stdin" }];
	// A file operand that is stdin (`bash /dev/stdin`, `sh /dev/fd/0`, `-`) reads the program from stdin (a process
	// substitution, `bash <(curl …)`, asks in the policy). Otherwise a script file runs a program the text doesn't show
	// (judged by the caller); no operand reads stdin.
	if (i < args.length && READS_STDIN.test(args[i].value) && args[i].kind !== "expansion") return [{ kind: "stdin" }];
	return i < args.length ? [] : [{ kind: "stdin" }];
}
/** Command names guard's rules look at: when one appears as a word of an unknown program, it may be run. */
const GUARDED_NAMES = new Set(["rm", "git", "find", "xargs", ...SHELLS]);
/**
 * Programs that take a guarded name only as text or as something to look up, never to run it: printing, searching,
 * documentation, lookup, package and repo tools whose own sub-commands share the names (`gh repo`, `herdr agent`).
 */
const NOT_WRAPPERS = new Set([
	"echo",
	"printf",
	"print",
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"sed",
	"awk",
	"tr",
	"cut",
	"sort",
	"uniq",
	"wc",
	"jq",
	"yq",
	"man",
	"info",
	"help",
	"which",
	"type",
	"whereis",
	"whatis",
	"apropos",
	"hash",
	"alias",
	"unalias",
	"complete",
	"compgen",
	"test",
	"[",
	"[[",
	"true",
	"false",
	"gh",
	"herdr",
	"apt",
	"apt-get",
	"dnf",
	"yum",
	"pacman",
	"pip",
	"pip3",
	"rustup",
	"pi",
	"claude",
	"codex",
	"node",
	"python",
	"python3",
	"ruby",
	"perl",
	"diff",
	"cmp",
	"ls",
	"stat",
	"file",
	"readlink",
	"realpath",
	"basename",
	"dirname",
	"touch",
	"mkdir",
	"cp",
	"mv",
	"ln",
	"chmod",
	"chown",
	"tar",
	"zip",
	"unzip",
	"gzip",
	"curl",
	"wget",
	"ssh-keygen",
	"tee",
	"column",
	"fold",
	"fmt",
	"nl",
	"od",
	"xxd",
	"hexdump",
	"strings",
	"date",
	"sleep",
	"read",
	"export",
	"local",
	"declare",
	"set",
	"unset",
	"shift",
	"return",
	"exit",
	"cd",
	"pushd",
	"popd",
	"dirs",
	"history",
	"fc",
	"bind",
	"ulimit",
	"umask",
	"kill",
	"wait",
	"jobs",
	"fg",
	"bg",
	"disown",
	"logger",
	"osascript",
	"pbcopy",
	"pbpaste",
	"say",
	"rtk",
	"vim",
	"nvim",
	"vi",
	"nano",
	"emacs",
	"git-lfs",
	"cmake",
	"biome",
	"tsc",
	"eslint",
	"prettier",
	"deno",
]);

/**
 * Tools whose sub-commands differ: some only take text or package names (`npm install rm`, `brew info git`), others
 * run a program (`npm exec rm`, `pnpm dlx`, `bun x`, `mise exec`). Only the text/package sub-commands listed here are
 * exempt from the generic wrapper rule; a runner or an unknown sub-command is judged by it (a guarded word asks).
 */
const TEXT_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
	npm: new Set([
		"install",
		"i",
		"ci",
		"add",
		"uninstall",
		"remove",
		"rm",
		"update",
		"outdated",
		"ls",
		"list",
		"info",
		"view",
		"show",
		"search",
		"init",
		"pack",
		"publish",
		"version",
		"config",
		"cache",
		"audit",
		"fund",
		"doctor",
		"help",
		"whoami",
		"login",
		"logout",
		"link",
		"prune",
		"dedupe",
		"explain",
		"why",
		"root",
		"bin",
		"prefix",
		"owner",
		"dist-tag",
		"deprecate",
		"query",
		"sbom",
		"pkg",
		"ping",
	]),
	pnpm: new Set([
		"install",
		"i",
		"add",
		"remove",
		"rm",
		"update",
		"up",
		"outdated",
		"list",
		"ls",
		"why",
		"info",
		"view",
		"store",
		"init",
		"pack",
		"publish",
		"audit",
		"config",
		"help",
		"link",
		"unlink",
		"prune",
		"import",
		"fetch",
		"root",
		"bin",
		"licenses",
		"patch",
		"patch-commit",
	]),
	yarn: new Set([
		"install",
		"add",
		"remove",
		"upgrade",
		"up",
		"outdated",
		"list",
		"info",
		"why",
		"init",
		"pack",
		"publish",
		"config",
		"cache",
		"audit",
		"help",
		"link",
		"unlink",
		"set",
		"plugin",
		"npm",
		"constraints",
		"workspaces",
	]),
	bun: new Set([
		"install",
		"i",
		"add",
		"remove",
		"rm",
		"update",
		"outdated",
		"pm",
		"init",
		"create",
		"link",
		"unlink",
		"publish",
		"upgrade",
		"info",
		"audit",
		"help",
	]),
	mise: new Set([
		"install",
		"i",
		"use",
		"u",
		"ls",
		"list",
		"ls-remote",
		"current",
		"where",
		"which",
		"outdated",
		"upgrade",
		"uninstall",
		"prune",
		"doctor",
		"settings",
		"config",
		"trust",
		"env",
		"plugins",
		"registry",
		"help",
		"version",
		"self-update",
		"cache",
		"reshim",
		"activate",
		"set",
		"unset",
		"latest",
		"alias",
		"tasks",
	]),
	asdf: new Set([
		"install",
		"uninstall",
		"list",
		"current",
		"where",
		"which",
		"plugin",
		"global",
		"local",
		"set",
		"latest",
		"help",
		"info",
		"reshim",
		"shim-versions",
		"update",
	]),
	cargo: new Set([
		"build",
		"b",
		"check",
		"c",
		"test",
		"t",
		"bench",
		"doc",
		"fmt",
		"clippy",
		"add",
		"remove",
		"update",
		"install",
		"uninstall",
		"search",
		"publish",
		"new",
		"init",
		"tree",
		"metadata",
		"fetch",
		"clean",
		"vendor",
		"help",
		"version",
		"login",
		"owner",
		"yank",
		"package",
		"locate-project",
		"pkgid",
		"verify-project",
		"generate-lockfile",
	]),
	go: new Set([
		"build",
		"test",
		"vet",
		"fmt",
		"get",
		"install",
		"mod",
		"list",
		"doc",
		"env",
		"version",
		"clean",
		"work",
		"help",
		"fix",
		"bug",
	]),
	brew: new Set([
		"install",
		"uninstall",
		"remove",
		"rm",
		"reinstall",
		"upgrade",
		"update",
		"info",
		"list",
		"ls",
		"search",
		"outdated",
		"deps",
		"uses",
		"leaves",
		"doctor",
		"cleanup",
		"config",
		"tap",
		"untap",
		"pin",
		"unpin",
		"link",
		"unlink",
		"home",
		"desc",
		"cat",
		"log",
		"commands",
		"help",
		"--version",
		"--prefix",
		"--cellar",
		"--cache",
		"autoremove",
		"services",
		"bundle",
	]),
	make: new Set(),
	code: new Set(),
	open: new Set(),
	tmux: new Set([
		"ls",
		"list-sessions",
		"list-windows",
		"list-panes",
		"list-clients",
		"list-keys",
		"list-commands",
		"attach",
		"attach-session",
		"a",
		"kill-server",
		"kill-session",
		"kill-window",
		"kill-pane",
		"has-session",
		"has",
		"rename-session",
		"rename-window",
		"select-window",
		"select-pane",
		"detach",
		"detach-client",
		"display-message",
		"display",
		"show-options",
		"show",
		"set-option",
		"set",
		"capture-pane",
		"source-file",
		"source",
		"info",
		"show-buffer",
		"save-buffer",
		"choose-tree",
		"switch-client",
		"-V",
	]),
	screen: new Set(["-ls", "-list", "-r", "-x", "-R", "-wipe", "-v", "-version"]),
};
/** A tool from `TEXT_SUBCOMMANDS` called with a sub-command that only takes text (`make`, `code`, `open`: never a runner here). */
function textSubcommand(name: string, argv: Word[]): boolean {
	const subs = TEXT_SUBCOMMANDS[name];
	if (!subs) return false;
	// `make rm`, `code rm.ts`, `open rm.txt`: a target or file name, not a command.
	if (name === "make" || name === "code" || name === "open") return true;
	// The first word that isn't an option is the sub-command (`npm --silent install x`, `tmux -L s new …`).
	let i = 1;
	while (i < argv.length && argv[i].kind === "literal" && argv[i].value.startsWith("-") && !subs.has(argv[i].value)) {
		i += /^-(?:[LSfc]|-socket-name|-prefix|-dir|-filter|-C)$/.test(argv[i].value) ? 2 : 1;
	}
	const sub = argv[i];
	if (!sub || sub.kind !== "literal") return false;
	// `npm run <script>`, `pnpm run`, `yarn <script>`: a package script, named in package.json, not a command word.
	if (
		(name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") &&
		(sub.value === "run" || sub.value === "test")
	)
		return true;
	return subs.has(sub.value);
}

/** Shell options that take the next word as their value. */
const SHELL_VALUE_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
/** Single-letter shell flags (bash, sh, zsh, dash, ksh): `-c` and `-s` are read; the rest only set behaviour. */
const SHELL_FLAG_LETTERS = "abcefhiklmnprstuvxBCEHPT";
const SHELL_LONG_FLAGS = new Set([
	"--login",
	"--norc",
	"--noprofile",
	"--posix",
	"--noediting",
	"--restricted",
	"--verbose",
	"--debugger",
	"--dump-strings",
	"--dump-po-strings",
	"--protected",
	"--no-rcs",
	"--no-globalrcs",
	"--interactive",
]);

/** A path a shell or `source` reads its program from that is its own stdin. */
const READS_STDIN = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

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
	const { at, seen } = options(args, { short: "ugGsw", long: ["--user", "--group", "--supp-group", "--shell"] });
	return seen.has("u") || seen.has("--user") ? execFrom(args, at) : [];
}

const SUDO_VALUES = [
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
];

const WRAPPERS: Record<string, (args: Word[]) => Step[]> = {
	sudo: (args) => {
		const { at, seen } = options(args, { short: "ughpCDrtUTR", long: SUDO_VALUES });
		if (seen.has("e") || seen.has("--edit") || seen.has("l") || seen.has("--list")) return [];
		const start = skipAssignments(args, at);
		// `sudo -s cmd …` / `sudo -i cmd …` hand the words to a shell's `-c`.
		if (seen.has("s") || seen.has("i") || seen.has("--shell") || seen.has("--login"))
			return start < args.length ? [{ kind: "script", body: args.slice(start) }] : [{ kind: "stdin" }];
		return execFrom(args, start);
	},
	doas: (args) => {
		const { at, seen } = options(args, { short: "uC" });
		if (seen.has("C")) return [];
		if (seen.has("s")) return [{ kind: "stdin" }];
		return execFrom(args, at);
	},
	su: (args) => suLike(args, false),
	runuser: (args) => suLike(args, true),
	pkexec: (args) => execFrom(args, options(args, { long: ["--user"] }).at),
	env: (args) => {
		const { at, seen } = options(args, {
			short: "uCPS",
			long: ["--unset", "--chdir", "--split-string", "--default-signal", "--ignore-signal", "--block-signal"],
		});
		const split = seen.get("S") ?? seen.get("--split-string");
		const start = skipAssignments(args, at);
		if (split && split !== true) return [{ kind: "script", body: [split, ...args.slice(start)] }];
		return execFrom(args, start);
	},
	timeout: (args) => execFrom(args, options(args, { short: "sk", long: ["--signal", "--kill-after"] }).at + 1), // the duration
	gtimeout: (args) => WRAPPERS.timeout(args),
	nice: (args) => execFrom(args, options(args, { short: "n", long: ["--adjustment"], numericFlags: true }).at),
	nohup: (args) => execFrom(args, options(args, {}).at),
	time: (args) => execFrom(args, options(args, { short: "of", long: ["--output", "--format"] }).at),
	command: (args) => {
		const { at, seen } = options(args, {});
		return seen.has("v") || seen.has("V") ? [] : execFrom(args, at);
	},
	exec: (args) => execFrom(args, options(args, { short: "a" }).at),
	builtin: (args) => execFrom(args, 0),
	stdbuf: (args) => execFrom(args, options(args, { short: "ioe", long: ["--input", "--output", "--error"] }).at),
	setsid: (args) => execFrom(args, options(args, {}).at),
	ionice: (args) => execFrom(args, options(args, { short: "cnpPu", long: ["--class", "--classdata"] }).at),
	caffeinate: (args) => execFrom(args, options(args, { short: "tw" }).at),
	// macOS and BSD runners: `arch -arm64 cmd`, `script -q file cmd`, `lockf file cmd`, `chroot dir cmd`,
	// `sandbox-exec -f profile cmd`, `taskpolicy -c class cmd`.
	arch: (args) => execFrom(args, options(args, { long: ["-arch"] }).at),
	script: (args) => {
		const { at } = options(args, { short: "FtT" });
		return at + 1 < args.length ? execFrom(args, at + 1) : []; // the transcript file, then the command
	},
	lockf: (args) => execFrom(args, options(args, { short: "t" }).at + 1), // the lock file
	chroot: (args) => execFrom(args, options(args, { short: "ug", long: ["--userspec", "--groups"] }).at + 1), // the root
	"sandbox-exec": (args) => execFrom(args, options(args, { short: "fpD" }).at),
	taskpolicy: (args) => execFrom(args, options(args, { short: "cdgtlbp" }).at),
	// More runners: `busybox rm …`, `fakeroot cmd`, `xcrun cmd`, `strace -f cmd`, `nsenter -t 1 cmd`, `unshare -r cmd`,
	// `taskset -c 0 cmd`, `chrt -f 10 cmd`, `entr cmd`, `proxychains4 cmd`, `torsocks cmd`. `parallel cmd ::: args`
	// gets its arguments at run time.
	// `tmux new-session|new|new-window|neww|split-window|splitw|respawn-pane|respawnp|respawn-window|run-shell|run …`
	// runs a shell command: its trailing words (one quoted word is a shell string, so it is re-parsed). Other tmux
	// sub-commands (`ls`, `attach`, `send-keys` text) run none here.
	tmux: (args) => {
		let i = 0;
		while (i < args.length && args[i].kind === "literal" && /^-[LSf]$/.test(args[i].value)) i += 2;
		while (i < args.length && args[i].kind === "literal" && /^-[2CDluvV8]+$/.test(args[i].value)) i++;
		const sub = args[i]?.value ?? "";
		if (
			!/^(?:new-session|new|new-window|neww|split-window|splitw|respawn-pane|respawnp|respawn-window|respawnw|run-shell|run)$/.test(
				sub,
			)
		)
			return [];
		const rest = args.slice(i + 1);
		const at = options(rest, { short: "cnstxyFeElpPtTw" }).at;
		const cmd = rest.slice(at);
		if (!cmd.length) return [];
		return cmd.length === 1 ? [{ kind: "script", body: cmd }] : execFrom(cmd, 0);
	},
	// `screen [-dmS name] cmd …` runs its trailing words; `screen -X stuff '…'` sends keys (text) to a session.
	screen: (args) => {
		const { at, seen } = options(args, { short: "SceshTtpX" });
		if (seen.has("X") || seen.has("r") || seen.has("x") || seen.has("ls") || seen.has("list")) return [];
		const cmd = args.slice(at);
		if (!cmd.length) return [];
		return cmd.length === 1 && cmd[0].kind !== "literal" ? [{ kind: "script", body: cmd }] : execFrom(cmd, 0);
	},
	busybox: (args) => execFrom(args, 0),
	fakeroot: (args) => execFrom(args, options(args, { short: "lsi" }).at),
	xcrun: (args) => execFrom(args, options(args, { long: ["--sdk", "--toolchain"] }).at),
	strace: (args) => execFrom(args, options(args, { short: "eopsuEIPXaSb" }).at),
	ltrace: (args) => execFrom(args, options(args, { short: "eopsuEIPXaSb" }).at),
	nsenter: (args) => execFrom(args, options(args, { short: "tSGwr" }).at),
	unshare: (args) => execFrom(args, options(args, { short: "" }).at),
	taskset: (args) => {
		const { at, seen } = options(args, {});
		return execFrom(args, seen.has("p") ? args.length : at + 1); // the mask
	},
	chrt: (args) => execFrom(args, options(args, {}).at + 1), // the priority
	entr: (args) => execFrom(args, options(args, {}).at, { openArgs: true }),
	proxychains4: (args) => execFrom(args, options(args, { short: "f" }).at),
	proxychains: (args) => execFrom(args, options(args, { short: "f" }).at),
	torsocks: (args) => execFrom(args, options(args, { short: "uapP" }).at),
	parallel: (args) => {
		const at = options(args, { short: "jSPN", long: ["--jobs", "--sshlogin", "--joblog"] }).at;
		const end = args.findIndex((w, k) => k >= at && /^:::+$|^::::$/.test(w.value));
		return execFrom(end < 0 ? args : args.slice(0, end), at, { openArgs: true, placeholder: "{}" });
	},
	unbuffer: (args) => execFrom(args, options(args, {}).at),
	rtk: (args) => execFrom(args, args[0]?.value === "proxy" ? 1 : 0),
	xargs: (args) => {
		const long = [
			"--max-args",
			"--max-lines",
			"--max-procs",
			"--max-chars",
			"--delimiter",
			"--arg-file",
			"--replace",
		];
		const { at, seen } = options(args, { short: "ILnPsdEaJRS", long });
		// `-I R` / `-J R` / `--replace[=R]`: R in the command is replaced by input (default `{}`).
		const r = seen.get("I") ?? seen.get("J") ?? seen.get("--replace");
		const placeholder = r === undefined ? undefined : r === true ? "{}" : r.value;
		return execFrom(args, at, { openArgs: true, placeholder });
	},
	find: (args) => {
		const steps: Step[] = [];
		for (let i = 0; i < args.length; i++) {
			if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i].value)) continue;
			const end = args.findIndex((w, j) => j > i && (w.value === ";" || w.value === "+"));
			const stop = end < 0 ? args.length : end;
			steps.push(...execFrom(args.slice(0, stop), i + 1, { openArgs: true, placeholder: "{}" }));
			i = stop;
		}
		return steps;
	},
	flock: (args) => {
		const { at, seen } = options(args, { short: "wEc", long: ["--timeout", "--conflict-exit-code", "--command"] });
		const c = seen.get("c") ?? seen.get("--command");
		if (c && c !== true) return [{ kind: "script", body: [c] }];
		return execFrom(args, at + 1); // the lock file
	},
	eval: (args) => (args.length ? [{ kind: "script", body: args }] : []),
	trap: (args) => {
		const { at, seen } = options(args, {});
		if (seen.has("p") || seen.has("l")) return [];
		// `trap ACTION SIG…`; a single operand resets that signal. The action runs later (at a signal or exit).
		return args.length - at >= 2 && args[at].value !== "-"
			? [{ kind: "script", body: [args[at]], outOfOrder: true }]
			: [];
	},
	watch: (args) => {
		const { at, seen } = options(args, { short: "nq", long: ["--interval", "--equexit", "--differences"] });
		if (at >= args.length) return [];
		return seen.has("x") || seen.has("--exec")
			? [{ kind: "exec", argv: args.slice(at), remote: true }]
			: [{ kind: "script", body: args.slice(at), remote: true }];
	},
	ssh: (args) => {
		const rest = args.slice(options(args, { short: "BbcDEeFIiJLlmOopQRSWw" }).at + 1); // after the host
		return rest.length ? [{ kind: "script", body: rest, remote: true }] : [{ kind: "stdin", remote: true }];
	},
};
for (const name of SHELLS) WRAPPERS[name] = shell;
// `source /dev/stdin <<EOF` / `. /dev/fd/0`: the heredoc or here-string body is the sourced program.
for (const name of ["source", "."])
	WRAPPERS[name] = (args) =>
		args[0] && args[0].kind !== "expansion" && READS_STDIN.test(args[0].value) ? [{ kind: "stdin" }] : [];

/**
 * Wrappers whose string or stdin program runs in a new process (a shell, `su`, `sudo -s`, `ssh`…), so it doesn't see
 * this shell's variables; `eval` and `trap` strings run in this shell and do. One owner with the wrapper table above.
 */
export const RUNS_IN_NEW_SHELL: ReadonlySet<string> = new Set([
	...SHELLS,
	"su",
	"runuser",
	"sudo",
	"doas",
	"env",
	"flock",
	"ssh",
	"watch",
]);
