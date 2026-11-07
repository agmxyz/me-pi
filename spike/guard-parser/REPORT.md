# #78 stage 1: report-only parser spike

Report only. Nothing here ships: `guard.ts` is unchanged, the published package's dependencies are unchanged, and no release file changed. The only change outside `spike/` adds `web-tree-sitter` 0.27.1 as a root devDependency (`package.json`, `package-lock.json`).

- Base: `origin/main` 3b33842. Branch: `spike/guard-parser-78`.
- Per-row table and every list below: [`results.md`](results.md), generated. Machine-readable data: [`results.json`](results.json).
- Environment: macOS, `/bin/bash` 3.2.57 (the shell Pi 1.5.0 runs here), Node v24.21.0.

## Reproduce

```sh
npm ci
node spike/guard-parser/run.ts
```

It writes `results.json` and `results.md` and exits non-zero if a self-check fails or a command-text row has a union miss. It takes about 10 s. Two runs gave identical verdicts on all 782 rows; only names `mktemp` and `$$` randomise in the argv differ.

## What was built

| file | role |
|---|---|
| `shell-ast.ts` | The adapter. `initShellAst()` (async, once), then `commands(src) → SimpleCommand[] \| null` (synchronous). |
| `vendor/tree-sitter-bash.wasm`, `vendor/tree-sitter-bash.LICENSE` | Taken from the `tree-sitter-bash@0.25.1` npm tarball (tarball sha1 `78499ecf…0470` matches npm's `dist.shasum`; wasm sha256 `8292919c…a7a`). MIT. |
| `bash-truth.ts`, `stubs.sh`, `sandbox.sb` | Ground truth: real bash, stubbed tools, sandbox-exec. |
| `guard-rules.ts` | Reuses guard's rules. It loads a byte-for-byte copy of `guard.ts` with one appended `export { DISPOSABLE, tmpdirMayChange, gitRisk, hasShort, TMPDIR_REF }` line, so no rule is duplicated and `guard.ts` isn't touched. |
| `verdict.ts` | Truth, parser, and union verdicts. All of them use guard's rules. |
| `corpus.ts`, `record.ts`, `assert-shim.ts`, `test-shim.ts`, `rows.ts` | The corpus (see below). |
| `run.ts` | The harness. |
| `probe.mjs` | A dev aid: dumps the AST for a JSON file of sources. |

### Adapter (`shell-ast.ts`)
- Walks every `command` node: `if`/`while`/`for`/`case`, functions, `!`, subshells, `{ }`, pipelines, `&&`/`||`, `$(…)`, backticks, `<(…)`, `>(…)`, assignment values, `[[ ]]`, redirect targets, and `$(…)` inside unquoted heredoc bodies.
- **Words** are tagged `literal`, `quoted`, or `expansion`, decoded as bash would (`\-r` gives `-r`, `$'…'` is decoded ANSI-C, adjacent nodes are joined into one word).
  - Globs, `~`, braces (`{,}`, `a{b,c}`, `{1..3}`), `$x`, `${…}`, `$(…)`, and `$((…))` count as expansions.
  - `tmpdirOnly` marks a word whose only expansion is a leading `${TMPDIR:?}`, the one expansion guard's `DISPOSABLE` rule trusts.
- **Redirects** take exactly one word; any further `destination` words tree-sitter gives (its `repeat1`) go back to argv in source order. `>&-`/`<&-` take none (see B).
- **Wrapper table** (`WRAPPERS`), each parsing its options like the real tool, matched by basename so full paths work:
  - privilege and process wrappers: `sudo` (incl. `-s`/`-i`, which pass the words to a shell), `doas`, `su`, `runuser`, `pkexec`, `env` (incl. `-S`), `timeout`/`gtimeout`, `nice`, `nohup`, `time`, `command` (`-v`/`-V` run nothing), `exec`, `builtin`, `stdbuf`, `setsid`, `ionice`, `caffeinate`, `unbuffer`, `rtk [proxy]`, `flock`;
  - commands that receive their arguments at run time: `xargs` and `find -exec/-execdir/-ok/-okdir` (marked `openArgs`);
  - `sh`/`bash`/`zsh`/`dash`/`ksh`/`mksh`/`ash` (`-c`, clustered `-lc`, `-o opt -c`, and stdin).
- **Re-parsed strings:** literal bodies of `sh/bash -c`, `su -c`, `eval`, `trap ACTION SIG…`, `env -S`, `flock -c`, `ssh host …` and `watch …` (the last two marked `remote`), and heredoc or here-string bodies fed to a shell's stdin.
  - A non-literal body (`eval "$x"`, `bash -c "…$HOME"`) or a shell reading unseen stdin (`… | bash`) gives a `dynamicBody` entry, and the parser verdict asks.
- Returns `null` on `hasError`, depth > 6 (nested re-parses), source > 100 kB, or > 5000 commands. It also returns `null` on non-plain text tree-sitter silently dropped between a command's nodes (see B).

### Ground truth (`bash-truth`)
- Each row runs as `/bin/bash -c <command>` under `sandbox-exec`.
  - Environment: `PATH` is the stub dir only, `HOME=/Users/stub`, `TMPDIR` is the real macOS one (`/var/folders/gg/…/T/`) unless the test row gives one, and `BASH_ENV` points at the run's `bashenv`. Nothing else is inherited.
  - Each run gets a fresh `mkdtemp` dir, and each row its own `rowN/w` working dir. The run dir is deleted afterwards.
- **Stubs:** every name-like token in the corpus is a symlink to `stubs.sh` in the stub dir.
  - Each stub logs `name, cwd, GIT_DIR, GIT_WORK_TREE, cd-happened, argc, argv…` NUL-separated to fd 9 (the row's log). fds survive `env -i` and `exec`.
  - Wrappers then run the wrapped command as the real tool would (option parsing per tool; `su`/`runuser` permute `-c`; `sudo -s` passes the words to `bash -c`; `env -i/-u/-C/-S`; `timeout`; `nice`; `xargs` with `-0`/`-I`/`-n`; `find -exec … {} ;|+` substitutes `.` and `./found`).
  - `cat`/`tee` copy data, and `chmod` is the real one (confined by the sandbox).
  - `rm`, `git`, `ssh`, `watch`, `node`, `python3` and every other name only log.
- **bashenv** (sourced by every bash in the row):
  - path functions (`/bin/rm`, `/usr/bin/env`, … → stub), because the sandbox can't exec real binaries;
  - `cd`/`pushd`/`popd` always succeed and mark the process as moved, so `cd x && git push` reaches git and is judged as "elsewhere";
  - `test`/`[` always return true, so `[ -d /x ] && rm -rf /x` reaches rm.

  `stubs.sh` drops these functions on entry.
- **Per row:** rm/git argv lists, all calls, exit status, stderr, and a 5 s timeout. On timeout, or after the row exits, the runner SIGKILLs the row's whole process group (`detached` + `kill(-pid)`).
- **Verdict:**
  - `dangerous` if an `rm` call had a recursive option and any operand guard's `DISPOSABLE` + `..` rule would not allow, or a `git` call got a sub-command guard's `gitRisk` flags.
    - Recursive means guard's `hasShort([rR], --recursive)` plus GNU long-option prefixes `--r…`.
    - The branch is the row's branch; "elsewhere" is a prior `cd`, `-C`/`--git-dir`/`--work-tree`, `GIT_DIR`/`GIT_WORK_TREE`, or an earlier `checkout`/`switch`.
  - `unknown` on `ssh`/`watch` (remote/deferred), a timeout, a name built at run time ("command not found"), an exec the sandbox denied, or sourcing or running a file the command doesn't create.
  - Otherwise `safe`.
  - Caveat, agreed with the coordinator: `python3`/`node`/`make` are log-only, so the code they would run isn't observed. Such rows carry `truthCaveats`; guard doesn't scan those programs as shell either.

Sandbox profile (`sandbox.sb`, given `RUN` and `ROW` as `-D` parameters):

```scheme
(version 1)
(allow default)
(deny network*)
(deny signal)
(allow signal (target same-sandbox))
(deny file-write*)
(allow file-write* (subpath (param "ROW")))
(allow file-write-data (literal "/dev/null"))
(allow file-write* (regex #"^/private/tmp/sh-thd"))
(deny file-read* (subpath "/Users") (subpath "/private/tmp") (subpath "/private/var/folders"))
(allow file-read* (subpath (param "RUN")) (regex #"^/private/tmp/sh-thd"))
(allow file-read-metadata (literal "/private/tmp") (literal "/tmp") (literal "/Users") (literal "/private/var/folders"))
(deny process-exec*)
(allow process-exec (literal "/bin/bash") (literal "/bin/chmod") (subpath (param "RUN")))
```

Checked by hand inside this profile:
- A write to `/tmp/p78/escape` fails ("Operation not permitted").
- `/bin/ls` and a real `/bin/rm` can't exec.
- `kill` of a process outside the sandbox fails, but killing the sandbox's own children works.
- `~/*` and `/tmp/*` stay unexpanded.

One gap: `/private/tmp/sh-thd*` stays writable, because bash 3.2 falls back there for heredoc temp files.

### Corpus (782 rows)
Each guard test file runs against main's `guard.ts` with recording stand-ins for `assert`, `node:test` and guard. The commands come from the values the tests actually pass, not from scraping source text. Rows are deduplicated by (command, branch, TMPDIR) with their sources merged.

- `test/guard.test.ts` on this branch (main): classify, workerRisk, and gitTreeWrite commands.
- `origin/fix/guard-temp-rm` (f8a50ad) and `origin/fix/guard-command-positions` (6441faa), the same way.
  - fix/guard-temp-rm calls `classify(cmd, branch, tmpdir)` with a session TMPDIR. Those rows keep their TMPDIR (`envRow`).
- `rows.ts`:
  - #78 body rows, one row per #76 bypass class the body lists, and the comment 1 and comment 2 rows;
  - #92's evidence table and #93 (incl. `git push origin 2>&1` on `main`);
  - the quoted `>` case;
  - about 95 adversarial rows: heredocs, full-path wrappers, `$'…'`, arrays, `<<<`, line continuations, `$CMD`, `eval`/`-c`/`trap`, wrapper options, control flow, and safe controls;
  - the user's false-alarm example (`cat > q.mjs <<'EOF'` … `EOF` + `node q.mjs`).

## Results

Bash truth: **384 dangerous, 346 safe, 52 unknown** (782 rows).

### A. Misses (bash truth dangerous, verdict allows)

| verdict | misses |
|---|---|
| regex (`classify` on main) | **79** |
| parser | **8** |
| union | **4**, as two lines: |
| ‣ command-text rows | **0** |
| ‣ **A-env: TMPDIR model** | **4** |

**A-env: TMPDIR model.** These are the 4 union misses: the same command, `rm -rf "${TMPDIR:?}/x"`, from fix/guard-temp-rm's test, with the session's TMPDIR set by the test:

| row | TMPDIR | bash ran |
|---|---|---|
| 538 | `/` | `rm -rf //x` |
| 543 | `/home/me` | `rm -rf /home/me/x` |
| 548 | `/tmp/../etc` | `rm -rf /tmp/../etc/x` |
| 553 | `/tmp/a b` | `rm -rf /tmp/a b/x` |

These rows test the environment, not the command text. guard 0.1.3 assumes `${TMPDIR:?}` is the OS temp dir unless the command rebinds it (#87). Both verdicts apply that same rule, so neither can see it. Not patched, as the brief requires.

The 8 parser misses are:
- **the 4 A-env rows** above;
- **4 rows where a quoted-delimiter heredoc writes a script that a later command runs:** #149 `cat > run.sh <<'EOF' && sh run.sh`, #164 `… bash run.sh`, #165 `… chmod +x run.sh && ./run.sh`, #689 `cat > f <<'EOF' … bash f`.
  - The parser treats a quoted heredoc into `cat` as text (by design), and doesn't follow the file into the later `sh`/`bash`/`./`.
  - The regex asks on all four, so the union catches them.
  - This matters for stage 3: the proposed cat/tee heredoc allow must not be applied blind to the body when the same command later runs the written file. These rows are the counter-examples.

The regex misses (79) are listed in `results.md`. By source:
- adversarial: 26
- fix/guard-command-positions: 22
- #78 comment 2: 9
- fix/guard-temp-rm: 8
- #78: 6
- #78 comment 1: 4
- #93: 2
- #78 body: 1
- quoted `>`: 1

**#78 issue rows:** every row from the issue body and both comments is caught by the parser verdict (`ask`) except #654, `TMP""DIR=/ rm -rf "${TMPDIR:?}/x"`. For that row, bash truth is **safe**: bash takes `TMP""DIR=/` as a command name, not an assignment, so it fails with exit 127 and `rm` never runs. Both verdicts allow it, which matches the truth. `watch 'rm -rf ~'` and `ssh h 'rm -rf ~'` are truth-`unknown` (remote/deferred); the parser asks on both.

### B. Parser misreads (parser argv ≠ bash argv): 20 now; 5 causes found and fixed during the spike

The comparison allows for runtime values: an `expansion` word matches any run of bash words, and `openArgs` commands may receive extra words.

**Found and fixed in `shell-ast.ts`** (each had rows here before the fix):

1. `2>&-` / `>&-` / `<&-`: tree-sitter lexes `-` into the operator token and then attaches the next word as the redirect's `destination`. So `rm -rf dist 2>&- /Users` read as rm `-rf dist`. Fixed: close operators take no word. Self-check row added (bash argv `["-rf","dist","/Users"]`).
2. `"a"" ""b"`-style strings: tree-sitter folds string content into the closing-quote token (`" "` gives tokens `"` and ` "`). `rm -rf dist" "x /etc` read as `distx`. Fixed: double-quoted text is read from the source span minus expansions.
3. `git commit -F - <<EOF`: tree-sitter drops the `-` before a heredoc without an ERROR node. Fixed: non-blank source text between a command's nodes is taken back as a word if plain, and fails closed (`null`) otherwise.
4. `rm -r\<newline>f ~`: a line continuation inside a word; tree-sitter splits it into `-r` and `f`. Fixed: words separated only by `\<newline>` are joined.
5. `$"…"` (translated string) parses as `$` plus a string. Fixed by joining adjacent nodes.

**Remaining 20**, by cause:

| cause | rows | parser verdict |
|---|---|---|
| Name or body is only known at run time: `$CMD`, `${a[0]}`, `"${a[@]}"`, `"$(echo rm)"`, `eval "$r -rf ~"`, `eval "rm -rf $HOME"`, `bash -c '…'"$HOME"`, `trap '…'"$HOME"`, `sh <<< "…$HOME"`, `sudo -s rm -rf ~` (the stub passes the words to `bash -c`; the parser re-parses them but `~` stays an expansion) | 712, 714, 722, 724, 725, 726, 728, 612, 613, 716, 734 | ask (all) |
| stdin of a shell comes from a pipe: `cat <<'EOF' \| bash`, `tee x <<'EOF' \| sh` | 693, 151 | ask (dynamic stdin) |
| A file written by a quoted heredoc is run later (`sh run.sh`, `bash f`, `./run.sh`, `./r*.sh`) | 149, 164, 165, 689, 142 | allow on 4, ask on 142 (glob in name). The regex asks on all 5 |
| tree-sitter rejects heredoc forms bash accepts: two heredocs where the first body holds the second's delimiter (`bash <<X && python3 - <<'EOF'`), and `<<'EOF'X` (delimiter `EOFX`) | 152, 155 | `null` → ask |

None of the 20 is a parser **allow** on a dangerous row except the four "file run later" rows, which are listed under A.

### C. Candidate false alarms (regex asks, bash truth safe): 122

| category | rows |
|---|---|
| `$TMPDIR` / `${TMPDIR}` without `:?` (guard trusts only `${TMPDIR:?}`) | 61 |
| TMPDIR may be rebound before `${TMPDIR:?}` (guard's fail-closed `tmpdirMayChange`; e.g. `doas true; rm -rf "${TMPDIR:?}/x"`) | 17 |
| `mktemp -d` variable (main doesn't track it) | 17 |
| program heredoc (python/node/make); truth is safe only because the stub doesn't run the program | 16 |
| **quoted-delimiter heredoc into plain `cat`/`tee` writing a file (the proposed stage-3 allow)** | **4** |
| xargs/find with no input in the sandbox | 2 |
| bash 3.2 syntax error (`&>>`, `\|&` are bash 4; bash ran nothing) | 2 |
| another expansion in a target (`rm -rf $DIR`, `` rm -rf /tmp/`echo x` ``) | 2 |
| uncategorised (`pythonx - <<'EOF'`) | 1 |

The proposed category holds **4 of 122**: #141 `cat > notes.md <<'EOF'`, #688 `cat > f <<'EOF'`, #694 `tee f <<'EOF' >/dev/null`, #699 `tee notes.md <<'EOF' >/dev/null`. The parser verdict allows all four.
- The user's example (#781, `cat > q.mjs <<'EOF'` … `node q.mjs`) is **not** a false alarm on main: `classify` already allows it, because its `TEXT_HEREDOC` rule drops `cat` heredoc bodies. Parser: allow. Truth: safe, with a caveat (node is opaque).
- The same `TEXT_HEREDOC` allow is why the regex catches the "file run later" rows only by luck of their shape. Rows 149/164/165/689 are the boundary stage 3 has to keep.
- Most false alarms (61 + 17 + 17) are TMPDIR/mktemp policy, not parsing. Several of them are fixed on the unmerged branches, whose tests are in this corpus.

### D. Cost

| item | measured |
|---|---|
| grammar `tree-sitter-bash.wasm` (vendored) | 1,358,224 B |
| `web-tree-sitter` 0.27.1 package on disk | 4,687,401 B (includes source maps, a `debug/` build and the CJS build) |
| of which needed at runtime (`web-tree-sitter.js` + `web-tree-sitter.wasm`) | 366,547 B |
| module import | ~4.3–4.6 ms |
| init (`Parser.init()` + `Language.load()`) | ~5.1–5.7 ms, once |
| `commands()` per corpus row, p50 / p99 / max | 0.027 ms / 0.23–0.34 ms / ~6 ms (the first call, JIT warm-up) |
| 200-line script | ~5.3–5.7 ms |

`web-tree-sitter` has no `dependencies`, and tree-sitter-bash needs no native build (only its WASM is vendored).

**Async init and guard's hook:** guard's `tool_call` handler is already `async`. There are two places to await init:
1. Make guard's default export `async` and await `initShellAst()` there. Pi's docs (`docs/extensions.md`, "Async factory functions") say Pi awaits a factory's Promise before startup continues, so the parser is ready before the first tool call. The cost is ~10 ms of startup.
2. Start init at load and `await` the same promise at the top of the `tool_call` handler. This costs nothing at startup, and the first bash call waits at most ~10 ms.

After init, `commands()` is synchronous.

### E. Init failure (described, not decided)

With a missing WASM file, `initShellAst()` rejects (`Error: ENOENT: no such file or directory, open '/nonexistent/tree-sitter-bash.wasm'`) and leaves the parser unset. Every later `commands()` call then throws `initShellAst() not awaited`; it doesn't return `null`. As written, a guard wired to it would have to catch that itself, and a thrown error in the `tool_call` handler would surface as a hook failure.

The open choice from the proposal stays open:
- regex-only plus a visible warning (today's behaviour, no regression);
- ask in the main session / block workers on every bash call.

A WASM/ABI mismatch after a `web-tree-sitter` upgrade would also show up here, as a `Language.load` rejection. That's untested.

### F. Unknowns (bash truth couldn't settle): 52

| reason | rows |
|---|---|
| Runs or sources a file the command doesn't create (`./install.sh`, `. ./vars`, `source .venv/bin/activate`, `git am < p.mbox`, `cat install.sh`); its content decides | 31 (parser asks on the 18 with a recursive rm, allows the 13 install/test-script rows) |
| remote/deferred: `ssh …`, `watch …` | 9 (parser asks on 6: rm in the remote string, and #634, which also has a local `git push`. It allows #624 `ssh host ls`, #640 `ssh host git pull`, and #145 `ssh h python3 - <<'EOF'` with an rm in the heredoc body; the regex asks on #145) |
| command name built at run time ("command not found"): `$CMD -rf ~` unset, `env --ignore` (BSD `env` has no long option, so the stub fails like it), `sudo -E env PATH=/x rm` (PATH points at nothing) | 6 |
| exec the sandbox denied: `command /bin/rm` (bypasses the path functions), `env -i bash -c` with PATH cleared, and `> >(sh)` | 6 |

All rows are listed in `results.md`. Of the F rows that contain an `rm`/`git` word, the parser allows only #640 (`ssh host git pull`, remote git) and #145 (an rm inside a heredoc for a remote python3); the union asks on #145.

### Self-checks: 14/14 pass

The harness asserts bash's exact rm/git argv for rows known by hand:
- line continuation, `sudo -u`, quote joining, `timeout -s … 2>&1 /Users`, `xargs` from a pipe, `/usr/bin/env -i /bin/rm`;
- `${TMPDIR:?}` set and unset (unset: rm never runs);
- `git -C … | tail`, `bash -c`, `trap … EXIT`, mention-only text (no rm/git runs);
- a heredoc-written script run by `bash f`;
- **`rm -rf dist 2>&- /Users` → `["-rf","dist","/Users"]`**.

A broken stub, sandbox or log fails the run with exit 1.

## Acceptance

| check | result |
|---|---|
| `npm run check --prefix extensions` | passes (biome, tsc, 316 tests, install smoke test 141/141, `git diff --check`). Spike files sit outside biome's and tsc's `includes`, so they can't break it. Separately, `tsc --noEmit` over `spike/guard-parser/*.ts` with the root config is clean, and biome with the repo's style rules shows only `noTemplateCurlyInString` warnings (shell `${…}` in strings, intended). |
| one command, reproducible | `node spike/guard-parser/run.ts`; two runs gave identical verdicts on all rows |
| union misses = 0 | **0 on command-text rows; 4 on A-env: TMPDIR model rows** (listed above, not patched) |
| every #78 row caught by the parser verdict, or listed under B | all caught except #654, which bash truth calls safe (bash never runs rm) |
| self-checks | 14/14 |

## Not verified / caveats

- Truth is bash 3.2 (Pi's shell on this Mac). Under bash 4/5, `&>>` and `|&` are valid (here they're syntax errors, so truth = safe), and some heredoc edge cases may differ.
- Stubs model the tools' option parsing (sudo, doas, su, runuser, env, timeout, nice, xargs, find, …) from their docs, not the real binaries, which can't run in the sandbox. A stub that's wrong in the same way the parser's wrapper table is wrong would hide a misread. The self-checks only cover a few wrappers.
- `python3`/`node`/`make` bodies aren't executed (caveat, not unknown).
- `ssh`/`watch` strings are only logged.
- `find` substitutes `.`-style placeholders and `xargs` sees only the corpus's own input, so dynamic targets aren't explored.
- The worker rules (`workerRisk`, `gitTreeWrite`) aren't evaluated. Their commands are in the corpus, but only guard's rm/`gitRisk` rules decide verdicts here.
- No CHANGELOG line: the brief forbids touching release files.
- The corpus runs the remote branches' test files with Node outside the sandbox. They're this repo's own branches, with `assert`, `node:test` and guard replaced by recorders.
