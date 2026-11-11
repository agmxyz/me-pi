import assert from "node:assert/strict";
import test from "node:test";

const {
	default: registerGuard,
	classify,
	workerRisk,
	gitWorktreeRemovals,
	gitWriteDirs,
	PROTECTED_BRANCHES,
} = await import("../packages/pi-workers/extensions/guard.ts");

const onMain = () => "main";
const onFeature = () => "feature/x";

test("flags pushes to main/master, history rewrites, discards, and recursive rm", () => {
	for (const [command, branch, label] of [
		["git push origin main", onFeature, "push to main/master"],
		["git push -u origin master", onFeature, "push to main/master"],
		["git push origin HEAD:main", onFeature, "push to main/master"],
		["git push origin feature/x:refs/heads/main", onFeature, "push to main/master"],
		["git push", onMain, "push to main/master"],
		["git push origin", onMain, "push to main/master"],
		["git push origin HEAD", onMain, "push to main/master"],
		["git push origin main 2>&1 | tail", onFeature, "push to main/master"],
		// A redirect is not a refspec: these push the current branch (#93).
		["git push origin 2>&1", onMain, "push to main/master"],
		["git push origin 2>&1 | tail -3", onMain, "push to main/master"],
		["git push origin >/dev/null 2>&1", onMain, "push to main/master"],
		["git push origin > log", onMain, "push to main/master"],
		["git push origin 2>> log", onMain, "push to main/master"],
		["git push origin &>/dev/null", onMain, "push to main/master"],
		["git push origin &>> log", onMain, "push to main/master"],
		["git push origin >| log", onMain, "push to main/master"],
		["git push origin >&2", onMain, "push to main/master"],
		["git push origin>log", onMain, "push to main/master"],
		["git push origin 2>&1 feature/x:main", onMain, "push to main/master"],
		["git push 2>&1 origin", onMain, "push to main/master"],
		["git push -f origin 2>&1", onFeature, "force push"],
		["git checkout -- src 2>&1", onFeature, "discard changes (git checkout)"],
		["git restore src 2>&1", onFeature, "discard changes (git restore)"],
		["git branch -D old 2>&1", onFeature, "git branch -D"],
		// A redirect glued to an option or a refspec keeps the part before it.
		["git push origin main&>/dev/null", onFeature, "push to main/master"],
		["git push --force&>/dev/null origin x", onFeature, "force push"],
		["git push -f&>x origin x", onFeature, "force push"],
		["git reset --hard&>x", onFeature, "git reset --hard"],
		["git clean -fd&>x", onFeature, "git clean -f"],
		["git push origin main|&tee log", onFeature, "push to main/master"],
		// Quoted `<>` can't be told from a redirect: the words are read whole.
		['git push origin "a>b:main"', onFeature, "push to main/master"],
		["git push origin 'x<y>:main'", onFeature, "push to main/master"],
		// A quote elsewhere in the command doesn't hide a glued redirect.
		['git push origin "x" --force&>log', onFeature, "force push"],
		['git push -f&>x "origin" x', onFeature, "force push"],
		['git push "origin" main&>log', onFeature, "push to main/master"],
		['git reset --hard&>x -- "a"', onFeature, "git reset --hard"],
		['git clean -fd&>x "p"', onFeature, "git clean -f"],
		// Each reading is judged on its own: the whole-word reading never hides the current-branch push.
		['git push "origin"&>x', onMain, "push to main/master"],
		['git push "origin" 2>&1', onMain, "push to main/master"],
		// Each command after a redirect is still judged.
		["git push origin >&2; git push --force", onFeature, "force push"],
		["git push origin &>/dev/null && git reset --hard", onFeature, "git reset --hard"],
		["git push origin &>/dev/null && rm -rf ~", onFeature, "recursive rm"],
		["git push origin < f main", onFeature, "push to main/master"],
		["git push origin <<< x main", onFeature, "push to main/master"],
		["rm -rf&>x dist", onFeature, "recursive rm"],
		["git push --all origin", onFeature, "push to main/master"],
		["git push --delete origin main", onFeature, "push to main/master"],
		["git -C /some/path push origin main", onFeature, "push to main/master"],
		["rtk proxy git push origin main", onFeature, "push to main/master"],
		["GIT_SSH_COMMAND='ssh -i k' git push origin main", onFeature, "push to main/master"],
		["git push origin feature/x && git push origin main", onFeature, "push to main/master"],
		// Quotes, subshells, and `sh -c` must not hide the branch.
		['bash -c "git push origin main"', onFeature, "push to main/master"],
		["sh -c 'git push origin main'", onFeature, "push to main/master"],
		["(git push origin main)", onFeature, "push to main/master"],
		["echo $(git push origin main)", onFeature, "push to main/master"],
		['git push origin "main"', onFeature, "push to main/master"],
		["git push origin 'master'", onFeature, "push to main/master"],
		// A bare push from another directory targets an unknown branch.
		["cd ../other && git push", onFeature, "push after changing directory or branch (target unknown)"],
		["git -C ../other push", onFeature, "push after changing directory or branch (target unknown)"],
		["git push --force origin feature/x", onFeature, "force push"],
		["git push -f", onFeature, "force push"],
		["git push --force-with-lease origin feature/x", onFeature, "force push"],
		["git push origin +feature/x", onFeature, "force push"],
		["git reset --hard HEAD~1", onFeature, "git reset --hard"],
		["git clean -fdx", onFeature, "git clean -f"],
		["git checkout -- src/a.ts", onFeature, "discard changes (git checkout)"],
		["git checkout .", onFeature, "discard changes (git checkout)"],
		["git restore src/a.ts", onFeature, "discard changes (git restore)"],
		["git restore --staged --worktree src/a.ts", onFeature, "discard changes (git restore)"],
		["git branch -D old", onFeature, "git branch -D"],
		["git branch --delete --force old", onFeature, "git branch -D"],
		["rm -rf src", onFeature, "recursive rm"],
		["rm -rf dist src", onFeature, "recursive rm"],
		["rm -rf dist/../src", onFeature, "recursive rm"],
		["rm -rf *", onFeature, "recursive rm"],
		["rm -rf $DIR", onFeature, "recursive rm"],
		["rm -rf ~", onFeature, "recursive rm"],
		["rm -rf /tmp/", onFeature, "recursive rm"],
		["rm -rf /tmp/*", onFeature, "recursive rm"],
		["rm -rf /var/folders/*", onFeature, "recursive rm"],
		['rm -rf "$TMPDIR"/*', onFeature, "recursive rm"],
		["rm -rf $TMPDIR/x", onFeature, "recursive rm"],
		["rm -rf /tmp/a*", onFeature, "recursive rm"],
		["rm -rf /tmp/x/../../etc", onFeature, "recursive rm"],
		["rm -rf /tmpx", onFeature, "recursive rm"],
		["rm -rf dist2", onFeature, "recursive rm"],
		["rm -rf dist*", onFeature, "recursive rm"],
		[`rm -rf "\${TMPDIR:?}"/*`, onFeature, "recursive rm"],
		["rm -rf /var/folders/ab/cd/T/x*", onFeature, "recursive rm"],
		// A redirect containing `&` or `|` does not end rm's arguments; later words are still targets (#88).
		...[
			"rm -rf dist 2>&1 /Users",
			`rm -rf "\${TMPDIR:?}/x" &>/dev/null /Users`,
			"rm -rf dist >| log /Users",
			"rm -rf dist &>>log /Users",
			"rm -rf dist >&2 /Users",
			"rm -rf dist 2>&1 ~",
			`rm -rf "\${TMPDIR:?}/x" 2>/dev/null /Users`,
			"rm -rf dist &> log /Users",
			"rm -rf dist >|log /Users",
			"rm -rf dist 2>&- /Users",
			'rm -rf dist ">" /Users',
			// A redirect glued to a temp root: rm gets the root (`/tmp/`).
			"rm -rf /tmp/&>/dev/null",
			"rm -rf /tmp/&>>log",
			`rm -rf "\${TMPDIR:?}/"&>/dev/null`,
			`rm -rf \${TMPDIR:?}/&>/dev/null`,
			"rm -rf /var/folders/ab/cd/T/&>/dev/null",
			"rm -rf /tmp/>/dev/null",
			"rm -rf /tmp/>&2",
			// A redirect glued to the recursive flag: rm still gets `-rf`.
			"rm -rf&>/dev/null /Users",
			"rm -f --recursive&>/dev/null /Users",
			"rm -R&>x /Users",
			"rm -rf>/dev/null /Users",
			"rm -r>log /Users",
		].map((command) => [command, onFeature, "recursive rm"]),
		// `${TMPDIR:?}` only catches an unset TMPDIR, not one the command rebinds first (#77).
		...[
			`TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`,
			`export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
			`export TMPDIR=/ && rm -rf "\${TMPDIR:?}/Users"`,
			`\\export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
			`builtin export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
			`declare -x TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
			`f() { local TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"; }; f`,
			`typeset TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
			`read TMPDIR <<< /; rm -rf "\${TMPDIR:?}/Users"`,
			`printf -v TMPDIR /; rm -rf "\${TMPDIR:?}/Users"`,
			// A quote-split prefix (`TMP""DIR=/ rm`) is a failing command, not an assignment; builtins take it.
			`export TMP''DIR=/; rm -rf "\${TMPDIR:?}/Users"`,
			`declare -x TM"P"DIR=/; rm -rf "\${TMPDIR:?}/Users"`,
			`export TMP""DIR=/; rm -rf "\${TMPDIR:?}/Users"`,
			`env TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`,
			`/usr/bin/env TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`,
			`env -i rm -rf "\${TMPDIR:?}/Users"`,
			`sudo rm -rf "\${TMPDIR:?}/Users"`,
			`/usr/bin/sudo rm -rf "\${TMPDIR:?}/Users"`,
			// Privilege wrappers may reset the environment; they rebind TMPDIR wherever they appear.
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
			// `.` followed by a redirect still sources.
			`.>/dev/null ./v; rm -rf "\${TMPDIR:?}/Users"`,
			`.>>x ./v; rm -rf "\${TMPDIR:?}/Users"`,
			`.>|x ./v; rm -rf "\${TMPDIR:?}/Users"`,
			`bash -c 'TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"'`,
			`z=TMP; z+=DIR=/; ((z)); rm -rf "\${TMPDIR:?}/Users"`,
			`e{xport,} TMP{DIR,}=/; rm -rf "\${TMPDIR:?}/Users"`,
			`$x TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`,
			`rm -rf "\${TMPDIR:?}/x" "\${TMPDIR:?}/$y"`,
			`git commit -m "x" <<< "$(export TMPDIR=/)"; rm -rf "\${TMPDIR:?}/Users"`,
		].map((command) => [command, onFeature, "recursive rm"]),
		["git push -o ci.skip origin", onMain, "push to main/master"],
		["git push --repo=origin main", onFeature, "push to main/master"],
		["/bin/rm -rf src", onFeature, "recursive rm"],
		["find . -name x -exec rm -rf {} \\;", onFeature, "recursive rm"],
		["find . -name x -print0 | xargs -0 rm -rf", onFeature, "recursive rm"],
		// The branch is read before the command runs; switching first hides the target.
		["git checkout main && git push", onFeature, "push after changing directory or branch (target unknown)"],
		["git switch main; git push origin HEAD", onFeature, "push after changing directory or branch (target unknown)"],
		// Other spellings of a command position.
		["/usr/bin/git push origin main", onFeature, "push to main/master"],
		['bash -lc "git push origin main"', onFeature, "push to main/master"],
		['zsh -c "git push origin main"', onFeature, "push to main/master"],
		['eval "git push origin main"', onFeature, "push to main/master"],
		["env -i git push origin main", onFeature, "push to main/master"],
		["if true; then git push origin main; fi", onFeature, "push to main/master"],
		["nohup git push origin main", onFeature, "push to main/master"],
		["{ git push origin main; }", onFeature, "push to main/master"],
		["bash <<EOF\ngit push origin main\nEOF", onFeature, "push to main/master"],
		["git commit -F - <<EOF && git push origin main\nmsg\nEOF", onFeature, "push to main/master"],
		// A python/node heredoc stays scanned unless its body is plain text to the interpreter.
		["python3 - <<EOF\n$(rm -rf ~)\nEOF", onFeature, "recursive rm"],
		["python3 - <<\\EOF\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["python3 - <<'EOF' | sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["python3 - <<'EOF' 2>&1 | bash\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		[`eval "$(python3 - <<'EOF'\nrm -rf ~\nEOF\n)"`, onFeature, "recursive rm"],
		["source <(node - <<'EOF'\nrm -rf ~\nEOF\n)", onFeature, "recursive rm"],
		["python3 - <<'EOF'\nprint(1)\nEOF\nrm -rf ~", onFeature, "recursive rm"],
		["python3 - <<'EOF' && rm -rf ~\nprint(1)\nEOF", onFeature, "recursive rm"],
		// Only an opening program heredoc counts: not one inside quotes or another heredoc, piped on, or a written file.
		["echo \"\npython3 - <<'EOF'\n$(rm -rf ~)\nEOF\n\"", onFeature, "recursive rm"],
		["wc -l <<X\npython3 - <<'EOF'\n$(rm -rf ~)\nEOF\nX", onFeature, "recursive rm"],
		["cat <<'X'\npython3 - <<'EOF'\nX\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["(\npython3 - <<'EOF'\nrm -rf ~\nEOF\n) | /bin/sh", onFeature, "recursive rm"],
		["cat > notes.md <<'EOF'\nrm -rf src\nEOF", onFeature, "recursive rm"],
		["cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nchmod +x r*.sh && ./r*.sh", onFeature, "recursive rm"],
		["cat > Makefile <<'EOF'\nx:\n\trm -rf ~\nEOF\nmake x", onFeature, "recursive rm"],
		["sudo python3 - <<'EOF'\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["ssh h python3 - <<'EOF'\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["pythonx - <<'EOF'\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["python3 - <<'EOF'\nrm -rf ~\nEOFX\nrm -rf ~", onFeature, "recursive rm"],
		["bash <<'EOF'\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["cat > run.sh <<'EOF' && sh run.sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["cat > x <<EOF\n$(rm -rf ~)\nEOF", onFeature, "recursive rm"],
		["tee x <<'EOF' | sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		// The body ends where bash ends it, and the rest of the command must not run the output or the file.
		["bash <<X && python3 - <<'EOF'\nrm -rf ~\nX\nprint(1)\nEOF", onFeature, "recursive rm"],
		["python3 - <<'EOF'\nEOF\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["cat > f <<'EOF'\n\nEOF\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["python3 - <<'EOF'X\nprint(1)\nEOFX\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["python3 - <<'EOF'\r\nprint(1)\r\nEOF\r\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["python3 - <<'EOF' \\\n| sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["python3 - <<'EOF'\nrm -rf ~", onFeature, "recursive rm"],
		[`eval "$(\npython3 - <<'EOF'\nrm -rf ~\nEOF\n)"`, onFeature, "recursive rm"],
		["(python3 - <<'EOF'\nrm -rf ~\nEOF\n) | sh", onFeature, "recursive rm"],
		["for i in 1; do\npython3 - <<'EOF'\nrm -rf ~\nEOF\ndone | bash", onFeature, "recursive rm"],
		["python3 - <<'EOF' > >(sh)\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["python3 - <<'EOF' > r.sh && sh r.sh\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nbash run.sh", onFeature, "recursive rm"],
		["cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nchmod +x run.sh && ./run.sh", onFeature, "recursive rm"],
		["python3 - <<'EOF' > out.sh\nrm -rf ~\nEOF\n. ./out.sh", onFeature, "recursive rm"],
		["python3 - <<'EOF' && rm -rf ~\nprint(1)\nEOF", onFeature, "recursive rm"],
		// Only an opening program heredoc counts: not one inside quotes or another heredoc, piped on, or a written file.
		["echo \"\npython3 - <<'EOF'\n$(rm -rf ~)\nEOF\n\"", onFeature, "recursive rm"],
		["wc -l <<X\npython3 - <<'EOF'\n$(rm -rf ~)\nEOF\nX", onFeature, "recursive rm"],
		["cat <<'X'\npython3 - <<'EOF'\nX\nrm -rf ~\nEOF", onFeature, "recursive rm"],
		["(\npython3 - <<'EOF'\nrm -rf ~\nEOF\n) | /bin/sh", onFeature, "recursive rm"],
		["cat > notes.md <<'EOF'\nrm -rf src\nEOF", onFeature, "recursive rm"],
		["cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nchmod +x r*.sh && ./r*.sh", onFeature, "recursive rm"],
		["cat > Makefile <<'EOF'\nx:\n\trm -rf ~\nEOF\nmake x", onFeature, "recursive rm"],
		["python3 - <<'EOF'\nx = 1\nEOF\ngit push -f origin main", onFeature, "force push"],
		// History rewrites and other discards.
		["git commit --amend --no-edit", onFeature, "history rewrite (commit --amend)"],
		["git rebase -i HEAD~3", onFeature, "history rewrite (rebase)"],
		["git filter-repo --path x", onFeature, "history rewrite (filter-repo)"],
		["git switch -f main", onFeature, "discard changes (git switch)"],
		["git stash drop", onFeature, "git stash drop"],
		["git stash clear", onFeature, "git stash clear"],
		// Nested commands and command substitution inside a message still run.
		['git log --format="$(git push origin main)"', onFeature, "push to main/master"],
		['git commit -m "$(git push origin main)"', onFeature, "push to main/master"],
		['git commit -m "\x60rm -rf src\x60"', onFeature, "recursive rm"],
		["rm -R src", onFeature, "recursive rm"],
		["rm --recursive src", onFeature, "recursive rm"],
		['sh -c "rm -rf x"', onFeature, "recursive rm"],
		["find . -name x | xargs rm -rf", onFeature, "recursive rm"],
	]) {
		assert.equal(classify(command, branch), label, command);
	}
});

// Each row was a bypass reported in a guard PR's review or fix; a guard change adds each new one here.
// #95's rows come from that draft PR's review corpus and review rounds. Rows are checked in both modes
// (`historyRewrites: false` and `true`).
test("must-ask regressions: past bypasses still ask", () => {
	for (const [command, branch, source] of [
		["python3 - <<'EOF' | sh\nrm -rf ~\nEOF", onFeature, "#83"],
		["cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nbash run.sh", onFeature, "#83"],
		["python3 - <<'EOF'\nEOF\nrm -rf ~\nEOF", onFeature, "#83"],
		[`export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`env TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`. ./vars; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		["rm -rf dist 2>&1 /Users", onFeature, "#92"],
		["rm -rf /tmp/&>/dev/null", onFeature, "#92"],
		["rm -rf&>/dev/null /Users", onFeature, "#92"],
		["git push origin 2>&1", onMain, "#104"],
		["git push origin main&>/dev/null", onFeature, "#104"],
		['git push "origin"&>x', onMain, "#104"],
		["git filter-repo --path x", onFeature, "#102"],
		[`rm -rf "\${TMPDIR:?}/$n"`, onFeature, "#75"],
		["rm -rf /tmp/`echo x`", onFeature, "#75"],
		['d=$(mktemp -d); d=/; rm -rf "$d"', onFeature, "#75"],
		['false && d=$(mktemp -d); rm -rf "$d"', onFeature, "#75"],
		['_=$(mktemp -d) && ls / && rm -rf "$_"/Users', onFeature, "#75"],
		[`d=$(mktemp -d) && sh -c 'rm -rf "$d"/x'`, onFeature, "#75"],
		["IFS=/; rm -rf $TMPDIR/x", onFeature, "#75"],
		['rm -rf "$TMPDIR"/x/.[.]/y', onFeature, "#75"],
		[`env -uTMPDIR bash -c 'rm -rf "$TMPDIR/Users"'`, onFeature, "#75"],
		['rm -rf dist" "x /etc', onFeature, "#76"],
		["eval 'rm' -rf /", onFeature, "#76"],
		['LC_ALL="C" rm -rf dist "$HOME"', onFeature, "#76"],
		[`bash -c 'rm -rf dist '"$HOME"`, onFeature, "#76"],
		[`rm -rf dist/"Bob's" ~`, onFeature, "#76"],
		["git -C . -C ../dirty reset --hard", onFeature, "#95"],
		["git -C ../dirty -C ../onmain push", onFeature, "#95"],
		["git --git-dir=/w/dirty/.git --work-tree=/w/dirty reset --hard", onFeature, "#95"],
		["GIT_DIR=/w/dirty/.git GIT_WORK_TREE=/w/dirty git reset --hard", onFeature, "#95"],
		['B=main; git checkout -B "$B" && git push -u origin HEAD', onFeature, "#95"],
		["git checkout -b topic & git push -u origin HEAD", onFeature, "#95"],
		["pushd ../onmain && git push", onFeature, "#95"],
		["f() { git push; }; git checkout main && f", onFeature, "#95"],
		["git checkout -f origin/main", onFeature, "#95"],
		["git push origin :main", onFeature, "#95"],
		["git push --mirror origin", onFeature, "#95"],
		["git push origin '+refs/heads/*:refs/heads/*'", onFeature, "#95"],
		["git push --receive-pack='rm -rf ~;:' ../bare.git feat", onFeature, "#95"],
		["git remote rename origin local && git push -f local main", onFeature, "#95"],
		["false && git remote set-url origin /tmp/x; git push -f origin main", onFeature, "#95"],
		["rm -rf ~bob", onFeature, "#95"],
		["cd ~ && rm -rf ~+/Documents", onFeature, "#95"],
		["p='sr?'; rm -rf $p", onFeature, "#95"],
		[`a=(src/*); rm -rf "\${a[@]}"`, onFeature, "#95"],
		["rm -rf .GIT", onFeature, "#95"],
		["cd /tmp/x & rm -rf src", onFeature, "#95"],
		["cd /tmp/nonexist-q || rm -rf src", onFeature, "#95"],
		["f() { rm -rf Library; }; cd ~ && f", onFeature, "#95"],
		["bash -s -- x <<'EOF'\nrm -rf ~\nEOF", onFeature, "#95"],
		["bash /dev/stdin <<'EOF'\nrm -rf ~\nEOF", onFeature, "#95"],
		["cat > a.sh <<'EOF'\nrm -rf ~\nEOF\ncp a.sh b.sh; sh b.sh", onFeature, "#95"],
		["echo ~ | xargs -I{} sh -c 'rm -rf {}'", onFeature, "#95"],
		["git bisect run sh -c 'rm -rf ~'", onFeature, "#95"],
		["pnpm exec rm -rf ~", onFeature, "#95"],
		["env --chdir=/w/clean rm -rf .git", onFeature, "#95"],
		["env --argv0=echo rm -rf ~", onFeature, "#95"],
		["bash -euxc 'rm -rf ~'", onFeature, "#95"],
		[`TMPDIR=/ rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`\\export TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`declare -x TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`read TMPDIR <<< /; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`printf -v TMPDIR /; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`export TMP''DIR=/; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`unset TMPDIR; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`sudo rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`doas true; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`.>/dev/null ./v; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`bash -c 'TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"'`, onFeature, "#87"],
		[`z=TMP; z+=DIR=/; ((z)); rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`e{xport,} TMP{DIR,}=/; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`$x TMPDIR=/; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		[`git commit -m "x" <<< "$(export TMPDIR=/)"; rm -rf "\${TMPDIR:?}/Users"`, onFeature, "#87"],
		["rm -rf dist >| log /Users", onFeature, "#92"],
		["rm -rf dist 2>&- /Users", onFeature, "#92"],
		['rm -rf dist ">" /Users', onFeature, "#92"],
		["rm -rf /tmp/>/dev/null", onFeature, "#92"],
		[`rm -rf "\${TMPDIR:?}/"&>/dev/null`, onFeature, "#92"],
		["rm -r>log /Users", onFeature, "#92"],
		["git push 2>&1 origin", onMain, "#104"],
		["git push origin>log", onMain, "#104"],
		["rm -rf /tmp/*", onFeature, "#94"],
		["rm -rf /tmp/a*", onFeature, "#94"],
		["find ~ -exec rm -rf {} +", onFeature, "#95"],
		["find ~ -execdir rm -rf {} +", onFeature, "#95"],
		["find ~ | xargs rm -rf", onFeature, "#95"],
		["find ~ -maxdepth 0 -exec sh -c 'rm -rf {}' \\;", onFeature, "#95"],
		["echo ~ | xargs -I % sh -c 'rm -rf %'", onFeature, "#95"],
		['cd ~ && rm -rf "$PWD/Documents"', onFeature, "#95"],
		["cd ~ && cd /tmp && rm -rf ~-/Documents", onFeature, "#95"],
		['cd ~ && cd /tmp && rm -rf "$OLDPWD/Documents"', onFeature, "#95"],
		["cd /tmp/x; rm -rf src", onFeature, "#95"],
		["(cd /tmp/x); rm -rf src", onFeature, "#95"],
		["for d in x; do rm -rf Documents; done; cd ~", onFeature, "#95"],
		["sh /dev/fd/0 <<'EOF'\nrm -rf ~\nEOF", onFeature, "#95"],
		[". /dev/stdin <<'EOF'\nrm -rf ~\nEOF", onFeature, "#95"],
		["bash - <<'EOF'\nrm -rf ~\nEOF", onFeature, "#95"],
		["bash /proc/self/fd/0 <<'EOF'\nrm -rf ~\nEOF", onFeature, "#95"],
		["sh -s foo <<'EOF'\nrm -rf ~\nEOF", onFeature, "#95"],
		["bash -es <<'EOF'\nrm -rf ~\nEOF", onFeature, "#95"],
		["cat > a.sh <<'EOF'\nrm -rf ~\nEOF\nchmod +x a.sh; ./a.sh", onFeature, "#95"],
		["cat > a.sh <<'EOF'\nrm -rf ~\nEOF\n. a.sh", onFeature, "#95"],
		["cat > a.sh <<'EOF'\nrm -rf ~\nEOF\nmv a.sh b.sh; sh b.sh", onFeature, "#95"],
		["cat > a.sh <<'EOF'\nrm -rf ~\nEOF\nln -s a.sh b.sh; sh b.sh", onFeature, "#95"],
		["cat > Makefile <<'EOF'\nx:\n\trm -rf ~\nEOF\nmake", onFeature, "#95"],
		["git checkout -b topic; git push -u origin HEAD", onFeature, "#95"],
		["git checkout --force main", onFeature, "#95"],
		["git checkout -qf main", onFeature, "#95"],
		["git switch --discard-changes main", onFeature, "#95"],
		["git restore --pathspec-from-file=f", onFeature, "#95"],
		["git -C ../dirty stash drop", onFeature, "#95"],
		["yarn exec rm -rf ~", onFeature, "#95"],
		["mise exec -- rm -rf ~", onFeature, "#95"],
		["asdf exec rm -rf ~", onFeature, "#95"],
		["git rebase -x 'rm -rf ~' HEAD~1", onFeature, "#114"],
		["GIT_SEQUENCE_EDITOR='rm -rf ~;:' git rebase -i HEAD~1", onFeature, "#114"],
		["git filter-branch --tree-filter 'rm -rf ~' HEAD", onFeature, "#114"],
		["git rebase --exec 'rm -rf ~' main", onFeature, "#114"],
		["git rebase --exec='rm -rf ~' main", onFeature, "#114"],
		["git rebase -ix 'rm -rf ~' HEAD~2", onFeature, "#114"],
		["git rebase -x'rm -rf ~' HEAD~1", onFeature, "#114"],
		["GIT_EDITOR='rm -rf ~;:' git rebase -i HEAD~1", onFeature, "#114"],
		["env GIT_SEQUENCE_EDITOR='rm -rf ~;:' git rebase -i HEAD~1", onFeature, "#114"],
		["export GIT_SEQUENCE_EDITOR='rm -rf ~;:'; git rebase -i HEAD~1", onFeature, "#114"],
		["git -c sequence.editor='rm -rf ~;:' rebase -i HEAD~1", onFeature, "#114"],
		["git --config-env=core.editor=E commit --amend", onFeature, "#114"],
		["git -c core.editor='rm -rf ~;:' commit --amend", onFeature, "#114"],
		["EDITOR='rm -rf ~;:' git commit --amend", onFeature, "#114"],
		["git filter-branch --index-filter 'rm -rf ~' HEAD", onFeature, "#114"],
		["git filter-branch --msg-filter='rm -rf ~' HEAD", onFeature, "#114"],
		["git filter-branch --env-filter 'rm -rf ~' HEAD", onFeature, "#114"],
		["git rebase --exe 'rm -rf ~' HEAD~1", onFeature, "#114"],
		["git rebase --ex='rm -rf ~' HEAD~1", onFeature, "#114"],
		["git filter-branch --setup 'rm -rf ~' HEAD", onFeature, "#114"],
		["GIT_EDITOR='rm -rf ~;:' git rebase --continue", onFeature, "#114"],
		["GIT_SEQUENCE_EDITOR+='rm -rf ~;:' git rebase -i HEAD~1", onFeature, "#114"],
		["git submodule foreach 'rm -rf ~'", onFeature, "#115"],
		["git -c alias.x='!rm -rf ~' x", onFeature, "#115"],
		["git -c alias.p='push -f' p", onFeature, "#115"],
		["git -c core.fsmonitor='rm -rf ~' status", onFeature, "#115"],
		["git -c core.sshCommand='rm -rf ~' fetch", onFeature, "#115"],
		["git -c core.hooksPath=/tmp/h commit -m x", onFeature, "#115"],
		["git --config-env=core.pager=X log", onFeature, "#115"],
		["git fetch --upload-pack='rm -rf ~' origin", onFeature, "#115"],
		["git ls-remote --upload 'rm -rf ~' origin", onFeature, "#115"],
		["git clone -u 'rm -rf ~' repo d", onFeature, "#115"],
		["git clone --upl='rm -rf ~' repo d", onFeature, "#115"],
		["git push --receive-pack='rm -rf ~' origin x", onFeature, "#115"],
		["git push --exec='rm -rf ~' origin x", onFeature, "#115"],
		["git push --exe 'rm -rf ~' origin x", onFeature, "#115"],
		["git archive --exec='rm -rf ~' --remote=x HEAD", onFeature, "#115"],
		["git archive --exe 'rm -rf ~' --remote=x HEAD", onFeature, "#115"],
		["git grep -O'rm -rf ~' x", onFeature, "#115"],
		["git grep -nO 'rm -rf ~' x", onFeature, "#115"],
		["git grep --open-files-in-pager='rm -rf ~' x", onFeature, "#115"],
		["git grep --open 'rm -rf ~' x", onFeature, "#115"],
		["git difftool -x 'rm -rf ~'", onFeature, "#115"],
		["git difftool -yx 'rm -rf ~'", onFeature, "#115"],
		["git difftool --extcmd='rm -rf ~'", onFeature, "#115"],
		["git difftool --ext 'rm -rf ~'", onFeature, "#115"],
		["GIT_SSH_COMMAND='rm -rf ~' git fetch", onFeature, "#115"],
		["env GIT_SSH='rm -rf ~' git fetch", onFeature, "#115"],
		["export GIT_ASKPASS='rm -rf ~'; git fetch", onFeature, "#115"],
		["SSH_ASKPASS='rm -rf ~' git fetch", onFeature, "#115"],
		["GIT_PROXY_COMMAND='rm -rf ~' git fetch", onFeature, "#115"],
		["GIT_EXEC_PATH=/tmp/x git status", onFeature, "#115"],
		["GIT_CONFIG_GLOBAL=/tmp/x git status", onFeature, "#115"],
		["GIT_SSH_COMMAND+='rm -rf ~' git fetch", onFeature, "#115"],
		["GIT_EXTERNAL_DIFF='rm -rf ~' git diff", onFeature, "#115"],
		["GIT_PAGER='rm -rf ~' git log", onFeature, "#115"],
		["PAGER='rm -rf ~' git log", onFeature, "#115"],
		["GIT_PAGER=catx git log", onFeature, "#115"],
		["git -c core.pager='rm -rf ~' log", onFeature, "#115"],
		["git -c pager.log='rm -rf ~' log", onFeature, "#115"],
		["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0='rm -rf ~' git log", onFeature, "#115"],
		[`GIT_CONFIG_PARAMETERS="'core.pager'='rm -rf ~'" git log`, onFeature, "#115"],
		["GIT_EDITOR='rm -rf ~;:' git commit", onFeature, "#115"],
		["GIT_EDITOR='rm -rf ~;:' git pull --rebase=interactive", onFeature, "#115"],
		["EDITOR='rm -rf ~;:' git tag -a v1", onFeature, "#115"],
		["git config core.pager 'rm -rf ~'", onFeature, "#115"],
		["git config set alias.x '!rm -rf ~'", onFeature, "#115"],
		["git config --global core.hooksPath /tmp/h", onFeature, "#115"],
		["git config --add core.sshCommand 'rm -rf ~'", onFeature, "#115"],
		["git config --file .git/config core.fsmonitor 'rm -rf ~'", onFeature, "#115"],
		["git config --replace-all core.pager 'rm -rf ~'", onFeature, "#115"],
		["git config --rename-section x core", onFeature, "#115"],
		["git config alias.x '!rm -rf ~ -l'", onFeature, "#115"],
		["git config core.pager 'rm -rf ~ -e'", onFeature, "#115"],
		["git config core.hooksPath /tmp/h", onFeature, "#115"],
		["git clone -c core.hooksPath=/tmp/h repo d", onFeature, "#115"],
		["git clone --config=core.fsmonitor='rm -rf ~' repo d", onFeature, "#115"],
		["git clone --template=/tmp/t repo d", onFeature, "#115"],
		["GIT_TEMPLATE_DIR=/tmp/t git clone r d", onFeature, "#115"],
		["git --exec-path=/tmp/x status", onFeature, "#115"],
		["git archive --e='rm -rf ~' --remote=x HEAD", onFeature, "#115"],
		["git clone --u='rm -rf ~' r d", onFeature, "#115"],
		["git pull --upload-pack='rm -rf ~' origin", onFeature, "#115"],
		["LESSOPEN='|rm -rf ~ %s' git log", onFeature, "#115"],
		["GIT_CONFIG=/tmp/c git log", onFeature, "#115"],
		["GIT_CONFIG_SYSTEM=/tmp/c git log", onFeature, "#115"],
		["VISUAL='rm -rf ~;:' git commit", onFeature, "#115"],
	]) {
		for (const historyRewrites of [false, true])
			assert.ok(
				classify(command, branch, { historyRewrites }),
				`${source}: ${command} (historyRewrites: ${historyRewrites})`,
			);
	}
});

test("a git -c value with quotes is read in linear time", () => {
	const started = performance.now();
	classify(`git -c ${"a".repeat(5000)}"`, onFeature, { historyRewrites: false });
	assert.ok(performance.now() - started < 1000, "GIT_GLOBALS backtracks");
});

// Git options and env that run a command ask in both modes; routine forms of the same commands stay quiet (#115).
test("git options and env that don't run a command stay quiet in both modes", () => {
	for (const command of [
		"git fetch",
		"git fetch origin",
		"git fetch --prune",
		"git fetch -u origin",
		"git log",
		"git --no-pager log",
		"GIT_PAGER=cat git log",
		"PAGER=cat git diff",
		"GIT_PAGER= git log",
		"PAGER='' git log",
		"git -c user.name=x commit -m y",
		"git -c user.name='a b' commit -m x",
		"git -c color.ui=never diff",
		"git -c core.pager=cat log",
		"git -c init.defaultBranch=main init",
		"git config user.name x",
		"git config --get core.pager",
		"git config core.pager",
		"git config --list",
		"git config --unset user.name",
		"git submodule update --init",
		"git grep foo",
		"git grep -n -o foo",
		"git clone -q origin.git work",
		"git archive --format=tar HEAD",
		"GIT_CONFIG_NOSYSTEM=1 git log",
		"GIT_SSH_COMMAND='ssh -i k' ssh host",
		"git config --get core.editor",
		"git config --unset core.editor",
		"git grep editor=",
		"git --exec-path",
		"git clone -c user.name=x repo d",
		"git config user.email 'a -l b'",
		"git push -o ci.skip origin feature/x",
	]) {
		for (const historyRewrites of [false, true])
			assert.equal(classify(command, onFeature, { historyRewrites }), undefined, `expected allowed: ${command}`);
	}
});

test("git options and env that run a command are read in linear time", () => {
	const started = performance.now();
	classify(`GIT_PAGER=${"c".repeat(5000)} git -c ${"'a'".repeat(3000)} config ${"--x ".repeat(3000)}`, onFeature);
	assert.ok(performance.now() - started < 1000, "#115 patterns backtrack");
});

test("allows feature pushes, PRs, and routine commands", () => {
	for (const [command, branch] of [
		["git push", onFeature],
		["git push -u origin feature/x", onFeature],
		// Redirects after a feature push don't make it a main push (#93).
		["git push origin feature/x 2>&1", onMain],
		["git push -u origin feature/x >/dev/null 2>&1", onMain],
		["git push origin 2>&1 | tail -3", onFeature],
		["git push origin &>/dev/null", onFeature],
		['git push origin ">" 2>&1', onFeature],
		// bash runs `git push origin y` here (the redirect ends at `x`): a push of branch y, not of main.
		['git push origin&>x "y"', onMain],
		['git commit -m "a>b" 2>&1', onMain],
		["rm -rf dist 2>&1", onMain],
		["rm -rf /tmp/x &>/dev/null", onMain],
		["git push origin HEAD", onFeature],
		["git push origin main-fix", onFeature],
		["gh pr create --fill", onMain],
		["git reset HEAD~1", onMain],
		["git reset --soft HEAD~1", onMain],
		["git clean -n", onMain],
		["git clean -fn", onMain],
		["git checkout feature/x", onMain],
		["git checkout -b feature/y", onMain],
		["git restore --staged src/a.ts", onMain],
		["git branch -d merged", onMain],
		["git log --grep push", onMain],
		["grep 'git push origin main' README.md", onMain],
		['echo "rm -rf /"', onMain],
		['git commit -m "rm -rf old dir"', onMain],
		['git commit -m "fix: then rm -rf src"', onMain],
		["git commit -am 'cd x && git push origin main'", onMain],
		['git commit --message="handle --amend"', onMain],
		["git commit -m 'git reset --hard was wrong' && git push", onFeature],
		["rm notes.txt", onMain],
		["rm -f notes.txt", onMain],
		["rm -rf dist", onMain],
		["rm -r -f build node_modules ./coverage", onMain],
		["rm -rf /tmp/me-pi-test", onMain],
		[`rm -rf "\${TMPDIR:?}/x"`, onMain],
		[`cd /tmp/x && rm -rf "\${TMPDIR:?}/x"`, onMain],
		["rm -rf dist 2>/dev/null", onMain],
		["rm -rf dist 2> /dev/null", onMain],
		["rm -rf dist > log", onMain],
		["rm -rf dist 2>&1 | tail -2", onMain],
		["rm -rf dist >/dev/null 2>&1", onMain],
		[`rm -rf "\${TMPDIR:?}/x" 2>/dev/null || true`, onMain],
		["rm -rf dist && echo ok", onMain],
		["rm -rf dist &>/dev/null", onMain],
		["rm -rf dist >| log", onMain],
		["rm -rf node_modules dist 2>&1", onMain],
		["rm -rf dist &> log", onMain],
		["rm -rf dist |& tail", onMain],
		["rm -rf /tmp/x/*", onMain],
		["rm -rf dist/a..b", onMain],
		["rm -rf /var/folders/ab/cd/T/me-pi-x", onMain],
		["git push -o ci.skip origin feature/x", onMain],
		["git rebase --continue", onMain],
		["git commit -m 'fix'", onMain],
		["git stash", onMain],
		["git stash pop", onMain],
		["git switch feature/y", onMain],
		["git checkout main", onFeature],
		["rmdir empty-dir", onMain],
		[`git commit -m "$(cat <<'EOF'\nfix: git push origin main and rm -rf src\nEOF\n)"`, onFeature],
		// An opening quoted heredoc fed to python or node is a program: shell words in its strings are text.
		["cd /tmp/x && python3 - <<'EOF'\ns = '[\"rm -rf /tmp/x/$y\", onFeature]'\nEOF", onFeature],
		[`python3 - <<'EOF'\nprint("\`rm -rf ~\`")\nEOF`, onFeature],
		["node - <<'EOF'\nconst c = `git push -f origin main`;\nEOF", onFeature],
		['python - <<"EOF"\nrm -rf ~\nEOF', onFeature],
		["/usr/bin/python3 <<-'EOF'\n\trm -rf ~\n\tEOF\nnode --test x 2>&1", onFeature],
		["python3 - <<'EOF'\nprint(1)\nEOF\nnode --test x 2>&1 | grep ok", onFeature],
		["cd /tmp/x && python3 - <<'EOF'\nrm -rf ~\nEOF\nnpx biome check --write . && npm test", onFeature],
		["python3 - <<-'EOF'\n\trm -rf ~\n\tEOF", onFeature],
		// A blank line inside the body does not end it.
		["python3 - <<'EOF'\np = 1\n\nprint('rm -rf ~')\nEOF", onFeature],
	]) {
		assert.equal(classify(command, branch), undefined, `expected allowed: ${command}`);
	}
});

test("workerRisk blocks commands that move an implement worker off its branch or reach shared state", () => {
	for (const command of [
		"git push origin x",
		"git push origin 2>&1",
		"git commit --no-verify&>x -m y",
		'git commit --no-verify&>x -m "y"',
		'git commit -n&>x -m "y"',
		"git stash drop&>x",
		"git push . HEAD:main",
		"git -C x worktree add",
		"git commit -nm x",
		"git commit --no-verify -m x",
		"gh pr list",
		"git config core.hooksPath x",
		"git config --unset user.name",
		"git remote set-url origin x",
		"git remote -v",
		"git update-ref refs/heads/main x",
		"git symbolic-ref HEAD x",
		"git branch -M x",
		"git branch --move a b",
		"git tag -d v1",
		"git tag --force v1",
		"./install.sh",
		"bash install.sh",
		"sh -x ./install.sh",
		"/abs/install.sh",
		"x/install.sh",
		"cd .. && ./install.sh",
		"bash -- install.sh",
		"bash --noprofile install.sh",
		"bash -n install.sh && ./install.sh",
		"bash -n install.sh && bash install.sh",
		"bash -n -c './install.sh'",
		"bash --noprofile -c './install.sh'",
		"pi install ./x",
		"pi config",
		"git symbolic-ref -d HEAD",
		". ./install.sh",
		"source install.sh",
		"bash <<EOF\n./install.sh\nEOF",
		"git commit -F - <<EOF && git push\nmsg\nEOF",
		"git switch other",
		"git switch -c other",
		"git checkout other",
		"git checkout -- a.ts",
		"git merge main",
		"git cherry-pick abc123",
		"git stash",
		"git stash pop",
		"git stash drop",
		"git pull",
		"git pull --rebase origin main",
		"cd x && git checkout main",
	]) {
		assert.ok(workerRisk(command), `expected blocked: ${command}`);
	}
	for (const command of [
		"npm run check --prefix extensions",
		"test/install.test.sh",
		'git commit -m "mention git push"',
		"git commit -m 'run ./install.sh'",
		"grep 'gh ' file",
		"git config --get user.name",
		"git config user.name",
		"git config --list --show-origin",
		"git config get user.name",
		"git branch -d old",
		"git log --oneline main..HEAD",
		"git merge-base main HEAD",
		"git stash list",
		"git stash show -p",
		'git commit -m "merge and stash notes"',
		"git tag v1",
		"cat install.sh",
		"bash -n install.sh",
		"bash -n install.sh test/install.test.sh",
		"bash -n ./install.sh && cmp -s README.md <(git show HEAD:README.md)",
		"pi --version",
		"git symbolic-ref -q HEAD",
		"git symbolic-ref --short HEAD",
		"git config --bool core.bare",
		"git config --type bool --get core.bare",
		"git config --type=int core.x",
		`git commit -m "$(cat <<'EOF'\ninstall.sh: link\ngit push is blocked\nEOF\n)"`,
		"git commit -F - <<EOF\nrun ./install.sh then gh pr list\nEOF",
	]) {
		assert.equal(workerRisk(command), undefined, `expected allowed: ${command}`);
	}
});

test("an implement worker's git in a fresh mktemp repo passes; leaving it or pointing git elsewhere does not", (t) => {
	const role = process.env.ME_PI_ROLE;
	t.after(() => {
		if (role === undefined) delete process.env.ME_PI_ROLE;
		else process.env.ME_PI_ROLE = role;
	});
	process.env.ME_PI_ROLE = "implement";
	const fresh = [
		'DIR=$(mktemp -d) && cd "$DIR" && git init -q source && cd source && git config user.email t@example.com && git remote add origin "$DIR/origin.git" && git push origin HEAD',
		"D=$(mktemp -d -t hooks); cd $D; git init -q --bare origin.git && git clone -q origin.git work && cd work && git push",
		`T=$(mktemp -d) && cd "\${T}" && git init -q && git commit -q --allow-empty -m x && git reset --hard`,
	];
	for (const command of fresh) {
		assert.equal(workerRisk(command), undefined, command);
		assert.equal(classify(command, onMain), undefined, command);
	}
	for (const command of [
		'DIR=$(mktemp -d) && cd "$DIR" && cd /repo && git push',
		'DIR=$(mktemp -d) && cd "$DIR" && git clone -q /repo work && cd work && git push',
		'DIR=$(mktemp -d) && cd "$DIR" && cd .. && git config user.name x',
		'DIR=$(mktemp -d) && cd "$DIR" && git -C ~/repo push',
		'DIR=$(mktemp -d) && cd "$DIR" && GIT_DIR=x git config user.name x',
		'DIR=$(mktemp -d) && cd "$DIR" && DIR=/repo && cd "$DIR" && git push',
		'DIR=$(mktemp -d) && cd "$DIR" && cd "$HOME" && git config user.name x',
		'cd "$DIR" && git config user.name x',
		'V=$(mktemp -d) && cd "$V" && cd - && git push --force origin main',
		'V=$(mktemp -d) && cd "$V" && cd && cd fun/me-pi && git push --force origin main',
		'V=$(mktemp -d) && cd "$V" && pushd work && popd && git config user.name x',
		'V=$(mktemp -d ./t.XXXX) && cd "$V" && git config user.name x',
	])
		assert.ok(workerRisk(command), command);
	// Cutting remotes doesn't stop git running a local command, so those checks still apply.
	for (const command of [
		`D=$(mktemp -d) && cd "$D" && git init -q && git -c alias.x='!touch p' x`,
		`D=$(mktemp -d) && cd "$D" && GIT_SSH_COMMAND='touch p' git fetch`,
	])
		assert.ok(classify(command, onMain), command);
	delete process.env.ME_PI_ROLE;
	assert.ok(classify(fresh[2], onMain), "the main session's guard never exempts temp repos");
});

test("gitWorktreeRemovals lists the worktrees a command removes or moves", () => {
	for (const [command, targets] of [
		["git worktree remove ../wt", [["../wt"]]],
		["git worktree remove -f ../wt", [["../wt"]]],
		["git worktree remove ../wt --force", [["../wt"]]],
		["git worktree remove --force '/tmp/a b'", "unknown"],
		['git worktree remove "$WT"', "unknown"],
		["git worktree remove $(pwd)/wt", "unknown"],
		["git worktree remove ../wts/y*", "unknown"],
		["git -C /repo worktree remove wt", [["/repo", "wt"]]],
		["cd ../wts && git worktree remove y", [["../wts", "y"]]],
		["cd ../wts\ngit worktree remove y", "unknown"],
		["git fetch && cd ../wts && git worktree remove y", "unknown"],
		["git worktree remove a && git worktree remove b", [["a"], ["b"]]],
		["git status; git worktree remove a 2>&1", [["a"]]],
		// No path in the text: `xargs` or a later line may supply one.
		["git worktree remove", "unknown"],
		["echo ../wts/y | xargs git worktree remove", "unknown"],
		["git worktree move ../wt ../new", [["../wt"]]],
		["git worktree move --force ../wt ../new", [["../wt"]]],
		["git worktree add ../wt -b x", []],
		["git worktree list", []],
		["git worktree prune", []],
		['git commit -m "git worktree remove a"', []],
		["echo git worktree remove a", []],
	] as const)
		assert.deepEqual(gitWorktreeRemovals(command), targets, command);
});

test("gitWriteDirs counts a directory change in any position", () => {
	for (const command of ["builtin cd /l; git add .", "command cd /l && git commit", "eval 'cd /l'; git commit -m x"])
		assert.equal(gitWriteDirs(command), "unknown", command);
	assert.deepEqual(gitWriteDirs("git add src/cd.ts abcd"), [[]]);
});

test("gitWriteDirs says where a command's git tree writes run, or that its text does not show it", () => {
	for (const [command, dirs] of [
		["git commit -m x", [[]]],
		["git add -A && git commit -m x", [[], []]],
		["git -C a commit", [["a"]]],
		["git -C 'a b' commit", [["a b"]]],
		["cd a && git add -A", [["a"]]],
		["pushd a; git add -A", [["a"]]],
		["cd a && git -C b commit -m x", [["a", "b"]]],
		// Only the writes count: a read elsewhere does not move them.
		["git -C /free status && git commit -m x", [[]]],
		["git commit -m x; git -C /free status", [[]]],
		["git -C /free status && /usr/bin/git commit -m x", [[]]],
		["git -C /free status && env X=1 git commit -m x", [[]]],
		["git -c color.ui=never -C /locked commit -m x", [["/locked"]]],
		["git -C ~/repo commit", [["~/repo"]]],
		// The text does not show where these run.
		["git status && cd ../wt && git commit -m x", "unknown"],
		["cd a && cd b && git add -A", "unknown"],
		["(cd ../wt && git commit -m x)", "unknown"],
		["cd a && git add -A && popd", "unknown"],
		["cd /locked\ngit commit -m x", "unknown"],
		["cd /locked || true; git commit -m x", "unknown"],
		['bash -c "cd /locked && git commit -m x"', "unknown"],
		["git --git-dir=/locked/.git --work-tree=/locked commit -m x", "unknown"],
		["GIT_DIR=/locked/.git git commit -m x", "unknown"],
		['cd "$WT" && git commit -m x', "unknown"],
		["cd $(pwd)/wt && git add -A", "unknown"],
		["git -C `pwd` commit -m x", "unknown"],
		["git -C a -C b commit", "unknown"],
		["git -C wt* commit", "unknown"],
		// No tree write.
		["git status", undefined],
		["cd ../wt && git log", undefined],
		["git status\ncd ../wt", undefined],
		['git commit -m "cd x && git add"', [[]]],
		["abcd x", undefined],
		["", undefined],
	] as const)
		assert.deepEqual(gitWriteDirs(command), dirs, command);
});

test("gitWriteDirs finds checkout-writing git subcommands and passes reads", () => {
	for (const command of [
		"git add -A",
		"git rm a.ts",
		"git mv a b",
		"git commit -m x",
		"git merge x",
		"git rebase main",
		"git reset HEAD~1",
		"git restore --staged a",
		"git checkout x",
		"git switch -c goal/x",
		"git stash",
		"git stash pop",
		"git stash list && git stash drop",
		"git cherry-pick abc",
		"git revert HEAD",
		"git am < p.mbox",
		"git apply p.diff",
		"git pull",
		"git clean -fd",
		"git update-index --assume-unchanged a",
		"git read-tree HEAD",
		"git checkout-index -a -f",
		"git sparse-checkout set src",
		"git submodule update --init",
		"git update-ref refs/heads/x HEAD",
		"git symbolic-ref HEAD refs/heads/x",
		"git symbolic-ref -d HEAD",
		"git symbolic-ref --delete HEAD",
		"git submodule update",
		"git submodule --quiet update",
		"git submodule foreach 'git status'",
		"git submodule add ../x x",
		"git sparse-checkout set x",
		"git sparse-checkout init",
		"git branch -f goal/x HEAD~1",
		"git branch --force goal/x main",
		"git branch -m old new",
		"git checkout -- . 2>&1",
		"git stash drop&>x",
		'git branch -D&>x "a"',
		"git branch -M new",
		"git branch --move old new",
		"git branch -d old",
		"git branch -D old",
		"git branch --delete old",
		"git -C /repo commit -m x",
		"rtk git add .",
		"git status && git commit -m x",
		"git -c user.name='a b' commit -m x",
		'git log --format="$(git reset --hard)"',
	]) {
		assert.notEqual(gitWriteDirs(command), undefined, command);
	}
	for (const command of [
		"git log --oneline",
		"git log --oneline -5",
		"git blame README.md",
		"git grep foo",
		"git status --porcelain",
		"git diff main..HEAD",
		"git show HEAD",
		"git branch --show-current",
		"git branch",
		"git branch -a",
		"git branch new-topic",
		"git fetch origin",
		"git tag v1",
		"git rev-parse HEAD",
		"git merge-base main HEAD",
		"git stash list",
		"git stash show -p stash@{0}",
		"git symbolic-ref --short HEAD",
		"git symbolic-ref -q HEAD",
		"git submodule",
		"git submodule status",
		"git submodule --quiet status --recursive",
		"git submodule summary",
		"git sparse-checkout list",
		"grep 'git commit' README.md",
		'echo "git add -A"',
		"npm run check --prefix extensions",
	]) {
		assert.equal(gitWriteDirs(command), undefined, `expected allowed: ${command}`);
	}
});

test("PROTECTED_BRANCHES is main and master", () => {
	assert.deepEqual([...PROTECTED_BRANCHES].sort(), ["main", "master"]);
});

function setup() {
	let handler: any;
	let command: any;
	const events = [];
	registerGuard({
		on: (_event, h) => {
			handler = h;
		},
		registerCommand: (_name, definition) => {
			command = definition;
		},
		events: { emit: (...event) => events.push(event) },
	});
	return { handler, command, events };
}

test("confirms with UI, blocks without UI or on refusal", async () => {
	const { handler } = setup();
	const event = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } };
	const cwd = process.cwd();

	const headless = await handler(event, { cwd, hasUI: false });
	assert.equal(headless?.block, true);
	assert.match(headless.reason, /push to main\/master/);

	assert.equal(await handler(event, { cwd, hasUI: true, ui: { confirm: async () => true } }), undefined);
	assert.equal((await handler(event, { cwd, hasUI: true, ui: { confirm: async () => false } }))?.block, true);
	assert.equal(await handler({ ...event, input: { command: "git status" } }, { cwd, hasUI: false }), undefined);
	assert.equal(await handler({ ...event, toolName: "read", input: { path: "x" } }, { cwd, hasUI: false }), undefined);
});

// Rejects instead of hanging when `promise` does not settle in time.
const within = (promise, label, ms = 2000) => {
	const timeout = Promise.withResolvers();
	const timer = setTimeout(() => timeout.reject(new Error(`${label}: not settled within ${ms} ms`)), ms);
	return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer));
};

