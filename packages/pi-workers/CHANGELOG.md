# Changelog

Pi shows new entries here after an update. Versions follow [semver](https://semver.org); before 1.0.0, a minor bump may change behavior.

## [Unreleased]

- **Behavior change:** `guard` asks only when a bash command is really dangerous: a recursive `rm` (or `find … -delete`) outside every Git repo (or of a repo root or `.git`) that isn't a temp or build path; losing uncommitted work (`git reset --hard`, `clean -f`, `checkout --`, `restore`, `switch -f`, or a recursive `rm` inside a repo), asked only when `git status` shows changes there, and `git stash drop`/`clear`, always asked; and a force push or a push to `main`/`master` on a network remote. It now parses commands with tree-sitter instead of matching their text, so `rm`/`git` inside messages, quoted arguments, and heredocs written to files no longer prompts. It no longer asks about `commit --amend`, `rebase`, `filter-branch`/`filter-repo`, `branch -D`, or pushes to a local path. Over 6,959 distinct commands from real Pi sessions, on a feature branch, it asks about 67 (60, plus 7 only on a dirty tree), where 0.1.3 asked about 205.
- **Behavior change:** delegate workers block every command `guard` would ask about (a discard only on a dirty tree), and still block `commit --amend`, `rebase`, `filter-branch`/`filter-repo`, and `branch -D`.
- `guard` asks when a command runs code it can't trace: a shell string git runs (`rebase -x`, `filter-branch` filters, `bisect run`, `submodule foreach`, `git -c` keys that aren't plain data, git aliases, options whose value is a command such as `--upload-pack`/`--receive-pack`/`--exec`/`grep -O`, variables git reads as a command or config source such as `GIT_EDITOR`/`GIT_SSH_COMMAND`/`GIT_CONFIG_*`/`EDITOR`, and `git config` writes of such keys), a shell reading `/dev/stdin`, a heredoc-written script that is then run, or a `sh -c` string with an `xargs -I`/`find -exec` placeholder.
- `guard` falls back to its older pattern rules for a command the parser can't read, and for the whole session, with one warning, if the parser fails to load within 5 seconds. Disk lookups for one command share a 5-second budget. A lookup that fails or times out counts as unknown and asks, never as "not a repo", "not `main`", or "a local remote".
- New dependency `web-tree-sitter` 0.27.1; the bash grammar (`tree-sitter-bash` 0.25.1, MIT) ships in `vendor/`.

## [0.1.3] - 2026-11-07

- `guard` asks again before a recursive `rm` of `"${TMPDIR:?}/name"` when the command could rebind `TMPDIR` first (`TMPDIR=/ rm …`, `export TMPDIR=/;`, `env`, `sudo`, `unset`, `source`, quote-split names, and similar). `${TMPDIR:?}` only catches an unset `TMPDIR`. Plain cleanups such as `rm -rf "${TMPDIR:?}/x"` still pass.
- `guard` now checks recursive `rm` targets that come after a redirect containing `&` or `|` (`rm -rf dist 2>&1 /Users`, `&>`, `>|`), targets glued to a redirect (`rm -rf /tmp/&>/dev/null` passes `/tmp/` to `rm`), and options glued to a redirect (`rm -rf>/dev/null /Users` is recursive). Before, it allowed these.
- The README's Safety section says `guard` can't see symlinks or other state that earlier commands left on disk.

## [0.1.2] - 2026-11-06

- `guard` no longer asks when a command opens with a quoted heredoc fed to `python`, `python3`, or `node` (`python3 - <<'EOF'`, optionally after `cd <dir> &&`) just because the program's text mentions `rm -rf` or `git push`. Any other heredoc is still checked, and so is everything after the body.

## [0.1.1] - 2026-11-06

- `implement` workers are told to keep scratch files in `"${TMPDIR:?}/<name>"`, which `guard` allows to remove, instead of a bare `$TMPDIR`, whose cleanup `guard` blocked in workers.
- The README's examples are plain requests: Pi decides when to delegate and which worker to use.

## [0.1.0] - 2026-11-06

First versioned release of the Pi package: `delegate`, `guard`, and `Skill`.

- `delegate` runs `scout`, `general`, and `implement` workers as separate Pi processes with hard time and cost limits, and returns only their answers.
- `implement` edits your checkout on a feature branch under a per-repo lock, runs your check, and commits; ✓ means the check passed on exactly the delivered commit.
- `/new`, `/resume`, `/fork`, and `/clone` ask before ending running background jobs; the default is to stay.
- `guard` asks before risky bash such as force pushes, `git reset --hard`, and recursive `rm`.
- `Skill` loads a skill Pi already discovered, by name.
- The repository moved to `agmxyz/me-pi`.
