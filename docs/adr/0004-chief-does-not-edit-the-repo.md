# The chief writes nothing in the repo, with no exception for small fixes or its own notes

On 2026-11-27 we decided that a session holding the chief lease is blocked from `edit` and `write` everywhere in the repo, and that a one-line fix, a glossary term or an ADR is a task for a coordinator like any other change. The chief keeps its working memory in its state directory outside the repo, and runs no builds, tests, installs or merges. The chief exists to keep one conversation and one picture of the repo; an allowance for trivial fixes is where delegation erodes, and a chief that edits becomes a second writer beside its coordinators.

## Considered options

- **Skill text only.** Rejected: the delegate guidelines tell every session to make small changes itself, so the rule would lose to them.
- **Allow trivial fixes.** Rejected: "trivial" is judged by the session that wants to make the change.
- **Allow the chief to write its own records in the repo** (first answer the same day). Rejected an hour later: a coordinator may write in the main checkout only when its tree is clean, so every note the chief took would block the next small fix.

## Consequences

- Every small change costs a coordinator run. One coordinator at a time may write in the main checkout when its tree is clean, so a small fix does not need a worktree.
- The chief's memory is not versioned or shared unless a task copies it into the repo.
- `bash` stays open under guard and can still write files; the block stops the habit, not a determined session.
