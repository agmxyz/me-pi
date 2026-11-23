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
