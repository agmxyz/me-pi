# Delegate vs inline: one historical sample

**Recorded:** run ID `implementer-0929-225729-7018`; the retained artifact does not preserve a reliable calendar date or year.

This is one unpaired comparison: one inline doc task and delegation measurements from unrelated runs. The task's sources were already loaded for the inline run. Treat costs, timings, and model names below as a historical snapshot—not current prices, a paired experiment, or a universal benchmark.

## Result in this sample

For the small, self-contained doc task with its source already in context, inline took ~15s and ~$0.03 with no handoff. Delegation was slower and more expensive in the estimated same-task comparison. Delegation can still be useful when the child absorbs substantial transcript, independent review is valuable, parallel work matters, or a fresh context helps.

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

Fixed overhead observed or estimated for this workflow:

- Coordinator writes the task file (Goal/Acceptance/Constraints/Paths/Output contract): the observed tasks were 1.4–3.4 KB ≈ 350–850 output tokens, ~15–30s generation, plus role/model choice.
- Child cold-starts: role preamble (~1.5 KB) + skill reads (implement, tdd) + re-reading required files. This session used 13 turns and ~350k cache-read tokens plus ~37k cache-write before finishing.
- Coordinator reviews the return and, for writers, the diff (`harvest` + `git diff`)—work it must still verify.
- Wait latency was minutes vs seconds in the sample; `-b` hides it only when there is other useful work.

For the same doc task delegated: estimated 45s task writing + 2–4 min child + ~$0.10–0.25 (sonnet) + reading the result ≈ 10× wall, 4–10× cost. This is an estimate, not a paired run.

## What this sample suggests

- Delegation may help when the expected child transcript is much larger than the task handoff and review. This implementation's ~350k cache-read tokens show one case where the coordinator avoided carrying substantial exploratory context; they do not establish a break-even threshold.
- Independent review/adversarial passes buy fresh context and another perspective; their value is not necessarily saved effort.
- `-b` with `-w` can enable parallel work when elapsed time matters; this sample does not measure a paired parallel speedup.
- For work estimated at one or two turns with context already loaded, inline avoids handoff and review overhead. Treat that as a heuristic from this case, not a general cutoff.

## Limits

n = 1 inline task; delegate numbers come from unrelated tasks, not a paired run. Token figures are provider-reported usage; approximate wall time excludes thinking not captured by jsonl timestamps. The run history and model pricing may change; use fresh measurements before making current cost or latency decisions. A paired sonnet run was not performed (estimated cost ≈ $0.15, which was not expected to change the historical conclusion).
