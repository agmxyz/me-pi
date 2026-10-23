# Delegate workflow skill — T1 evidence

Status: preparation complete; adoption blocked. This report distinguishes offline preparation from the authenticated lifecycle comparison. It makes no reliability claim.

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

## Authenticated lifecycle comparison

Status: `UNRUN` and intentionally out of scope for T1.

The user approved temporary symlinks to `~/.pi/agent/auth.json` for a later isolated A/B. No symlinks were created, and no auth contents were accessed. No A/B model session, delegate job, or lifecycle event was run. No reliability, WIP-recovery, dependency-order, review, or fix-cap outcome is claimed. T2 remains pending until the live comparison passes.

For the next live-validation job, use the prepared A/B goals, equivalent isolated settings, the same model/provider/thinking/limits, no reminders, and no real remotes. Record the actual transcripts and available usage metrics; report `n=1` if only one pair is available. Any oracle manipulation, missing expected review finding, or other stated inconclusive condition is not a passing pair.

## Next commands

To recreate offline scratch artifacts without authentication:

```sh
node test/workflow/prepare.mjs
```

For live validation, after setting `SCRATCH_ROOT` to the generated root, creating only the approved temporary auth symlinks, and choosing the shared `MODEL` and `THINKING` values, start arm A with this command; repeat with B's paths before recording outcomes:

```sh
(cd "$SCRATCH_ROOT/goals/a" && PI_CODING_AGENT_DIR="$SCRATCH_ROOT/agents/a" ME_PI_DELEGATE_CONFIG="$SCRATCH_ROOT/agents/a/delegate.json" PI_CODING_AGENT_SESSION_DIR="$SCRATCH_ROOT/sessions/a" pi --model "$MODEL" --thinking "$THINKING")
```
