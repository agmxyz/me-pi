/**
 * guard's row generator (method step 2): each dangerous seed command wrapped in every hiding construct we know, crossed
 * with the fixtures where it is dangerous, plus safe twins (the same construct around a safe seed, or run where the
 * seed is safe) so false prompts are measured too. `test/guard-oracle.ts` judges the rows.
 *
 * Tokens (filled in by the oracle): `@CLEAN@`, `@DIRTY@`, `@MAIN@` are the fixture repos' absolute paths.
 */

export type Fixture = "clean" | "dirty" | "main" | "sub" | "temp";
export type Want = "ask" | "allow" | "ask-if-dirty" | "unknown";
export interface Row {
	cmd: string;
	cwd: Fixture;
	want: Want;
	source: string;
	/** An old gap both guards allow: reported, never failing. */
	known?: boolean;
}

/** A seed: `prog opts target` (each part may be empty), and where it is dangerous. */
interface Seed {
	id: string;
	prog: string;
	opts: string;
	target: string;
	/** Fixtures where it is dangerous (`ask`); in `safeIn` it is safe (a twin). */
	dangerIn: Fixture[];
	safeIn: Fixture[];
	/** The fixture to `cd` into for it to be dangerous (relative seeds), and where it is safe. */
	cdDanger: string;
	cdSafe?: string;
}

const SEEDS: Seed[] = [
	{
		id: "rm-home",
		prog: "rm",
		opts: "-rf",
		target: "~",
		dangerIn: ["clean", "dirty", "sub"],
		safeIn: [],
		cdDanger: "@DIRTY@",
	},
	{
		id: "rm-src",
		prog: "rm",
		opts: "-rf",
		target: "src",
		dangerIn: ["dirty"],
		safeIn: ["clean"],
		cdDanger: "@DIRTY@",
		cdSafe: "@CLEAN@",
	},
	{
		id: "reset-hard",
		prog: "git",
		opts: "reset --hard",
		target: "",
		dangerIn: ["dirty"],
		safeIn: ["clean"],
		cdDanger: "@DIRTY@",
		cdSafe: "@CLEAN@",
	},
	{
		id: "checkout-all",
		prog: "git",
		opts: "checkout --",
		target: ".",
		dangerIn: ["dirty"],
		safeIn: ["clean"],
		cdDanger: "@DIRTY@",
		cdSafe: "@CLEAN@",
	},
	{
		id: "clean-fdx",
		prog: "git",
		opts: "clean -fdx",
		target: "",
		dangerIn: ["dirty"],
		safeIn: [],
		cdDanger: "@DIRTY@",
	},
	{
		id: "force-push",
		prog: "git",
		opts: "push --force origin",
		target: "feat",
		dangerIn: ["clean", "dirty"],
		safeIn: [],
		cdDanger: "@DIRTY@",
	},
	{
		id: "push-main",
		prog: "git",
		opts: "push origin",
		target: "main",
		dangerIn: ["clean", "dirty"],
		safeIn: [],
		cdDanger: "@DIRTY@",
	},
	{
		id: "bare-push-on-main",
		prog: "git",
		opts: "push",
		target: "",
		dangerIn: ["main"],
		safeIn: ["clean"],
		cdDanger: "@MAIN@",
		cdSafe: "@CLEAN@",
	},
	{
		id: "find-delete-home",
		prog: "find",
		opts: "",
		target: "~ -delete",
		dangerIn: ["clean", "dirty"],
		safeIn: [],
		cdDanger: "@DIRTY@",
	},
	{
		id: "stash-drop",
		prog: "git",
		opts: "stash",
		target: "drop",
		dangerIn: ["clean"],
		safeIn: [],
		cdDanger: "@DIRTY@",
	},
];

/** Safe seeds for every fixture: the same constructs around them must not ask. */
const SAFE_SEEDS: Seed[] = [
	{
		id: "rm-temp",
		prog: "rm",
		opts: "-rf",
		target: `"\${TMPDIR:?}/guard-oracle-x"`,
		dangerIn: [],
		safeIn: ["clean"],
		cdDanger: "",
	},
	{ id: "rm-dist", prog: "rm", opts: "-rf", target: "dist", dangerIn: [], safeIn: ["dirty"], cdDanger: "" },
	{ id: "push-feat", prog: "git", opts: "push origin", target: "feat", dangerIn: [], safeIn: ["clean"], cdDanger: "" },
	{ id: "echo", prog: "echo", opts: "rm -rf", target: "~", dangerIn: [], safeIn: ["clean"], cdDanger: "" },
	{ id: "find-dist", prog: "find", opts: "", target: "dist -delete", dangerIn: [], safeIn: ["dirty"], cdDanger: "" },
];

const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
const cmdOf = (s: Seed) => join(s.prog, s.opts, s.target);

