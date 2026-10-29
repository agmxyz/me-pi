# Delegation autonomy — local ticket index

> **Temporary LOCAL planning artifact.** Intended repository path: `docs/specs/delegation-autonomy-tickets/README.md`. The existing authoritative plan remains `docs/specs/delegation-autonomy.md`. No implementation, tracker, install, policy activation, or remote action was performed to prepare this draft.

## Purpose and authority

These local IDs and this index replace the external-tracker workflow for this initiative. Do not create a GitHub parent or subtickets, or infer permission for comments, closure, PRs, push, merge, or publication. The user's choice is local spec/tickets and later cleanup—not now and not automatic.

Temporary cleanup set, only at a later user-approved cleanup point: the existing `docs/specs/delegation-autonomy.md`, this ticket directory, and `docs/specs/delegation-autonomy-handoff.md`. Preserve all through implementation; do not delete them automatically. `GLOSSARY.md` and `docs/research/*` are existing references, not cleanup targets or orphaned files.

## Tickets and status

Statuses are **PENDING** unless explicitly marked otherwise. IN PROGRESS is not completion; DONE requires reviewed changes, a passing exact repository check, and an identified local commit. A4 is source/check complete but remains explicitly inactive pending the final integrated review and separate activation gate.

| ID | Scope | Status |
|---|---|---|
| [A0](A0.md) | Repo-owned single-task and ticket-graph skills; safe user-level discovery | A0-source sources/docs/installer and hermetic discovery acceptance complete (`npm run check --prefix extensions`: 198 tests, 92 installer smoke checks); final integrated independent two-axis review pending; A0-live blocked by the current no-live-install boundary and not started; prerequisite for A4 authoring/activation respectively |
| [A1](A1.md) | Coordinator workflow and artifact-ownership guide | Source/check complete at guide source commit `b6f5815295ed558aff72dcb26aa1dca916ed8a2c` (183 tests; all 56 installer smoke checks); final integrated independent two-axis review pending; recovery not activated; prerequisite for A4 |
| [A2](A2.md) | Typed stop provenance; fail-closed fallback limitation | Earlier provenance checkpoint at `be57e36` does not close the endpoint correction. Cross-model fallback is disabled because installed Pi cannot bind the fresh child's effective endpoint; current delta check passed (198 tests, 92 installer smoke checks); independent affected-delta closure pending. Coordinator-owned consent remains external; A4 inactive |
| [A3](A3.md) | 45-minute implement hard-time default; separately approved scout cap increase to 60 calls | DONE for original A3 scope (local commit); prerequisite for A4 |
| [A4](A4.md) | Bounded recovery policy (authored INACTIVE) and later activation | SOURCE/CHECK COMPLETE; final integrated independent Standards/Spec review pending. ACTIVATION BLOCKED: A0-live unavailable, separate user approval and the full approved capability/install/reload gate still required; live policy and personal pilot untouched |
| [A5](A5.md) | Optional review model pool, selection only | Source/check accepted at `c01ed0e` (183 tests; all 56 installer smoke checks); bounded review `bg65` adequate; final integrated independent two-axis review pending; independent of A2/A4 |
| [A6](A6.md) | Concurrent worktree writers | Pending, deferred design-only; not a current delivery blocker |

**Dependency graph:** A0, A1, A2, A3, and A5 have no ticket dependencies. A4 authoring is blocked by **all of A0-source, A1, A2, and A3**; A4 activation additionally needs **A0-live** and separate user approval (spec, “Approved delivery decisions”). A5 has no A2 dependency; A2 owns its later fallback-safety migration. A6 is independent and deferred.

Approved order (2026-10-29): A3 → A5 → A1 → A2 → A0-source → A4 (authored INACTIVE) → frozen final two-axis review of the whole result, including inactive A4 → activation (separate user approval). Keep one checkout writer and serialize writes.

A4 source/check is now complete, but the current phase is not fully activated: final integrated review remains pending; A0-live is unavailable; `GLOBAL_AGENTS.md` and the personal pilot remain untouched; no install, migration, or reload occurred. Activation still requires separate user approval and the full capability, live-policy, install/reload, and affected-delta gate.

## Shared acceptance and boundaries

Every ticket uses the exact repository check **`npm run check --prefix extensions`**. Acceptance targets in the authoritative spec are not claims of passing tests; ticket rows above record source/check evidence and remaining review or activation gates where known.

The spec distinguishes **current** from **future** policy. Current stop-on-any-guard/worker-limit behavior remains binding until A4's approved, tested capability/policy/skill-install-and-reload gate is fully active. A3's 45-minute implement limit and separately approved 60-call scout cap apply only after the changed runtime is loaded; neither activates A4. Do not use A4's planned recovery while bootstrapping.

The LOW delegate-activity readability backlog remains only the pointer in `docs/research/karto-delegation-pilot.md` (“Low-priority backlog: delegate activity readability”); it is not a dependency or ticket here.