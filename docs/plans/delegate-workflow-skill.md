# Delegate workflow skill

Status: planned; adoption depends on live comparison.
Base: `94f8b71a4820a35f899ffe2131a85b6eece5bbaf`.

## Goal and scope

Make delegate's always-injected guidelines usable outside the author's setup without losing the tested goal/ticket/PR orchestration. Keep operation and safety inline; disclose the opinionated workflow through a model-invocable packaged skill. Do not change GLOBAL_AGENTS.md, do the root packaging cleanup, add an opt-out flag, or change repository visibility/history.

This is a live checkout: extensions and GLOBAL_AGENTS.md affect new sessions. Prepare and test the candidate in scratch before changing live extension source. Never run the live installer from a worker or scratch clone. Do not use Herdr panes for risky tests.

## Agreed design

Keep inline: proportionate delegation, model panels, role/answer selection, drafts, web risk, BLOCKED reporting, treating delegate workers as subagents, commit existing work before implement (worker starts at HEAD), task/acceptance/check requirements, checkout fence, background delivery/worker limit, handback/WIP/tripwire handling, and starting the next already-authorized ready job in the same turn.

Use job rather than ticket in generic tool guidance. Accept a passing implement handback without immediately rereading its diff, reviewing it, or rerunning its check; this does not suppress a later goal-wide review. Remove the private reference to “the Approval rules”. Remote/destructive actions remain subject to applicable user authorization. Remove the assertion that a goal-end review satisfies arbitrary repository review requirements.

Move into `extensions/skills/implement-goal/SKILL.md`: personal precommit review policy, goal-base tracking, committing spec/tickets, ticket sequencing and test seams, Claude Code skill overlay, tracker lifecycle, draft PR timing, final suite and goal-wide review, reviewer awareness of checks already passed, one-fix cap, and WIP disclosure/squash-merge guidance. Preserve stronger repository and user requirements. The skill must not grant remote/destructive approval.

Add a strong inline pointer: for a spec, ticketed goal, or PR workflow, load `implement-goal` before the first implement job. Include a single-ticket/PR routing case so the lifecycle rules do not depend on having multiple tickets. Ship it through the existing extensions/package.json pi.skills manifest. Verify Pi 1.3.0 actually discovers it; explicit CLI skill loading is not evidence of package discovery. No author-global routing dependency. T1 keeps both candidate artifacts outside live extension source and applies the prompt/manifest patch only to a scratch package clone.

Keep existing runtime semantics. Update README paths/usage and tests affected by moving guidelines; avoid brittle verbatim prose pins, favor structural checks, a word budget, and relevant behavior assertions.

## Evidence and uncertainty

Observed with injected guidance: seven-round review/fix loop before fix cap, waiting without a started job, redundant check due to reviewer BLOCKED reporting, and main/worker refusal to satisfy subagent instructions. Worker CONTRACT_SHARED already independently fixes worker refusal. WIP continuation has live and fake-pi coverage. Early issue closure and premature pushes were not observed; those rules are preventive. No skill-only workflow has been live-tested across handbacks and goal-end review.

## Confirmed test seams

1. Existing extension suite and install smoke tests: `npm run check --prefix extensions`.
2. Offline package discovery: `node test/workflow/prepare.mjs` starts Pi 1.3.0 in isolated offline RPC mode for both arms. `get_commands` confirms B's `implement-goal` has `source: "skill"` and `sourceInfo.origin: "package"`, with no explicit `--skill`; a scratch probe confirms exactly one `delegate` tool in each arm. No model is invoked. The paired lifecycle remains UNRUN. Workers inherit their arm's agent environment.
3. Two identical scratch toy repositories, same model/provider/thinking/limits and equivalent global policies/pools: A uses current guidelines, B uses candidate guidance and packaged skill. No reminders at handbacks or goal end. No remote targets; no actual pushes or tracker closures.
4. Ticket 1 conditionally implements then reports `BLOCKED: oracle unavailable` and leaves changes uncommitted while the harness oracle is unavailable. The condition lives in the ticket, not a permanent main-session instruction. Finish must produce a non-cancel WIP and failing handback. Harness enables the oracle; main must dispatch recovery before dependent ticket 2. Worker manipulation of the oracle makes the run inconclusive. Existing implement-dirty fake-pi test is the deterministic WIP lifecycle seam.
5. Ticket 2 prescribes a known incomplete first pass; full spec remains visible to main/reviewer. Goal review should identify it and trigger at most one fix job. A reviewer miss makes the run inconclusive, not passing. This tests lifecycle, not model competence.
6. Record skill loading before first job, actual job starts, handback/check/WIP results, review count and fix count, model, elapsed time, available context/usage metrics and nudges. Run two paired comparisons if available; otherwise report n=1. A successful pair is evidence, not proof of reliability.
7. B must match A on successful WIP recovery, dependency order, next-ready-job continuation, goal review, fix cap, and absence of unauthorized remote actions. Test lack of premature closure/push via transcript in this no-remote setup, not a claim that remote behavior was exercised.

Authentication for isolated agents requires current user approval before temporary symlinks to ~/.pi/agent/auth.json are created. Never read/copy/log credential contents. No config/secret reads beyond granted scope.

## Adoption gate

Do not change live guidelines or advertise the split as validated until the live comparison passes. T1 preparation and offline package-discovery evidence are recorded in `docs/plans/delegate-workflow-skill-evidence.md`; the authenticated A/B is UNRUN because explicit user approval for temporary auth symlinks is pending. T2 remains pending. If B fails or either arm is inconclusive, retain current workflow injection (generic wording may be a later separate change); report evidence and BLOCKED items. Do not add an opt-out flag.

## Tickets

### T1 — Prepare candidate and validation harness

Status: PREPARED — offline validation passed; adoption blocked, live comparison UNRUN.

The candidate artifacts are in `test/workflow/candidate/`; the scratch-only preparation, package-discovery check, paired goal fixtures, oracle gate, and A/B procedure are in `test/workflow/`. The sanitized evidence report is `docs/plans/delegate-workflow-skill-evidence.md`. Keep live extension source/manifest unchanged. No secrets in evidence. The authenticated comparison is blocked pending explicit user approval for temporary auth symlinks; do not claim live results. T1 closes only as preparation in a passing commit, with T2 still pending.

### T2 — Adopt validated workflow split

Status: TODO; depends on a passing live comparison from T1 and explicit resolution of BLOCKED items.

Apply the validated candidate to extensions/delegate.ts, add the packaged skill and manifest entry, update affected tests and README, and preserve runtime behavior. Include targeted discovery/guidance tests. Final check is the full extension suite and install smoke checks. Close this ticket only in a passing commit.

## Review and delivery

One final goal-wide review against this spec and repository standards. At most one high/medium fix job. Open a PR only after a passing implementation handback; no merge, visibility change, branch deletion, or history rewrite is authorized by this plan. Report live-test limitations and sample size in the PR evidence.
