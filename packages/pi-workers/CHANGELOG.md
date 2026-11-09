# Changelog

Pi shows new entries here after an update. Versions follow [semver](https://semver.org); before 1.0.0, a minor bump may change behavior.

## [Unreleased]

- `guard` asks again before `git push origin 2>&1` (and `>/dev/null 2>&1`, `&>log`, `>|log`, `>&2`) on main: a redirect was read as the refspec, so the push of the current branch looked like a push to another branch. Redirects are now dropped from every git command's words.

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
