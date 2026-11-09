import assert from "node:assert/strict";
import test from "node:test";

const { initShell, parseShell, tmpdirRebinds, isWrapper } = await import(
	"../packages/pi-workers/extensions/guard-shell.ts"
);

type Parsed = ReturnType<typeof parseShell>;
type Ok = Extract<Parsed, { ok: true }>;

function parsed(src: string): Ok {
	const r = parseShell(src);
	assert.equal(r.ok, true, `parse failed for ${JSON.stringify(src)}: ${r.ok ? "" : r.reason}`);
	return r as Ok;
}
const argv = (src: string, at = 0) => parsed(src).commands[at].argv.map((w) => w.value);
const names = (src: string) => parsed(src).commands.map((c) => c.name);
const find = (src: string, name: string) => parsed(src).commands.find((c) => c.name === name);

// Runs first: a failed load leaves the module unloaded and parsing reports it instead of throwing.
test("initShell rejects a missing or broken grammar and stays unloaded", async () => {
	await assert.rejects(initShell("/nonexistent/tree-sitter-bash.wasm"), /cannot load the bash parser/);
	assert.deepEqual(parseShell("true"), { ok: false, reason: "not-loaded" });
	assert.deepEqual(parseShell("echo hi"), { ok: false, reason: "not-loaded" });
	assert.equal(tmpdirRebinds("echo hi"), true);
	// Not a WASM module at all.
	await assert.rejects(initShell(new URL(import.meta.url)), /cannot load the bash parser/);
	assert.deepEqual(parseShell("true"), { ok: false, reason: "not-loaded" });
});

test("initShell loads the vendored grammar once", async () => {
	await initShell();
	assert.equal(parseShell("true").ok, true);
	await initShell(); // already loaded: a no-op
	assert.deepEqual(argv("echo hi"), ["echo", "hi"]);
});

test("tags words literal, quoted, or expansion", () => {
	const [, a, b, c, d, e, f] = parsed(`printf \\-r 'a'"b"c $'\\t' "$x" ~/y *.ts`).commands[0].argv;
	assert.deepEqual([a.value, a.kind], ["-r", "literal"]);
	assert.deepEqual([b.value, b.kind], ["abc", "quoted"]);
	assert.deepEqual([c.value, c.kind], ["\t", "quoted"]);
	assert.equal(d.kind, "expansion");
	assert.equal(e.kind, "expansion");
	assert.equal(f.kind, "expansion");
	assert.equal(parsed("echo a{b,c}").commands[0].argv[1].kind, "expansion");
	assert.equal(parsed("/usr/bin/env true").commands[0].name, "env");
	assert.equal(parsed('"$T/run.sh"').commands[0].name, undefined);
});

test("a redirect takes exactly one word; the rest go back to argv", () => {
	assert.deepEqual(argv("rm -rf src 2>&1 /Users"), ["rm", "-rf", "src", "/Users"]);
	assert.deepEqual(argv("rm -rf src >log /Users"), ["rm", "-rf", "src", "/Users"]);
	// `>&-` closes a descriptor and takes no word.
	const closed = parsed("rm -rf src 2>&- /Users").commands[0];
	assert.deepEqual(
		closed.argv.map((w) => w.value),
		["rm", "-rf", "src", "/Users"],
	);
	assert.equal(closed.redirects[0].target, undefined);
	assert.equal(parsed("echo x >out").commands[0].redirects[0].target?.value, "out");
});

test("undoes tree-sitter-bash word misreads", () => {
	// `" "` folded into the closing-quote token.
	assert.deepEqual(argv('rm -rf dist" "x /etc'), ["rm", "-rf", "dist x", "/etc"]);
	// A `-` before `<<EOF` is in no node.
	assert.deepEqual(argv("git commit -F - <<EOF\nmsg\nEOF"), ["git", "commit", "-F", "-"]);
	// `\<newline>` inside a word joins it.
	assert.deepEqual(argv("rm -r\\\nf /x"), ["rm", "-rf", "/x"]);
	// `$"…"` is a translated string: the `$` disappears.
	const [, t] = parsed('echo $"hi there"').commands[0].argv;
	assert.deepEqual([t.value, t.kind], ["hi there", "quoted"]);
});

test("re-parses `<<'EOF' 2>&1 | …` after moving the redirect before the opener", () => {
	const r = parsed("cat <<'EOF' 2>&1 | tail -n 1\nrm -rf /\nEOF");
	assert.deepEqual(r.commands.map((c) => c.name).sort(), ["cat", "tail"]);
	const cat = r.commands.find((c) => c.name === "cat");
	assert.equal(cat?.heredocs[0].body.includes("rm -rf /"), true);
});

