/**
 * What guard knows about git's command line, in one place: its own sub-commands (anything else may be an alias, whose
 * expansion is config the text doesn't show), the `-c` keys that are only data, the sub-commands and options that run
 * a shell string, and git's unique-prefix long options (`--ha` is `--hard`). Facts only; guard-policy decides.
 */

/** git's own sub-commands (`git --list-cmds=main,nohelpers`, git 2.53) plus a few common built-ins it omits there. */
export const GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"add",
	"am",
	"annotate",
	"apply",
	"archimport",
	"archive",
	"backfill",
	"bisect",
	"blame",
	"branch",
	"bugreport",
	"bundle",
	"cat-file",
	"check-attr",
	"check-ignore",
	"check-mailmap",
	"check-ref-format",
	"checkout",
	"checkout-index",
	"cherry",
	"cherry-pick",
	"clean",
	"clone",
	"column",
	"commit",
	"commit-graph",
	"commit-tree",
	"config",
	"count-objects",
	"credential",
	"credential-cache",
	"credential-netrc",
	"credential-osxkeychain",
	"credential-store",
	"cvsexportcommit",
	"cvsimport",
	"cvsserver",
	"daemon",
	"describe",
	"diagnose",
	"diff",
	"diff-files",
	"diff-index",
	"diff-pairs",
	"diff-tree",
	"difftool",
	"fast-export",
	"fast-import",
	"fetch",
	"fetch-pack",
	"filter-branch",
	"fmt-merge-msg",
	"for-each-ref",
	"for-each-repo",
	"format-patch",
	"fsck",
	"fsck-objects",
	"gc",
	"get-tar-commit-id",
	"grep",
	"hash-object",
	"help",
	"hook",
	"http-backend",
	"http-fetch",
	"http-push",
	"imap-send",
	"index-pack",
	"init",
	"init-db",
	"instaweb",
	"interpret-trailers",
	"jump",
	"last-modified",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"mailinfo",
	"mailsplit",
	"maintenance",
	"merge",
	"merge-base",
	"merge-file",
	"merge-index",
	"merge-octopus",
	"merge-one-file",
	"merge-ours",
	"merge-recursive",
	"merge-recursive-ours",
	"merge-recursive-theirs",
	"merge-resolve",
	"merge-subtree",
	"merge-tree",
	"mergetool",
	"mktag",
	"mktree",
	"multi-pack-index",
	"mv",
	"name-rev",
	"notes",
	"p4",
	"pack-objects",
	"pack-redundant",
	"pack-refs",
	"patch-id",
	"pickaxe",
	"prune",
	"prune-packed",
	"pull",
	"push",
	"quiltimport",
	"range-diff",
	"read-tree",
	"rebase",
	"receive-pack",
	"reflog",
	"refs",
	"remote",
	"remote-ext",
	"remote-fd",
	"remote-ftp",
	"remote-ftps",
	"remote-http",
	"remote-https",
	"repack",
	"replace",
	"replay",
	"repo",
	"request-pull",
	"rerere",
	"reset",
	"restore",
	"rev-list",
	"rev-parse",
	"revert",
	"rm",
	"send-email",
	"send-pack",
	"shell",
	"shortlog",
	"show",
	"show-branch",
	"show-index",
	"show-ref",
	"sparse-checkout",
	"stage",
	"stash",
	"status",
	"stripspace",
	"submodule",
	"subtree",
	"switch",
	"symbolic-ref",
	"tag",
	"unpack-file",
	"unpack-objects",
	"update-index",
	"update-ref",
	"update-server-info",
	"upload-archive",
	"upload-pack",
	"var",
	"verify-commit",
	"verify-pack",
	"verify-tag",
	"version",
	"whatchanged",
	"worktree",
	"write-tree",
	"help",
	"version",
	"whatchanged",
	"lfs",
	"flow",
	"gui",
	"citool",
	"gitk",
	"credential-manager",
	// An add-on guard's rules already name: a dropped history rewrite, still blocked in workers.
	"filter-repo",
]);

/**
 * `git -c KEY=VALUE` keys whose value is only data (names, colours, defaults, display). Any other key may name a
 * program or command git runs (`core.fsmonitor`, `core.sshCommand`, `alias.*`, `*.textconv`, `core.pager`, …).
 */
