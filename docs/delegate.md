# Use and recover delegate workers

The `delegate` tool starts child `pi --mode json -p` workers. A worker sees the task you pass, not the main conversation, so include the relevant paths, context, and acceptance criteria. Ask Pi in ordinary language, for example: “Have a scout trace how this retry path works and return path-and-line evidence.” Read-only workers cannot run shell commands; the coordinating session must supply any needed command output or diff as a file path.

## Roles and tools

- `general` is the default for read-only local investigation. `scout` is a short local lookup with path-and-line evidence. `review` returns severity-ranked findings for the supplied material.
- `research` gathers web sources; `challenge` stress-tests a premise. Both enable web tools by default. They require `pi-web-access`, installed separately (the optional full setup installs the unpinned npm package; to install that extension alone, run `pi install npm:pi-web-access`). Other roles can request web tools with `web: true`; `implement` cannot.
- `implement` is the only role that edits the checkout. Its `edit`/`write` paths are restricted to the real checkout, excluding the Git common directory; it runs the required `check` command and commits there. It requires a clean Git tree on a branch other than `main` or `master`; worker checks block ordinary `gh` and Git push commands. Give it one unchained `check` command; the worker runs it alone, exactly as given, after its final edit. When a skill applies, the coordinator retains its required user decisions and orchestration through completion, including any independent review the skill requires. Workers cannot delegate; a handback completes only the assigned step. Use `background: true` for longer work, then wait for its handback before editing or running Git write commands in that repository.

The package's `Skill` extension adds the `Skill` tool for skills Pi already discovered; it does not supply skills. Filtering the package to `extensions/delegate.ts` does not activate the separate `Skill` extension or the main-session `guard` extension. The delegate implementation still imports sibling helper modules from the package. Install the package, not a copied `delegate.ts` file.

All roles except `implement` are read-only by default. Set `output: true` for a draft: it adds only the `write` tool, restricted to that non-implement worker's fresh private directory under the OS temp directory; the result reports its path. It does not grant `edit`, Bash, or writes to other temporary paths. The main session must review and copy any draft it wants to keep.

## Choose and close work

First honor explicit user-required delegation and any delegation or independent review required by the repo or an applicable skill. Otherwise, delegate bounded, independently checkable work when context savings, parallelism, or independent judgment justify briefing and verification costs; keep coupled decisions with the coordinator. Give each worker a compact, self-contained brief covering scope, deliverable, relevant context and constraints, acceptance evidence, and how to report blockers.

A multi-model panel (`runs`) repeats the same task for each model; decompose work into separate calls with separate briefs. Treat partial answers as incomplete. Explicitly accept, reject, or recover each handback; verify decisive claims proportionately, inspecting implementation diffs and check adequacy without routinely repeating worker work. Failed checks, timeouts, and WIP commits stay incomplete until recovery. Live UI acceptance requires actual observable evidence from the running interface; static inspection alone does not establish it.

## Configure model pools

Optional model pools live at `~/.pi/agent/delegate.json`. Without a file, workers use the main session's model and thinking level; `scout` thinking is capped at `low` (or remains `off`). For model IDs, use IDs available to your Pi installation.

```json
{
  "version": 3,
  "scout": {
    "models": [{ "model": "provider/scout-model", "thinking": "low" }]
  },
  "worker": {
    "models": [{ "model": "provider/worker-model", "thinking": "medium" }]
  }
}
```

Replace the example IDs with your provider/model IDs. Pools are role defaults, not allowlists. When the model is omitted, each pool's `models` array is tried in order when a configured candidate is unavailable; each entry needs a `thinking` value. Scout entries accept `low` or `off`; worker entries accept `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Optional pool-level `thinking` sets the level for models without a per-model entry; if omitted, the session level is used.

For a one-off choice, the coordinator can set either or both fields in a run, for example `runs: [{ model: "provider/model", thinking: "high" }]`. An omitted model keeps the role's configured model selection; an omitted thinking level keeps the configured per-model default, then the pool-level default, then the session level. Any explicitly named model runs alone and never falls back to another model, even if it is listed in the role's pool. An explicit thinking level applies to each default-pool fallback candidate when model is omitted. An unlisted model must be an exact Pi catalog ID in `provider/model` form: Pi's model registry must report it as available with usable authentication. Human-friendly names are not resolved by the tool; the coordinator must provide the exact ID. Scouts remain capped at `low`, or `off` when requested. One-off choices never modify `delegate.json`.

