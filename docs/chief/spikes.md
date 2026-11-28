# Spikes

## 2026-11-27: print-mode session behaviour (Pi 1.6.1)

Script and outputs: [sources/spike-2026-11-27/](sources/spike-2026-11-27/). Three checks, each run once, in a scratch git repo, with `ME_PI_UNATTENDED=1`.

1. **Session reuse works.** `pi -p --mode json --session-id <id>` created the session (with a warning on stderr), a second run with the same id recalled a word from the first, and `pi -p --session <id>` opened it too. All exited 0. Opening it in the interactive TUI was not tried.
2. **Two concurrent runs on one session id are not refused and damage the session.** Both exited 0 with no error. The session file forked: run A's reply was left on an abandoned branch, and run B saw A's prompt as its own history and ran A's command a second time ([tree](sources/spike-2026-11-27/s2-session-tree.txt)). A later run saw replies "base, A, B", so the damage is silent. The per-task run lock is therefore required, and it must also cover `attach`.
3. **A background delegate result was unavailable after a print-mode run.** The run started a job and exited 0; a later run on the same session saw only the start confirmation and no result. Whether the job was aborted at exit or finished unseen was not determined; its answer was not visible in the later run.

Related: [Architecture](architecture.md), [Open decisions](open-decisions.md).

## 2026-11-27, second set: headless facts the review asked for (Pi 1.6.1)

Script and outputs: [sources/spike2-2026-11-27/](sources/spike2-2026-11-27/). Each check run once, in a scratch repo under `/tmp`, with `ME_PI_UNATTENDED=1`.

1. **Signals give a clear exit status; the JSON stream gives no ending.**
   - SIGTERM mid-command: exit 143, the command's child processes were gone, and the stream simply stopped after the tool started, with no closing event.
   - SIGKILL mid-command: exit 137, and **the command's two child processes were still alive** two seconds later.
   - An invalid `--model`: exit 1, error on stderr, empty stream.
   - A normal run ends its stream with `agent_end` then `agent_settled` (seen in check 3).
2. **A session killed mid-tool cannot be resumed.** The next run on it exited 1: the provider rejected the history because the tool call had no result. So a retry after a lost run needs a fresh session, or a repair of the old one.
3. **Project skills need trust in headless mode.** In the untrusted scratch repo, a project skill under `.agents/skills/` was absent by default and present with `--approve`. In an existing me-pi worktree the repo-only skills (for example `implement-me-pi`) were also absent. A parent directory of the worktree was trusted, but why the skills were absent was not determined at this point.
4. **Foreground `delegate` works in print mode.** A scout ran and its answer came back as the tool result; the run ended normally.
5. **Guard did not run.** A destructive command executed without a block in the unattended headless run. Inspection, rather than a further run, established that guard was not loaded; this did not test whether it enforces its rules in print mode.
6. **Interactive open reached a trust prompt, not the session.** Under a pseudo-terminal, `pi --session <id>` showed "Trust project folder?" for the scratch repo. That the session then opens was not observed; the check must be repeated in a trusted directory.

### What this changes
- The result of a run is: process exit status for signals and invocation errors, plus the last stream event (`agent_settled` and the final stop reason) for everything else. Neither alone is enough.
- Stopping a run must signal its whole process group, and a lost wrapper must not be read as "no writer".
- `FAILED(lost)` and `FAILED(cancelled)` cannot simply retry on the same session.
- `launch` must decide trust explicitly and check that the skills the brief needs are loaded.
- The spike did not test the unattended guard refusal described in decision 5.

## 2026-11-27, third set: attach and skills in a worktree (Pi 1.6.1)

Outputs: [sources/spike3-2026-11-27/](sources/spike3-2026-11-27/). Each check run once, in a scratch repo and a git worktree of it under a trusted parent directory.

1. **Interactive open of a headless session works.** A session created with `pi -p --session-id` in the worktree was opened with `pi --session <id>` under a pseudo-terminal. The earlier prompt was on screen, no trust prompt appeared, and a typed question was answered from the earlier history. The interactive session used the user's default model, not the one a caller might expect, so `launch` should name the model.
2. **Project skills load in a worktree under a trusted parent.** A project skill under `.agents/skills/` was listed in both the main checkout and the worktree, with no `--approve`.
3. **The "missing repo-only skills" of set 2 was an artefact of the question.** A skill with `disable-model-invocation: true` is not in the list the model sees, but `/skill:<name>` in a print-mode prompt loaded it. `implement-me-pi`, `batch-chief` and `pi-live-test` all carry that flag (`me-pi@8f9a81f`). So a contract names such a skill with `/skill:<name>`.
