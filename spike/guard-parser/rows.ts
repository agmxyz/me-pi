// Hand-written corpus rows: issue #78 (body and comments), #92, #93, the quoted `>` case, adversarial rows, and the
// user's false-alarm example. `branch` is the session's branch for `git push` (default feature/x).
export interface Row {
	source: string;
	command: string;
	branch?: string;
}

const r = (source: string, branch?: string) => (command: string) => ({ source, command, branch });

const issue78 = [
	"if rm -rf src; then :; fi",
	"! rm -rf src",
	"timeout 5 rm -rf src",
	"nice -n -5 rm -rf src",
	'timeout -s "KILL" 5 rm -rf src',
	"watch 'rm -rf ~'",
	"trap 'rm -rf /' EXIT",
	"trap -- 'rm -rf ~' EXIT",
	"ssh h 'rm -rf ~'",
	"sudo -u root rm -rf src",
	"env -u X rm -rf src",
	"runuser -u me -- rm -rf src",
	"doas -u root rm -rf src",
	'nice -n "-5" git push origin main',
].map(r("#78"));

// The #76 bypass classes the issue body lists, one concrete row each.
const issue76Classes = [
	'LC_ALL="C" rm -rf dist "$HOME"',
	"'rm' -rf /",
	"timeout 5 'rm' -rf /",
	`trap 'rm -rf dist '"$HOME" EXIT`,
	"/usr/bin/env rm -rf /",
	"/usr/bin/sudo rm -rf /",
	'\\export TMPDIR=/; rm -rf "${TMPDIR:?}/x"',
	'builtin export TMPDIR=/; rm -rf "${TMPDIR:?}/x"',
	'TMP""DIR=/ rm -rf "${TMPDIR:?}/x"',
	"1=$(rm -rf ~)",
	"rm -rf '$TMPDIR'/x",
].map(r("#78 body (#76 classes)"));

const comment1 = [
	"doas rm -rf /",
	'su -c "rm -rf /"',
	"runuser -u x rm -rf /",
	"pkexec rm -rf /",
	'doas true; rm -rf "${TMPDIR:?}/x"',
].map(r("#78 comment 1"));

const comment2 = [
	"rm -rf dist \\\n         /Users",
	'rm -rf dist ";" /Users',
	"rm -rf dist \\; /Users",
	"rm -rf dist '&' /Users",
	"rm -rf dist/x${IFS}/Users",
	"rm -rf /tmp/$(true)",
	"rm -rf /tmp/{,}",
	"rm \\-r /Users",
	"rm --r /Users",
].map(r("#78 comment 2"));

const pr92 = [
	"rm -rf dist 2>&1 /Users",
	'rm -rf "${TMPDIR:?}/x" &>/dev/null /Users',
	"rm -rf dist >| log /Users",
	"rm -rf dist &>>log /Users",
	"rm -rf dist >&2 /Users",
	"rm -rf dist 2>&1 ~",
	'rm -rf "${TMPDIR:?}/x" 2>/dev/null /Users',
	"rm -rf dist &> log /Users",
	"rm -rf dist >|log /Users",
	"rm -rf dist 2>&- /Users",
	'rm -rf dist ">" /Users',
	"rm -rf dist 2>&1 | tail -2",
	"rm -rf dist >/dev/null 2>&1",
	'rm -rf "${TMPDIR:?}/x" 2>/dev/null || true',
	"rm -rf dist && echo ok",
	"rm -rf dist &>/dev/null",
	"rm -rf dist >| log",
	"rm -rf dist &> log",
	"rm -rf dist |& tail",
	"rm -rf node_modules dist 2>&1",
	"rm -rf /tmp/&>/dev/null",
	"rm -rf /tmp/&>>log",
	'rm -rf "${TMPDIR:?}/"&>/dev/null',
	"rm -rf ${TMPDIR:?}/&>/dev/null",
	"rm -rf /var/folders/ab/cd/T/&>/dev/null",
	"rm -rf /tmp/>/dev/null",
	"rm -rf /tmp/>&2",
	"rm -rf&>/dev/null /Users",
	"rm -f --recursive&>/dev/null /Users",
	"rm -R&>x /Users",
	"rm -rf>/dev/null /Users",
	"rm -r>log /Users",
	"git push origin main 2>&1 | tail",
].map(r("#92"));

