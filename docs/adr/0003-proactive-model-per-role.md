# Proactive model-per-role assignment

Subagent roles get the model that best fits the job's nature (correctness, independence, speed), chosen deliberately per role — cost is tracked but is never the deciding factor. Concretely: worker/delegate on the strong main model (gpt-5.6-luna); scout/researcher on a fast cheap tier; reviewer and devil's advocate on a *different model family* (opus-5.5 via openrouter) so independent eyes don't share the implementer's blind spots.

Considered: cost-driven model choice (trial downgrades when spend stings) — rejected; it optimizes the wrong axis and erodes review quality. Assignments live in live `settings.json` `subagents.agentOverrides` and may change deliberately when a role underperforms.
