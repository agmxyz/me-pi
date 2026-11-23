# Coordinators write their own code; the implement worker is removed

On 2026-11-23 we decided that every coordinator writes, checks, and commits its task itself, with only read-only workers, and that the `implement` delegate role is deleted rather than kept for the main session. A task too large for one coordinator's context is split by its caller before it starts; coordinators have no cost or time cap of their own, and the caller watches for one that is stuck. One kind of writer everywhere is what the chief and future orchestration build on.

## Considered options

- **Keep `implement` for coordinators.** Rejected on evidence. In paired A/B runs on 4 real piops tickets, coordinators writing directly delivered 8/10 against 5/10; four of the five failures were the implement worker hitting its budget or time cap and leaving a WIP commit. Direct writing cost more there (median $0.43 against $0.24 per accepted run). On 7 synthetic tasks with hidden acceptance tests (2 OpenAI models), the arms tied, 26/28 against 25/28, with direct writing at 0.68× the cost per pass. Direct writing never delivered less.
- **Keep `implement` for the main session only.** Rejected for simplicity: about 18% of `implement` calls since 2026-10-26 came from interactive sessions, so it is used but not essential, and two writing paths would keep ~1,500 lines of lifecycle code (checkout lock, check freshness, commit handback, continuations) that nothing else needs.
- **Cap coordinators like workers.** Rejected: worker caps caused most failures in the evidence, Pi's dollar figure is an estimate on subscription plans, and liveness belongs to whoever launched the coordinator.

## Consequences

- Breaking change for `@agmxyz/pi-workers` (0.3.0): `role: "implement"`, `implementSkills`, and the `check` parameter go away. Read-only worker caps stay (see #54).
- Coordinator recovery is one rule: after an interruption, check the repository's state before acting, and report BLOCKED when it cannot be explained. Continuations and recovery envelopes no longer exist.
- Evidence: runner and synthetic suite under `evals/ab.ts` and `evals/synth/`; plans and results were kept outside the repository with the raw records.
