# Evaluating `evolvability-review`

Draft protocol. The skill is not installed until it passes. Fill in every `TBD` and commit this file before the first scored run; thresholds change only by a new commit made before the next run.

## Question

Does `code-review` plus `evolvability-review` find real future change cost that `code-review` alone misses, without flagging clean code, at a review cost worth paying?

## Repos and roles

| Role | Sources | Rule |
|---|---|---|
| Tuning | `me-pi`, `piops`, public controls | Iterate on the skill freely. Results here are not evidence. |
| Held out | `f0` | Untouched until the skill is frozen at a commit; scored once. |
| Clean controls | `python-hyper/h11` (`_state.py`, `_connection.py`, PR #132), `tj/commander.js` 2021 PRs (#1502, #1513) | A good reviewer reports few or no findings. |
| Known-bad controls | commander.js at the parent of #1502 (argument checks tied to the action handler); Theatrical Players kata (TS, Python) | A good reviewer reports the documented problem. |

All clones and repo copies live in a temp directory, never in the source repos.

## Arms

- **A:** `code-review` (Standards + Spec) alone.
- **B:** `code-review` + `evolvability-review`.
- Same model, thinking level, and diff per case. Report token cost per arm; B costs more by construction, so compare findings per cost as well as raw.

## Stage 1: precision and noise

- Cases: TBD (target ~20) merged diffs from tuning repos plus all clean controls.
- Each arm runs 3 times per case.
- The user labels every finding blind to arm: **real** (would change the code), **taste**, or **wrong**.
- Measures: precision (real / all), findings on clean controls, agreement across the 3 runs.
- Pass: precision ≥ TBD; clean-control findings ≤ TBD per case; B's added real findings > 0 on ≥ TBD cases.

## Stage 2: recall on planted defects

- Plant one defect per diff copy, one per mechanism: leaked decision, duplicated rule, change amplification, contract drift (validation or error handling), blind feedback, prose drift.
- Include the known-bad controls.
- Pass: B detects ≥ TBD of planted defects and beats A on ≥ TBD mechanisms without lower Stage 1 precision.

## Stage 3: does acting on findings help (held out, `f0`)

- Pick a snapshot with real later commits. Branch **fix** applies B's High and Medium remedies; branch **base** does not.
- Replay TBD real later changes as tasks on both branches, each run TBD times by the same agent setup.
- Measures: task success on the repo check, files touched, diff size, tokens, wall time, regressions.
- Pass: fix beats base on success or cost by ≥ TBD with no more regressions.
- Small samples detect only large effects; a null result is reported as inconclusive, not as harmless.

## Records

Per run: case id, arm, skill commit, model, thinking, tokens, wall time, findings with labels. Keep the record outside the checkout until a results write-up is committed.
