# Delegation autonomy — local ticket index

> **Temporary LOCAL planning artifact.** Intended repository path: `docs/specs/delegation-autonomy-tickets/README.md`. The existing authoritative plan remains `docs/specs/delegation-autonomy.md`. No implementation, tracker, install, policy activation, or remote action was performed to prepare this draft.

## Purpose and authority

These local IDs and this index replace the external-tracker workflow for this initiative. Do not create a GitHub parent or subtickets, or infer permission for comments, closure, PRs, push, merge, or publication. The user's choice is local spec/tickets and later cleanup—not now and not automatic.

Temporary cleanup set, only at a later user-approved cleanup point: the existing `docs/specs/delegation-autonomy.md`, this ticket directory, and `docs/specs/delegation-autonomy-handoff.md`. Preserve all through implementation; do not delete them automatically. `GLOSSARY.md` and `docs/research/*` are existing references, not cleanup targets or orphaned files.

## Tickets and status

All statuses are **PENDING**; these drafts are not implementation evidence.

| ID | Scope | Status |
|---|---|---|
| [A0](A0.md) | Repo-owned single-task and ticket-graph skills; safe user-level discovery | Pending; A0-source prerequisite for A4 authoring, A0-live for A4 activation |
| [A1](A1.md) | Coordinator workflow and artifact-ownership guide | Pending; prerequisite for A4 |
| [A2](A2.md) | Typed stop provenance and safe fallback authorization | Pending; prerequisite for A4 |
| [A3](A3.md) | 45-minute implement hard-time default | Pending; prerequisite for A4 |
| [A4](A4.md) | Bounded recovery policy (authored INACTIVE) and later activation | Pending; authoring blocked by A0-source+A1+A2+A3; activation needs A0-live + separate user approval |
| [A5](A5.md) | Optional review model pool, selection only | Pending; independent of A2/A4 |
| [A6](A6.md) | Concurrent worktree writers | Pending, deferred design-only; not a current delivery blocker |

**Dependency graph:** A0, A1, A2, A3, and A5 have no ticket dependencies. A4 authoring is blocked by **all of A0-source, A1, A2, and A3**; A4 activation additionally needs **A0-live** and separate user approval (spec, “Approved delivery decisions”). A5 has no A2 dependency; A2 owns its later fallback-safety migration. A6 is independent and deferred.

Approved order (2026-10-29): A3 → A5 → A1 → A2 → A0-source → A4 (inactive) → frozen final two-axis review of the whole result, including inactive A4 → activation (separate user approval). Keep one checkout writer and serialize writes.

## Shared acceptance and boundaries

Every ticket uses the exact repository check **`npm run check --prefix extensions`**. No check was run while preparing these drafts. Acceptance targets are proposed seams, not claims of passing tests.

The spec distinguishes **current** from **future** policy. Current stop-on-any-guard/worker-limit behavior remains binding until A4's approved, tested capability/policy/skill-install-and-reload gate is fully active. A3's 45-minute limit applies only after its changed runtime is loaded. Do not use A4's planned recovery while bootstrapping.

The LOW delegate-activity readability backlog remains only the pointer in `docs/research/karto-delegation-pilot.md` (“Low-priority backlog: delegate activity readability”); it is not a dependency or ticket here.