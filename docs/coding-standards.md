# Coding standards

- Each invariant and state transition has one owning module. Change the rule there; callers request outcomes rather than adding their own special case or copy of it.
- Report partial, unknown, or unavailable outcomes distinctly from success at the interface.
- Keep a compatibility path only for a named consumer, with its removal condition. Delete the exports, tests, and doc references a change makes obsolete.
- Tests for a lifecycle change cover the affected cancellation, timeout, partial-work, cleanup, and recovery paths.
- Tests run inside `mkdtemp` fixtures with `HOME`, `TMPDIR`, and `PI_CODING_AGENT_DIR` pointed there; the real `~/.pi`, `~/.agents`, and this checkout's git state stay untouched.
- A guard change adds each bypass found while making it as a row of the must-ask table in `test/guard.test.ts`.
- A contract change updates its tests and affected `docs/`, `skills/`, and `README.md` text in the same change.