// A confirm that records its options and stays pending until the test answers it.
const pendingConfirm = () => {
	const entry = Promise.withResolvers();
	const answer = Promise.withResolvers();
	const confirm = (_title, _message, opts) => {
		entry.resolve(opts);
		return answer.promise;
	};
	return { confirm, entry: entry.promise, answer: answer.resolve };
};

test("confirm gets the turn's abort signal and an abort while it is open blocks (#133)", async () => {
	const { handler } = setup();
	const event = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } };
	const ac = new AbortController();
	const fake = pendingConfirm();
	const result = handler(event, { cwd: process.cwd(), hasUI: true, signal: ac.signal, ui: { confirm: fake.confirm } });
	const opts = await within(fake.entry, "confirm entry");
	assert.equal(opts?.signal, ac.signal);
	// Like Pi's dialog: an aborted signal closes it with no answer.
	opts.signal.addEventListener("abort", () => fake.answer(false), { once: true });
	ac.abort();
	const outcome = await within(result, "handler");
	assert.equal(outcome?.block, true);
});

test("a confirm that answers yes after the turn aborted still blocks (#133)", async () => {
	const { handler } = setup();
	const event = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } };
	const ac = new AbortController();
	const fake = pendingConfirm();
	const result = handler(event, { cwd: process.cwd(), hasUI: true, signal: ac.signal, ui: { confirm: fake.confirm } });
	await within(fake.entry, "confirm entry");
	ac.abort();
	fake.answer(true);
	const outcome = await within(result, "handler");
	assert.equal(outcome?.block, true);
});

