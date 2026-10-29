# me-pi action plan after the Karto pilot

## Decision

Keep bounded delegation and one writer. Improve verification scheduling, review closure and artifact ownership first. Separately approve a narrowly bounded recovery-policy change and an optional reviewer pool. Use existing read-only parallelism before designing concurrent writers.

This is a proposal, not authorization or an implemented policy change. The low-priority rendering backlog remains in `karto-delegation-pilot.md`.

## Evidence and confidence

Sol 6.1/xhigh and DeepSeek V4.1 Flash 1017/max independently analyzed the gathered evidence, then rebutted each other. The coordinator received both requested-model handbacks, inspected both final reports, and resolved their material disagreements below. No model-quality comparison follows from this run.

Primary sources:
- Karto session JSONL under `~/.pi/agent/sessions/--Users-mmo-fun-agm-karto--/`, filename `2026-10-26T17-48-18-517Z_01a17953-d0d4-764c-8007-32f61f052838.jsonl` (physical line citations below).
- `/tmp/me-pi-karto-timing-evidence.md`, expanded JSON and reproducible parser `/tmp/me-pi-karto-timing.py`; coordinator executed the parser and checked its aggregate output.
- `/tmp/me-pi-karto-pilot-delivery-notes.md`, final delivery and rounds 1–5 review reports; provenance and accepted final checkpoint in `karto-delegation-pilot.md`.
- Installed `~/.agents/skills/implement-spec-me-pi/SKILL.md`, original `implement-spec` and Matt `code-review`; current `docs/delegate.md` and implement lifecycle code.

The timing census includes physical history and failed requests, not just the accepted model-context projection. Parser continuation matching is heuristic; it silently skips malformed JSON and does not establish exclusive time buckets. Model workers did not execute the parser or rerun Karto checks. Raw transcripts/diagnostics remain private. Temporary evidence paths may disappear.

## Where time went

| Surface | Recorded amount | Interpretation |
|---|---:|---|
| Entire session span | 63.19 hours | Includes inactivity, approvals, outages, tool execution and work; not active effort. |
| Implement workers | 11.55 hours / 50 attempts | Includes construction, tests, recoveries, fixes and failures; not pure coding or 50 tickets. Detail-header rounding agrees with recorded durations. |
| All review calls | 55.1 minutes / 38 calls | 28 focused calls plus 10 full-axis readers. Mixed worker/call measurements; preparation, adjudication and repair excluded. |
| Five full two-axis rounds | 27.2 reader-minutes; about 15.3 minutes parallel-round latency | Sum of readers differs from elapsed time; latency uses the longer axis per round. |
| Coordinator response metadata | 7.17 hours | Request-stream wall durations, not pure reasoning or an exclusive bucket. |
| Four failed responses inside that metadata | 4.02 hours | JSONL lines 570/572/574/576: three `Request timed out.` errors and one `terminated`; coordinator independently verified all four durations and error states. |
| Implement work before / after first full review | 5.86 / 5.68 hours | Chronology, not necessary/wasted-work separation. |

Review execution was not the largest measured cost. Post-review implementation includes genuine omissions, newly approved late-album semantics, regression repairs, tests, recoveries and outages. It must not be labelled entirely redundant review work. Thirteen attempt headers had no fresh final check: eleven `none`, two `stale`; preserved WIP may still contain useful work.

Do not add these overlapping surfaces as an elapsed-time pie chart. Do not call the unallocated remainder human waiting. Candidate failure-to-instruction gaps are not measured approval delay: some selected messages only configured notifications, and some intervals contain provider failures or quota resets. No defensible total for recoverable hours, cost per defect or counterfactual speedup was established.

## Was the code overreviewed?

Not as a blanket conclusion. Full rounds 1–4 found required issues after green tests and focused acceptance: routing/replay gaps, independent read-along OFF, late-album data loss, missing notices, receipt ordering and hidden cleanup/registration failures. Round 5 closed required findings while explicitly deferring one maintenance judgement.

The skill requires integrated Standards/Spec review and affected review after fixes. It does not require five full-baseline rounds, a reader after every attempt, or fixing every heuristic. Later full reruns were also explicitly requested by the observer on the user's behalf; they cannot all be attributed to autonomous coordinator excess.

The strongest redundancy candidate is repeating unchanged Spec coverage after the final isolated registration-error fix. This is a plausible scope reduction, not proof that final acceptance was unnecessary. Review reports are evidence, not an independent re-audit of all production code.

