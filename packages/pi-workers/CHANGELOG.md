# Changelog

Pi shows new entries here after an update. Versions follow [semver](https://semver.org); before 1.0.0, a minor bump may change behavior.

## [Unreleased]

- `guard` asks in every session before git options and env that run a command: `git -c` with a key off a short safe list (`user.*`, `color.*`, `pull.rebase`, …), `--config-env`, `git config` writes of such keys, `submodule foreach`, `clone -c/--template`, `--exec-path`, `--upload-pack` (and `clone -u`), `push --receive-pack/--exec`, `archive --exec`, `grep -O`, `difftool -x`, an editor override on any git command, and `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_*`, `GIT_TEMPLATE_DIR`, `LESSOPEN`, or a `GIT_PAGER`/`PAGER` other than `cat`. Safe `-c` and `git config` keys, `GIT_PAGER=cat`, and `git config` reads and `--unset` stay quiet; these checks also apply in an implement worker's fresh temp repo (#115).
- `/guard` completes its `on` and `off` arguments.
- The `delegate bg: N running, $X spent` footer line is gone. It counted only background jobs, so it showed the wrong total while foreground workers ran. The activity widget shows running jobs, each result ends with its cost, and `/delegate status` lists recent calls with a total.
- Two features can run at once in one repo: `implement` locks one checkout instead of the whole repo, so a session in a Git worktree runs its own job while another writes in the main checkout. A job no longer trips when a branch checked out in another worktree moves or is deleted; `main`, `master`, tags, the stash, and other config still trip it.
- While another Pi session's `implement` job writes in a checkout, this session's `edit`, `write`, and Git tree writes there are blocked, with a pointer to `git worktree add`. Before, only the session that started the job was blocked. A git write whose directory the command does not show (a later `cd`, `bash -c`, `--git-dir`, an expanded path) is blocked while any checkout of the repo has a job running, and `edit` and `write` paths given as `~/…` or `file://…` are checked where they land.
- `git worktree remove` and `git worktree move` are blocked while an `implement` job runs in that worktree.
- `implement` workers in a linked worktree can no longer write its `.git` file.

## [0.1.6] - 2026-11-10

- The delegate activity widget is leaner: no `Delegate activity` heading, and rows show the model without its provider. Rows drop the role; foreground rows also drop the `fg` call id, while background rows keep their `bg` job id for `/delegate cancel`. Thinking level, elapsed time, and last tool stay.
- A read-only worker with `output: true` can still write into its own output directory after its wrap-up budget runs out, so it no longer loses its final file. Each such write uses the same over-budget allowance as a blocked call, and every other tool stays blocked.
- `guard` asks again in the main session before history rewrites that run a command (`git rebase -x/--exec`, an editor override such as `GIT_SEQUENCE_EDITOR`, `filter-branch --tree-filter` and other command filters); plain rewrites still run without asking (#114). Delegate workers now block these too when they resume a rebase (`GIT_EDITOR=… git rebase --continue`).

## [0.1.5] - 2026-11-09

- `guard` asks again before `git push origin 2>&1` (and `>/dev/null 2>&1`, `&>log`, `>|log`, `>&2`) on main: a redirect was read as the refspec, so the push of the current branch looked like a push to another branch. Redirects are now dropped from every git command's words.
- The delegate docs say that later worker-pool entries run only when you name them: the coordinator is not told the pool.

## [0.1.4] - 2026-11-09

- `guard` no longer asks before history rewrites in the main session: `git commit --amend`, `rebase`, `filter-branch`, and `branch -D` run, since the reflog, `refs/original/`, or `git fsck` can recover them. `git filter-repo` still asks, because by default it expires every reflog and prunes. Delegate workers still block all of them. Other risks in the same command (a force push, `reset --hard`, a recursive `rm`) still ask.
- A worker's timeout stop message now shows the role's limit (`timeout after 300s`), including when an infra retry times out. Before, it showed the time left when the attempt started, so it could print less than the limit.

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
