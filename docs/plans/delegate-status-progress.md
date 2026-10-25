# Ticket: Show active worker progress in `/delegate status`

**Rig:** fresh Herdr Pi session `rig-smoke w3:p2C`.

## User benefit

When a background delegate is running, `/delegate status` currently identifies its call and models but not its stage or which worker is still active. Show a compact snapshot so a user returning to the session can tell whether work is in `Workers` or `Rebuttal` and what each active worker last did, without relying on the TUI activity panel.

## Scope

Add per-worker rows to the existing status output using `ActiveCall.stage` and `ActiveCall.workers` already held by `extensions/delegate-command.ts`. Keep the existing call summary, pools, tool availability, and history. List active workers only; show the worker index for multi-worker calls, short model, thinking level, elapsed time, and latest tool label when present. Omit an unavailable latest-tool label. Use the existing sanitized/allowlisted tool label, never task text, tool arguments, results, or reasoning. Do not change activity-widget rendering, worker lifecycle, or cancellation behavior.

## Acceptance

- `/delegate status` retains current output and adds stage plus concise per-active-worker progress under a running call.
- Completed workers are not presented as still running; calls without worker metadata retain current output.
- The worker detail contains no prompt/task text or tool arguments/results. Unknown/latest-tool-not-yet-seen is omitted rather than guessed.
- No settings, installer, network, or external integration changes.

## Deterministic test seams

In `test/delegate.test.mjs`, exercise the registered command via `registerDelegateCommand` with a fake Pi/UI and a controlled `CommandDeps.active` map containing two worker entries (one active, one complete), a `Rebuttal` stage, and a known sanitized label such as `grep`. Assert the notification includes the stage and active worker's model/thinking/index/latest tool, excludes the completed worker's tool, and retains the existing call summary. Include a no-worker-metadata case to guard compatibility. Avoid sleeps, child processes, and assertions on real elapsed seconds.

Run the full required check exactly as `npm run check --prefix extensions`.

## Live workflow and safety

Main session first creates a clean, unique `goal/...` branch on the shared checkout; do not start work on `main`/`master`. Then use foreground Scout for a narrow check of the existing command/test seams, background `implement` for this two-file change, a foreground read-only Review of the committed diff, and the full check on the resulting tree. Keep the implement worker the sole checkout writer until handback. Wait for the background result; no installer, settings edits, remote actions, PR, or publishing.

**Lifecycle constraint:** the repository's `implement` contract requires the worker to run its declared check and commit passing changes before handback. Therefore Review and a post-review full check occur after that commit; the requested strict `Scout → implement → Review → full suite → commit` order is not available through one implement job. Treat a failed check, WIP, tripwire, or review finding as incomplete and stop for coordinator review before further work.

## Completion evidence

Completed in implementation commit `29903b8`. The compatibility finding was fixed; final Standards and Spec reviews found no remaining issues. `npm run check --prefix extensions` passed (179 tests, 56 smoke checks).

An earlier `593685ms` shutdown delay did not recur (isolated run: `1.47s`; full suite: about `22s`). It was not fixed, and its root cause is unknown.
