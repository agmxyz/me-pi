# Implementation handoff — me-pi delegation autonomy

**Reading this handoff does not authorize policy activation, live installation, migration, or remote action.**

Implementation branch: `delegation-autonomy`, starting at `508f092d442261b6e6b796a9744016095365a7cb`; preserve fixed integrated review baseline `17d2d09e5319e23a93f6d034337c6f72b4f2d311`. Current changes are local. The required final exact check, normal commit, independent coordinator review, and final acceptance are pending. Do not report independent review complete.

## User-approved pragmatic verification amendment (current implementation)

- Record Bash failure as `effect: completed`, `replaySafe: false` only for matching completed start/end identity, `isError: true`, canonical structured integer `exit_code` 1–127, and no contradictory interruption or owner facts. Retain the parent `tool-failure/completed` stop and failed-tool history/artifact. This is reported termination under the trusted host/tool/hook assumption already made for successful Bash, not containment, atomicity, proof about descendants/external effects, or replay authority.
- Bash declared-check success requires `isError: false` and canonical structured status 0. Missing/invalid/conflicting or contradictory status, 128+ signal/high statuses, interrupted/unclosed/mismatched/duplicate calls, denials, limits, unknown/partial effects, and integrity/tripwire outcomes stay fail-closed. A fresh green check cannot clear an unrelated unknown effect.
- Finalization may ignore a parent `tool-failure/completed` only when exactly one `pi-runtime` Bash effect matches for the same job/attempt/call ID and `replaySafe: false`; this one-to-one rule applies independently to each such failure, while any competing stop or duplicate/missing fact blocks. This permits same-run repair, not automatic replay, another worker attempt, or A4 recovery. Fresh passing declared checks and normal committed delivery remain required.
- Repo-owned implementation skills use evidence-driven verification by default, without mandatory red-first work or routine user seam approval; explicit user/repository test-first requirements remain binding. Installer preflight checks literal destination paths, not all Pi-discovered frontmatter names. Use the real loader for collision tests. The in-root `.pilot-bak` recipe is superseded; do not inspect or modify the personal pilot.

The focused runtime tests and installer shell checks have been run, but the required `npm run check --prefix extensions` has not yet been run for the final state. Run it alone after the last edit. No `GLOBAL_AGENTS.md` edit, live install/reload, personal-pilot migration, external tracker action, or remote publication is in scope.

## Prior user-approved cross-model amendment (2026-10-30; historical; base revision `delegation-autonomy1e60e1d`)

The user explicitly approved deferring cross-model fallback until supported child-boundary enforcement of the effective endpoint and positive scope/budget tests. This supersedes only the prior fallback acceptance; original requirements and review/evidence checkpoints remain historical and are not erased. Current A2 acceptance is trusted provenance plus safe first-only dispatch, with no endpoint/scope enforcement claim. The reviewed conclusion reported for `bg90`/`bg91` is no unsafe replay under fail-closed behavior; A2's original scoped-fallback acceptance remains unmet. A5's fallback checkpoint is historical, not current runtime support.

The original A2 authorization-driven candidate-restart and A2/A3 cross-candidate budget test seams are historical/deferred, not current source acceptance. Current tests require first-only refusal with provenance and the dispatched attempt's applicable budget facts; they do not claim positive scope enforcement or cross-candidate budget preservation.

A4 remains authored **INACTIVE**. Its future continuation target is one initial attempt plus at most two reconciled continuations on the same selected eligible model and original task-data/provider authority, within all per-attempt budgets and a fixed coordinator-owned aggregate envelope. No pool switches, account/provider evasion, or authority reset. A4 activation requires a complete separate install/policy/reload approval and all existing gates. That earlier task left `GLOBAL_AGENTS.md`, personal skills, config/provider/model/account/budget settings, live installation/reload, migration, remote actions, and coordinator artifacts untouched. Its 2026-10-30 check result is historical evidence for that earlier state only and does not verify the current amendment.

> **Temporary LOCAL planning artifact** intended for `docs/specs/delegation-autonomy-handoff.md`. Reader has not seen the planning session. Initial preparation produced local planning documents only; no runtime implementation, Git/config/install changes or remote publication had been performed then. These documents are not evidence that implementation tests passed.

## Agreed plan and artifact handling

- Local tickets A0–A5 and their index remain the planning artifacts; do not use an external tracker. **No GitHub parent/subissues, remote inspection/fetch, remote issue mutations, PR, push, merge, or publication** is part of this implementation. The existing authoritative spec remains `docs/specs/delegation-autonomy.md`.
- A6 is deferred design-only, not a current blocker. The LOW UI readability item remains only the pointer in `docs/research/karto-delegation-pilot.md`; do not turn it into work here.
- The existing spec, new ticket directory, and this handoff are temporary LOCAL planning artifacts intended for user-approved later cleanup. Preserve them during implementation; do not auto-delete or clean them now. `GLOSSARY.md` and `docs/research/*` are references, not cleanup targets/orphans.
- The spec and local ticket index agree on local-only execution. Update local status/evidence as work proceeds; do not create an external tracker merely because an original skill normally expects one.

## Frozen decision sources and review contract

