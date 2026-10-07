# Coding standards

## Scope
- Keep changes within the request; avoid speculative work, remove newly unused code, and leave unrelated code untouched.
- State material assumptions; ask when ambiguity could change behavior.
- Match local conventions for names, libraries, and style. Add dependencies only when clearly cheaper than direct implementation.

## Concurrent changes
- Keep one writer per checkout. Isolate concurrent writers in separate checkouts or worktrees, then inspect changes before integration.

## Failure handling
- Handle plausible input, I/O, network, and external-tool failures clearly. Propagate failures; do not swallow errors or hide them with fallbacks.

## Verification
- Define observable success and verify changed behavior.
- Keep tests faithful; do not weaken or skip them.

## Readability
- Use descriptive names, including for non-obvious constants; clarify complex conditions.
- Comment on why, intent, or tricky behavior—not to restate code.
