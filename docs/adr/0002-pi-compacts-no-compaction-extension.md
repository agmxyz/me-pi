# Pi does the compacting; no compaction extension of our own

On 2026-11-25 we decided not to ship `auto-compact`, an extension that let the model choose when to compact and wrote its own summaries, and to rely on Pi's own compaction instead, moved per model through `compaction.modelOverrides[...].reserveTokens`. The `/autocompact` command (#165) sets that value as a percentage. A live experiment found no difference in correctness between the two and no cost advantage for the extension that passed the stopping rule we fixed before the results.

## Considered options

Four set-ups ran the same synthetic task (`c3`: three facts and two constraints given early in follow-up messages, needed late, in no file) on `openai-codex/gpt-6-luna` and `claude-code/claude-sonnet-5`, both at a 272,000-token window:

- **Pi's default** (compacts at about 95%).
- **Pi at half the window** (`reserveTokens` set to half).
- **The extension with a fixed 50% trigger.**
- **The extension with the model choosing the moment**, and a backstop.

What 23 completed attempts showed:

- **Nothing was lost.** 0 of 115 fact and constraint checks failed, in every set-up on both models, including Pi compacting at 95 to 104% of the window.
- **The model-chosen moment was not cheaper than Pi at half the window.** Tokens per compacting attempt: 8.7 to 12.1M against 10.1 to 12.2M on Luna; 11.5M and 16.3M against 16.2 to 19.2M on Sonnet, from two attempts. The rule asked for a 4-to-0 or 5-to-1 split on both models; neither model reached it.
- **The fixed trigger was the weakest.** It gave the most expensive attempt (29.0M tokens, 85 minutes, 12 compactions), and two of its three Luna attempts reported they could no longer show they had read every audit output.
- **Compacting at half the window trades time for tokens.** Median time rose from 26.0 to 37.5 minutes on Luna and from 30.2 to 47.5 on Sonnet; median tokens fell from 24.6M to 16.3M on Sonnet and did not measurably change on Luna.

One result favours the extension and did not change the decision: in an offline replay of 34 compaction points its summaries kept 97% of facts against 91% for Pi's on Luna, and neither lost any on Sonnet. That gap never became a lost fact in a live attempt, and it cost summaries two to three times longer.

## Consequences

- The threshold is a per-model choice, not a default we set: the data shows a trade-off at 272,000 tokens and no optimum. `/autocompact` exists so the choice is one command.
- Not tested, so not decided: a 1M-token window, where Pi's default waits until about 980,000 tokens; any threshold between 50% and 95%; any quality measure beyond the five items and the hidden tests. A difference under about 1.5 times in tokens would not have shown with two or three attempts per set-up.
- Reopen this if compaction is seen to lose instructions or facts in real sessions, or if a 1M-window comparison shows a quality gap. The extension, its tests, the eval harness with task `c3`, the experiment log and the raw records were kept outside the repository: they describe a local eval set-up and were not published.
