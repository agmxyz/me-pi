# Karto delegation pilot: interim observations and reviewer-pool proposal

## Purpose and scope

Karto's coordinator delivers spec `agmxyz/karto#1`; the observing me-pi session gathers evidence about delegation. Delivery takes priority. This is an interim record, not a final retrospective or model benchmark. No me-pi runtime or model configuration change is made by this note.

Pilot: `/Users/mmo/fun/agm/karto`, existing integration branch `feat/slice-1-pipeline`, baseline `6b20c03e425789c97c7c8ff6fa3974122791cab0`. In-scope tickets: #3, #5, #6, #7, #8, #9; #4 deferred. The separately installed, user-invoked `implement-spec-me-pi` skill uses serial implement workers, TDD, coordinator-owned acceptance, and final two-axis review.

## Evidence sources and limits

- Herdr pane `w3:p31`: observer-read status and terminal output at checkpoints, not continuous monitoring.
- Delivery coordinator's notes: `/tmp/me-pi-karto-pilot-delivery-notes.md` and ledger `/tmp/karto-pilot-delivery-ledger.md`. These are mutable local artifacts; observations below identify the checkpoint, not a permanent transcript snapshot.
- Worker details: `im1.md` through `im9.md` under `/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-18683/`. Raw failed-tool diagnostic payloads remain private and are not copied into this report.
- Current model-selection semantics: `docs/delegate.md`, section “Configure model pools.” The worker list is an ordered availability-fallback pool, not a role assignment.

The observer inspected coordinator notes/output, not every historical diff, worker call, or test execution. Reported checks below are attributed to delivery evidence; they were not rerun by the observer. No causal time/cost savings or model-quality ranking is established.

## Delivery observations so far

| Checkpoint | Observed/reported outcome | Implication to investigate |
|---|---|---|
| #3, im1 | Time gate before final `just check`; WIP `056172f` preserved. Coordinator recorded 31 failed tools, including exact-text edit failures. | Count-cap removal did not eliminate budget exhaustion. Root cause is not established by failed-call count. |
| #3, im2 | User-approved recovery at `5b45a06`; `just check` reported 64 tests passing. Independent acceptance inspection found no required defects; #3 closed. | Bounded recovery and explicit acceptance can complete preserved work. |
| #6, im3 | Packaging command containing recursive temporary-directory cleanup was guard-blocked; WIP `b15451f`, no final check. | Nonessential cleanup can halt a whole workflow. The observer sought explicit approval; no bypass was authorized. |
| #6, im4–im5 | Approved non-destructive verification retained temp artifacts. Acceptance inspection/review identified missing Correction behavior and incomplete cascade coverage; fixes at `ec12311`, 72 tests reported passing, #6 closed. | Review added evidence beyond passing checks; WIP/recovery history was preserved. |
| #5, im6 | Accepted at `ddf8cc9`, checks including real Postgres reported passing; #5 closed. | Counterexample to universal failure: not every ticket required human recovery. Live linguistic quality remained unverified. |
| #7 A, im7 | Onboarding/webhook step accepted at `c18c388`, 100 tests reported passing. | Coordinator decomposed a larger ticket into bounded steps. |
| #7 B1, im8 | Time gate again, WIP `ed15364`; earlier passing tests did not verify latest edits. | Budget exhaustion recurred even after decomposition; do not infer a sufficient remedy yet. |
| #7 B1, im9 | Approved recovery at `17c7faf` reports passing `just check`. Observer saw subsequent Luna/max acceptance review report “Required findings”; dispositions/full-ticket acceptance not yet established. | Passing recovery is not equivalent to accepting the full ticket. |

At the last inspected checkpoint, #3/#6/#5 were accepted and closed, #7 remained incomplete, and #8/#9 plus final integrated review were pending. This is not a live status dashboard.

## Reviewer-pool proposal — saved, not implemented

The user observed implementation and review both selecting Luna/max and supported an explicit reviewer pool.