test("history rewrites: classify skips them with historyRewrites: false, and only that", () => {
	for (const command of [
		"git commit --amend --no-edit",
		"git rebase -i HEAD~3",
		"git filter-branch --subdirectory-filter sub HEAD",
		"git rebase main",
		"git branch -D old",
		"git branch --delete --force old",
	]) {
		assert.match(classify(command, onFeature) ?? "", /history rewrite|git branch -D/, command);
		assert.equal(classify(command, onFeature, { historyRewrites: false }), undefined, command);
	}
	// A resumed rebase without an editor override runs nothing new.
	for (const command of ["git rebase --continue", "git rebase --abort"]) {
		assert.equal(classify(command, onFeature, { historyRewrites: false }), undefined, command);
	}
	// Other risks in the same command still count.
	for (const [command, label] of [
		["git commit --amend --no-edit && git push -f", "force push"],
		["git rebase main && git push origin main", "push to main/master"],
		["git branch -D old; rm -rf ~", "recursive rm"],
		["git commit --amend -m x && git reset --hard", "git reset --hard"],
		["git filter-branch --subdirectory-filter sub HEAD && git clean -fd", "git clean -f"],
		// filter-repo expires every reflog and prunes by default: it always asks.
		["git filter-repo --path x", "history rewrite (filter-repo)"],
	]) {
		assert.equal(classify(command, onFeature, { historyRewrites: false }), label, command);
	}
});

