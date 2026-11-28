# Always-On Chief Design (Round 2)

## 1. Extension Inbox & Ship-First Choice
Yes—you're right. `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` (`extensions/watch.ts:279`, `packages/pi-workers/extensions/delegate.ts:897-907`) and `session_start` restore (`watch.ts:307-311`) make an extension inbox a ~150-LOC pattern, cutting B from 1–2 weeks to ~2–3 days and flipping my ship-first choice to **thin private `extensions/chief.ts` + `chief.ts` CLI + skill**. That eliminates terminal dialog-hijack completely (`packages/pi-workers/extensions/guard.ts:565` vs `skills/batch-chief/SKILL.md:91`). What stays hard: cross-process `lock.json` + `herdr` liveness checks (an extension only sees its own session), idempotent wake tracking across `/reload` (marking notified before `sendMessage` and suppressing wakes for unwatched endings, `watch.ts:274-280`), and keeping the extension private in `extensions/` rather than expanding `@agmxyz/pi-workers`.

## 2. Single-Chief Enforcement
In A, single-chief is enforced for CLI mutations but advisory against a stray Pi session editing files directly. However, **I disagree** that a `tool_call` hook (`guard.ts:537-560`) alone enforces "one chief per repo" cleanly: `guard.ts:538` only hooks `bash`, and a repo-wide hook would block legitimate coordinators unless each coordinator carries a lease token matching its worktree. Enforcement belongs in `lock.json` for chief identity, plus checkout leases (or always-worktree) for writers.

## 3. Stopping the Chief from Editing
Skill-only "delegate all work" erodes on small fixes. The cheapest hard stop is ~20 LOC in `extensions/chief.ts`: when this session holds the chief lock, a `tool_call` hook (`guard.ts:537-557`) returns `{ block: true }` on `edit`/`write` inside `<repo>` (allowing `<state-dir>`), leaving `bash` open under `guard`.

## 4. Collapsing `batch-chief`'s Launch
Collapse mechanical plumbing (`skills/batch-chief/SKILL.md:60,62-67`—worktree, pane split, `ME_PI_UNATTENDED=1` start, `agent_session`, event, contract, prompt) into one `chief.ts launch` command to stop partial-launch orphans. **I disagree** with collapsing judgment steps: task-sizing, file-overlap/stale-brief checks (`SKILL.md:58`), and choosing `--worktree` or `--setup` (`SKILL.md:61`) stay with the chief model.
