# Delegate workflow skill — T1 preparation and T2 evidence

Status: T1 preparation complete; authenticated T2 comparison inconclusive and adoption blocked. This report distinguishes offline preparation from lifecycle evidence. It makes no reliability claim.

## Offline preparation

- Base: `94f8b71a4820a35f899ffe2131a85b6eece5bbaf`.
- Preparation command: `node test/workflow/prepare.mjs`.
- Scratch root from the final preparation run: `/private/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-4Kirit`.
- Baseline package A: `/private/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-4Kirit/packages/a`.
- Candidate package B: `/private/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-4Kirit/packages/b`.
- Paired scratch goals: `/private/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-4Kirit/goals/a` and `/private/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-4Kirit/goals/b`; both clean at preparation, no remote configured, oracle absent.
- Pi 1.3.0 offline RPC discovery passed for both package arms. B's `implement-goal` was discovered from `extensions/package.json` with `source: "skill"` and package origin, without `--skill`; a scratch probe found exactly one `delegate` tool in each arm. No model was invoked.
- `node --test test/workflow/prepare.test.mjs` passed: 2/2 tests. `node test/workflow/prepare.mjs` passed and recorded the paths above. The final `npm run check --prefix extensions` passed: lint, typecheck, 121 tests, install smoke test (37 checks), and diff check.

The generated `artifact-index.json` records exact paths and discovery results. The artifacts are temporary; recreate them with `node test/workflow/prepare.mjs`. No auth or secret paths were read, written, copied, or linked.

## Authenticated lifecycle comparison (T2 outcome)

Status: `INCONCLUSIVE` — one attempted pair (`n=1`), zero completed lifecycle pairs. The candidate was not adopted. This lifecycle outcome is separate from the passing offline discovery/preparation evidence above.

The user approved, and the main session ran, one Luna-only A/B attempt using temporary auth symlinks in scratch; credential contents were never read, copied, or logged. A temporary RPC driver was syntax-checked. Both arms ran under Pi 1.3.0 with the same neutral prompt and no nudges, resolving to `openai-codex/gpt-6-luna` at `low` thinking. A Haiku availability probe returned `429`; the user selected Luna for both arms, and the Luna probe passed.

- **A, baseline:** No `implement-goal` skill was discovered or loaded. The transcript records reads of `SPEC.md`, `tickets/T1.md`, and `tickets/T2.md`. `node scripts/check.mjs T1` returned `BLOCKED: oracle unavailable` (exit 1). The main session edited `src/math.mjs` directly, then reported the change uncommitted and `BLOCKED`; it made no delegate call.
- **B, candidate:** `implement-goal` was discovered from the package (`source: "skill"`, `origin: "package"`) and loaded before any delegate call (1,715 ms). The transcript records reading `SPEC.md` and both ticket files. The same oracle check returned `BLOCKED: oracle unavailable` (exit 1). The main session edited `src/math.mjs` directly, then made one foreground `implement` delegate attempt. The guard refused to start a job with `implement needs a clean tree; commit your work first (1 changed or untracked file(s))`.

In both arms the oracle was absent at start and was never enabled by the harness. No implement job started, no classifiable worker handback or T1 recovery occurred, and T2, goal review, and review/fix stages were not exercised. There were no remote action attempts; both fixtures remained remote-free, so remote behavior was not tested.

### Metrics and interpretation

Session-level metrics (not worker usage; B's implement job never started):

| Arm | Elapsed | Input / output / cache-read tokens | Final context usage | Reported cost |
|---|---:|---:|---:|---:|
| A | 18.5 s | 13,636 / 426 / 43,776 | 6,363 / 272,000 (2.34%) | $0.00201436 |
| B | 22.1 s | 21,553 / 573 / 41,344 | 7,190 / 272,000 (2.64%) | $0.00285524 |

The raw A transcript confirms it read both `tickets/T1.md` and `tickets/T2.md`; any contrary summary is incorrect. The observed B failure is an orchestration/task-fixture ambiguity: the main session treated the ticket's partial, uncommitted-work condition as its own instruction, edited before dispatch, then attempted to start a clean-tree worker. Dispatching before that edit could have allowed the worker to start. This run does not show that the fixture is logically incompatible with clean-tree workers, does not establish a runtime regression, and is not evidence that the candidate split works. An unattributed prior local git-config change remains untouched; no new tripwire was added or suppressed.

## Disposition

The offline preparation and package-discovery commands above remain reproducible and distinct from lifecycle evidence. No further live run was performed for this record.

`BLOCKED: Adoption and rerun decisions need explicit user resolution; T2 remains incomplete.`
