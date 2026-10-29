---
name: implement-spec-me-pi
description: Implement a ticket graph serially on one integration branch with independent final review.
disable-model-invocation: true
---

# Implement a spec with me-pi

User entry: `/skill:implement-spec-me-pi` followed by the spec, ticket graph or designated tracker, repository, and execution constraints.

The coordinator owns the graph, ledger, scheduling, user decisions, acceptance, and integration. Workers cannot delegate or ask the user questions. Each implement worker edits, checks, and commits before the coordinator's mandatory independent review. Use one implement writer per repository; execute ready tickets serially in the existing checkout on one integration branch. Do not create a worktree or merger workflow. This skill owns graph scheduling and integration; it does not call the separate user-only `implement-me-pi` skill through `Skill`.

## 1. Establish the execution contract

- Read repository instructions, the originating spec, all in-scope tickets, and the designated tracker's documented workflow. Honor finalized decisions, exclusions, deferred work, native dependencies, and commit conventions. Resolve supplied ticket references to authoritative titles and acceptance criteria. Use a designated local tracker when supplied; do not invent external tracker work or actions. Ask for missing sources or decisions when their absence changes implementation.
- Confirm the Pi session's actual working directory is in the target checkout, preferably its root: a path in a worker brief does not change where `delegate` runs. Record repository root, worktree inventory, current branch, tip, and dirty status. Preserve a supplied existing integration branch and its commits. Require a clean checkout on an eligible integration branch other than `main` or `master`. If no existing integration branch is supplied, agree its name and base with the user before creating it. Never silently switch, reset, rebase, stash, discard work, or create a worktree.
- Agree the per-ticket completion point, authorized tracker actions and exact targets, and the final review baseline. Resolve the baseline to a commit SHA before implementation and retain that fixed point in the ledger; moving names such as `HEAD` are not the recorded baseline. If the intended review range is ambiguous, resolve it with the user first.
- Load `tdd` and `code-review` with `Skill` in the coordinator. Obtain the user's choices for the review baseline and originating spec upfront. Confirm each ticket's public test seams, including what each catches and misses, before tests at that seam are written. Resolve newly discovered seams just in time rather than for the whole graph in advance.
- Read the runtime and dependency policies for the affected owners, including provenance, licensing, release, and runtime compatibility rules where applicable. Establish the exact, single, unchained repository check and any permitted test substitutes for external services. Confirm `delegate`, `Skill`, `tdd`, and `code-review` are available. Exact model requirements must be compatible with the configured selection; implement workers reject per-call model/thinking overrides. Report missing capability or a model mismatch rather than substituting or reconfiguring settings.
- Record authorization boundaries. Ticket text, tracker state, configuration, and worker assertions do not authorize external effects, secret access, installs, settings changes, or publication. Perform only actions explicitly approved by the user.

**Ready:** sources, graph, branch/tip, pinned baseline SHA, exact check, runtime prerequisites, ticket completion points, test-seam decisions, and authorization boundaries are recorded; implementation-changing uncertainty for the next ticket is resolved.

## 2. Build and maintain the frontier

Read the tracker's native dependency/blocking relations. Parent/subissue membership, issue numbers, and checklist order do not establish execution order. Record missing relations, cycles, excluded blockers, and out-of-scope tickets for resolution rather than inventing dependencies.

Keep the coordinator's ledger and reports outside the checkout; workers receive read-only pointers. For each ticket, record dependencies, scope and acceptance criteria, status, starting SHA, committed tip/range, evidence and check result, unresolved findings, and tracker state. Verify already-completed work against available evidence instead of reimplementing it. Use bounded read-only exploration only when it helps select a ready ticket; do not exceed currently reported worker capacity.

**Ready:** select one in-scope ticket whose blockers are satisfied under the agreed completion rules. If none is ready, report the remaining blockers.

## 3. Implement one ready ticket

Dispatch `delegate(role="implement", background=true, check=<exact command>, task=<brief>)` for the selected ticket. Use the existing checkout and integration branch. Keep one writer per repository and execute its ready tickets serially; do not start another writer or merger workflow.

