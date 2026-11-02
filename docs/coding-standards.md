# Coding standards

For agents and humans changing or reviewing `me-pi` code. Apply to the behavior you touch; propose broader restructuring separately.

## Ownership

- Read the behavior's owner, callers, and tests before changing it. Each invariant and state transition has one owner; callers request outcomes instead of repeating its rules.
- Make effects, ordering, and failure modes visible at the interface. Distinguish partial or unavailable outcomes from success.
- If the change would add another special case or copy of a rule, fix the owner first, within the request's scope.

## Abstraction and removal

- Add a module, option, or seam only for caller knowledge it removes or a variation a named caller or test needs.
- Delete code, exports, tests, and doc references the change makes obsolete. Keep a compatibility path only for an identified consumer, with a removal condition.

## Verification

- Test changed behavior through the owning module's exports, as `test/*.test.mjs` does by importing `extensions/*.ts`. Add caller/event wiring checks when the risk crosses that seam.
- For lifecycle changes, cover the affected cancellation, timeout, partial-work, cleanup, and recovery paths.
- Keep tests inside `mkdtemp` fixtures with `HOME`/`TMPDIR`/`PI_CODING_AGENT_DIR` pointed there; never touch the real `~/.pi`, `~/.agents`, or this checkout's git state.
- Rerun affected checks after any later write, including `npm run fix`, formatters, and hooks.
- Review the diff for intended behavior, interfaces, effects, and missing cases. Green checks are evidence, not a review.

## Contracts and docs

- Put non-obvious invariants and tradeoffs in a comment at their owner.
- When a contract changes, update code, tests, and affected `docs/`, `skills/`, and `README.md` text in the same change. If a constraint forces workarounds, revisit it against its purpose rather than preserving obsolete behavior.
