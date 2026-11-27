### (a) What batch-chief does today

- An **attended, finite batch**: one coordinator per READY ticket or labelled row, each in a worktree and herdr pane; the chief supervises through merge, leave-open, or drop (`skills/batch-chief/SKILL.md:9-28`).
- State is an append-only JSONL event log at `<repo>.worktrees/.batch/<run-id>/events.jsonl`; commands replay it, `current` points to the run, and `ledger.md` is regenerated (`skills/batch-chief/batch.ts:1-4,449-530`).
- Launch is a **chief-executed sequence**, not one helper operation: fetch, `git worktree add`, install dependencies, split pane, export unattended/status variables, start Pi, record launch, generate contract, then prompt (`skills/batch-chief/SKILL.md:57-68`).
- Detached watchers poll every 30 seconds for deadline or coordinator absence, then send a LOOK hint; they check for a live Pi and visible dialog and can give up (`skills/batch-chief/batch.ts:36-69,1351-1458`).
- Approval records retain user words, question, action and scope; inferred approvals need confirmation. Contracts include explicit applicable approvals, excluding merge, which remains the chief/user decision (`skills/batch-chief/SKILL.md:50-53`; `skills/batch-chief/CONTRACT.md:17,48-60`).

### (b) Batch-specific versus reusable

- **Batch-specific:** READY briefs, PR/CI gate, fixed review point, push/merge workflow, live checks, ticket overlap ordering, maximum four running rows and cleanup (`skills/batch-chief/SKILL.md:30-40,57-58,74-85,101-105`).
- **Reusable concepts:** event replay and reconciliation, coordinator contracts, explicit approval scope, pane/dialog checks, deadlines, status signals, session resume and ownership boundaries. Adapting them is design work, not an existing general-chief API.
- Current default prompt conflicts with “delegate all work”: coordinators are told to edit themselves and use worktrees only on request or concurrent writers (`packages/pi-workers/extensions/delegate.ts:455-460`). ADR 0001 explicitly makes coordinators the writers (`docs/adr/0001-coordinators-write-no-implement-worker.md:3`).
- Worker flag `ME_PI_RUN=1` is distinct from unattended `ME_PI_UNATTENDED=1`; no chief role flag is evident in the inspected protocol (`packages/pi-workers/extensions/delegate-env.ts:5-17`). `guard` intercepts `tool_call` and refuses gated actions unattended (`packages/pi-workers/extensions/guard.ts:537-560`).

### (c) Single-chief enforcement

- **No single-chief lock found.** Preflight refuses a previous nonterminal batch or owed live check, but checks and writes the `current` pointer separately, without an atomic lock. It protects neither arbitrary Pi sessions nor concurrent preflight races (`skills/batch-chief/batch.ts:650-685,712-714`).

### (d) Documented limitations and open questions

- Timer messages identify neither run nor repo; an ended chief cannot receive wakes, and absent timers require manual status (`skills/batch-chief/SKILL.md:11,87`).
- Pane notifications can accidentally answer a guard dialog; the skill restricts commands while coordinators run (`skills/batch-chief/SKILL.md:89-93`). Worktree one-writer policy is not extension-enforced (`packages/pi-workers/docs/delegate.md:33`).
- Spend budgets are warnings, not automatic stops; provider failures are signals (`skills/batch-chief/SKILL.md:82`; `packages/pi-workers/extensions/delegate.ts:470-515`).

### (e) Coordinator reporting and failures

- Coordinator writes a report with exact `DONE` or `BLOCKED` status, sends a one-line herdr prompt, and stops; attempt-failure notifications are separate hints (`skills/batch-chief/CONTRACT.md:60-61,70-85`).
- `status` discovers a report only when its modification time is newer than the last event; otherwise the chief must explicitly record it. Invalid status is refused; the rest of the report is not gate-validated (`skills/batch-chief/batch.ts:730-750,941-960`; `skills/batch-chief/SKILL.md:72`).
- Notification delivery, chief availability, stale timestamps, malformed reports, pane dialogs and status-log write failures can impede observation. Budget/provider log lines do not change row state or stop work (`skills/batch-chief/batch.ts:935-960`; `packages/pi-workers/extensions/delegate.ts:477-490`).

**Verification limits:** Read-only inspection; no commands or runtime tests were available. The requested exact `rg` sweep was not runnable; tool searches respect ignore rules, so ignored/hidden checkpoint mentions may be missing.