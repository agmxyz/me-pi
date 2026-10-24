# Delegate hardening — implementation plan

**Final repository path:** `docs/plans/delegate-hardening.md` (one plan file; no separate ticket files or wiki pages).

## Goal and boundaries

Implement four approved changes: make implement handbacks reflect the content checked and committed; keep personal ticket/PR/review choreography out of the package-default prompt while retaining its safety contract; make the required check read-only and installer policy conflicts fail before mutation; and verify full and delegate-only package loading in fresh isolated Pi profiles without adopting the optional rig policy.

Work serially, one ticket per implement job, in order **T3 → T1 → T2 → T4**. The order makes the check read-only before later tickets rely on it, separates the two tickets that both touch `extensions/delegate.ts` and `test/delegate.test.mjs`, then verifies the integrated package. For each ticket, run exactly `npm run check --prefix extensions` after the last edit. It forwards to the root check; that offline full suite includes lint, typecheck, all tests, the isolated installer smoke test, and `git diff --check HEAD`.

No public visibility changes, publishing, remote operations, real user-profile installation, secret access, wiki writes, or live `./install.sh` execution. The unapproved chief-of-staff wiki location is not a blocker to these code tickets. The installer test may exercise its isolated fixture copy only.

## Verified baseline

- `extensions/delegate.ts` `trackCheck` recognizes the declared Bash check and successful `edit`/`write` events after a pass, but does not detect Bash content changes. `test/delegate.test.mjs` already drives implement tool-event streams and temporary Git fixtures; `test/delegate-implement.test.mjs` has real-Git lifecycle tests.
- Root `package.json` runs `lint` in `check`; `lint` currently uses `biome check --error-on-warnings --write .`, so the acceptance check may rewrite sources.
- `install.sh` detects an occupied `~/.pi/agent/AGENTS.md` after creating the extensions directory and continues package, example, and RTK work before failing. `test/install.test.sh` currently expects that mutation on conflict.
- `PROMPT_GUIDELINES` contains package tool guidance and personal ticket/PR/review choreography. `GLOBAL_AGENTS.md` already owns approval, coding-standard, secret-handling, and failure rules; do not duplicate them. The current prompt also says `Trust a ✓ handback: no diff read, no review, no re-check.`, which conflicts with `docs/coding-standards.md`'s requirement to review the diff and not treat a success label as review.
- `test/pi-package-resources.test.mjs` and `test/fixtures/pi-package-resource-harness.mjs` use Pi 1.3.0's package manager and resource loader in fresh `PI_CODING_AGENT_DIR`s. They cover full loading and a guard-only filter, but not delegate-only loading or policy non-adoption.

## T3 — Read-only checks and installer preflight (user-approved item 3)

**Status:** Completed; independently reviewed.

**Scope:** `package.json`, `test/package.test.mjs`, `install.sh`, `test/install.test.sh`, and `README.md` only as needed.

**Acceptance:**

- `npm run check --prefix extensions` and its root check path perform no formatter writes. Keep the formatter's write mode behind one explicit fix command and document it; add no unrelated scripts or formatting policy.
- Test the configured read-only lint command against a deliberately unformatted temporary fixture: it may report the style error, but the fixture's bytes remain unchanged. Assert that the check/lint scripts do not use a write flag and that the explicit fix command is separate. Do not make the full suite run against an intentionally unformatted repository fixture.
- Before creating directories or changing settings/packages, installing packages, copying examples, or invoking RTK, the installer detects an existing policy file or any nonmatching symlink at the destination. It exits nonzero and preserves all prior state. A correct policy symlink remains valid. Preserve successful first runs, idempotent reruns, and upgrade behavior.

**Confirmed test seams:** `test/package.test.mjs` for script definitions and the read-only fixture check; `test/install.test.sh`'s isolated HOME/fake-Pi/RTK fixture for no-mutation collisions. For both regular-file and foreign-symlink collisions, assert empty Pi/RTK invocation logs, unchanged existing state, and no newly created settings or extensions directory. Retain tests for a valid first run, correct symlink, repeat run, and old extensions-registration upgrade. Never run the live installer.

## T1 — Check freshness for Bash content changes (user-approved item 1)

**Status:** Completed; independently reviewed.

**Scope:** `extensions/delegate.ts`; `extensions/delegate-implement.ts` only if required by the owning implementation; `test/delegate.test.mjs` and/or `test/delegate-implement.test.mjs`.

**Acceptance:**