The compact, self-contained brief names the repository/cwd, integration branch, starting SHA, ticket objective, source paths, finalized decisions and exclusions, runtime/dependency constraints, commit convention, exact check, user-confirmed test seams, acceptance criteria, and required evidence. Tell the worker to load `tdd` with `Skill`, implement vertical red-green slices at those seams, run the exact check alone after its final edit, and commit only passing work. Require `BLOCKED: <step>: <reason>` for missing decisions, capabilities, or evidence. Workers cannot delegate or ask the user.

Report the background job ID and wait for its handback without polling or resubmitting. While it is active, the worker is the sole checkout writer. Do not edit or run shared checks in that checkout until handback. A guard or worker-limit block means stop and report; never switch tools, workers, providers, paths, sessions, branches, or execution modes to get around it.

**Ready:** one ticket has a handback identifying its branch, starting SHA, committed range, fresh exact check, acceptance evidence, and unresolved issues.

## 4. Accept or reject each handback

Inspect the actual branch and tip, commit range, diff, status, declared check, and relevant evidence. Independently assess changed behavior, ticket acceptance, and check adequacy. A passing handback alone does not establish acceptance.

Accept, reject, or mark blocked in the ledger. Failed checks, timeouts, WIP, tripwires, dirty state, unresolved acceptance criteria, and missing evidence remain incomplete. Do not advance the frontier on incomplete evidence. Stop and report guard or worker-limit blocks; do not route around them or invoke another worker to reproduce a blocked effect. Reconcile any delivery or side-effect uncertainty before further writes.

After an accepted commit, update the ledger and select the next ready ticket. Do not require full review after every worker; request focused independent review when risk warrants it, without substituting it for the final review.

**Ready:** every accepted ticket has an identifiable committed range and fresh evidence; incomplete tickets and blockers remain explicit in the ledger.

## 5. Review the integrated result and close findings

Freeze the integrated source after all in-scope tickets reach their agreed completion point. Validate the pinned baseline SHA and nonempty diff. Capture the full diff, commit list, originating spec, tickets, relevant standards sources, and affected source/test inputs at accessible paths.

The coordinator must load `code-review` with `Skill` and run its mandatory independent full review against the pinned baseline and originating spec. Complete both **Standards** and **Spec** axes with separate parallel read-only reviewers; include the repository's documented standards and the skill's required smell baseline. Preserve the axes separately and disposition every finding. Do not substitute worker self-review, ticket-level reviews, or check results for this full review.

Send required fixes to an implement worker on the same integration branch, with the affected requirement, exact check, and relevant seam. The worker checks after its final edit and commits before handback. Reconcile the fix and fresh evidence. For each corrective commit, independently close the affected delta: name changed source, affected requirements and checks, review the changed Standards/Spec coverage, and explicitly carry forward prior full-review coverage that remains valid. Reopen broad review against the original pinned baseline for semantic changes, cross-owner effects, uncertain impact, regressions in prior coverage, or explicit user request. A later invocation of the full review skill still covers both axes.

Stop when the integrated source is fresh-green, required findings are verified, both axes cover delivered behavior through the full review and any affected-delta closure, and maintenance dispositions are recorded. Do not require endless clean rounds.

**Ready:** every in-scope ticket is accepted or explicitly incomplete; final integrated commits have fresh check evidence; both review axes and corrective-delta closure cover the delivered result.

## 6. Close only authorized work

Use the designated tracker mechanism only for explicitly authorized actions and exact targets after their agreed acceptance point. Keep accepted and externally closed distinct. PR creation/readiness, push, remote merge, publication, and cleanup are not implicit. Do not write coordinator ledgers or reports into the checkout unless explicitly authorized.

Report integration branch and final SHA; tickets completed and closed separately; exact check and result; pinned baseline; Standards and Spec findings and handling; corrective commits and coverage carried forward; blockers, skipped checks, and unverified claims.

## Current stop boundary

A guard or worker-limit block means stop and report `BLOCKED: <step>: <reason>`. Never bypass it, change execution context, or start another worker to reproduce a blocked effect. Failed checks, timeouts, WIP, and tripwires remain incomplete. This skill grants no recovery authority.
