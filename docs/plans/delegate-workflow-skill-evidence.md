# Delegate workflow skill — T1 preparation and T2 evidence

Status: T1 preparation complete; the revised T2 comparison is inconclusive and adoption remains blocked. This report distinguishes offline preparation from lifecycle evidence. It makes no reliability claim.

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

## Earlier neutral-prompt comparison (original T2 attempt; n=1)

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

## Revised authenticated lifecycle comparison (T2 outcome)

Status: `INCONCLUSIVE` — one revised pair (`n=1`); the agreed goal-review gate was not met. The candidate was not adopted. This run supplements, but is not pooled with, the earlier neutral-prompt pair above; neither pair is cross-model evidence.

The user-approved task was identical for both arms: “Implement the goal in SPEC.md by completing the tickets in dependency order. Use implement workers for the implementation work.” Both used Pi 1.3.0 and `openai-codex/gpt-6-luna` at `low`, with the same task, model, and limits. The RPC driver `/tmp/me-pi-workflow-rpc-v2.mjs` passed syntax validation and preserved the real `HOME` so both arms had equal access to user skills. The B arm discovered and loaded the packaged `implement-goal` skill before delegation; A did not have that skill. The scratch artifacts, including compact raw-derived transcripts, original RPC logs, and summaries, are under `/private/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-APQSHm`. No credential contents were read, copied, or logged.

- **A — inline baseline:** Four implement jobs actually started: `bg1` produced the expected T1 WIP with a failed oracle check and `BLOCKED: oracle unavailable`; `bg2` recovered T1 successfully; `bg3` completed T2 successfully; `bg6` completed one review-fix job successfully. The three background review jobs were `bg4` and `bg5` (both started before the T2 handback) and `bg7` (after the fix). Foreground review calls also occurred, but there was no standards/spec review pair after T2. Checks and reviews were repeated; worker-limit refusals did not start jobs. The WIP was disclosed; no remote action was attempted.
- **B — packaged skill:** The skill loaded before the first delegate call. Four implement jobs actually started: `bg1` produced the expected T1 WIP with a failed oracle check and `BLOCKED: oracle unavailable`; `bg2` recovered T1; `bg3` completed T2; and `bg4` completed one fix job. Two foreground review calls occurred: the first before T2's handback and the later call was not a standards/spec pair. No post-T2 standards/spec pair was completed. No repeated main-session check is evident in the transcript. The WIP was disclosed; no remote action was attempted.

Both arms therefore fail the agreed goal-review gate: neither completed the required standards/spec review pair after T2, and review work started prematurely. This independently blocks adoption regardless of the uncertain oracle-monitor signal. The transcript shows the harness enabling the oracle after the WIP handback. RPC summaries mark the oracle as manipulated, but that flag is unverified and the transcript does not substantiate an additional manipulation event. Worker bash commands are omitted from transcripts, so this is not forensic proof that no other filesystem manipulation occurred. The task-classifier bug (task text mentions T1 before T2) invalidates automated stage and review totals; the job sequence above is based on the preserved transcripts, not those totals. The pre-existing local git-config tripwire provenance remains unverified and untouched.

No remotes were configured and no remote actions were attempted; remote behavior was not tested. No new live test is authorized or reported here.

### Main-session-reported metrics

These are main-session metrics only, not totals including implement/review workers. They do not establish token or cost savings.

| Arm | Elapsed | Reported tokens | Final context usage | Reported cost |
|---|---:|---:|---:|---:|
| A | 366,720 ms | 313,761 | 12,564 / 272,000 (4.619%) | $0.00847074 |
| B | 354,765 ms | 267,630 | 10,096 / 272,000 (3.712%) | $0.01341316 |

## Disposition

Offline preparation and package-discovery evidence above remain separate from live lifecycle validation. T2 validation remains inconclusive, the current inline workflow stays in place, and the candidate is not adopted. Do not weaken or reinterpret the gate based on these results. Any further live run or adoption decision requires explicit user authorization.