const issue93 = [
	...[
		"git push origin 2>&1",
		"git push 2>&1",
		"git push origin main 2>&1 | tail",
		"git push origin >/dev/null 2>&1",
	].map(r("#93", "main")),
	...["git checkout -- . 2>&1", "git restore . &>/dev/null", "git branch -D old 2>&1"].map(r("#93")),
];

const quotedRedirect = [r("quoted >")("rm -rf '/tmp/x/ > /../../../Users'")];

const adversarial = [
	// Heredocs.
	"cat > f <<'EOF'\nrm -rf ~\nEOF",
	"cat > f <<'EOF'\nrm -rf ~\nEOF\nbash f",
	"bash <<'EOF'\nrm -rf ~\nEOF",
	"bash <<EOF\nrm -rf $HOME\nEOF",
	"cat <<EOF\n$(rm -rf ~)\nEOF",
	"cat > f <<EOF\nx $(rm -rf ~) y\nEOF",
	"cat <<'EOF' | bash\nrm -rf ~\nEOF",
	"tee f <<'EOF' >/dev/null\nrm -rf /\nEOF",
	"sh -s <<'EOF'\ngit push --force origin main\nEOF",
	"bash <<-'EOF'\n\trm -rf ~\n\tEOF",
	"python3 - <<'EOF'\nimport os\nos.system('rm -rf ~')\nEOF",
	"cat > notes.md <<'EOF'\nNever run git push --force origin main.\nEOF",
	"tee notes.md <<'EOF' >/dev/null\nrm -rf ~ is bad\nEOF",
	// Wrappers by full path.
	"/usr/bin/sudo rm -rf ~",
	"/usr/bin/env -i /bin/rm -rf ~",
	"/bin/rm -rf ~",
	"/usr/bin/timeout 5 rm -rf src",
	"/usr/bin/nice -n 5 /usr/bin/git push origin main",
	"/usr/bin/xargs rm -rf <<<'/Users'",
	"/bin/bash -c 'rm -rf ~'",
	"/bin/sh -c 'rm -rf ~'",
	// $'…'.
	"rm -rf $'/Users'",
	"$'r\\x6d' -rf ~",
	"rm $'-rf' ~",
	"rm -rf $'dist\\n/Users'",
	// Arrays.
	'a=(rm -rf ~); "${a[@]}"',
	'args=(-rf /Users); rm "${args[@]}"',
	"a[0]=rm; ${a[0]} -rf ~",
	// Here-strings.
	"bash <<< 'rm -rf ~'",
	'sh <<< "rm -rf $HOME"',
	"rm -rf <<<'x' /Users",
	"xargs rm -rf <<< /Users",
	// Line continuations.
	"sudo \\\n rm -rf ~",
	"rm -r\\\nf ~",
	"git push \\\n origin main",
	// $CMD names.
	"CMD=rm; $CMD -rf ~",
	"$CMD -rf ~",
	"X=git; $X push origin main",
	'"$(echo rm)" -rf ~',
	'r=rm; eval "$r -rf ~"',
	// Re-parsed strings.
	"eval 'rm -rf ~'",
	'eval "rm -rf $HOME"',
	"bash -c 'rm -rf ~'",
	"bash -lc 'git push origin main'",
	"bash -o pipefail -c 'rm -rf ~'",
	"su - root -c 'rm -rf ~'",
	"env -S 'rm -rf ~'",
	"sudo -s rm -rf ~",
	"sudo -E env PATH=/x rm -rf ~",
	"timeout --signal=KILL 5 rm -rf src",
	"nice -5 rm -rf src",
	"flock /tmp/l rm -rf ~",
	"stdbuf -oL rm -rf ~",
	"setsid rm -rf ~",
	"caffeinate -i rm -rf ~",
	"rtk proxy rm -rf ~",
	"command rm -rf ~",
	"command /bin/rm -rf ~",
	"exec rm -rf ~",
	"builtin eval 'rm -rf ~'",
	"time rm -rf src",
	"nohup rm -rf src &",
	"echo /Users | xargs rm -rf",
	"echo /Users | xargs -I{} rm -rf {}",
	"find / -name x -exec rm -rf {} +",
	"find . -name dist -exec rm -rf {} \\;",
	"find . -delete",
	// Control flow and substitutions.
	"(cd / && rm -rf usr)",
	"f() { rm -rf ~; }; f",
	"false || rm -rf ~",
	"[ -d /x ] && rm -rf /x",
	"x=$(rm -rf ~)",
	"echo <(rm -rf ~)",
	"echo `rm -rf ~`",
	'while read d; do rm -rf "$d"; done <<< /Users',
	"for d in /Users; do rm -rf $d; done",
	"case x in x) rm -rf ~;; esac",
	"{ rm -rf ~; }",
	"rm -rf dist; git push --force",
	"git -C ../other push --force",
	"cd /; rm -rf dist",
	"GIT_DIR=/x git push origin HEAD",
	"git push origin HEAD:refs/heads/main",
	// Expected safe.
	'rm -rf "${TMPDIR:?}/x"',
	"rm -rf dist",
	"rm -rf ./node_modules/.cache",
	"rm -f a b c",
	"git status && git log --oneline -3",
	"grep -r 'rm -rf' .",
	"rg 'git push origin main' .",
	'echo "rm -rf /"',
	"git commit -m 'never rm -rf ~'",
	'd=$(mktemp -d) && rm -rf "$d"',
	"cat <<'EOF'\nrm -rf ~\nEOF",
].map(r("adversarial"));

