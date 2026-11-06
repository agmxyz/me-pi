# Changelog

Pi shows new entries here after an update. Versions follow [semver](https://semver.org); before 1.0.0, a minor bump may change behavior.

## [Unreleased]

- The delegate docs say that later worker-pool entries run only when you name them: the coordinator is not told the pool.

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