/** Constructs that keep the working directory: `{c}` is the command. */
const IN_PLACE: [string, string][] = [
	["plain", "{c}"],
	["function then call", "f() { {c}; }; f"],
	["function, newline call", "f() { {c}; }\nf"],
	["trap EXIT", "trap '{c}' EXIT"],
	["loop", "for i in 1; do {c}; done"],
	["while loop", "while true; do {c}; break; done"],
	["background", "{c} &"],
	["after a failing cd ||", "cd /nonexistent-guard-oracle || {c}"],
	["after a failing cd ;", "cd /nonexistent-guard-oracle; {c}"],
	["after a background cd", "cd /tmp & {c}"],
	["subshell", "({c})"],
	["group", "{ {c}; }"],
	["if", "if true; then {c}; fi"],
	["pipeline", "true | {c}"],
	["bash -c", "bash -c '{c}'"],
	["sh -c", "sh -c '{c}'"],
	["zsh -c", "zsh -c '{c}'"],
	["bash -lc", "bash -lc '{c}'"],
	["bash -s heredoc", "bash -s <<'EOF'\n{c}\nEOF"],
	["sh heredoc", "sh <<'EOF'\n{c}\nEOF"],
	["sh /dev/stdin heredoc", "sh /dev/stdin <<'EOF'\n{c}\nEOF"],
	["bash here-string", "bash <<< '{c}'"],
	["eval", "eval '{c}'"],
	["eval double-quoted", 'eval "{c}"'],
	["command substitution", "echo $({c})"],
	["backquotes", "echo `{c}`"],
	["assignment substitution", "x=$({c})"],
	["process substitution", "cat <({c})"],
	["source process substitution", "source <(echo '{c}')"],
	["written script run", "cat > g.sh <<'EOF'\n{c}\nEOF\nbash g.sh"],
	// A program that prints the command into a script, then the script runs (the program text alone is data).
	["python prints a script", "true; python3 - <<'EOF' > g.sh\nprint('{c}')\nEOF\nbash g.sh"],
	["node prints a script", "node -e 'console.log(`{c}`)' > g.sh; bash g.sh"],
	["node prints to sh", "node -p '`{c}`' | sh"],
	["python -c prints to bash", "python3 -c 'print(\"{c}\")' | bash"],
	["node runs it", "node -e 'require(\"child_process\").execSync(`{c}`)'"],
	// sed/perl: a substitution is text; `e` runs it; a script written by them then run runs it.
	["sed e flag", "echo x | sed 's/x/{c}/e'"],
	["sed e command", "echo x | sed '1e {c}'"],
	["sed writes a script", "echo x | sed 's/x/{c}/' > g.sh; bash g.sh"],
	["sed to sh", "echo x | sed 's/x/{c}/' | sh"],
	["perl e flag", "echo x | perl -pe 's/x/{c}/e'"],
	["perl system", "perl -e 'system(\"{c}\")'"],
	["python runs it", "true; python3 - <<'EOF'\nimport os\nos.system('{c}')\nEOF"],
	["printf to sh", "printf '%s\\n' '{c}' | sh"],
	["echo to bash", "echo '{c}' | bash"],
	["xargs", "echo | xargs {c}"],
	["xargs -I", "echo x | xargs -I{} {c}"],
	["xargs sh -c", "echo x | xargs -I{} sh -c '{c}'"],
	["find -exec", "find . -maxdepth 0 -exec {c} \\;"],
	["find -exec sh -c", "find . -maxdepth 0 -exec sh -c '{c}' \\;"],
	["find -exec sh -c {}", "find . -maxdepth 0 -exec sh -c '{c} {}' \\;"],
];
const WRAPPERS = [
	"sudo",
	"sudo -u root",
	"doas",
	"env",
	"env -i",
	"env A=1",
	"A=1",
	"nohup",
	"time",
	"command",
	"builtin",
	"exec",
	"timeout 5",
	"gtimeout 5",
	"nice",
	"nice -n 5",
	"stdbuf -o0",
	"setsid",
	"ionice",
	"caffeinate",
	"arch -arm64",
	"script -q /dev/null",
	"busybox",
	"fakeroot",
	"xcrun",
	"strace",
	"ltrace",
	"taskset 1",
	"chrt 1",
	"flock /tmp/guard-oracle.lock",
	"sandbox-exec -n no-network",
	"unbuffer",
	"proxychains4",
	"torsocks",
	"rtk",
	"rtk proxy",
	"lockf /tmp/guard-oracle.lock",
	"taskpolicy -b",
	"/usr/bin/env",
];
const RUNNERS = [
	"npm exec --",
	"npx",
	"pnpm exec",
	"pnpm dlx",
	"yarn exec",
	"bun x",
	"bunx",
	"mise exec --",
	"asdf exec",
	"tmux new-session -d",
	"screen -dm",
	"devbox run",
	"uv run",
	"poetry run",
	"pipx run",
	"mytool",
];