The spec's historical decision/evidence sources include `GLOSSARY.md`, root `AGENTS.md`, `docs/coding-standards.md`, `GLOBAL_AGENTS.md`, `docs/delegate.md`, and the Karto research notes. The previously reported personal-pilot path is a safety boundary only: do not inspect or modify that resource. This handoff is not evidence that every code owner was reviewed.

For independent coordinator review, freeze the actual integrated source state: pin a commit SHA (never `HEAD` as the baseline), record the exact spec/ticket versions, and retain accessible copies of the originating spec/tickets, relevant instructions, captured diff/commit list, and affected source/test inputs. Full final review must run on a stable frozen integrated result with independent Standards and Spec axes. Resolve required findings, rerun affected checks, then do affected-delta closure naming changed coverage and explicitly carrying forward prior coverage. Reopen broad review only for semantic/cross-owner changes, uncertainty, regression, or user request. Do not require review after every job or add panels.

## Historical checkout facts — superseded

Earlier planning notes referred to branch `uncap-readonly-delegate`, HEAD `13b32fd`, fetched `origin/main`, a reportedly clean tracked tree, and pre-checkpoint untracked planning files. None of those facts or setup steps applies to the current implementation. Current approved branch/start SHA and review baseline are stated at the top; no branch switch, fetch, or planning checkpoint is part of this work.

## Current work order and policy boundaries

- Local IDs only. Preserve the 2026-10-29 historical order and decision records. Under the 2026-10-30 amendment, A2 current acceptance is trusted provenance plus safe first-only dispatch; cross-model fallback is deferred, and A4 authoring depends on A0-source + A1 + amended A2 acceptance + A3. A5 remains selection-only with no A2 dependency; its fallback checkpoint is historical only. A4 remains INACTIVE and its future continuations are SAME-MODEL. Serialize checkout writes. No activation follows from this plan.
- A4 is future coordinator policy, not runtime aggregate enforcement: max one initial attempt plus two continuations per fixed slice; 135 allocated hard minutes plus possible finalization overhead, existing per-attempt caps; reconcile effects before continuation; no routine human approval per ordinary stop. No relabel/split/job/base reset. A denied effect stays denied; only optional, predeclared work with trusted non-execution may be omitted.
- Until the entire A4 capability/policy/skill availability+reload gate is approved and active, current stop-on-any-guard/worker-limit policy remains binding. Do **not** use planned standing recovery while bootstrapping. A stale runtime cannot acquire authority from newer policy prose. The 45-minute implement limit and the separately user-approved 60-call scout cap take effect only after the updated runtime is loaded. The scout hard timeout remains 300 seconds; `wrapUpShare = 0.8`, nominal $5 cost cap, other role limits, and four concurrent slots are unchanged. Neither limit change activates A4. No hidden retry, guard bypass, new provider/account/billing authority, secret access, or policy-by-configuration.
- Repo-owned skill sources were updated in this implementation; this does not imply installation or activation. Preserve original/personal skill resources untouched. Installer preflight checks literal destination paths, not every duplicate Pi frontmatter name; verify uniqueness through the real loader. The earlier in-root `.pilot-bak` rename recipe is superseded. No live install/reload or configuration change is in scope.
- Do not edit `GLOBAL_AGENTS.md`, inspect or modify the personal pilot, access live settings, install/reload, or migrate anything. A4 remains inactive and requires its separate complete approval/lifecycle gate. Do not follow the superseded in-root backup recipe.
- `./install.sh` effects beyond skill pointers: requires `pi`; refuses if `~/.pi/agent/AGENTS.md` is not a link to this checkout's `GLOBAL_AGENTS.md`, else links it; `pi install <repo>` and `pi remove` of a legacy `<repo>/extensions` registration if listed; `pi install npm:pi-web-access`; one-time copy of Pi's `interactive-shell.ts`/`handoff.ts` examples (never overwritten); `rtk init --global --agent pi` if `rtk` exists. Under `set -e` a failing step leaves earlier steps applied (partial outcome); RTK failure only warns.
- Do not inspect or change live configuration, model/provider/account settings, or availability as part of this implementation.

## Implementation completion

Run exactly **`npm run check --prefix extensions`** alone after the final edit. It has not yet been run for this final state. Preserve test strength and use owner interfaces. Keep coordinator artifacts read-only, preserve the one-writer boundary, and capture review inputs before review. Stop/report genuine guard/worker limits; never route around them.

The check and independent review recorded for `f0a40af` are historical evidence for that earlier source state only. Current changes start at `508f092d442261b6e6b796a9744016095365a7cb` and preserve review baseline `17d2d09e5319e23a93f6d034337c6f72b4f2d311`. After the exact check, make a normal local commit only if it passes. Independent coordinator review, any required findings work, and final acceptance remain pending. A4 is inactive; no live policy edit/install/reload, pilot migration, push, PR, or remote publication is in scope.

## Coordinator next steps

1. After all source and documentation edits are complete, run `npm run check --prefix extensions` alone. If it passes, make a normal local commit with a clear subject and explanatory body; do not claim a check or commit until observed.
2. Perform independent review against baseline `17d2d09e5319e23a93f6d034337c6f72b4f2d311`, resolve findings, and record required affected-delta closure. This implementation is not the independent review or final acceptance.
3. Keep A4 inactive and leave live policy, installation/reload, the personal pilot, remote resources, and planning-artifact cleanup untouched.