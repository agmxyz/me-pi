# Design review, 2026-11-27

Two models reviewed the design and build order before any code: `claude-fable-5-2` and `gpt-6.2-astra`, both at high thinking, read-only, with one rebuttal round. Their answers: [fable](sources/review-fable-5-2-round2.md), [astra](sources/review-astra-6-2-round2.md), [round 1 of both](sources/review-round1.md). Both said **fix first**; both said headless one-shot coordinators remain viable. Neither ran anything. They read Pi 1.6.0's installed files, while the spikes ran on 1.6.1.

As of 2026-11-27 none of the findings below had been put to the user or applied to the other pages.

## Agreed by both

1. **Exit status is not the result.** In JSON mode Pi exits 0 on a failed or aborted reply; only text mode sets exit 1 (`dist/modes/print-mode.js:120-137` and `docs/cli-integration.md:46` of Pi 1.6.0, both read directly by the designing session). The architecture page's "exit code plus a report file" is wrong: the wrapper must read the final event of the JSON stream.
2. **The event log has several writers and check-then-append guards.** Wrappers, the chief's commands, attach and reconcile all append. One repo-wide lock must cover replay, the lease generation check, capacity and checkout reservation, and the append. A stale chief's commands and its shutdown must be fenced, not only its wakes.
3. **Launch is not atomic.** A crash between spawning Pi and recording the run leaves a live writer nobody owns, and a retry then forks the session. Record a reservation before setup and spawn, record wrapper and Pi identities, publish exit evidence by write-then-rename, and let unknown ownership block retry, attach, cleanup and signalling.
4. **Approvals are supplied by the model.** The chief copies "the user's words" itself, has open bash, and reads coordinator reports. `GLOBAL_AGENTS.md` says quoted text is not approval. Approve, takeover, drop and lifting the retry cap should come only from something the user types or confirms, bound to action, target and task.
5. **Drop and cleanup can hit a live process.** The lifecycle allows drop from STOPPING and ATTACHED. Exclude both, make cleanup take the run lock, check untracked and ignored files, never force removal.
6. **In-place needs identity, not just a clean tree.** Record branch, launch commit and reviewed commit; recheck before accept, after attach, and on every round. A switched branch or unexplained change stops for the user to inspect.
7. **The edit block does not cover `<repo>.worktrees/`**, and with open bash ADR 0004 is a convention, as the ADR itself says.
8. **The background-delegate ban does not exist yet**, and keying it on `ME_PI_UNATTENDED` would change `batch-chief`, whose TUI coordinators set that flag (`skills/batch-chief/SKILL.md:63`, read directly). This page corrects [Architecture](architecture.md), whose 2026-11-27 update said the ban "is enforced".
9. **Fresh worktrees may not load project skills** in headless mode because of Pi's project trust rules (Pi `docs/security.md`; trust keying unverified). Preflight that required resources loaded.
10. **Mutual refusal with batch-chief checks the wrong thing.** Keyed on the lease, a batch can start right after the chief exits while its coordinators still run. Key it on outstanding runs. Decision 9 also says "unchanged" while requiring an edit to `batch.ts`.
11. **Exit confirmation cannot be promised.** `packages/pi-workers/extensions/delegate.ts:595` (`me-pi@8f9a81f`, read directly): "Pi offers no hook before /reload or exit".

## Raised by one, not contested
- The "exact command" of a guard refusal can carry secrets into reports, the log and the contract; redact, and keep run logs private (fable).
- The script cannot know which session called it; the extension must pass a session and generation token (fable).
- `after` is hollow for `branch` landings: the dependent worktree lacks the dependency's commits, and a dropped dependency blocks forever (both, in different words).
- A standing approval is wider than `GLOBAL_AGENTS.md`, which says approval "persists for the same task" (fable).
- A hung run or hung lease holder has no remedy; move `cancel` earlier and allow confirmed takeover of a live holder (both).
- Task ids must satisfy `--session-id` rules; sessions are bound to their directory, so attach fails after worktree removal (fable). Astra disagreed on one detail: Pi offers Continue or Fork when the directory is gone, and the chief must refuse that.
- The glossary says the lease "outlives no session", but STALE does.

## Disagreement
- Fable called a dirty main checkout a deadlock (unattended guard refuses cleanup, the chief may not edit). Astra: not a deadlock, the user can resolve it. Both agree only the user can.
- Astra would not keep raw JSON tool output; fable keeps it as the only diagnostic of a headless run, with private permissions.

## Spike before step 1 (union of both)
1. JSON-mode final event and exit status on provider error, SIGTERM and abort.
2. A headless run in a fresh worktree: are skills and settings loaded?
3. Interactive open of a headless session, on its exact file and directory.
4. Foreground `delegate` inside `pi -p`.
5. A timer wake while a guard dialog is open or the user is typing.
6. Kill setup, wrapper and Pi separately; pid reuse; stale wake; branch switch; missing worktree.
7. `/chief`, batch preflight and a direct resume at the same time.

## Proposed cuts from slice 1 (both)
Standing approvals, `after` dependencies, spend beyond "unknown", exit confirmation, the setup-command config, automatic worktree removal.

## Build-order changes proposed
Contract generation, admission checks, reconcile and `cancel` move before the first real launch. The acceptance run of decision 26 has no fault paths and supplements, not replaces, the fault tests above.

## Update 2026-11-27: the user agreed
After reading a summary of this page the user agreed to take the three blockers and the approvals finding as written, and to the proposed cuts from slice 1. This supersedes, without rewriting them, these entries in [Open decisions](open-decisions.md): 4 (standing approvals cut; approvals come only from what the user types or confirms), 9 (refusal keyed on outstanding runs), 11 (ban must not change `batch-chief`), 19 (no automatic worktree removal; no drop while stopping or attached), 21 (no exit confirmation promised), 23 (spend cut), 24 (setup command cut), and the `after` field. The user then asked for experiments to decide the remaining points; see [Spikes](spikes.md).

Related: [Open decisions](open-decisions.md), [State machines](state-machines.md), [Architecture](architecture.md).
