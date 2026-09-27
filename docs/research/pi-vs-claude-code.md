# `pi-vs-claude-code`: useful `just` pattern

Reviewed upstream commit [`0ed11f4`](https://github.com/disler/pi-vs-claude-code/tree/0ed11f44932fdef29bd98467700019762298f50d).

## What `just` does there

`just` is a discoverable launch menu. Its default recipe lists commands. Recipes such as `pi`, `ext-minimal`, and `ext-damage-control` start Pi with named extension combinations. `open` accepts an arbitrary stack. These are new process launches, not persistent settings changes. ([justfile](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/justfile#L1-L4), [extension recipes](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/justfile#L19-L70), [open recipe](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/justfile#L93-L103))

The repo also has `primepi` and `primecc` recipes to start Pi or Claude Code. `primecc` uses `--dangerously-skip-permissions`, which we should not copy. ([justfile](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/justfile#L9-L14))

## What fits me-pi

- Reuse the named-recipe idea for a few stable startup profiles. `just` makes them easy to list, remember, and review.
- Keep recipes as launchers. Do not mutate live settings or choose models and thinking levels, which remain user-controlled.
- Keep the main session as coordinator. Do not use persona switching to replace it with an implementer or reviewer.

Important integration check: `me-pi/install.sh` symlinks the whole `extensions/` directory into `~/.pi/agent/extensions/` (`install.sh:69`). A recipe that only adds `pi -e ...` may not isolate that extension from globally discovered extensions. Verify the intended extension set before calling recipes separate flavors. Local `pi --help` says `--no-extensions` disables discovery while explicit `-e` paths still load; verify that the subagent extension remains available before adopting this pattern.

Do not copy the upstream `dotenv-load` setting. Its README says it loads `.env` for every recipe, unlike this rig's machine-local credential setup. ([justfile](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/justfile#L1), [README](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/README.md#L62-L63))

## Agent-team fit

`agent-team.ts` is a dispatcher-only orchestrator. It removes normal tools, changes the main prompt to require `dispatch_agent`, and makes every request delegate ([system prompt and tool restriction](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/extensions/agent-team.ts#L631-L699)). It spawns child `pi` processes, reuses per-agent session files, inherits the parent model, and sets thinking to `off` ([dispatch implementation](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/extensions/agent-team.ts#L301-L435)). Team membership comes from [`teams.yaml`](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/.pi/agents/teams.yaml).

That conflicts with me-pi's small-work-inline coordinator and duplicates `pi-subagents`, role prompts, and model assignments. The named teams and progress grid are interesting ([team config](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/.pi/agents/teams.yaml), [dashboard](https://github.com/disler/pi-vs-claude-code/blob/0ed11f44932fdef29bd98467700019762298f50d/extensions/agent-team.ts#L1-L18)), but the current sequential ticket flow does not need another orchestrator. Do not adopt the extension as-is.

## Recommendation

Adopt `just` as an optional launch menu, not a workflow orchestrator. First choose the flavor axis: extension stack, harness, or startup behavior. Start with only the profiles that represent real recurring differences. No need to copy the repo's large extension catalog or agent architecture.
