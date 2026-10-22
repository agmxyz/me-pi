# Workflow fixture spec

This is a deliberately small, local-only implementation goal for comparing delegate guidance. The full specification stays visible to the main session and the goal reviewer.

Implement `sum(values)` and `mean(values)` in `src/math.mjs` for arrays of numbers.

- `sum` adds every value and returns `0` for an empty array.
- `mean` returns the arithmetic mean for non-empty input and `null` for an empty array.

The fixture intentionally lacks an assertion for `mean([])` until the goal-review fix. A passing check is not proof that every spec edge case is implemented; the reviewer must compare code against this full specification.

No network, remote repository, tracker, issue closure, or push is part of this exercise.
