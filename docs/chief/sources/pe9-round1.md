# Always-On Chief Design (Round 1)

## 1. Three Hardest Failure Modes & Mechanisms

1. **Single-chief split-brain across crashes, `/resume`, and pane moves.**
   `batch-chief` only blocks overlapping runs via `<repo>.worktrees/.batch/current` (`skills/batch-chief/batch.ts:648-677`) and freezes `chiefPane` at `preflight` (`batch.ts:708`). PID-only locks fail on PID reuse; stale `chiefPane` strands watchers (`batch.ts:1448`) and coordinators (`skills/batch-chief/CONTRACT.md:78`).
   - **Mechanism:** Atomic `O_CREAT|O_EXCL` lease at `<git-common-dir>/me-pi-chief/lock.json` (shared across worktrees via `--git-common-dir`, `batch.ts:450`) storing `{pane, pid, session, generation}`. Claiming verifies liveness via `herdr pane process-info` (`batch.ts:1335-1343`) and `herdr pane get` `agent_session.value` (`skills/batch-chief/SKILL.md:63`). Dead pane/non-Pi foreground allows atomic reclaim (`generation++`); live leases refuse with the active pane ID unless `--takeover` is confirmed. Every mutating CLI call checks `currentPane === lock.pane`.

2. **Coordinator → chief reporting (dialog hijack, moved pane, spoofed wakes).**
   Coordinators call `herdr agent prompt <chief pane>` directly (`CONTRACT.md:78`), bypassing `promptBlocker` (`batch.ts:1352-1361`). A wake hitting an open `guard` dialog presses Enter and approves it (`SKILL.md:91`, `packages/pi-workers/docs/delegate.md:85`), and a moved chief pane drops wakes.
   - **Mechanism:** Coordinators write `<state>/tasks/<id>/report.md` and run `chief.ts notify <id> <DONE|BLOCKED|FAILED>`. The proxy reads the live chief pane from `lock.json`, runs `promptBlocker` (`dialogVisible`, `batch.ts:1347-1349`), and injects a content-free wake `[chief <repo>] status` (watcher retries if blocked). `chief.ts status` trusts only report files, `ME_PI_STATUS_LOG` (`delegate.md:83`), and git/gh state.

3. **Approvals crossing sessions & single-writer checkout races.**
   Unattended coordinators (`ME_PI_UNATTENDED=1`, `delegate.md:85`) must not treat chief prose as authority (`CONTRACT.md:60`, `GLOBAL_AGENTS.md:23`), and nothing enforces one writer per checkout (`delegate.md:33`).
   - **Mechanism:** Record verbatim user approvals (`--quote`, `--question`, `--action`, `--task`) in `events.jsonl` and compile them into immutable `contract.md` (`batch.ts:1598-1727`), refusing `--inferred` scopes. `chief.ts launch` enforces checkout leases: main is leased only when clean, on base, and idle; any concurrent writer or dirty main forces `--worktree`.

*(Context growth is secondary: `docs/adr/0002-pi-compacts-no-compaction-extension.md:3,16` showed Pi compaction lost 0/115 facts, and `events.jsonl` lets the chief compact or `/new` and reload via `status`.)*

## 2. Two Distinct Architectures

### A: Skill + Stateful CLI (`skills/chief/SKILL.md` + `chief.ts`)
- **Split:** Skill = task-sizing, worktree judgement, diff review, escalation. Script (`chief.ts`) = lock, `events.jsonl`, checkout leases, launch, `notify` proxy, watchers, contracts, cleanup. Extensions = existing `guard`/`delegate` only.
- **Disk state:** `<git-common-dir>/me-pi-chief/{lock.json,events.jsonl,ledger.md,tasks/<id>/{contract.md,report.md,status.log,scratch/},timers/}`.
- **Lock:** `lock.json` lease verified via `herdr` + PID per command.
- **Reuses from `batch-chief`:** `mainCheckout`, `TRANSITIONS` + `events.jsonl`, `piInPane`/`dialogVisible`/`promptBlocker`, detached `watch`, `CONTRACT.md` compiler, `confirmedApprovals`, `cleanRow`/`removeBelow` (`batch.ts:226-291,449-522,1334-1511,1547-1895`).
- **Cost:** ~1–2 days (~600–900 LOC extracting shared primitives from `batch.ts` + tests).

### B: Thin Chief Extension + Skill + CLI
- **Split:** New Pi extension owns lock lifecycle (start/`/resume`/`/new`/exit), blocks direct writes in chief mode, and delivers completions via local inbox/socket instead of `herdr agent prompt` (no dialog hijack). CLI = event log, worktrees, contracts, cleanup. Skill = delegation policy.
- **Disk state:** Same `<git-common-dir>/me-pi-chief/` plus `inbox.jsonl`/socket.
- **Lock:** OS `flock` / extension lease bound to Pi's process; auto-updates `pane`/`session` on `/resume`.
- **Reuses from `batch-chief`:** Event log, contract compiler, approvals, cleanup; drops `dialogVisible` scraping for chief wakes.
- **Cost:** ~1–2 weeks (extension runtime + inbox delivery, `@agmxyz/pi-workers` tests/release, CLI, skill).

## 3. Ship First

**Architecture A.** It matches `ADR 0001` (`docs/adr/0001-coordinators-write-no-implement-worker.md:8`) and `ADR 0002` (no extension lifecycle code without evidence), reuses ~80% of `batch.ts`, keeps `@agmxyz/pi-workers` untouched, and builds the exact state layer B can wrap later if wakes or chief self-edits fail in practice.

## 4. Uncertainties

- **Main vs always-worktree:** Whether leasing main to one coordinator is worth dirty-tree friction vs always using worktrees for writers and `delegate` scouts for reads.
- **Pi wake API:** Whether Pi extensions can inject unsolicited turns safely during an open `guard` dialog.
- **`herdr` session identity:** Whether `agent_session.value` updates atomically across `/new` and `/resume`.
- **Approval scope:** Per-task `push` approvals vs standing repo-level feature-branch push approval.