Edit the JSON yourself, then `/reload` to reload the extension. Use `/delegate models` to see the config path and `/delegate status` to see pool availability and missing tools.

## Run and stop work

For a long task, ask Pi to use `background: true`. It returns a `bg<n>` job ID; `/delegate status` shows running IDs and recent calls, and `/delegate cancel <id>` requests cancellation. For calls with worker entries, status also shows the stage and active workers' short model name, thinking level, elapsed time, and (for multi-worker calls) worker index; it includes the latest sanitized tool name when available. It never includes task text, tool arguments, or results. At most four workers can run at once across calls. `/reload`, session replacement, or Pi exit ends background jobs; wait for them before reloading when possible. In the TUI, a compact panel above the prompt shows active foreground and background workers with compact foreground `fg<n>` or background `bg<n>` IDs, role, current model and thinking level, elapsed seconds, and latest sanitized tool name. It updates as tools start and once per second for elapsed time, and hides when idle. The panel never includes task text, tool arguments or results, stderr, or reasoning. Ctrl+O still expands live delegate tool progress to show up to eight recent sanitized tool labels per worker; the collapsed view stays compact.

A `research` task needs the separately installed web extension; installing me-pi alone does not provide web tools. Web-enabled workers can read project files as well as fetched pages, so enable web only when outside sources are needed and treat fetched content as untrusted data.

## Safety and recovery

This is not a sandbox: Pi extensions and `implement`'s Bash run with Pi's operating-system permissions. Read-only workers can read project files; web-enabled ones combine local reads with network access. `guard` asks before matching risky Bash commands (or blocks them when there is no UI), but it is a pattern matcher, not a parser. `implement` worker-side checks block selected commands and disable Git remote protocols, but they do not isolate the process; some environment or Git options can bypass those checks. Use a clean feature branch, keep the main session out of the checkout until handback, and review the result.

Workers have hard time limits of 5 minutes for `scout`, 15 minutes for other read-only roles, and 30 minutes for `implement`; each run has a nominal $5 cost cap. Pi-reported cost is an estimate; it may be absent or overshoot and is not billing authorization. Tool calls are blocked at 80% of the time or cost limit (for `implement`, 24 minutes and $4) to prompt a final answer. `scout` alone is capped at 30 tool calls; all other roles have no attempt-count gate and remain subject to the time and cost gates. A worker that ignores three such blocks is terminated on the next blocked call. These limits do not make execution safe.

Cancellation is not rollback. If an `implement` run stops with uncommitted non-ignored changes, the extension may save them in a `WIP(delegate …)` commit on the job branch. A moved branch can prevent that save. Check the handback's branch, commit range, `check` status, and any `Details:` path; inspect the checkout before continuing. A follow-up `implement` recognizes a WIP commit from an earlier attempt and is asked to finish it first.

Implement jobs also capture bounded, event-derived details for every failed tool call, including targeted tests and non-Bash tools; successful calls and read-only roles are excluded. The private JSON artifact is `<TMPDIR>/me-pi-delegate-<parentPid>/<imN>-failed-tools.json`, linked from the details file and from failed handbacks. It is not a worker transcript: effective commands and numeric exit codes appear only when supplied by Pi, and `full_output_path` values are references only—the referenced files are never opened or copied. Explicit-pattern redaction is best-effort (`not guaranteed complete`), so treat the artifact as sensitive and do not share it publicly. If writing it fails, the details and handback show a warning; capture does not change the `check` result or gate, and a successful handback keeps its two-line shape.

A `Tripwire` reports that watched shared state changed; it does not restore anything. Stop and inspect the handback and details file before proceeding. Tripwires cover pre-existing Git refs other than the job branch, local Git config other than upstream-tracking entries, files under Git `hooks/` and `info/`, and Pi package, extension, skill, prompt, and theme settings. Treat a failed check, WIP, or tripwire as incomplete work; do not assume the worker rolled back changes.
