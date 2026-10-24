# Coding standards

For human and agent contributors changing or reviewing `me-pi` code. Optimize for the next change; apply these criteria to touched behavior, not as a mandate to restructure the repository.

## Ownership

- Read the behavior owner, callers, and tests before changing it. Give each invariant and state transition one discoverable owner; callers request outcomes rather than repeat its decisions.
- Make effects, ordering, and failure modes clear at the interface. Distinguish partial or unavailable outcomes from success; prefer behavior-oriented interfaces over coordinated mutable internals.

## Scope and abstraction

- Include local design repair needed for the request; propose broader restructuring separately.
- Justify new modules, options, or seams by caller knowledge removed or concrete variation needed by a caller or test, not line count. Forwarding can earn its place as an adapter or compatibility interface.
- New compatibility paths need an identified consumer or migration; temporary compatibility also needs a retirement condition.

## Verification and failure

- Exercise changed behavior through the owning module's supported interface. Focused helper tests are useful; check caller/event wiring when the risk crosses those seams.
- For lifecycle changes, verify affected cancellation, timeout, partial-work, cleanup, and recovery paths. Isolate filesystem/process effects in tests.
- Tie passing results to delivered code. Later relevant writes from tools, commands, formatters, or hooks require fresh evidence for affected checks.
- Review the diff for intended behavior, interfaces, effects, and missing cases. Passing tests and success labels are evidence, not a completed review or a reason to preserve unintended behavior.

## Living contracts

- Keep non-obvious invariants and consequential tradeoffs near their owner; separate decision documents need a reason local explanation is insufficient.
- When an intended contract changes, revise code, checks, and affected guides/examples together. Revisit constraints against their purpose rather than preserving obsolete behavior.