Recommended cadence:
1. At the first usable integration seam, map critical original requirements to end-to-end evidence; do not confuse completed worker steps with complete requirements.
2. Use focused independent review when risk or evidence gaps justify it, not after every job by default.
3. Perform the required integrated two-axis review. After local fixes, review the delta and affected invariants/axis, explicitly carrying unchanged coverage forward.
4. Reopen broad review for changed semantics, migrations/cross-owner effects, uncertain coverage, or explicit user requirement. Each new invocation of Matt's full skill still honors both axes.
5. Stop when required findings have verified dispositions, current code is check-green and covered, and nonblocking judgements have justified deferrals. A new commit or a deferred smell alone does not restart the loop.

## Prioritized actions

| Priority | Action | Targets / acceptance |
|---|---|---|
| NOW, approval to edit still required | Reserve verification time within each worker's tool window. Bound scope using actual check/build costs, stop adding behavior before the reserve, and preserve incomplete state rather than pretending success. | `implement-spec-me-pi` §§2–4; `docs/delegate.md`. Walk through no-check/stale-check cases. No invented universal minute cutoff or prohibition on necessary fixes after failed checks; relevant edits require fresh checks. |
| NOW | Explicitly assign outside-checkout ledgers/reports to the coordinator; implementers read pointers and return handbacks. | Skill §§3–4 and guide. im48 walkthrough must not ask a worker to write `/tmp` artifacts; write fence remains intact. |
| NOW | Add integrated acceptance coverage and change-sensitive review closure above. For a recurring defect class, inspect relevant analogous sites within the affected owner/scope, fixing or dispositioning each. | Skill §§2,4–5 and review briefs/dispositions. Keep class sweeps bounded; no repository-wide smell cleanup or mandatory new panel. |
| NOW | Distinguish acceptance from recovery: unchanged normal committed/check-green work does not need an implementer merely to repeat a check. | Skill §4; guard/limit stops still require current-policy approval before resumption. Never claim an old report inspected a new HEAD. |
| NEXT, explicit policy decision | Permit one standing-authorized continuation after a positively identified time-wrap-up stop, same scope/limits, state preserved, verification prioritized. Stop on recurrence, ambiguous cause, hard timeout, quota, cost, guard or tripwire. | Policy owner: `GLOBAL_AGENTS.md`; skill, guide and typed stop provenance where necessary. Explicit authorization and failure-path tests before adoption; no hidden automatic retry in this pilot. |
| NEXT, small runtime change | Optional explicit `review` pool; absent means existing worker behavior, explicit model still runs alone. | `extensions/delegate.ts`, status/help, `test/delegate.test.mjs`, guide. Test old configurations, review-only selection, invalid config, explicit overrides and actual status. No positional meaning for the second worker entry. |
| LATER, separate design | Concurrent isolated-worktree implementers only where ready independent work exceeds integration cost. | Implement lifecycle, owning tests, guide and skill. Preserve cancellation/WIP, check provenance, refs/tripwires, serialized integration and merged-result verification. Do not weaken the current lock opportunistically. |

Proposals need focused contract checks and the repository check before shipping. No runtime, skill, global policy, guard, pool or concurrency changes are made by this document.

## Parallelism

Supported now: two-axis readers on frozen sources; one implementer plus independent spec/seam/test-coverage investigation; cautious review of a frozen prior delta during disjoint writing. Use at most four worker slots. A live changing checkout is not a frozen review snapshot.

Unsupported now: simultaneous same-repository or linked-worktree implementers. The common-directory lock, write scope and check provenance deliberately serialize them. Worktrees alone do not solve shared-ref ownership, conflicts, cancellation or verifying the integrated result. Separate repositories have separate locks, but starting extra sessions/clones to evade same-repo limits is not a solution.

Karto also had native ticket dependencies and shared hot owners, limiting theoretical concurrency. The pilot does not quantify speedup. Preserve stable handback/source-to-commit matching before main build/Compose proof; overlapping that proof with an active checkout writer risks invalid evidence.

## Rebuttal resolution and rejected claims

Both models converged on the action direction. Sol qualified DeepSeek's categorical “no overreview”: useful required findings do not prove every whole-baseline rerun was necessary. Adopt that narrower conclusion.

Reject claims that approximately six hours of gated/recovery runtime were wasted or recoverable, that candidate gaps bound savings, or that dividing repair time by report finding count yields cost per defect. Preserved work, overlapping classifications, repeated findings and scope changes make those inferences unsound. Also reject a fixed 18-minute verification deadline: no optimal reserve was measured. Four failed coordinator request durations are established, but subtracting them does not prove the rest of an overnight interval was human absence.

No more panels or telemetry are required to make these bounded decisions. Stop analysis here; select a small implementation batch separately. Keep reviewer-pool ergonomics, recovery authorization, and concurrent-write lifecycle as distinct changes with distinct acceptance checks.