**Proposed interface:** optional `review` pool in `delegate.json`, using the existing ordered model/thinking entries and availability-fallback semantics. `role="review"` would use it when configured and otherwise retain the current `worker` pool behavior. Preserve explicit per-call selection semantics. This is a future design proposal, not valid current configuration.

Keep `worker.models` as an availability order. Do not interpret its second entry as “the reviewer”: that conflates fallback priority with role assignment. Do not add model routing machinery or infer a pool change from list position.

For this pilot, the user explicitly requested upcoming independent reviews use `openai-codex/gpt-6.1-sol` at `medium`. The observer sent that instruction to `w3:p31` with these limits:

- Set `runs: [{ model: "openai-codex/gpt-6.1-sol", thinking: "medium" }]` on upcoming read-only reviews; leave implement selection/configuration unchanged.
- Apply to future per-ticket acceptance reviews and both final review axes; do not cancel or repeat an existing review just to switch models.
- Explicit model selection has no fallback; report unavailability rather than silently substitute.
- Do not reload during active jobs or change global configuration.

At instruction delivery, the visible B1 review had already used Luna/max; it is not evidence of Sol review. Subsequent actual selection/outcomes must be recorded before drawing conclusions.

## Review role versus review skill

`delegate(role="review")` selects a worker preset; it does not automatically execute Matt's `code-review` skill. Per-ticket acceptance has used focused inspections/review briefs. The final integrated review is required to follow the loaded skill: separate Standards and Spec readers in parallel, a pinned baseline and originating spec, and findings/dispositions kept per axis. Completion of that final review has not yet been observed.

Separate contexts provide some independence even with the same model. Different models may expose different blind spots, but this pilot does not establish that cross-model review is better: ticket complexity, time, and implementation state also change. Neither Matt's `implement`/`implement-spec` nor `code-review` prescribes a model or thinking level.

## Later checkpoint: #8 time-budget exhaustion

The observer subsequently read #7's accepted/closed state at `d3c2e51` (128 tests reported passing) and #8 step A at `23fad65` (132 tests reported passing). Sol/medium focused reviews had identified actionable defects that were fixed; this is evidence of useful findings, not a controlled comparison against Luna.

#8 step B1 (`bg14`/`im14`) then stopped with reported tool time-budget exhaustion, preserving WIP `d26e9f3ccd061b4f28d8a8ba3d2137c7da662130`. Final `just check` was not run, and earlier targeted tests predated the latest edits. The coordinator recorded 28 failed tools; that count does not establish the cause of exhaustion. Forms/transactional decisions and a malformed-signature fix were in scope; B2 orchestration remained separate.

Classify this as **time-budget exhaustion / incomplete attempt**, not an application defect, test failure, or provider outage. The observed handback does not by itself establish a hard process timeout versus the earlier tool wrap-up gate. Do not label every time-budget stop a hard timeout. WIP preservation is successful recovery of state, not successful completion of work.

This is the third recorded time-budget incident in the inspected pilot checkpoints (`im1`, `im8`, `im14`), distinct from `im3`'s recursive-cleanup guard block. This is not an exhaustive incident census. The user explicitly approved bounded #8 recovery, preserving history and keeping B2 separate; the observer forwarded that approval and requested explicit gate classification in delivery notes. Recovery outcome remains pending at this checkpoint.

## Proposed recovery-policy split — deferred until after delivery

Repeated budget stops required fresh human approval despite the user's request for delegated routine decisions. The user agreed to finish the current #9 recovery under existing rules and defer policy changes until after Karto delivery.

Recommended future policy, not adopted in this run:

- Permit one explicitly bounded continuation after a time wrap-up under standing authorization: preserve WIP/history, same scope and limits, prioritize verification, record the incident.
- Permit coordinator acceptance review after a normal committed/check-green result without manufacturing an implementation recovery.
- Continue to stop for safety guards, tripwires, cost caps, or repeated exhaustion. No bypasses or unlimited retries.
- Do not infer that increasing time limits fixes verification starvation; assess scope and verification reserve from completed evidence first.

