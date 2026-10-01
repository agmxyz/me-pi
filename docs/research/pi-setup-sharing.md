# Pi setup sharing: ownership and installation

## Summary

The earlier recommendation to keep the whole-directory symlinks was wrong for this project. They let outside installers write into the repo, and `install.sh` could also copy machine files into it. The target should separate repository-owned sources from machine-owned install directories: register the repo's custom extensions as a Pi local package; keep live extension, agent, and shared-skill directories machine-owned; link only repo-owned agent and skill entries; let Pi and RTK manage their own packages/extensions.

## Findings

1. **User vs project scope.** Pi's user config lives under `~/.pi/agent`; `.pi/` is for project-specific resources gated by project trust. me-pi is a personal setup, so it belongs at user scope. Project trust is not a sandbox: extensions run with Pi's OS permissions. Use project resources only when behavior should travel with that project. [Configuration](https://pi.dev/docs/latest/configuration#project-pi-directory) · [Settings: resources](https://pi.dev/docs/latest/settings#resources) · [Security](https://pi.dev/docs/latest/security#understand-project-trust)

2. **Local code vs Pi packages.** Pi packages can be installed from npm, Git, or a local path. A local package loads from its resolved path without copying. Use an explicit `pi.extensions` manifest so only `me-setup.ts` loads; tests and package metadata are not extensions. Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`; declare them as peer dependencies, not bundled runtime dependencies. `npm ci --prefix extensions` is for local tests, not Pi package installation. [Packages](https://pi.dev/docs/latest/packages) · [Extensions](https://pi.dev/docs/latest/extensions)

3. **External extension ownership.** The old `~/.pi/agent/extensions -> repo/extensions` symlink made the repo an install target. RTK's `rtk init --global --agent pi` writes `rtk.ts` in the live extension directory and may overwrite a modified file only with approval. With a real user extension directory, RTK owns that file outside the repo. `interactive-shell.ts` is a copy of Pi's bundled example, not a standalone Pi package; keep the feature by copying the example to the live directory if missing, not by tracking its implementation here. [RTK README](https://github.com/rtk-ai/rtk#installation) · [RTK changelog](https://github.com/rtk-ai/rtk/blob/main/CHANGELOG.md) · [Pi example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)

4. **Agent runtime and model assignment.** Repo role files are linked individually into `~/.pi/agent/agents/`. `/me-setup` persists per-role choices in `settings.json` under `subagents.agentOverrides`; `bin/delegate` consumes those overrides, then falls back to role frontmatter and pi defaults. `pi-web-access` remains a separately managed package recorded in live settings. [Packages](https://pi.dev/docs/latest/packages)

5. **Shared skills.** Pi and Codex both discover `~/.agents/skills`. Keep me-pi-owned skills in the repo and link them individually; Matt Pocock skills installed by the global skills installer stay external and are not vendored here. A whole-directory symlink makes installer writes land in the repo, so keep the live directory real. Preserve name collisions for manual resolution. [Skills](https://pi.dev/docs/latest/skills) · [`npx skills`](https://github.com/vercel-labs/skills)

6. **Settings and secrets.** Keep `settings.json` as a seed copied only when absent; `pi install` manages package entries in the live file. Keep auth and endpoint credentials machine-local. `models.json` can contain literal API keys, so ignore it in Git and prefer environment/command-backed keys. [Models](https://pi.dev/docs/latest/models)

## Installer target

- `extensions/` is a Pi local package exposing only project-maintained extensions.
- `~/.pi/agent/extensions/` is not symlinked to the repo; RTK owns `rtk.ts`, and Pi's interactive-shell example is copied there if missing.
- `~/.pi/agent/agents/` and `~/.agents/skills/` are machine-owned directories; repo-owned agents/skills are linked per entry, while globally installed Matt Pocock skills remain external copies.
- `pi install` registers the local package and the pinned `pi-web-access` package.
- Never copy live directory entries into the repo. On migration, unlink only verified links into this repo; untracked files inside tracked skills are backed up to `~/.agents/.me-pi-migration/` (never copied into live skills, which would block per-skill links); preserve other live directories and report name collisions. Refuse a symlinked settings file and package-store links into the repo so `pi install` cannot write there.

## Limits

The three inspected public personal configs demonstrate copy, symlink, and clone-in-place options; this small sample cannot establish prevalence. The repository tracks only me-pi-owned skills; any externally managed skill with a colliding name needs manual ownership resolution. Review globally loaded extensions as executable trusted code.

## Sources

- Official Pi: [Configuration](https://pi.dev/docs/latest/configuration), [Settings](https://pi.dev/docs/latest/settings), [Extensions](https://pi.dev/docs/latest/extensions), [Packages](https://pi.dev/docs/latest/packages), [Skills](https://pi.dev/docs/latest/skills), [Security](https://pi.dev/docs/latest/security), [Models](https://pi.dev/docs/latest/models).
- RTK: [README](https://github.com/rtk-ai/rtk#installation), [CHANGELOG](https://github.com/rtk-ai/rtk/blob/main/CHANGELOG.md).
- Personal config examples examined earlier: [agent-stuff](https://github.com/theskumar/agent-stuff), [dotpi](https://github.com/arjun-zosma/dotpi), [pi-config](https://github.com/HazAT/pi-config). Their varied approaches are examples, not prevalence evidence.
