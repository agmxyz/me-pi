---
name: batch-chief
description: Supervise one coordinator Pi session per READY ticket, from brief to a PR the user merges or leaves open.
disable-model-invocation: true
---

# Batch chief

You are the chief: one Pi session supervising one coordinator Pi session per ticket, each in its own git worktree and herdr pane. v1 is attended: the user is at the chief pane, and nothing wakes you on a timer.

The helper keeps the run's state: `node <skill-dir>/batch.ts <command>`. Its commands today:

- `preflight --repo <path> --tickets <n,...> --check "<cmd>" --chief-pane <id>`: creates the run.
- `event <n> <event> [options]`: records a row's transition.
- `approve --quote "<user's words>" --action <action> --tickets <n,...> [--inferred]`: records an approval.
- `note --kind <kind> --ticket <n> "<what>"`: records a note.
- `status`: rebuilds the state, reconciles it with GitHub and report files, lists the commands each row allows, and writes `ledger.md`.
- `gate <n> --judged "<your note on the diff>"`: fetches the PR's facts and records `GATED(sha)` when all pass.
- `merge <n>`: merges a gated, approved PR pinned to its head, or updates a behind branch for a new gate.
- `prompt <n> "<text>"`: types into a coordinator's pane after checking for a live Pi and no open dialog.
- `cleanup [--dry-run]`: quits each terminal row's coordinator, removes its worktree, branch and pane, and prints the notes and the resources left.