const DATA_KEY =
	/^(?:user\.(?:name|email)|author\.(?:name|email)|committer\.(?:name|email)|color\..+|advice\..+|init\.defaultbranch|core\.(?:quotepath|autocrlf|safecrlf|filemode|ignorecase|precomposeunicode|longpaths|abbrev|commentchar|whitespace)|commit\.(?:gpgsign|verbose|cleanup)|tag\.gpgsign|log\.(?:date|decorate|showsignature|follow)|diff\.(?:noprefix|mnemonicprefix|renames|algorithm|context|colormoved|relative)|status\.(?:short|branch|showuntrackedfiles)|pull\.(?:rebase|ff)|push\.(?:default|autosetupremote|followtags)|fetch\.(?:prune|parallel)|merge\.(?:ff|conflictstyle)|rebase\.(?:autosquash|autostash|updaterefs)|rerere\.enabled|protocol\.version|http\.(?:version|postbuffer)|safe\.directory|maintenance\.auto|gc\.auto(?:detach)?|feature\..+|pack\.threads|grep\.(?:linenumber|extendedregexp)|blame\.(?:date|coloring)|format\.pretty|i18n\..+|column\.ui|branch\.sort|tag\.sort|versionsort\..+)$/i;

/** Whether `git -c KEY=…` sets only data, never something git runs. */
export function gitDataKey(key: string): boolean {
	return DATA_KEY.test(key);
}

/**
 * Sub-commands that run a shell string or program the caller gives: `rebase -x/--exec`, `filter-branch` with any
 * `--*-filter`, `bisect run`, `submodule foreach`, `for-each-repo --config`, `difftool/mergetool --extcmd/-x`. Returns
 * a short description, or undefined.
 */
export function gitRunsString(sub: string, words: string[]): string | undefined {
	const has = (re: RegExp) => words.some((w) => re.test(w));
	switch (sub) {
		case "rebase":
			return has(/^-x|^--exec(?:=|$)|^--ex?e?c?$/) || has(/^-[A-Za-z]*x/)
				? "rebase --exec runs a shell string"
				: undefined;
		case "filter-branch":
			return has(/^--[\w-]*filter(?:=|$)/) || has(/^--setup(?:=|$)/)
				? "filter-branch runs a shell filter"
				: undefined;
		case "bisect":
			return words[0] === "run" ? "bisect run runs a command" : undefined;
		case "submodule":
			return words.includes("foreach") ? "submodule foreach runs a shell string" : undefined;
		case "for-each-repo":
			return "for-each-repo runs a git command in other repos";
		case "difftool":
		case "mergetool":
			return has(/^-x$|^--extcmd(?:=|$)|^--tool(?:=|$)|^-t$/) ? `${sub} runs an external tool` : undefined;
		case "send-email":
		case "instaweb":
		case "daemon":
			return `${sub} runs programs`;
		default:
			return undefined;
	}
}

/**
 * Long options guard's git rules check, so a unique prefix git accepts (`reset --ha`, `clean --fo`, `push --mi`)
 * reads as the full option. Only prefixes of at least 3 characters (`--x`) are expanded, and only when one guarded
 * option starts so.
 */
const GUARDED_LONG = [
	"--hard",
	"--force",
	"--force-with-lease",
	"--force-if-includes",
	"--discard-changes",
	"--mirror",
	"--delete",
	"--all",
	"--recursive",
	"--upload-pack",
	"--receive-pack",
	"--open-files-in-pager",
	"--config-env",
	"--extcmd",
	"--worktree",
	"--staged",
	"--dry-run",
	"--exec",
	"--amend",
];

/** A git long option written as a unique prefix of a guarded one, spelled out (`--ha` → `--hard`); else as given. */
export function gitLongOption(word: string): string {
	const m = /^(--[\w-]+)(=.*)?$/.exec(word);
	if (!m || m[1].length < 3 || GUARDED_LONG.includes(m[1])) return word;
	// git resolves an abbreviation shared by `--force` and `--force-with-lease` to the one it is a prefix of most
	// directly: the shortest match, if every other match extends it (`--fo` → `--force`).
	const hits = GUARDED_LONG.filter((o) => o.startsWith(m[1])).sort((a, b) => a.length - b.length);
	const best = hits[0];
	return best !== undefined && hits.every((h) => h.startsWith(best)) ? best + (m[2] ?? "") : word;
}