test("the main session runs history rewrites without asking; a worker still blocks them", async (t) => {
	const run = process.env.ME_PI_RUN;
	t.after(() => {
		if (run === undefined) delete process.env.ME_PI_RUN;
		else process.env.ME_PI_RUN = run;
	});
	const { handler } = setup();
	const cwd = process.cwd();
	const event = (command) => ({ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command } });
	delete process.env.ME_PI_RUN;
	assert.equal(await handler(event("git commit --amend --no-edit"), { cwd, hasUI: false }), undefined);
	assert.equal(await handler(event("git branch -D old"), { cwd, hasUI: false }), undefined);
	assert.equal((await handler(event("git reset --hard"), { cwd, hasUI: false }))?.block, true);
	const exec = await handler(event("git rebase -x 'rm -rf ~' HEAD~1"), { cwd, hasUI: false });
	assert.equal(exec?.block, true);
	assert.match(exec.reason, /history rewrite \(rebase --exec\)/);
	process.env.ME_PI_RUN = "1";
	const worker = await handler(event("git commit --amend --no-edit"), { cwd, hasUI: false });
	assert.equal(worker?.block, true);
	assert.match(worker.reason, /history rewrite \(commit --amend\)/);
	assert.equal((await handler(event("git rebase -i HEAD~3"), { cwd, hasUI: false }))?.block, true);
	const resumed = await handler(event("GIT_EDITOR='rm -rf ~;:' git rebase --continue"), { cwd, hasUI: false });
	assert.equal(resumed?.block, true);
});

test("/guard toggles enforcement for the session", async () => {
	const { handler, command } = setup();
	const notes = [];
	const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify: (message) => notes.push(message) } };
	const push = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git push origin main" } };

	await command.handler("off", ctx);
	assert.equal(notes.pop(), "guard off");
	assert.equal(await handler(push, ctx), undefined);

	await command.handler("", ctx);
	assert.equal(notes.pop(), "guard off");

	await command.handler("on", ctx);
	assert.equal(notes.pop(), "guard on");
	assert.equal((await handler(push, ctx))?.block, true);

	await command.handler("maybe", ctx);
	assert.equal(notes.pop(), "usage: /guard [on|off]");
});

test("/guard completes on and off", () => {
	const { command } = setup();
	assert.deepEqual(command.getArgumentCompletions(""), [
		{ value: "on", label: "on" },
		{ value: "off", label: "off" },
	]);
	assert.deepEqual(command.getArgumentCompletions("of"), [{ value: "off", label: "off" }]);
});
