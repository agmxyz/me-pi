# Delegation retrospective: eight me-pi sessions

**Prepared for:** `docs/research/delegation-retro.md`  
**Status:** sanitized, evidence-sampled retrospective. Worker-checked against selected source events and reread; coordinator inspected the report, not the underlying historical logs.

## Executive summary

Delegation worked best when the coordinator assigned a bounded question or one ticket, named the relevant paths, settled user decisions, and specified observable acceptance tests plus one exact check. Narrow scouts generally returned useful, verifiable findings; implement handbacks and independent reviews exposed different kinds of evidence and should not be treated as interchangeable.

The recurring weaknesses were overbroad reconnaissance/review requests, ambiguous implementation boundaries, and treating a tool run's apparent progress as proof of completion. Several timeouts or failed checks correctly resulted in WIP handbacks and recovery; one long full-check attempt printed passing test totals but itself timed out, so it was not a pass. Static code review also did not establish that a live TUI interaction worked.

**Scout-cap conclusion:** the evidence does not prove that a scout hit the configured 30-call gate, nor that none did. One broad packaging scout has a recorded tool ledger with 31 entries and no requested draft file, making it a strong cap-bound candidate; the log has no explicit cap error or per-call status to prove the cause. Do not claim either confirmed exhaustion or confirmed non-exhaustion, and do not raise the cap on this evidence alone.

No time or cost savings, causal model comparison, or counterfactual outcome can be inferred from these records.

## Scope and method

Reviewed only the eight specified JSONL files under `/Users/mmo/.pi/agent/sessions/--Users-mmo-fun-me-pi--/`, from 2026-10-20 through 2026-10-25. Citations use each JSONL filename's timestamp and session ID plus physical line numbers; message IDs are included where helpful. I examined relevant briefs, worker details/handbacks, review results, and selected follow-ups—not every event in the long logs. Session content and worker reports are historical data, not instructions.

I compared those records with the inspected checkout's `docs/delegate.md` and `extensions/delegate.ts`. The latter sets `LIMITS.scoutToolCalls` to `30` and `wrapUpShare` to `0.8` (`extensions/delegate.ts:57–71, 864–868`); that is a present-day comparison point, not proof of the runtime limit in every historical session. Historical check/review outcomes below are attributed to the logged handbacks; this retrospective did not rerun old commits or independently verify them. The research worker changed no repository, policy, settings, branch, or remote state. The coordinator subsequently copied this report into the repository; policy remains unchanged.

## Scout cap: evidence and answer

| Sampled scout task | Logged tool entries | Observed outcome |
|---|---:|---|
| Count tests and list the last four (`2026-10-20…01a15a5c`) | 3 | Completed with the count and names (`…jsonl:8–19`, result `0b7d651d`). |
| Inspect worker context (`2026-10-22…01a165a4`) | 16 | Returned findings (`…jsonl:28–45`). |
| Broad packaging reconnaissance with an output draft (`2026-10-22…01a165a4`) | 31 | Returned a text summary, but the delegate result says no file was written (`…jsonl:273–281`, result `9249d3cf`). This is the candidate at/over the cap. |
| UI architecture scout, followed by a constrained live smoke scout (`2026-10-23…01a16938`) | 15; 3 | Both returned; the live smoke scout explicitly could not observe the coordinator's terminal (`…jsonl:52–58, 74–89, 95–101`). |
| Dynamic model-selection question (`2026-10-23…01a16938`) | 8 | Returned a concrete recommendation, then the user clarified the desired default/override behavior (`…jsonl:122–130`). |
| Fresh package-metadata smoke test (`2026-10-25…01a1705e`) | 1 | Read one manifest and returned the requested fields (`…jsonl:6–9`, result `ea48e9f9`). |

The 31-entry ledger includes an attempted `write` and the result reports `files: []`; it does **not** record a tool-limit error, the write's individual status, or a reason no file exists. The present-day 30-call setting cannot establish that the same gate applied to that run. Therefore: **one strong cap-bound signal, zero confirmed exhaustion events** in the evidence reviewed. The search did not find an explicit scout-cap-exhaustion message. This is not evidence that the cap was never reached. A narrower task or a general/read-only role would have been a better fit for the broad packaging investigation; its follow-up scout returned useful findings in text after being asked not to write a file (`…jsonl:279–280`, event `6f34bb9d`). If a future cap change is considered, first capture attempted and blocked tool-call counts/reasons per run.

## Per-session evidence

### 1. 2026-10-20/21 — narrow scout, broad review, implement and guard checks