/** Constructs that move to `{d}` first (`cd`, `pushd`, `-C`): the command runs there. */
const MOVED: [string, string][] = [
	["cd &&", "cd {d} && {c}"],
	["cd ;", "cd {d}; {c}"],
	["cd newline", "cd {d}\n{c}"],
	["subshell cd", "(cd {d} && {c})"],
	["pushd", "pushd {d} && {c}"],
	["call after a later cd", "f() { {c}; }; cd {d} && f"],
	["call after a later cd ;", "f() { {c}; }; cd {d}; f"],
	["loop with a later cd", "for i in 1 2; do {c}; cd {d}; done"],
	["trap with a later cd", "trap '{c}' EXIT; cd {d}"],
	["cd via variable", "D={d}; cd $D && {c}"],
	["cd then bash -c", "cd {d} && bash -c '{c}'"],
	["bash -c with cd", "bash -c 'cd {d} && {c}'"],
	["cd then eval", "cd {d} && eval '{c}'"],
	["cd in sudo sh -c", "sudo sh -c 'cd {d} && {c}'"],
];

/** Hiding the command, the option, or the target in a variable. */
function variables(s: Seed): [string, string][] {
	const out: [string, string][] = [
		["command in a variable", `C='${cmdOf(s)}'; $C`],
		["command in a variable, eval", `C='${cmdOf(s)}'; eval "$C"`],
		["command in a variable, bash -c", `C='${cmdOf(s)}'; bash -c "$C"`],
		["command in a variable, sh -c", `C='${cmdOf(s)}'; sh -c "$C"`],
		["program in a variable", join(`P=${s.prog};`, "$P", s.opts, s.target)],
		["program in a quoted variable", join(`P=${s.prog};`, '"$P"', s.opts, s.target)],
	];
	if (s.opts) out.push(["options in a variable", join(`O='${s.opts}';`, s.prog, "$O", s.target)]);
	// Unquoted, so `~` expands at the assignment as it would in the command (`T='~'` holds a literal `~`, a relative
	// name); a target of several words can't be held this way.
	if (s.target && !/\s/.test(s.target))
		out.push(["target in a variable", join(`T=${s.target};`, s.prog, s.opts, "$T")]);
	if (s.prog === "git") out.push(["git -C", join("git -C {d}", s.opts, s.target)]);
	return out;
}

const fill = (template: string, c: string, d = "") => template.replaceAll("{c}", c).replaceAll("{d}", d);
// `{c}` inside single quotes: a seed with a single quote can't be placed there unescaped (none has one).

/** Every generated row. */
export function generated(): Row[] {
	const rows: Row[] = [];
	// Interpreter programs (and sed/perl `e`) that run or print the command: neither guard polices program bodies (an old
	// gap, listed).
	const known = (construct: string) =>
		/^(?:python|node) (?:prints|runs)|^sed (?:e |writes)|^perl (?:e flag|system)/.test(construct);
	const add = (cmd: string, cwd: Fixture, want: Want, seed: Seed, construct: string) =>
		rows.push({
			cmd,
			cwd,
			want,
			source: `generate: ${seed.id} / ${construct}`,
			...(want === "ask" && known(construct) ? { known: true } : {}),
		});
	const inPlace = (s: Seed): [string, string][] => [
		...IN_PLACE.map(([n, t]): [string, string] => [n, fill(t, cmdOf(s))]),
		...WRAPPERS.map((w): [string, string] => [`wrapper ${w}`, `${w} ${cmdOf(s)}`]),
		...RUNNERS.map((r): [string, string] => [`runner ${r}`, `${r} ${cmdOf(s)}`]),
		...variables(s)
			.filter(([n]) => n !== "git -C")
			.map(([n, t]): [string, string] => [n, t]),
	];
	for (const s of SEEDS) {
		for (const [n, cmd] of inPlace(s)) {
			for (const f of s.dangerIn) add(cmd, f, "ask", s, n);
			for (const f of s.safeIn) add(cmd, f, "allow", s, `${n} (twin: safe here)`);
		}
		// Moved: from the clean fixture into the place it is dangerous; the twin moves where it is safe.
		const moved: [string, string][] = [
			...MOVED,
			...variables(s).filter(([n]) => n === "git -C"),
			["cd to temp, then back", "cd /tmp && cd {d} && {c}"],
		];
		for (const [n, t] of moved) {
			add(fill(t, cmdOf(s), s.cdDanger), "clean", "ask", s, n);
			if (s.cdSafe) add(fill(t, cmdOf(s), s.cdSafe), "dirty", "allow", s, `${n} (twin: moves where it is safe)`);
		}
		// A relative seed moved to a temp dir is safe there (except git, which isn't in a repo there: unknown).
		if (s.prog === "rm" && s.target === "src")
			for (const [n, t] of MOVED) add(fill(t, cmdOf(s), "/tmp"), "dirty", "allow", s, `${n} (twin: to temp)`);
	}
	for (const s of SAFE_SEEDS)
		for (const [n, cmd] of inPlace(s)) for (const f of s.safeIn) add(cmd, f, "allow", s, `${n} (safe seed)`);
	return rows;
}
