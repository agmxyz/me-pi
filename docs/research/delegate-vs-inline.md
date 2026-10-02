# Delegate vs inline: measured

## Verdict

For a small, self-contained doc task with the source already in context: **inline wins** (~15s, ~$0.03, no handoff). Delegation pays only when the work is large or exploratory enough that its transcript would bloat the coordinator, or is parallelisable. Below ~1 turn of work, handoff overhead dominates.

## Task

Write `specs/delegate.md` (spec for `bin/delegate`: commands, run files, worktree lifecycle, GC). Chosen: self-contained, `specs/plan.md` does not exist. Measured inside the implementer session that built harvest/prune (`implementer-0929-225729-7018`, sonnet), so `bin/delegate`, the test files and the design were already loaded. Numbers are from that session's jsonl (`usage` per assistant message).

## (a) Inline

| | |
|---|---|
| Wall time | ~13s generation for the writing turn (+ ~2s tool) |
| Turns | 1 (the `write` call; content composed from context already held) |
| Output tokens | ~1.8k (2.7 KB file) |
| Context read | ~39k tokens (cache read; the session's existing context, not extra reading) |
| Cost | $0.026 (that one turn) |
| Extra reads/greps | 0; a few glance-checks of `specs/me-setup.md` for house style were done earlier |

Caveat: near-zero marginal cost because the context was already paid for. A cold coordinator would add reading `bin/delegate` (~19 KB ≈ 5k tokens) → ~1–2 more turns, still < $0.10, < 1 min.

## (b) Delegate path, from run history (`~/.pi/agent/runs/*/out.md` trailers)

| Run type | n | Cost | Wall |
|---|---|---|---|
| reviewer (default/cheap) | 4 | $0.006–0.013 | 71–340s |
| devils-advocate (sonnet) | 3 | $0.08–0.18 | 46–86s |
| devils-advocate (glm flash) | 1 | $0.01 | 279s |
| implementer (default) | 2 | $0.035–0.057 | 240–625s |
| implementer (sonnet) | 2 | $0.25–0.32 | 530–~900s |

Fixed overhead per delegation, independent of task:
- Coordinator writes the task file (Goal/Acceptance/Constraints/Paths/Output contract): existing tasks are 1.4–3.4 KB ≈ 350–850 output tokens, ~15–30s generation, plus the choice of role/model.
- Child cold-starts: role preamble (~1.5 KB) + skill reads (implement, tdd) + re-reading every file it needs. This session: 13 turns, ~350k cache-read tokens, ~37k cache-write, before finishing.
- Coordinator reviews the return and, for writers, the diff (`harvest` + `git diff`) — it re-reads the changes it would have authored anyway.
- Wait latency: minutes vs seconds (`-b` hides this only if there is other useful work).

For the same doc task delegated: est. 45s task writing + 2–4 min child + ~$0.10–0.25 (sonnet) + reading the result ≈ 10× wall, 4–10× cost, and the coordinator still has to verify content it didn't produce.

## When delegation pays

- Work whose transcript would consume ≥ ~20–30k tokens of the coordinator's context (multi-file implement + test loops, large log/code trawls): the child absorbs the noise (this feature: ~350k cached-read tokens, kept out of the coordinator) and returns ~100 tokens.
- Independent review/adversarial passes: value is a fresh context and a different model, not saved effort. Cheap (< $0.02 on the default model).
- Parallel work (`-b` + `-w`) where wall time matters.
- Work that should not see coordinator bias.

## When not

- Anything the coordinator can finish in ≤ 1–2 turns with context it already holds (docs from loaded code, small edits, single-file tweaks).
- Tasks whose spec is as long as the result: task file ≈ output.
- Work needing repeated user dialog or design decisions.
- Cold-context work where the child must reread what the coordinator has already read.

Rule of thumb: delegate if (expected child transcript) ≫ (task file + review of result); otherwise inline.

## Limits

n = 1 inline task; delegate numbers are from unrelated tasks, not a paired run. Token figures are provider-reported usage; "approximate" wall time excludes my own thinking overhead not captured in the jsonl timestamps. Did not run the doc task both ways (cost of a paired sonnet run ≈ $0.15 would not change the conclusion).