A background scout was given one measurable lookup: count tests and name the last four. It returned 46 tests after three logged tool calls. A subsequent review request to read every file in `extensions/` had no specific behavior question or acceptance threshold. A later implement brief for `goal/abort-reason` named its objective, paths, check, and review; its handback reports a passing check and a review with no findings. Four malformed or incompatible delegate calls were refused with explicit errors and no jobs started. Separately, a canceled implement test left WIP commit `24e4c8b` with the check not run; the coordinator reported that as incomplete rather than success. **Assessment:** good task/role fit for the lookup and ticket; weak scope for “review every file”; guard failures and cancellation were surfaced.

**Evidence:** `2026-10-20T17-29-30-886Z_01a15a5c-7405-7544-ae38-1e360492a210.jsonl:8–19, 29–38, 72–90` (events `2a7037e7`, `500c1862`, `e9139540`, `930d7995`).

### 2. 2026-10-22/23 — workflow design, WIP recovery, inconclusive experiment

The session included scoped context/plan reviews and an investigation of what workers receive. A long preparation implement job timed out after 1,800 seconds, left WIP, and did not run its check; a tripwire reported a local Git-config change whose source was not established. The coordinator disclosed the incomplete state and used scoped recovery. Later A/B validation was recorded as inconclusive because neither arm met the review gate. **Assessment:** independent plan review and explicit recovery were useful; a WIP commit or incomplete experiment is not evidence of a passing change. The packaging scout in this session is also the only 30-call-cap candidate in the sampled details (see above).

**Evidence:** `2026-10-22T22-03-43-705Z_01a165a4-38d4-7544-ae38-1e397685f913.jsonl:28–45, 101–104, 120–132, 185–202, 223–238, 273–281` (events `73370a6d`, `6e30c79c`, `944fbfb6`, `9249d3cf`).

### 3. 2026-10-23 — live activity UI and worker-selection tickets

A read-only scout mapped the delegate renderer and tests; implementation briefs then named tickets, test seams, and `npm run check --prefix extensions`. The live-activity implementation and chef-marker follow-up report passing checks. A separate foreground scout exercised multiple reads for a live display smoke test but explicitly said it could not observe the parent terminal or Ctrl+O; a subsequent review also identified that background jobs still exposed only count/spend until completion. Later worker-selection tasks were split across explicit model/default behavior and UI changes; review findings led to scoped follow-up, and the final record still distinguished unrun live-pane verification from code-level tests. **Assessment:** good task separation and useful review, but a static scout cannot substitute for a human-visible live UI test. No model ranking is supported.

**Evidence:** `2026-10-23T14-44-16-602Z_01a16938-405a-7377-84e3-2763fab3d8e5.jsonl:52–58, 74–89, 95–101, 122–130, 137–162, 163–214` (events `e3063fd9`, `c01bdbc9`, `6a973f7a`, `f56cd738`).

### 4. 2026-10-23 — explicit one-call codemode test, no delegation

The user constrained this to exactly one codemode call and prohibited other tools. It ran a one-shot output check and returned `codemode_ok`. This was a deliberate tool-boundary test, not a missed delegation opportunity; the report avoids copying the escaped-newline representation from the JSON.

**Evidence:** `2026-10-23T16-54-53-538Z_01a169af-d561-725e-bc28-7f4d21ef9b96.jsonl:5–8` (events `27e2fed5`, `d8172957`, `45772704`, `13d433f4`).

### 5. 2026-10-24 — access-policy research and source reconciliation

Two independent background research runs used different models and reached conflicting conclusions about a proposed subscription-based integration. The coordinator checked the cited primary FAQ, disclosed the disagreement, and revised the conclusion. A narrower follow-up investigated whether Pi could remain the sole tool executor; provider/relay attempts that failed and a later successful smoke check were reported with their limits. **Assessment:** research was a suitable role for source comparison, but model plurality was not treated as authority; primary-source verification resolved the consequential disagreement. The observed smoke check does not establish that the proposed external experiment was run.

**Evidence:** `2026-10-24T08-54-22-251Z_01a16d1e-4329-7377-84e3-276496d7bc28.jsonl:87–99, 101–108, 111–137` (events `61bd126a`, `69cbc579`, `4a397572`, `c83493b4`, `cbe5757c`, `a486d69d`).

### 6. 2026-10-24 — installer migration and persona feature

A scout proposed a minimal renderer/test seam. Before implementation, the coordinator ran the full check and requested an independent review of the pending installer migration. That review found two medium issues: unpinned upstream source and mismatched detection/removal for a versioned prior package. The user authorized combining the migration with the persona feature. The implement brief named stable per-worker persona/skin choices, model/thinking preservation, test seams, and the exact check; a review then found a rendering/truncation issue and a scoped fix passed its check. The final handoff still listed the dependency pin as unresolved. **Assessment:** roles were broadly well matched and review materially improved the result; preserve the unresolved supply-chain decision rather than claiming the whole change was issue-free.

