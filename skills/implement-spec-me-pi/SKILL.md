---
name: implement-spec-me-pi
description: Implement a ticketed spec serially on an integration branch with bounded me-pi workers.
disable-model-invocation: true
---

# Implement a spec with me-pi

User entry: `/skill:implement-spec-me-pi` followed by the spec, tracker, repository, and execution constraints.

The coordinator owns the task graph, scheduling, user decisions, acceptance, and all skill-required orchestration. Workers cannot delegate or ask the user questions. Use one implement worker per repository, executing ready tickets serially in the existing checkout on one integration branch; no new worktree or merger workflow.

## 1. Establish the execution contract

- Read repository instructions, the originating spec, tickets, and documented tracker workflow. Honor finalized decisions, exclusions, deferred work, and commit conventions. Ask for missing sources rather than guessing.
- Confirm the Pi session's actual cwd is in the target checkout, preferably its root: a path in a worker brief does not change where `delegate` runs. Otherwise stop and ask the user to reopen Pi there. Record repository root, worktree inventory, current branch, tip, and dirty status. Preserve an explicitly supplied **existing** integration branch and its commits. If none is supplied, agree its name and base with the user before creating it. Require a clean checkout on that integration branch, not `main`/`master`; stop for dirty work, branch conflicts, or a missing supposedly existing branch. Never silently reset, rebase, stash, or discard work.
- Agree the per-ticket completion point, exact authorized tracker actions/targets, and final review baseline. Resolve that baseline to a commit SHA before implementation and retain it in the ledger; moving names such as `HEAD` are not the recorded fixed point. Acceptance on the integration branch need not wait for a remote merge.
- Load `tdd` and `code-review` with `Skill` in the coordinator. Obtain their required user choices: review fixed point and originating spec upfront; public test seams (what each catches/misses) for each ticket before tests at those seams are written. Resolve newly discovered seams just in time, not for the entire spec in advance.
- Consult repository runtime prerequisites and dependency policies, including provenance, licence, release, and runtime compatibility requirements where applicable. Establish an exact, single, unchained repository check command and permitted test substitutes for external services.
- Confirm `delegate`, `Skill`, and both required skills are available. Use the delegate tool's contract and the installed me-pi package's `docs/delegate.md` for capability/recovery details; locate the package rather than assuming this guide exists in the target project. Exact model requirements must be compatible with configured selection: implement workers reject per-call model/thinking overrides. Report mismatches; do not silently substitute or reconfigure global settings.

**Ready:** sources, branch/tip, pinned baseline, check, prerequisites, completion points, and authorization boundaries are recorded; unresolved implementation-changing choices for the next ticket block that ticket.

## 2. Build the frontier

Read the tracker's **native dependency/blocking relations**. Parent/subissue membership, issue numbers, and checklist order do not establish execution order. Record missing relations, cycles, and excluded blockers for resolution rather than inventing dependencies.

Retain the pinned review baseline and maintain a ticket ledger: dependencies; scope/acceptance criteria; ready/running/blocked/accepted status; starting SHA and exact committed tip/range; evidence and check result; unresolved issues; tracker closure state. Verify already-completed work against available evidence instead of reimplementing it.

Optional read-only exploration may run in parallel within the worker limit. Use `delegate(role="general", output=true, ...)` for notes in each worker's private temp directory. Review notes, copy only appropriate artifacts, and pass accessible paths onward. Supply command outputs as files: read-only workers cannot run commands.

**Ready:** select one in-scope ticket whose blockers are satisfied under the agreed completion rules. If none is ready, report remaining blockers.

## 3. Implement one ready ticket

Dispatch `delegate(role="implement", background=true, check=<exact command>, task=<brief>)`.

Keep the brief compact and self-contained:
- Repository/cwd, integration branch, starting SHA, ticket objective, and pointers to the spec, fetched tracker data, repository instructions, research, and prior commits.
- Finalized decisions, exclusions/deferred work, runtime/dependency constraints, commit conventions, and allowed scope.
- Instruction to load `tdd` via `Skill`; user-confirmed seams; acceptance criteria and required behavioral evidence; the exact check to run alone after the final edit, then commit passing work.
- Instruction to return `BLOCKED: <step>: <reason>` for missing decisions, capabilities, or evidence; no delegation or scope expansion.

Report the background job ID and await its handback without polling or resubmitting. While active, the worker is the sole checkout writer: no coordinator edits or Git writes there. Read-only work may parallelize within available slots. A guard or worker-limit block means **STOP and report**, not an automatic alternate tool, command, model, or environment bypass.

## 4. Accept or recover

Inspect the handback, actual branch/tip/range, diff, declared check result, and relevant details. Independently assess changed behavior, acceptance coverage, and check adequacy proportionately; use targeted verification or independent read-only review where evidence is insufficient. Passing handback alone does not establish spec completion.

Explicitly accept, reject, or recover each result and update the ledger. Failed checks, WIP, timeouts, unresolved blockers, and tripwires remain incomplete. On a tripwire, stop and report before proceeding. Resolve necessary user decisions before a bounded implement recovery; rerun affected verification. Advance the frontier only on accepted evidence, then repeat steps 3–4.

## 5. Review the integrated result

The coordinator executes the loaded `code-review` workflow against the agreed baseline and originating spec. Validate the baseline and nonempty diff; provide captured diff, commit list, and sources as accessible files. Dispatch its separate Standards and Spec axes in parallel foreground read-only workers, including its required standards/smell instructions. Preserve both axes in the report; workers must not silently skip orchestration or missing choices.

Fix findings through an implement worker, then rerun affected checks and review. Record every finding's disposition; unresolved required fixes prevent completion.

## 6. Close only authorized work

Use the repository's documented tracker mechanism only for explicitly authorized actions and exact targets after their agreed acceptance point. Ticket comments/closures may occur after each accepted integration commit if requested. Keep accepted and closed distinct. PR creation/readiness, push, remote merge, and deletion are not implicit; a PR workflow requires user request/approval.

Report integration branch and final tip; tickets completed and closed separately; check command/result; review findings and handling; blockers, skipped checks, and unverified claims.

Throughout: follow current safety/authorization policy and the invocation's external-service restrictions, using only approved substitutes. No autonomous global installs, secret reads, environmental bypasses, or worktree deletion.
