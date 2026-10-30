# Delegation autonomy — local ticket index

> **Temporary LOCAL planning artifact.** Intended repository path: `docs/specs/delegation-autonomy-tickets/README.md`. The existing authoritative plan remains `docs/specs/delegation-autonomy.md`. No implementation, tracker, install, policy activation, or remote action was performed to prepare this draft.

## Purpose and authority

These local IDs and this index replace the external-tracker workflow for this initiative. Do not create a GitHub parent or subtickets, or infer permission for comments, closure, PRs, push, merge, or publication. The user's choice is local spec/tickets and later cleanup—not now and not automatic.

Temporary cleanup set, only at a later user-approved cleanup point: the existing `docs/specs/delegation-autonomy.md`, this ticket directory, and `docs/specs/delegation-autonomy-handoff.md`. Preserve all through implementation; do not delete them automatically. `GLOSSARY.md` and `docs/research/*` are existing references, not cleanup targets or orphaned files.

## Tickets and status

Statuses are **PENDING** unless explicitly marked otherwise. IN PROGRESS is not completion; DONE requires reviewed changes, a passing exact repository check, and an identified local commit. The 2026-10-30 user-approved amendment to revision `delegation-autonomy1e60e1d` defers cross-model fallback; current A2 acceptance is trusted provenance plus safe first-only dispatch. A4 remains explicitly inactive.

| ID | Scope | Status |
|---|---|---|
| [A0](A0.md) | Repo-owned single-task and ticket-graph skills; safe user-level discovery | A0-source accepted at `f0a40af`; A0-live remains unstarted and blocked pending separate pilot-migration/install/policy-activation/reload approval; prerequisite for A4 authoring/activation respectively |
| [A1](A1.md) | Coordinator workflow and artifact-ownership guide | Source accepted at `f0a40af`; recovery not activated; prerequisite for A4 |
| [A2](A2.md) | Typed stop provenance and safe first-only dispatch; cross-model fallback deferred | **AMENDED CURRENT SCOPE:** trusted provenance and safe first-only dispatch; no endpoint/scope enforcement claim. Source accepted at `f0a40af`; scoped fallback remains deferred until supported child-boundary enforcement and positive scope/budget tests. Historical checkpoints `be57e36`/`acecbe2` remain evidence of their delivered states. A4 remains inactive |
| [A3](A3.md) | 45-minute implement hard-time default; separately approved scout cap increase to 60 calls | DONE; source accepted at `f0a40af`; prerequisite for A4 |
| [A4](A4.md) | Bounded same-model coordinator continuations (authored INACTIVE) and later activation | **AMENDED, INACTIVE:** same-model continuation source accepted at `f0a40af`; future continuations stay on the same selected eligible model and original authority, with fixed-slice and per-attempt budgets. Cross-model fallback is deferred, not an A2 prerequisite. Activation remains blocked pending A0-live and separate exact pilot-migration/install/policy-activation/reload approval; live policy and personal pilot untouched |
| [A5](A5.md) | Optional review model pool, selection only | Source accepted at `f0a40af`; `bg65` bounded review remains historical evidence. Its fallback checkpoint is not current runtime support; current dispatch is first-only. Selection remains independent of A2/A4 |
| [A6](A6.md) | Concurrent worktree writers | Pending, deferred design-only; not a current delivery blocker |

**Dependency graph (amended 2026-10-30):** A0, A1, A2, A3, and A5 have no ticket dependencies. A4 authoring requires **A0-source, A1, A2's amended trusted-provenance/first-only-dispatch acceptance, and A3**; the original scoped-fallback capability is deferred and is not an A4 prerequisite. A4 activation additionally needs **A0-live** and complete separate install/policy/reload approval. A5 selection has no A2 dependency. A6 is independent and deferred.

Approved order (2026-10-29): A3 → A5 → A1 → A2 → A0-source → A4 (authored INACTIVE) → frozen final two-axis review of the whole result, including inactive A4 → activation (separate user approval). Keep one checkout writer and serialize writes.

A4 source is accepted but remains INACTIVE; same-model continuation is not active. At source `f0a40af`, `npm run check --prefix extensions` passed (198 tests; 92 installer smoke checks), and the final independent affected-delta closure found no remaining findings. Live activation remains blocked pending separate exact pilot-migration/install/policy-activation/reload approval; `GLOBAL_AGENTS.md`, the personal pilot, and live installation remain untouched.

## Shared acceptance and boundaries

Every ticket uses the exact repository check **`npm run check --prefix extensions`**. Acceptance targets in the authoritative spec are not claims of passing tests; ticket rows above record source/check evidence and remaining review or activation gates where known.

The spec distinguishes **current** from **future** policy. Current stop-on-any-guard/worker-limit behavior remains binding until A4's approved, tested capability/policy/skill-install-and-reload gate is fully active. A3's 45-minute implement limit and separately approved 60-call scout cap apply only after the changed runtime is loaded; neither activates A4. Do not use A4's planned recovery while bootstrapping.

**Final source evidence (2026-10-30):** Source accepted at `f0a40af2d0b2cd4963b6f71cd460448c47d59d3c`; the exact check passed there (198 tests, 92 installer smoke checks). Independent Standards/Spec review covered baseline `17d2d09e5319e23a93f6d034337c6f72b4f2d311` through `6daa873`, followed by correction reviews `bg86`/`bg87`, `bg90`/`bg91`, wording/Spec reviews `bg93`/`bg94`, and final affected-delta closures `bg96`/`bg97` at `f0a40af`, both with no remaining findings. This is full integrated review plus affected-delta closure, not a new full review for each delta; review runs did not rerun the check. Required findings were resolved or the capability deferred with user approval. Cross-model fallback remains deferred; A4 same-model continuation is source-only and inactive. A0-live, migration, install, policy activation, reload, and remote publication were not performed.

The LOW delegate-activity readability backlog remains only the pointer in `docs/research/karto-delegation-pilot.md` (“Low-priority backlog: delegate activity readability”); it is not a dependency or ticket here.