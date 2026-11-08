# Ticket readiness rubric

Worker contract for `ticket-readiness`. You answer, for each ticket you own: can an agent implement it, prove it is done, and have it merged unattended, at the review SHA in your brief? Read the code; run nothing. A `ready-for-agent` label is evidence from intake, not now: re-check every ticket.

The brief gives you the repo, the review SHA, the **done** rules (the exact check command, the standards files, the live environment that proves what fakes cannot), the ticket snapshot with comments, and the index of all open tickets. A comment that changes the body is the later decision; a comment that contradicts the body without resolving it is a context gap.

## Checks per ticket

Cite `file:line` at the review SHA for every claim.

1. **Still valid.** Is the problem present? Already done, or partly? Every precondition met ("once X exists": does X exist in the code)?
2. **Context is enough.** Is a decision missing that would change the implementation? Does every interface, type, command, file, and ADR the ticket names exist? Name each gap. A ticket's stale `file:line` is drift: report the current location; it is never a gap or a failure by itself.
3. **Acceptance map.** For each criterion, as written or implied, give the check an agent would use to prove it. The bar for a criterion: it names an observable pass/fail outcome a reviewer could check, not "works correctly" (the same bar as `triage`'s agent brief, "Complete acceptance criteria", when that skill is installed). Mark how it is met:
   - **V**: verifiable by the agent in this repo with fakes (a test, a red-then-green test, a command).
   - **L**: live only; needs the live environment, docker, sudo, the network, or a provider beyond what the done check itself needs (that environment is a prerequisite from the brief, not L). Name the repo's live-check skill and the step that proves it, the command, and what it observes. If that check runs on a stand-in (a container or VM in place of the real host), list what the stand-in does not prove; a criterion only the real target can prove makes the ticket `LIVE_CHECK` cannot-ship. With no live-check skill, say so.
   - **H**: human judgement; wording, taste, a product or security decision.
   - **X**: vague; no observable pass/fail.

   One mark per criterion: split a criterion that mixes them (docs wording H beside a tested behaviour V) into one line each.

   Flag **weak** evidence: the done check green as the only proof; a self-reported measurement; a grep or regex that code could pass without meeting the criterion; an audit that produces prose rather than a test; a test that passes trivially in some environments; a test that drives an internal setter or test-only endpoint instead of the user's path; a visible result checked without its side effect; a dry run trusted by its name rather than by observing what it skips; a criterion with several entry points proven through only one.
4. **Size.** Estimate changed lines and files. Over about 1,500 lines, several PRs, or several long verification loops is TOO_BIG; propose a split.
5. **Dependencies and overlaps.** From the index: which tickets must land first (hard) or should (soft); which overlap in files or scope.
6. **Unattended-merge risk.** low, medium, or high, with the reason: security boundaries, persisted data or migrations, privileges, secrets, destructive paths, published CLI/API behaviour.

## Verdict

Exactly one, the first that applies:

- `STALE`: already done, invalid, or a precondition unmet. Give the evidence.
- `DECISION`: a missing decision blocks it, including scope only an owner can fix (a comment that changes the plan without settling how far). State the question.
- `TOO_BIG`: over the size bar. Give the split.
- `AMBIGUOUS`: a criterion is X, or the scope is unclear in a way no single owner answer settles. Say which.
- `LIVE_CHECK`: at least one criterion is L. Say which of two kinds: **code can ship**, with the live check queued for the user, or **cannot ship** without the live environment.
- `READY`: valid, context enough, every criterion V with sound evidence or H on wording or placement only, within size, risk low or medium. Each such H criterion gets a `Calls:` entry, and the ticket's merge risk is at least medium. An H product or security decision is `DECISION`.

Add a **confidence** (high, medium, low) and a **Not checked** line naming what you did not read or could not confirm (git history, tests, host behaviour).

## Output

Write to a file in your output directory, exactly this shape per ticket, then one table row per ticket:

```
### #<n> <title>
Verdict: <VERDICT> (confidence: <high|medium|low>)
Valid: <yes|no|partly>: <evidence file:line>
Context gaps: <none | list>
Acceptance map:
- AC1 "<criterion>" → <check> [V|L|H|X] <weak: reason, if any>
- ...
Size: ~<lines> lines, <files> files
Depends on: <tickets or none>; overlaps: <tickets or none>
Unattended-merge risk: <low|medium|high>: <reason>
Drift: <none | ticket's ref → current location, ...>
Ships: <code can ship, live check: ... | cannot ship | n/a>   (LIVE_CHECK only)
Split: <...>   (TOO_BIG only)
Ticket fix: <none | an edit the ticket text needs (a wrong name, a missing file, a broken check), or "close: superseded by #<m>" / "close: done at <file:line>">
Calls: <none | AC<k>: <the call> → <proposed default> [default|ask]>
Stop if: <none | a condition, specific to this ticket, under which the implementer stops and hands back instead of deciding>
Not checked: <...>
```

`Ticket fix:` is a correction the implementer applies to its reading of the ticket; the tracker changes only when the user asks. A `Calls:` entry marked `default` binds the implementer, and the reviewer checks it; `ask` is a call only the owner can make, and the ticket waits for the answer. `Stop if:` names what the ticket's own risks make unsafe to decide alone (a security boundary, a scope larger than `Size:`, a check that cannot go red), not general caution.

```
| #<n> | <VERDICT> | <confidence> | <one-phrase reason> |
```

The handback names the file path and any `BLOCKED: <step>: <reason>`.

The evidence rules in check 3 (user path over internal setters, side effects, dry runs, entry points, stand-ins) adapt ideas from pstack's `create-verification-skill` (MIT, Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack/skills/create-verification-skill
