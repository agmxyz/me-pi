---
description: Implement the given ticket/issue, then independent review loop until clean
argument-hint: "<ticket text, issue number, or ticket file path>"
---
Work the ticket below through the standard loop. You are the coordinator; agents do the work.

Ticket: $@

## Loop

1. **Prepare the brief.** Determine the diff surface: if the ticket references an issue/file, read it. Establish the working tree is clean (`git status --short`); if not, stop and tell me.
2. **Implement.** Dispatch the `implementer` agent with: the ticket, its acceptance criteria (derive them if unstated and state them), and the boundary contract (criteria, constraints, current commit SHA, tests to run).
3. **Review.** Run `git diff` yourself and dispatch the `reviewer` agent with: the diff, the acceptance criteria, and the boundary contract.
4. **Route findings:**
   - `No issues.` → commit with a conventional message on the current branch. Report the SHA. Done.
   - Findings → dispatch `implementer` again with the findings verbatim as the fix scope. Go to step 3.
   - Max 3 review rounds; if still unclean, stop and report the remaining findings to me.
5. **Never push.** Report: files changed, final test command + exit code, commit SHA.
