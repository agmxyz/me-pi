# Chief wiki

Design record for the per-repo chief. Pages are history: every claim carries a date, and claims about code cite a commit. Nothing here describes built behaviour; as of 2026-11-27 no chief code exists.

## Build
- [Slice 1 spec](slice-1.md): the single description to build from, written 2026-11-27; later than every other page where they differ.

## Decisions
- [Not built on pi-durable](pi-durable.md): why `@earendil-works/pi-durable` was rejected as the foundation.
- [Architecture](architecture.md): interactive chief session, private extension, CLI, headless coordinators.
- [State machines](state-machines.md): chief lease, task lifecycle, runs.
- [Landing](landing.md): the per-task policy for how accepted work finishes, and what replaces `batch-chief`.

## Evidence
- [Spikes](spikes.md): what was run against Pi itself, with dates and versions.
- [Design review 2026-11-27](review.md): two-model review of the design and build order; verdict fix first.

## Open
- [Open decisions](open-decisions.md): the original open items, what three grill rounds settled on 2026-11-27, what stayed open, and the slice-1 build order.

## Sources
- [Sources](sources/): discussion rounds, worker reports and spike records, sanitized for publication. Spike summaries preserve observed outcomes; scripts describe the original experiments and may produce raw output if rerun.
