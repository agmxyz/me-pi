# Rig plan v1 — co-driver orchestration

Reviewed by gpt-6-sol (high thinking); deltas incorporated. Status: accepted.

## North star

**Tickets completed correctly with little coordinator effort.** Context longevity is a leading indicator, not the goal: a lean parent context that loses requirements in handoffs is failure, not success.

Measure per ticket: coordinator effort (prompts, interventions), rework (defects caught late), parent-context usage, info lost at handoffs.

## Layers

| Layer | Choice | Status |
|---|---|---|
| Discipline | Pocock skills v1.2.3, shared `~/.agents/skills` | live |
| Machinery | `pi-subagents` (pinned version), stock example = one-ticket fallback | step 1 |
| Guardrails | vendored `damage-control-continue` + rig rules YAML | step 2 |
| Personas | 3 thin agents wrapping Pocock skills | step 5, post-warmup |

## Boundary contract (what crosses agent boundaries)

Every agent handoff carries: ticket acceptance criteria, constraints, repo state (commit SHA), tests run + exit codes, unresolved decisions, next action. Reviewer inspects the **diff + criteria independently** — never just the implementer's summary. Output contracts (cavecrew-derived) enforce brevity; details live in tool-result details, not the coordinator's context.

## Autonomy policy

Agents may: edit repo files, run tests, **commit on: clean known starting diff + green tests + diff matches intent** (green alone is insufficient). May not: push, install deps, force/hard flags, touch outside cwd + `~/.pi`. Enforcement: damage-control-continue YAML denylist — **mistake prevention, not a security boundary** (shell variants/scripts/child processes can bypass; use OS isolation when that matters).

## Role → model (proactive, ADR-0003)

| Role | Model | Why |
|---|---|---|
| worker/delegate | gpt-5.6-luna (codex) | correctness on edits |
| scout/researcher | gpt-5.4-mini (openai) | fast recon, no cheap codex tier |
| reviewer | opus-5.5 (openrouter) | different family = independent eyes |
| devils-advocate | opus-5.5 (openrouter) | adversarial diversity |

## Rollout

- **0. Baseline ticket**: one real ticket, fully manual (no agents). Record: effort, rework, context use. The yardstick.
- 1. ✅ **done** — skim clean (no telemetry, recursion-guarded at entry, spawns local pi only) → installed `npm:pi-subagents@0.71.0` (pinned) → role→model overrides in live settings → smoke test: scout resolved to gpt-5.4-mini, contract-compliant output.
- 2. Vendored damage-control-continue + rules YAML (denylist above).
- 3. Role→model config in live settings; document intended values here.
- 4. **2-week stock warmup** on real tickets; log model-fit (defects caught, rework, wrong-model signs, handoff loss) into `specs/trial-log.md`. Compaction (built-in) before any ledger thoughts.
- 5. Author personas: implementer (implement+tdd), reviewer (code-review+Fowler), devils-advocate (grilling) — thin bodies, skill-bind first line, output contracts.
- 6. Prompts: `/implement-and-review`, `/scout-and-plan` in `rig/prompts/`.
- 7. Review session vs baseline: decide council (Pragmatist[luna]+Risk[opus] parallel → DA → user synthesizes; rare, ceremony-threshold only) and whether ledger/`/recall` is earned. Fresh-machine install check + settings-drift verification added to install.sh around here.

## Non-goals (v1)

Council from day one, ledger/coms-net, cross-harness agent spawning, publishing packages, CI integration.
