# me-pi delegation

me-pi coordinates bounded specialist work while retaining responsibility for decisions, acceptance, and integration.

## Language

**Chief**:
The one agent a user talks to for a project; it splits work into tasks, launches one coordinator per task, watches them, and holds the user's approvals.
_Avoid_: Supervisor, chief of staff, manager

**Coordinator**:
The agent that owns one task end to end: it writes, checks, and commits the change itself, uses read-only workers for exploration and review, and decides acceptance or escalation.
_Avoid_: Lead who delegates the writing, implementer

**Worker**:
A bounded, read-only agent a coordinator or chief starts for exploration, research, or review; it never writes to the task's checkout.
_Avoid_: Subagent that edits, implement worker

**Caller**:
Whoever starts a coordinator (the user or a chief); it sizes the task to fit one coordinator and notices a coordinator that is stuck or looping.

**Failure provenance**:
Evidence from the owner of an operation identifying why it stopped or was refused and what is known about its effects. A worker's explanation alone is not authoritative provenance.

**Review closure**:
The disposition of findings and affected coverage that establishes whether delivered work satisfies its required review obligations.

**Task**:
One piece of work the chief assigns to one coordinator, with a brief, a landing, and a recorded outcome.
_Avoid_: Row, ticket (a ticket is one possible origin of a task), job

**Task lifecycle**:
The states every task moves through from queued to accepted or dropped, whatever its landing.
_Avoid_: Core mode, batch core

**Run**:
One uninterrupted stretch of a coordinator working on a task, ending in a report, a question, or a failure.
_Avoid_: Turn, attempt (a retry is a new run)

**Round**:
A further run the chief starts on a task that has already reported, asked, or failed: a fix, a review, an update, an answer, or a retry.

**Landing**:
The per-task policy, fixed when the task starts, for how accepted work finishes: nothing to integrate, a commit in place, a branch kept for a later local merge, or a pull request.
_Avoid_: Finish mode, task mode, batch mode, PR mode

**PR delivery**:
The landing in which acceptance is replaced by a gate on one exact commit of a pull request, followed by a merge the user approves or a decision to leave it open.
_Avoid_: Batch mode, PR mode

**Chief lease**:
The record that one session is the chief of a repo; a second session can become chief only when the holder is gone or the user confirms a takeover.
_Avoid_: Chief lock (a lease can be taken over, and one left by a session that ended is reclaimed)

**Task approval**:
The user's recorded words authorising one protected action for one task.

**Standing approval**:
The user's recorded words authorising, for the whole repo until withdrawn, ordinary pushes of a task's own branch and opening its pull request; nothing else can be standing.

**Attach**:
The user opening a coordinator's session themselves while no run is live; the chief starts no round on that task until the user leaves.

**Brief**:
What the chief gives a coordinator to define a task: the goal, a "done when" check, the landing, and the files or area in scope.
_Avoid_: Prompt, ticket

**Accept**:
The chief's recorded judgment that a task's report and result satisfy its brief; for PR delivery the gate takes its place.
_Avoid_: Approve (approval is the user's), close
