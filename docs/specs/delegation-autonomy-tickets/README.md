# Delegation autonomy — local ticket index

> **Temporary LOCAL planning artifact.** The existing authoritative plan remains `docs/specs/delegation-autonomy.md`. It now records the user-approved pragmatic verification amendment and current local implementation status. No tracker, live install, policy activation, or remote action is authorized or performed here.

## Purpose and authority

These local IDs and this index replace the external-tracker workflow for this initiative. Do not create a GitHub parent or subtickets, or infer permission for comments, closure, PRs, push, merge, or publication. The user's choice is local spec/tickets and later cleanup—not now and not automatic.

Temporary cleanup set, only at a later user-approved cleanup point: the existing `docs/specs/delegation-autonomy.md`, this ticket directory, and `docs/specs/delegation-autonomy-handoff.md`. Preserve all through implementation; do not delete them automatically. `GLOSSARY.md` and `docs/research/*` are existing references, not cleanup targets or orphaned files.

## Tickets and status

Statuses are **PENDING** unless explicitly marked otherwise. IN PROGRESS is not completion; DONE requires reviewed changes, a passing exact repository check, and an identified local commit. The 2026-10-30 amendment defers cross-model fallback; the later pragmatic verification amendment adds narrow correlated ordinary-Bash-failure provenance, evidence-driven skill defaults, and safer installer-collision guidance. The current amended source passed the exact check (204 tests; 103 installer smoke checks); the worker handback records its normal local commit. Independent integrated coordinator review and final acceptance remain pending; the prior `f0a40af` check/review records are historical. Preserve baseline `17d2d09e5319e23a93f6d034337c6f72b4f2d311`; A4 remains explicitly inactive.

| ID | Scope | Status |
|---|---|---|
| [A0](A0.md) | Repo-owned single-task and ticket-graph skills; safe user-level discovery | Pragmatic verification amendment implemented locally; current exact check passed (204 tests; 103 installer smoke checks); independent review pending. A0-live remains unstarted and blocked by separate live-install/reload approval; prerequisite for A4 authoring/activation respectively |
| [A1](A1.md) | Coordinator workflow and artifact-ownership guide | Amended guide source updated locally; current exact check passed; independent review pending; recovery not activated; prerequisite for A4 |
| [A2](A2.md) | Typed provenance and safe first-only dispatch; cross-model fallback deferred | Pragmatic correlated Bash-failure and canonical declared-check evidence added locally; current exact check passed; independent review pending. No endpoint/scope enforcement claim. Historical checkpoints do not verify this delta. A4 remains inactive |
| [A3](A3.md) | 45-minute implement hard-time default; separately approved scout cap increase to 60 calls | Existing ticket scope/source accepted at `f0a40af`; the current amended source passed the exact check; independent coordinator review remains pending |
| [A4](A4.md) | Bounded same-model coordinator continuations (authored INACTIVE) and later activation | **INACTIVE:** prior source checkpoint `f0a40af`; current amended source passed the exact check, while independent coordinator review remains pending. Same-run ordinary Bash repair is not A4 continuation or replay authority. Activation remains blocked pending A0-live and separate install/policy/reload approval; live policy and personal pilot untouched |
| [A5](A5.md) | Optional review model pool, selection only | Prior selection-only source/check at `f0a40af` remains historical and unchanged; current overall exact check passed and independent coordinator review remains pending. Its fallback checkpoint is not current runtime support; current dispatch is first-only. Selection remains independent of A2/A4 |
| [A6](A6.md) | Concurrent worktree writers | Pending, deferred design-only; not a current delivery blocker |

**Dependency graph (amended 2026-10-30):** A0, A1, A2, A3, and A5 have no ticket dependencies. A4 authoring requires **A0-source, A1, A2's amended trusted-provenance/first-only-dispatch acceptance, and A3**; the original scoped-fallback capability is deferred and is not an A4 prerequisite. A4 activation additionally needs **A0-live** and complete separate install/policy/reload approval. A5 selection has no A2 dependency. A6 is independent and deferred.

Approved order (2026-10-29): A3 → A5 → A1 → A2 → A0-source → A4 (authored INACTIVE) → frozen final two-axis review of the whole result, including inactive A4 → activation (separate user approval). Keep one checkout writer and serialize writes.

The `f0a40af` source/check/review record and its affected-delta closures are historical evidence for that earlier state only. The current pragmatic amendment passed the exact check (204 tests; 103 installer smoke checks); independent coordinator review and final acceptance remain pending. A4 remains INACTIVE; same-run ordinary Bash repair is not continuation or replay authority. Live activation remains blocked; `GLOBAL_AGENTS.md`, the personal pilot, and live installation remain untouched.

## Shared acceptance and boundaries

Every ticket uses the exact repository check **`npm run check --prefix extensions`**. Acceptance targets in the authoritative spec are not claims of passing tests; ticket rows above record source/check evidence and remaining review or activation gates where known.

The spec distinguishes **current** from **future** policy. Current stop-on-any-guard/worker-limit behavior remains binding until A4's approved, tested capability/policy/skill-install-and-reload gate is fully active. A3's 45-minute implement limit and separately approved 60-call scout cap apply only after the changed runtime is loaded; neither activates A4. Do not use A4's planned recovery while bootstrapping.

**Historical evidence (2026-10-30):** Source at `f0a40af2d0b2cd4963b6f71cd460448c47d59d3c` passed the exact check (198 tests, 92 installer smoke checks) and received integrated Standards/Spec review from the fixed baseline through `6daa873`, followed by correction/affected-delta closures `bg86`/`bg87`, `bg90`/`bg91`, `bg93`/`bg94`, and `bg96`/`bg97`. Those results cover only that source state. The current change starts at `508f092d442261b6e6b796a9744016095365a7cb`; preserve review baseline `17d2d09e5319e23a93f6d034337c6f72b4f2d311`. The current amended source passed the exact check (204 tests; 103 installer smoke checks); independent coordinator review and final acceptance remain pending. Cross-model fallback remains deferred; A4 remains source-only and inactive. A0-live, personal-pilot migration, install, policy activation, reload, and remote publication were not performed.

The LOW delegate-activity readability backlog remains only the pointer in `docs/research/karto-delegation-pilot.md` (“Low-priority backlog: delegate activity readability”); it is not a dependency or ticket here.