- A successful declared check establishes the content baseline. After each completed Bash tool event, including an event that reports an error, content changes from that baseline make the check stale; a later stage/commit cannot turn it green. A failed declared check remains failed. A successful rerun of the declared check after mutation/commit can restore pass.
- Staleness is based on content, not Git status text, timestamps, or `.git` metadata. Staging and committing content already present when the check passed do not stale it. A green handback must not survive a Bash content mutation that is staged and committed after the pass.
- Preserve existing `edit`/`write` staleness, check-failure behavior, WIP handling, tripwires, and Bash safety rules. If the content baseline cannot be determined, do not report a green check. Make the user-visible stale reason accurate for Bash changes as well as edit/write changes.

**Confirmed test seam:** Extend the implement event-path integration in `test/delegate.test.mjs` using its fake Pi JSON events and a temporary real Git repository. The regression must execute real Bash content mutation and real Git staging/commit effects—not only fabricated tool events or a helper-only test. Cover (1) content already present at check time, then staged/committed without invalidating pass; (2) a passing check followed by Bash content mutation and stage/commit, yielding a stale/failed handback; and (3) a check rerun after that commit restoring pass. Assert the resulting Git content and handback. Keep or extend the existing failed-check and edit/write-staleness cases. `test/delegate-implement.test.mjs` may cover helper-level snapshot behavior, but cannot replace the event-path regression.

## T2 — Neutral package-default prompt (user-approved item 2)

**Status:** Completed; independently reviewed.

**Scope:** `extensions/delegate.ts`, `test/delegate.test.mjs`, and `GLOBAL_AGENTS.md` only if applicable personal workflow guidance needs a rig-specific home.

**Acceptance:** Remove personal goal/ticket/issue-tracker, PR/push sequencing, and per-goal review/fix choreography from `PROMPT_GUIDELINES`. Move only guidance appropriate to this rig into `GLOBAL_AGENTS.md`, where it does not duplicate or conflict with the existing approval, coding-standard, secret, or failure policy. Preserve package-default guidance for roles/tools, model runs and rebuttal, web risk, private drafts, background limits, BLOCKED/failure handling, and the single-writer/safety contract.

Delete `Trust a ✓ handback: no diff read, no review, no re-check.` from the package-default prompt and **do not copy or replace that instruction in `GLOBAL_AGENTS.md`**. Leave review decisions to existing repo/user policy; a green handback is not a substitute for diff review. Do not weaken runtime restrictions or misstate worker capabilities.

**Confirmed test seam:** Update `test/delegate.test.mjs` assertions for `PROMPT_GUIDELINES`, worker contracts, and tool capabilities. Assert the personal choreography and trust-green instruction are absent from the package default, and assert retained capabilities, safety, and failure behavior remain. Review `GLOBAL_AGENTS.md` against its existing rules before any addition; do not add redundant approval, coding-standard, secret-handling, or failure rules.

## T4 — Isolated full and delegate-only package loading (user-approved item 4)

**Status:** Completed; independently reviewed (bg31 approved, no high/medium findings).

**Scope:** `test/pi-package-resources.test.mjs`, `test/fixtures/pi-package-resource-harness.mjs`, and concise baseline text in `README.md` only if needed.

**Acceptance:** In a fresh isolated profile per scenario, use the pinned Pi 1.3.0 package manager to install the local package, configure the filter where applicable, and reload resources. Retain the full-package case and add a filter selecting only `extensions/delegate.ts`. Verify the delegate tool registers; `guard` and `Skill` are not loaded in the delegate-only case; imported sibling helpers load successfully without becoming extension entrypoints; and package-only installation does not adopt/link `GLOBAL_AGENTS.md` into the profile. Assert the expected extension paths and empty errors/warnings.

The harness currently rejects its delegate-registration probe when `ME_PI_RUN` is set. Since `npm run check --prefix extensions` can itself run inside an implement worker with that marker, make the isolated subprocess model a normal main-session load by omitting the worker-only marker from that test subprocess. This is test-fixture setup, not a production-mode change. Do not access user profiles or auth. The README already names Pi 1.3.0 and Node.js ≥22.19; update it only if the tested local baseline changes, and do not claim GitHub transport or interactive `/reload` was tested.

**Confirmed test seam:** Extend the existing `DefaultPackageManager` / `DefaultResourceLoader.reload()` harness and fresh `PI_CODING_AGENT_DIR` scenarios; do not create a second harness. Do not invoke `install.sh`.

## Offline and external verification boundary

The required `npm run check --prefix extensions` is the offline full-suite gate and must pass on each delivered ticket. The isolated Pi test covers local package installation/resource reload, not external Git transport or the interactive `/reload` command; both remain unverified. GitHub installation requires network/access to a private repository and is not part of this work. Do not run the live installer, change public visibility, publish, read secrets, or write to a wiki. Report external checks as unverified, not as offline-suite failures.