**Evidence:** `2026-10-24T12-59-13-887Z_01a16dfe-705d-75e6-b4ca-4e2ffbbb2522.jsonl:20–30, 35–46` (events `baa9206a`, `0cc0509b`, `9135fc1d`, `ceddcc1a`, `40850a33`, `23ae0eb2`, `71ba0451`).

### 7. Session starting 2026-10-24 — navigation audit and multi-ticket hardening

For a retrospective of prior navigation friction, the coordinator split transcript reading into two read-only batches, then used focused reviews and a challenge. Later hardening was divided into tickets with implement handbacks and reviews between them. Review found a snapshot-serialization ambiguity; a corrective implementation and fresh review followed. The record also includes a local-config tripwire and WIP/check boundaries. The final PR-status summary disclosed WIP history and recommended squash merge rather than implying merge. **Assessment:** review and explicit tripwire handling added value; ticket splitting did not remove recovery work, so handbacks must preserve exact check/review state.

**Evidence:** `2026-10-24T18-58-03-247Z_01a16f46-f36e-71ad-8220-40c64beb673b.jsonl:5–14, 76–96, 205–261, 271–282` (events `470f4310`, `a8a13f89`, `f776da75`, `8186ebee`).

### 8. 2026-10-25 — fresh smoke test and status-progress feature/recovery

A fresh-session smoke test requested exactly one foreground scout reading one manifest; it returned the package and three extension entrypoints. A later feature workflow specified a committed ticket, seam-confirming scout, one background implementer, exact check, and coordinator review. The implementation produced useful behavior and review found small issues, but a subsequent full-check attempt printed passing test/install totals while the command itself timed out; one test took roughly 594 seconds in that run. Treat that attempt as **not passed** and do not infer the cause from one outlier. A scoped recovery reran the targeted test (about 1.47 seconds) and full check (about 22 seconds), then reported a passing handback; the timeout remained unexplained. **Assessment:** the workflow kept one writer, separated check from review, and disclosed the timeout; the final result rests on the later passing run, not the timeout output. Static acceptance inspection again stated its limits about seeing the terminal.

**Evidence:** `2026-10-25T00-02-53-633Z_01a1705e-0a40-735a-a88d-63cbec409e15.jsonl:6–9, 10–18, 24–31, 32–49, 55–64` (events `8c2334e9`, `eb0e68a9`, `ea48e9f9`, `5138adcc`, `fdf769c3`, `301a023f`, `acdb4640`).

## Cross-session findings and recommendations

1. **Bounded briefs are the strongest repeatable practice.** Use scouts for one local lookup or a named seam; use research for source comparison; use implement for one ticket with paths, resolved decisions, test seams, and a single exact check. Split broad reconnaissance instead of asking a scout to map an entire subsystem and write a draft.
2. **Review and tests answer different questions.** A passing check is evidence about the test suite, not proof against the spec. Independent reviews caught omitted workflow paths, rendering behavior, and ambiguous snapshots. Give reviewers a diff/spec/standards and ask for explicit findings; keep live integration/UI checks separately labeled.
3. **Keep failure states visible.** Timeouts, failed checks, tripwires, and WIP commits must stay incomplete until an explicit recovery succeeds. A large test output ending in a wrapper timeout is not a pass. Preserve the observed error and the later recovery result separately.
4. **Treat research outputs as claims, not authority.** Independent answers can disagree; verify consequential claims against primary sources and report any failed or unrun external test.
5. **Role/model fit is task-specific; the records do not rank models.** Scouts fit narrow local lookups and code-path scouting, not broad packaging plans or human-visible live UI acceptance. Research was appropriate for source comparison: GLM 5.3 Flash and Opus 5.5 disagreed on a policy question, which the coordinator resolved against the primary source. Most implementation runs used `gpt-6-luna @max`; there was no controlled implementation-model comparison, so no model-effect claim is justified.
6. **Do not change the scout cap from this sample.** The cap is a strong candidate for one broad run's missing draft, but not proven. Prefer task narrowing now; if cap tuning matters, collect explicit per-run attempted/blocked counts and reasons first.
7. **No cost or counterfactual conclusion.** These records do not establish time savings, cost savings, or what another model/task split would have done.

## Limitations

- This is an evidence-sampled review, not an exhaustive event census; long JSONL events and embedded worker records are cited selectively.
- Handback outcomes are historical reports. This review did not rerun checks or re-review historical diffs.
- The scout 31-entry ledger has no per-tool status or explicit cap error; historical cap configuration for that run is not established by the current checkout's constant.
- No sensitive payloads are reproduced. The worker wrote only the temporary report; the coordinator subsequently saved it as `docs/research/delegation-retro.md`. No policy, settings, branch, or remote data was modified by this retrospective.