The observer relayed current approval for `bg23`/`im23` #9 step B recovery at WIP `988e423a51fc0ef72c972dfabecc98052ad31129`: rerun the corrected local Compose/version probe, final check, normal commit, and acceptance review. The prior failed probe and its unverified correction are not a passing result. Recovery outcome is pending at this checkpoint; no actual deployment or live calls were authorized.

## Later intervention: Sol implementation and high-thinking review

After `bg31`/`im31` late-album step 2 exhausted its tool time budget, the user explicitly approved bounded recovery at WIP `2a8d97cf46b8f8bb9451cd3ef479b0ef4118feee` and requested Sol 6.1/medium implementation plus Sol 6.1/high reviews. The earlier reported 203-test pass was stale after a test edit; the worker's suspected fixture/chunk-count problem had not yet been executed/confirmed.

Because implement workers reject per-call model overrides, the observer changed `~/.pi/agent/delegate.json`'s global `worker.models` to only `openai-codex/gpt-6.1-sol` at `medium`, with no availability fallback, leaving scout unchanged. Prior configuration is preserved locally at `/tmp/me-pi-delegate-before-sol.kHPXZC`. This affects global worker defaults, not a dedicated reviewer pool. Karto had zero active workers before its reload; configuration shape and reload output were verified. Upcoming reviews were instructed to explicitly select the same model at `high`. Actual runtime selection and outcomes still require evidence; instruction delivery alone is not proof.

Treat the switch as an intervention with confounders: implementation state, recovery scope, context, and review thinking also changed. It cannot isolate model quality, speed, or the benefit of cross-model review. No automatic restoration of the previous configuration was requested or performed.

## Later intervention: Codex usage limits and GLM/DeepSeek switch

Karto's delegate worker then failed with `Codex error: The usage limit has been reached` (`bg34`, zero commits, no check). The user directed a further model switch. The latest instruction set was applied; the earlier Haiku/Sonnet proposal was superseded.

Observer updated global `~/.pi/agent/delegate.json` and backed up the prior configuration to `/tmp/me-pi-delegate-before-glm-deepseek.json`. New active pools:

- `worker.models`: only `openrouter/z-ai/glm-5.3-flash` at `max`, used by `implement` (which cannot take per-call model overrides) and as the default for other worker roles.
- `scout.models`: only `openrouter/z-ai/glm-5.3-flash` at `low`.

Because the worker default is no longer a review model, the observer instructed Karto to set `runs: [{ model: "openrouter/deepseek/deepseek-v4.1-flash-1017", thinking: "high" }]` explicitly on every independent review call. Karto was also authorized to continue its current authorized work, including bounded recovery of existing unaccepted WIP or failed `bg34` state without history rewrite or bypass. The switch is another confounder: usage-limit failure, recovery state, and review model changed together; no model-quality conclusion follows.

## Return to Luna implementation and Sol review

The observer later saw Karto report `bg35` stopped with `timeout after 1800s`, zero commits/files and no final check. This establishes a hard worker timeout for that attempt, unlike earlier time-wrap-up-only evidence. Coordinator request-timeout/terminated/retry failures were also visible and should not be conflated with the worker timeout or assumed to have the same cause.

The user directed continuation with Luna/max implementation, Luna/off scout, and Sol 6.1/medium review. With zero active workers, the observer changed the global single-candidate worker/scout pools to `openai-codex/gpt-6-luna` at `max`/`off`, verified Karto reload output, and relayed explicit Sol review selection. The coordinator remained on its existing Sol/medium model. The observer instructed it to preserve state, report any remaining recovery-approval boundary, and keep all time/cost/safety limits unchanged. Dispatch, model availability, and successful continuation remain unverified at this checkpoint.

## Final scoped local delivery — accepted

