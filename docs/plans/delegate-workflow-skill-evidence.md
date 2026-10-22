# Delegate workflow skill — T1 evidence

Status: preparation complete; adoption blocked. This report distinguishes offline preparation from the authenticated lifecycle comparison. It makes no reliability claim.

## Offline preparation

- Base: `94f8b71a4820a35f899ffe2131a85b6eece5bbaf`.
- Preparation command: `node test/workflow/prepare.mjs`.
- Scratch root from this run: `/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-C3oGYX`.
- Baseline package A: `/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-C3oGYX/packages/a`.
- Candidate package B: `/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-C3oGYX/packages/b`.
- Paired scratch goals: `/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-C3oGYX/goals/a` and `/var/folders/gg/m4k2c11115j155971lzv7vxh0000gn/T/me-pi-delegate-workflow-C3oGYX/goals/b`; both clean at preparation, no remote configured, oracle absent.
- Pi 1.3.0 offline RPC discovery passed for both package arms. B's `implement-goal` was discovered from `extensions/package.json` with `source: "skill"` and package origin, without `--skill`; a scratch probe found exactly one `delegate` tool in each arm. No model was invoked.
- `node --test test/workflow/prepare.test.mjs` passed. It checks candidate/fixture integrity, scratch isolation, Pi package discovery, the initially unavailable oracle, and script syntax.

The generated `artifact-index.json` records exact paths and discovery results. The artifacts are temporary; recreate them with `node test/workflow/prepare.mjs`. No auth or secret paths were read, written, copied, or linked.

## Authenticated lifecycle comparison

Status: `UNRUN`.

BLOCKED: explicit user approval for temporary symlinks to `~/.pi/agent/auth.json` is pending. No A/B model session, delegate job, or lifecycle event was run. No reliability, WIP-recovery, dependency-order, review, or fix-cap outcome is claimed. T2 remains pending until the live comparison passes and all blockers are resolved.

Once approval is provided, follow `test/workflow/README.md` using the prepared A/B goals, equivalent isolated settings, the same model/provider/thinking/limits, no reminders, and no real remotes. Record the actual transcripts and available usage metrics; report `n=1` if only one pair is available. Any oracle manipulation, missing expected review finding, or other stated inconclusive condition is not a passing pair.

## Next safe command

To recreate the offline scratch candidate and package-discovery evidence without authentication:

```sh
node test/workflow/prepare.mjs
```