// The user's false-alarm example: a quoted-delimiter heredoc into plain `cat` writing a file, then node runs it.
const falseAlarm = [
	r("user false-alarm")(
		"cat > q.mjs <<'EOF'\nconst a = \"rm -rf /tmp/x\";\nconst b = `rm -rf '/tmp/y'`;\nconst c = 'git push --force origin main';\nconsole.log(a, b, c);\nEOF\nnode q.mjs",
	),
];

export const ROWS: Row[] = [
	...issue78,
	...issue76Classes,
	...comment1,
	...comment2,
	...pr92,
	...issue93,
	...quotedRedirect,
	...adversarial,
	...falseAlarm,
];

/** Rows whose rm/git argv under bash is known by hand: the harness asserts them so a broken stub can't pass silently. */
export const SELF_CHECKS: { command: string; branch?: string; tmpdir?: string; rm?: string[][]; git?: string[][] }[] = [
	{ command: "rm -rf dist \\\n /Users", rm: [["-rf", "dist", "/Users"]] },
	{ command: "sudo -u root rm -rf src", rm: [["-rf", "src"]] },
	{ command: 'rm -rf "a b" \'c\'"d"', rm: [["-rf", "a b", "cd"]] },
	{ command: "timeout -s KILL 5 rm -rf src 2>&1 /Users", rm: [["-rf", "src", "/Users"]] },
	{ command: "echo /Users | xargs rm -rf", rm: [["-rf", "/Users"]] },
	{ command: "/usr/bin/env -i /bin/rm -rf x", rm: [["-rf", "x"]] },
	{ command: "rm -rf dist 2>&- /Users", rm: [["-rf", "dist", "/Users"]] },
	{ command: 'rm -rf "${TMPDIR:?}/x"', tmpdir: "/var/folders/zz/stub/T", rm: [["-rf", "/var/folders/zz/stub/T/x"]] },
	{ command: 'rm -rf "${TMPDIR:?}/x"', tmpdir: "", rm: [] },
	{ command: "git -C x push origin main 2>&1 | tail", git: [["-C", "x", "push", "origin", "main"]] },
	{ command: "bash -c 'git push origin main'", git: [["push", "origin", "main"]] },
	{ command: "trap 'rm -rf ~' EXIT", rm: [["-rf", "/Users/stub"]] },
	{ command: "echo rm -rf / && grep 'git push' x", rm: [], git: [] },
	{ command: "cat > f <<'EOF'\nrm -rf ~\nEOF\nbash f", rm: [["-rf", "/Users/stub"]] },
];
