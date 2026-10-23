# Delegate workflow scratch validation

This harness prepares, but does not run, the authenticated A/B. It builds everything under a fresh OS temp directory, loads the candidate from the `extensions/package.json` Pi manifest, and keeps both goal repos remote-free.

## Prepare and validate offline

From the repository root:

```sh
node test/workflow/prepare.mjs
node --test test/workflow/prepare.test.mjs
```

`prepare.mjs` requires local Pi 1.3.0 and uses `git archive` at base `94f8b71a4820a35f899ffe2131a85b6eece5bbaf`; it does not fetch, install packages, load `--skill`, invoke a model, read auth, or change the live extension. It creates:

- `packages/a`: baseline package from the agreed base.
- `packages/b`: the candidate package, with the narrowly patched prompt guidelines, `extensions/skills/implement-goal/SKILL.md`, and `pi.skills: ["./skills"]` in its own `extensions/package.json`.
- `goals/a` and `goals/b`: matching clean scratch Git repos with the two-ticket fixture and no remotes.
- `agents/a` and `agents/b`: isolated Pi config dirs with equivalent copies of the baseline global policy, identical empty delegate pools, and each arm's local package path.
- `sessions/a` and `sessions/b`: separate session directories.
- `artifact-index.json`: generated paths, base SHAs, and offline discovery results.

The script separately starts Pi 1.3.0 in offline RPC mode for each arm, asks `get_commands`, and calls a scratch-only probe command. For B it requires `skill:implement-goal` with `source: "skill"` and `sourceInfo.origin: "package"`; for both arms it requires exactly one registered `delegate` tool. Neither discovery check uses an explicit `--skill` option. The probe writes only tool names inside its scratch agent dir. A failure stops preparation and surfaces Pi diagnostics.

The oracle is initially absent. After a failing T1 WIP handback, enable it for exactly that arm with:

```sh
node test/workflow/set-oracle.mjs <SCRATCH_ROOT> a
```

Use `b` for the other arm. The helper validates the generated scratch marker and fixture path, and refuses to overwrite an existing gate. Check the handback and confirm the worker did not create or alter `.workflow/oracle.ready` before using the helper; any worker manipulation makes that arm inconclusive.

## Live comparison — T2 attempted, inconclusive

One user-approved Luna-only pair was attempted in scratch under Pi 1.3.0 with no nudges, but zero lifecycle pairs completed; the candidate was not adopted. See `docs/plans/delegate-workflow-skill-evidence.md` for the sanitized outcomes and limitations. The approved temporary auth symlinks were created for that run; auth contents were never read, copied, printed, or logged. The procedure below is retained only for a future separately approved comparison; this record does not authorize a rerun.

### Procedure for a future separately approved run

Start each arm separately, using the same model, provider, thinking level, limits, and initial task:

```sh
(
  cd <SCRATCH_ROOT>/goals/a
  PI_CODING_AGENT_DIR=<SCRATCH_ROOT>/agents/a \
  ME_PI_DELEGATE_CONFIG=<SCRATCH_ROOT>/agents/a/delegate.json \
  PI_CODING_AGENT_SESSION_DIR=<SCRATCH_ROOT>/sessions/a \
  pi --model <SAME_PROVIDER_AND_MODEL> --thinking <SAME_LEVEL>
)
```

Repeat with `b` for every A path. The empty pool files make delegate workers use the selected main-session model; record the exact resolved model/provider/thinking and available usage/context metrics in both arms. Start with the same neutral request: `Implement the goal in SPEC.md by completing the tickets in dependency order.` Do not remind either arm to load a skill, recover WIP, start the next ticket, review the goal, or stop after one fix. Confirm from the transcript that B actually loads `implement-goal` before its first job.

For each arm, keep the transcript and record: skill load timing; every job start and order; each ✓/✗/WIP and check result; oracle-gate timing; recovery before T2; immediate next-ready-job continuation; goal-review count and fix count; any nudges; model/provider/thinking; elapsed time; and available token, context, and usage metrics. The only operator action between T1's failing handback and recovery is enabling that arm's oracle with the command above; provide no workflow reminder. If T1 does not produce a non-cancel WIP/failed handback, the oracle is manipulated, T2 starts before T1 recovery, B misses the known spec gap, or either arm is nudged, mark the pair inconclusive. T2's first pass intentionally omits `mean([]) === null`; keep `SPEC.md` available to the main session and reviewer. The goal review must find the gap and cause at most one fix job. A reviewer miss is inconclusive, not a pass.

Do not configure real remotes, push, close tracker items, or claim remote behavior was tested. The offline package-discovery result is not lifecycle evidence. Run two pairs if available; otherwise report `n=1`. A successful pair is evidence, not proof of reliability. Keep `docs/plans/delegate-workflow-skill-evidence.md` sanitized and separate harness validation from lifecycle results. The attempted T2 pair was inconclusive; no further live run is part of this task. `BLOCKED: Adoption and any rerun require explicit user resolution.`