Karto reported completion at `ffd02bb3e5c9fb42be7f475d8ec0b872deb2a9d6` on `feat/slice-1-pipeline`. The observer independently checked that exact HEAD and empty Git porcelain output. It also read `/tmp/karto-final-delivery.md`, `/tmp/karto-final-review-round5/reports.md`, and the completed delivery checkpoint notes. Execution/review results below remain attributed to those artifacts, not independently rerun by the observer.

- All six scoped tickets (#3, #5, #6, #7, #8, #9) implemented and previously closed. #4 remained deferred. No push, PR, main merge, deployment or real provider/Telegram/Letter calls.
- Final main-coordinator standalone `just check`, after final review at unchanged HEAD: 255 tests passed, one existing httpx2 cookie deprecation warning, no skips, strict Pyright zero errors/warnings, Ruff passed.
- Fresh local Compose proof applied all 17 migrations and checked health/restart, invalid-secret rejection, stopped-upstream failure and synthetic privacy markers. All 60 staged build files reportedly matched final committed blobs.
- Fifth full Matt review round: two separate parallel Sol 6.1/medium readers, Standards zero hard violations/one explicitly deferred maintenance judgement (J5 Data Clumps), Spec zero material findings. All required findings resolved; deferral has a stated cost, risk and future trigger.
- Alpha gates remain outside this local acceptance: consent/controller/EU backend decisions, native-language review, retention scheduling, real browser/TLS/deployment and production security. Development storage remains unencrypted without backups under recorded tradeoffs; no real Letters before those gates are satisfied.

This completes delivery, not the me-pi analysis. Strong follow-up evidence now includes repeated verification starvation and incident-specific approval friction; successful WIP preservation and stale-check rejection; separate focused versus full-review findings; and a worker report-write guard caused by assigning a coordinator artifact to the implementer. Model switches and narrow recovery scopes remain confounders; there is no controlled model-quality or cost/speed comparison.

Final pointers: `/tmp/karto-final-delivery.md`, `/tmp/karto-final-review-round5/reports.md`, `/tmp/karto-final-review-sources/dispositions.md`, `/tmp/karto-final-compose-proof-round5.txt`, `/tmp/karto-final-review-round5/source-match.txt`. These are local temporary evidence, not durable repository attachments. Do not publish raw session or failed-tool diagnostics.

## Low-priority backlog: delegate activity readability

Opportunistic task for the next delegate-rendering refactor, not a standalone priority. Screenshot review of a two-model panel showed two worker rows under one background job, clipped model/thinking/activity text, and cost figures whose scopes were unclear to the reader. The count is not a confirmed bug: one panel job can contain two workers.

Candidate targets: `extensions/delegate-render.ts` and related widget/footer rendering in `extensions/delegate.ts`; confirm owners before changing code.

Acceptance ideas:
- Distinguish job count from worker count, e.g. “1 job · 2 workers.”
- Keep short model names, thinking levels, and useful activity readable at narrow widths; retain full identifiers in expanded view.
- Label cost totals by their actual accounting scope; verify semantics before choosing labels.
- Add targeted narrow-width/multi-worker rendering tests, preserving Unicode safety and bounded, payload-free status output.

No runtime/UI changes implemented. The source image was a temporary clipboard file, so this written description is the durable backlog context.

## Follow-up after delivery

1. Check actual review model/thinking and whether a review was focused acceptance or the full skill; record concrete findings and their handling, not only “passed.”
2. Compare successful bounded work with time-gated work before proposing changes to scope, verification reserve, edit-error handling, or recovery policy. Preserve guard/authorization boundaries; this report grants no recovery or safety-policy change.
3. Decide whether an optional review pool earns its configuration cost. No positional routing, model rankings, automatic retry policy, new telemetry, or orchestration expansion is justified yet.
4. Complete one final retrospective from delivery evidence; keep Karto implementation, pending product decisions, external-service restrictions, and remote approvals separate from me-pi experimentation.