test("a heredoc written to a file is data; one fed to a shell is commands", () => {
	const written = parsed("cat > f.sh <<'EOF'\nrm -rf /\nEOF");
	assert.deepEqual(
		written.commands.map((c) => c.name),
		["cat"],
	);
	assert.deepEqual(written.commands[0].heredocs, [{ body: "rm -rf /\n", span: [19, 28], literal: true }]);
	assert.equal(written.commands[0].redirects.find((x) => x.op === ">")?.target?.value, "f.sh");
	const run = find("bash <<EOF\nrm -rf /\nEOF", "rm");
	assert.ok(run);
	assert.deepEqual(run.via, ["bash"]);
	assert.equal(run.reparsed, true);
	assert.deepEqual(
		run.argv.map((w) => w.value),
		["rm", "-rf", "/"],
	);
	assert.deepEqual(
		parsed("bash <<EOF\nrm -rf /\nEOF").commands.map((c) => [c.name, c.reparsed]),
		[
			["bash", false],
			["rm", true],
		],
	);
});

test("`bash --version` and `bash -n f` run nothing", () => {
	assert.deepEqual(names("bash --version"), ["bash"]);
	assert.deepEqual(names("bash -n f"), ["bash"]);
	assert.deepEqual(names("bash run.sh"), ["bash"]);
	// A shell reading a stdin the text doesn't show.
	const piped = parsed("cat x | bash").commands.at(-1);
	assert.equal(piped?.dynamicBody, "<stdin>");
});

test("unwraps wrappers", () => {
	assert.deepEqual(find("sudo -u root rm -rf x", "rm")?.via, ["sudo"]);
	assert.deepEqual(find("env -i FOO=1 rm -rf x", "rm")?.via, ["env"]);
	assert.deepEqual(find("timeout 5 nice -n 2 rm -rf x", "rm")?.via, ["timeout", "nice"]);
	assert.deepEqual(find("command rm -rf x", "rm")?.via, ["command"]);
	assert.equal(find("command -v rm", "rm"), undefined);
	assert.equal(find("xargs -0 rm -rf", "rm")?.openArgs, true);
	assert.equal(find("find . -name x -exec rm -rf {} \\;", "rm")?.openArgs, true);
	const dashC = find("sh -c 'rm -rf x'", "rm");
	assert.deepEqual([dashC?.via, dashC?.reparsed], [["sh"], true]);
	assert.deepEqual(find("bash -lc 'rm -rf x'", "rm")?.via, ["bash"]);
	assert.deepEqual(find("eval rm -rf x", "rm")?.via, ["eval"]);
	assert.deepEqual(find("trap 'rm -rf x' EXIT", "rm")?.via, ["trap"]);
	assert.equal(find("ssh host 'rm -rf ~'", "rm")?.remote, true);
	assert.equal(find("watch 'rm -rf x'", "rm")?.remote, true);
	assert.deepEqual(find("su -c 'rm -rf x' root", "rm")?.via, ["su"]);
	const dynamic = parsed('eval "rm -rf $x"').commands.at(-1);
	assert.equal(dynamic?.dynamicBody, '"rm -rf $x"');
	assert.equal(isWrapper("sudo"), true);
	assert.equal(isWrapper("rm"), false);
});

test("records assignments, offsets, and control flow", () => {
	assert.deepEqual(find("GIT_DIR=x git status", "git")?.assignments, ["GIT_DIR"]);
	const r = parsed("cd a && rm -rf b; echo $(rm -rf c)");
	const [cd, rm] = r.commands;
	assert.equal(cd.certain, true);
	assert.equal(rm.certain, false);
	assert.equal(
		cd.after.some(([a, e]) => rm.at >= a && rm.at < e),
		true,
	);
	assert.equal(r.commands.find((c) => c.argv[2]?.value === "c")?.script, "cd a && rm -rf b; echo $(rm -rf c)");
	// A re-parsed string's commands take the outer command's offset.
	const inner = find("true; sh -c 'rm -rf x'", "rm");
	assert.equal(inner?.at, "true; ".length);
});

test("reads bindings", () => {
	const b = parsed('d=/tmp/x; rm -rf "$d"').bindings;
	assert.deepEqual(
		b.values.get("d")?.map((w) => w.value),
		["/tmp/x"],
	);
	assert.equal(b.firstAt.get("d"), 0);
	assert.equal(b.opaque, false);
	assert.equal(parsed("X=1 cmd").bindings.values.get("X"), null);
	assert.equal(parsed("read d; rm -rf $d").bindings.values.get("d"), null);
	assert.deepEqual(
		parsed("for f in a b; do echo $f; done")
			.bindings.values.get("f")
			?.map((w) => w.value),
		["a", "b"],
	);
	assert.equal(parsed("false && t=x && rm -rf $t").bindings.conditional.has("t"), true);
	for (const src of ["eval x", ". ./vars", "((z))", "declare -n r=x", "echo $" + "{!x}"])
		assert.equal(parsed(src).bindings.opaque, true, src);
});