/**
 * Options whose value is a command git runs: `--upload-pack`/`-u` (fetch, clone, pull, ls-remote), `--receive-pack`
 * and `--exec` (push, archive, send-pack), `-O`/`--open-files-in-pager` (grep), `--config-env` (a config key from the
 * environment), `--extcmd` (difftool). Prefix forms count (`--upload` is `--upload-pack`). Returns the option as named
 * in the command, or undefined.
 */
export function gitCommandOption(sub: string, words: string[]): string | undefined {
	for (const w of words) {
		if (w === "--") return undefined;
		const long = /^--([\w-]+)(?:=|$)/.exec(w)?.[1];
		if (long && long.length >= 2) {
			const hit = COMMAND_OPTIONS.find((o) => o.startsWith(long));
			if (hit && (long.length >= 3 || hit === long)) return `--${hit}`;
		}
		// Short forms: `-u <cmd>` takes a command for fetch/clone/pull/ls-remote (not `push -u`, upstream); `-O[cmd]` for
		// grep.
		if (/^-u/.test(w) && UPLOAD_U.has(sub)) return "-u";
		if (/^-O/.test(w) && sub === "grep") return "-O";
	}
	return undefined;
}
const COMMAND_OPTIONS = ["upload-pack", "receive-pack", "exec", "open-files-in-pager", "config-env", "extcmd"];
const UPLOAD_U = new Set(["fetch", "clone", "pull", "ls-remote"]);

/**
 * Environment variables git, or a program it runs, reads as a command or as a config source (which can name
 * commands). Also the ones that point git at another repo or work tree (`GIT_DIR`, …): where it acts is then unknown.
 */
export const GIT_COMMAND_ENV =
	/^(?:GIT_(?:EDITOR|SEQUENCE_EDITOR|SSH|SSH_COMMAND|SSH_VARIANT|EXTERNAL_DIFF|PAGER|ASKPASS|PROXY_COMMAND|EXEC_PATH|TEMPLATE_DIR|CONFIG|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|DIFF_OPTS|ALTERNATE_OBJECT_DIRECTORIES|OBJECT_DIRECTORY|INDEX_FILE|NAMESPACE|TRACE2_EVENT|SSL_.*)|SSH_ASKPASS|EDITOR|VISUAL|PAGER|LESSOPEN|LESSCLOSE)$/;
export const GIT_ELSEWHERE_ENV = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR)$/;

/**
 * A `git config` that writes a key whose value git may run (`core.editor`, `core.sshCommand`, `alias.*`, …): the key,
 * or undefined. Reads (`--get`, `--list`, `get`, one operand), removals (`--unset`), and data keys (`user.name`) are
 * not writes of code. `--file`/`--blob` writes to another file are writes too.
 */
export function gitConfigCodeWrite(words: string[]): string | undefined {
	const READS =
		/^(?:--get(?:-all|-regexp|-urlmatch|-color(?:bool)?)?|--list|-l|--show-origin|--show-scope|--name-only|--null|-z|--unset(?:-all)?|--remove-section|--rename-section|-e|--edit)$/;
	if (words.some((w) => READS.test(w))) return undefined;
	const VALUE_OPTS = new Set(["--file", "-f", "--blob", "--type", "--default", "--comment", "--value"]);
	const ops: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		if (VALUE_OPTS.has(w)) {
			i++;
			continue;
		}
		if (w.startsWith("-")) continue;
		ops.push(w);
	}
	// The `git config set|unset|get|list…` sub-command form (git 2.46+).
	if (["get", "list", "unset", "remove-section", "rename-section", "edit"].includes(ops[0] ?? "")) return undefined;
	const rest = ops[0] === "set" ? ops.slice(1) : ops;
	if (rest.length < 2) return undefined; // one operand reads
	return gitDataKey(rest[0]) ? undefined : rest[0];
}
