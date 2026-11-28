# The chief drives headless Pi coordinators, with no terminal multiplexer, daemon, or pi-durable

On 2026-11-27 we decided that the per-repo chief is an ordinary interactive Pi session, and that each coordinator run is a separate one-shot Pi process (`pi -p --session-id <task>`) in the task's checkout, whose result is read from its exit status, its event stream and a report file. The user required a chief that does not depend on herdr and can replace `skills/batch-chief/`; one process per run keeps every coordinator a real Pi session with the same extensions, skills and policy, and leaves nothing running that can take all coordinators down at once.

## Considered options

- **Coordinators in herdr panes, woken by typing into the chief's pane** (what `batch-chief` did). Rejected: it ties the chief to one terminal tool, and a wake typed into a pane can answer an open guard dialog.
- **A per-repo daemon owning long-lived `pi --mode rpc` coordinators.** Rejected for now: it allows steering mid-run and keeps background jobs alive, but one daemon crash or upgrade ends every coordinator, and it adds socket and lifecycle code. Revisit if one process per run proves too limiting.
- **A host built on `@earendil-works/pi-durable`.** Rejected: as of 1.6.1 it is a separate runtime from Pi sessions, is marked experimental, and has no cross-process locking, so the lease would still be ours to write.

## Consequences

- Nobody can watch or type into a coordinator mid-run. The user attaches to its session between runs instead.
- Two runs on one session are not refused by Pi 1.6.1 and silently fork the session (spike of 2026-11-27, `docs/chief/spikes.md`), so a per-task run lock is required and attach must take it.
- A background delegate job's answer is lost when a one-shot run exits, so one-shot runs refuse `background: true`.
- Coordinators run without guard in the first version (the user's choice on 2026-11-27, guard being excluded in their own settings), so nothing refuses a destructive command; the contract tells the coordinator which commands to report to the chief instead of running. Superseded on 2026-11-27 by [#197](https://github.com/agmxyz/me-pi/issues/197): a coordinator follows the guard state of the chief session that starts its run, guarded by default, and the contract lists no command ([Guard](../chief/slice-1.md#guard)).