test("reports syntax errors and limits as failures", () => {
	assert.deepEqual(parseShell("echo 'unterminated"), { ok: false, reason: "syntax" });
	assert.deepEqual(parseShell(`echo ${"x".repeat(100_001)}`), { ok: false, reason: "limit" });
	assert.deepEqual(parseShell(`${"eval ".repeat(8)}echo hi`), { ok: false, reason: "limit" });
	assert.deepEqual(parseShell("true;".repeat(5_001)), { ok: false, reason: "limit" });
});

test("tmpdirRebinds flags every TMPDIR rebinding (#77, #87)", () => {
	for (const command of [
		`TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`,
		`export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`export TMPDIR=/ && rm -rf "\${TMPDIR:?}/Users"`,
		`\\export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`builtin export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`declare -x TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`f() { local TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"; }; f`,
		`typeset TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`readonly TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`read TMPDIR <<< /; rm -rf "\${TMPDIR:?}/Users"`,
		`mapfile TMPDIR < x; rm -rf "\${TMPDIR:?}/Users"`,
		`printf -v TMPDIR /; rm -rf "\${TMPDIR:?}/Users"`,
		`export TMP''DIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`declare -x TM"P"DIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`export TMP""DIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`env TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`,
		`/usr/bin/env TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`,
		`env -i rm -rf "\${TMPDIR:?}/Users"`,
		`sudo rm -rf "\${TMPDIR:?}/Users"`,
		`/usr/bin/sudo rm -rf "\${TMPDIR:?}/Users"`,
		`doas true; rm -rf "\${TMPDIR:?}/Users"`,
		`su -l x; rm -rf "\${TMPDIR:?}/Users"`,
		`runuser -u x true; rm -rf "\${TMPDIR:?}/Users"`,
		`pkexec true; rm -rf "\${TMPDIR:?}/Users"`,
		`unset TMPDIR; rm -rf "\${TMPDIR:?}/Users"`,
		`set -a; . ./vars; rm -rf "\${TMPDIR:?}/Users"`,
		`set -a && source vars && rm -rf "\${TMPDIR:?}/Users"`,
		`source ./vars; rm -rf "\${TMPDIR:?}/Users"`,
		`. ./vars; rm -rf "\${TMPDIR:?}/Users"`,
		`cd /tmp/x && . vars && rm -rf "\${TMPDIR:?}/Users"`,
		`.>/dev/null ./v; rm -rf "\${TMPDIR:?}/Users"`,
		`.>>x ./v; rm -rf "\${TMPDIR:?}/Users"`,
		`.>|x ./v; rm -rf "\${TMPDIR:?}/Users"`,
		`eval x; rm -rf "\${TMPDIR:?}/Users"`,
		`bash -c 'TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"'`,
		`z=TMP; z+=DIR=/; ((z)); rm -rf "\${TMPDIR:?}/Users"`,
		`let z; rm -rf "\${TMPDIR:?}/Users"`,
		`declare -n r=TMPDIR; rm -rf "\${TMPDIR:?}/Users"`,
		`echo \${!x}; rm -rf "\${TMPDIR:?}/Users"`,
		`\${z}=1; rm -rf "\${TMPDIR:?}/Users"`,
		`a[z]=1; rm -rf "\${TMPDIR:?}/Users"`,
		`e{xport,} TMP{DIR,}=/; rm -rf "\${TMPDIR:?}/Users"`,
		`$x TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
		`git commit -m "x" <<< "$(export TMPDIR=/)"; rm -rf "\${TMPDIR:?}/Users"`,
	])
		assert.equal(tmpdirRebinds(command), true, command);
});

test("tmpdirRebinds ignores a `$` or `?` that rebinds nothing", () => {
	for (const command of [
		`rm -rf "\${TMPDIR:?}/x"; echo $?`,
		`cd /tmp/x && rm -rf "\${TMPDIR:?}/x"`,
		`rm -rf "\${TMPDIR:?}/x" 2>/dev/null || true`,
		// Another expansion in a target is the policy's concern, not a rebinding.
		`rm -rf "\${TMPDIR:?}/x" "\${TMPDIR:?}/$y"`,
		`X=1 rm -rf "\${TMPDIR:?}/x"`,
		`a[0]=1; ls ?.txt`,
		"git status",
	])
		assert.equal(tmpdirRebinds(command), false, command);
});
