# Watch: background-work status in the main session (design proposal)

**Recommendation.** Add one small private extension, `extensions/watch.ts` (about 180 lines plus tests). It watches a process the launcher started and needs nothing new beyond two things the launcher already has or can add in one line: a **pid** and an **exit file**. The model registers a watch once with a `watch` tool call (`label`, `pid`, optionally `progress` file, `total` and `exitFile`). From then on a timer in the extension, which costs no tokens, updates **one footer status** (`ctx.ui.setStatus`; Pi's footer already truncates it to the terminal width). It decides "alive" from the process table, not from how fresh a file is: the pid has to exist *and* keep the start time it had when the watch began, so a reboot or a reused pid reads as dead. When the work finishes or dies, the extension wakes the model **exactly once** with one custom message. The watch is stored as a session entry, so it survives `/reload` and resume. The extension never runs a model-chosen command.

## Why not a convention alone

| Option | What it cannot do |
| --- | --- |
| Launcher prompts the main pane per item (`herdr agent prompt`) | Each prompt costs a model turn. It says nothing during a silent hour-long attempt. A launcher that died (sleep, panic, reboot) sends nothing, so silence looks the same as progress. |
| herdr pane metadata (`herdr pane report-metadata --title`) | It shows in herdr's pane chrome, not in the main session (how herdr draws it: not verified). It is written by the launcher, so when the launcher dies the title freezes at its last value. That is the silent-stale failure from today. |
| A status file the launcher rewrites | Something still has to read it and notice it stopped changing. "Stopped changing" cannot tell an hour-long attempt from a dead sweep. |
| The user glances at the other pane | That means leaving the main session, which is what the user wants to avoid. |

The one thing no convention gives is an independent check that the process is still alive. That check is the core of the extension; everything else stays minimal.

Also rejected:
- **A model-set shell command run on a timer.** It makes a model turn into a recurring, unattended exec that the guard never sees (the guard checks only the `bash` tool). Not needed for the cases at hand.
- **A below-editor widget like `steps`.** It needs its own component, its own width handling and a render timer. That is the class of code that crashed the TUI with a too-wide line. The footer status already gets truncated by Pi's footer (`dist/modes/interactive/components/footer.js:253-260`) and by this repo's `minimal-footer.ts`.
- **Folding it into `steps` or delegate's activity widget.** `steps` is model-driven and hides when the model is idle, which is the opposite lifecycle. Delegate's widget tracks child processes it owns, while watch tracks processes it does not own. Sharing code would couple them for about 10 lines of overlap.
- **Watching a herdr pane's `agent_status`.** It would fit "another agent in a pane" and is a natural second source (see open questions). v1 keeps to pid and files so it has no herdr dependency.

## What it observes, and who chooses it

The **launcher's author** (usually the model, writing the launch command) chooses what is observed. The **model** registers it with the `watch` tool. The user can list and drop watches with `/watch`.

- `pid` (required): the process whose life defines the work. When it is registered, the extension records the process's start time (`ps -o lstart= -p <pid>`, run with `execFile`, fixed argv, no shell). It refuses the watch if the pid does not exist.
- `progress` (optional): a file that gains one line per finished item, such as the sweep's `<record>.jsonl`. The extension counts newlines incrementally from a stored byte offset (it recounts if the file shrinks) and reads its mtime. It never reads content into the model's context.
- `total` (optional): the item count, for `7/24`.
- `exitFile` (optional): where the launcher writes `$?`. This is the only way to get the exit code of a process that is not our child.

Launcher shape for the sweep. The pid to watch is the wrapper shell, so the exit file always exists before that pid disappears:

```sh
sh -c 'echo $$ > run/pid; node evals/ab.ts … --resume run/record.jsonl > run/log 2>&1; echo $? > run/exit'
```

## States and behaviour

The extension checks every 30 s, at once on `session_start`, and right after the `watch` call. Each check produces one of these states:

| State | Rule | Footer (one status per watch) | Wakes the model |
| --- | --- | --- | --- |
| running | pid present with the recorded start time | `⏵ sweep 7/24 · last +1 23m ago · 2h41m` | no |
| quiet | running, and the progress file is older than `quietAfter` (optional) | same line in warning colour, `quiet 1h12m` | no (a long silent attempt is legitimate) |
| finished | pid gone (or its start time changed) and `exitFile` holds an integer | `✓ sweep exit 0 · 24/24 · 3h02m` (error colour when the exit code is not 0) | once |
| died | pid gone, and there is no `exitFile`, or it is missing or unparsable | `✗ sweep died, no exit status · 7/24 · last +1 14:02` | once |
| unknown | `ps` failed or timed out (2 s) | `? sweep unchecked 3m (<error>)` | no |

The cases from the brief:
- **Finish.** The wrapper writes `run/exit`, then exits. The next check reads `finished`, and the model is woken with `[watch] sweep finished: exit 0, 24/24 items, 3h02m. progress: run/record.jsonl`.
- **Death mid-run** (SIGKILL of the wrapper, pane closed). The pid is gone and there is no exit file, so the state is `died`. Without `exitFile` every end reads as `died, no exit status`. That is true, and it is shown that way on purpose.
- **Reboot.** The pid is gone, or it was reused by an unrelated process with a different start time. Either way the state is `died` on the first check after Pi starts again.
- **Sleep.** Pi's timer sleeps too. The first check after wake reports the truth: still running, or died while asleep (for example, network failures). The footer also turns `unknown`/stale by itself if no check has succeeded within 90 s, so a stalled checker cannot keep showing an old `running` line. A blocked event loop also stops footer renders. That is acceptable, because the next render shows the gap.
- **Stale progress.** "Last item 1h ago" is shown, never judged as death. Only the process table decides death.

"How long the current item has run" is shown as *time since the last progress line* (`last +1 23m ago`). For a serial sweep that is exactly the current item's age. For `ab.ts` with parallel workers it is the time since any attempt last finished. I chose that label so it never claims more than it knows.

## Waking the model, once

- Each watch moves to a terminal state at most once. The extension first appends a `watch` session entry with `{ state, notified: true }`, then calls `pi.sendMessage({ customType: "watch", content, display: true }, { triggerTurn: true, deliverAs: "followUp" })`. While idle this starts a turn; while streaming it queues after the current turn (`docs/extensions.md:1642-1649`).
- **Two sessions watching the same work.** Before sending, the extension creates a claim file, `<agent dir>/watch/<pid>-<starttime>.notified`, with the `wx` flag. Only the session that creates it wakes its model. The others show the final status line and record `notified` without a turn.
- **Resume or startup after the end.** If the work ended while no Pi was watching, the status line shows the end at once. The message goes out with `deliverAs: "nextTurn"`, so the model learns it on the user's next prompt instead of starting a surprise turn on resume. (The claim file still applies.)
- Running states never wake the model. There is no per-item wake.

## Lifecycle

- **`session_start`** (any reason, `ctx.mode === "tui"` only, so delegate workers and print/JSON runs get no tool and no timer): restore watches from the latest `watch` entries on `ctx.sessionManager.getBranch()`, start one `setInterval` (`unref`), and check now.
- **`session_shutdown`** (fires on `/reload` and exit): clear the interval and clear the statuses. Module state is not trusted across `/reload`; it is rebuilt from entries.
- **`/fork`, `/tree`** (`session_tree`): restore from the new branch, as `steps` does.
- A finished or dead watch stays in the footer until it is dropped, or until the next user prompt after it has been notified, whichever comes first. Exact rule: open question 3.
- Pi gone entirely means nothing watches. The next session started on the same session file catches up on its first check.

## Interface

Tool (TUI only):

```ts
watch({
  label: string,          // ≤ 24 chars after control chars and newlines are stripped
  pid?: number,           // required to add; omit with drop
  progress?: string,      // path, resolved against cwd
  total?: number,
  exitFile?: string,
  quietAfter?: number,    // minutes
  drop?: boolean,         // remove the watch with this label
})
// → "watching sweep (pid 4242, started 14:05)" or an error; adding a label that exists replaces it.
```

Prompt guideline (one line): "After starting long background work, call `watch` once with its pid, and its progress and exit files when it has them. Do not poll it; you will get a message when it ends."

Command: `/watch` lists the watches and their states; `/watch drop <label>` removes one. No settings file. There is no on/off switch: no watch means no footer and no timer.

## Width and robustness

- Output goes only through `ctx.ui.setStatus`. No custom component means no `render(width)` that could overflow. The label is sanitised and capped, and the status text has no newlines. Pi's footer truncates; so does `minimal-footer.ts` (`truncateToWidth`).
- Every check is async (`execFile` with a timeout, `fs.promises`), runs inside one try/catch per watch, and skips a run while the previous one is still pending. A failed check makes that watch `unknown`. It never throws into Pi's timer and never touches other watches.
- At most 8 watches. Beyond that the tool returns an error.

## Placement and relations

- `extensions/watch.ts` in the private root package, listed in `package.json` `pi.extensions`, with one row in `README.md` `## Extensions`, like `steps` and `minimal-footer`. It may move to `packages/pi-workers/` later if it proves useful outside this rig. Nothing in it is worker-specific.
- Independent of `steps` (model checklist) and of delegate's `delegate-activity` widget (its own child jobs). Delegate jobs need no watch: delegate already reports them.

## Security

- **Reads.** `progress` and `exitFile` are paths the model chose. The extension reads only their size, mtime and newline count, plus one integer from `exitFile`. File content never enters a model message. All the message contains is the label, the counts, the exit code and the paths the model itself supplied. Even so, the tool should refuse paths that the repo's secret-path rule flags (`secretPathIn` in `packages/pi-workers/extensions/delegate-fence.ts`). I have not checked that its `(toolName, input, cwd)` signature fits a non-file tool; it may need a small path-level export.
- **Runs.** Only `ps -o lstart= -p <int>`, through `execFile`, with an integer pid and no shell. The pid is only read, never signalled: `/watch drop` does not kill anything.
- **Writes.** Session entries, and claim files under `<agent dir>/watch/`.
- **Guard.** Not involved. The guard checks `bash` tool calls, and the extension executes nothing the model wrote. The launcher itself is started through `bash`, or through herdr from `bash`, so the guard already sees it.

## Tests (`test/watch.test.ts`, node:test)

- A pure `assess(watch, observation, now) → state` function covers every row of the state table: running, quiet, finished (exit 0 and non-zero), died (no exit file, unparsable exit file), pid reused (same pid, different start time), unknown (ps error or timeout), and a check older than 90 s.
- Extension tests with a fake Pi, as in `test/steps.test.ts`, inside a `mkdtemp` fixture with `HOME`, `TMPDIR` and `PI_CODING_AGENT_DIR` pointed there:
  - A real `sh -c 'sleep …; echo 0 > exit'` child, through the paths finished, killed (died) and running with a growing progress file.
  - Exactly one `sendMessage` per terminal state, and none after `/reload` or restore from entries that are already notified.
  - Two extension instances on one pid: one wake, through the claim file.
  - On resume after the end, `deliverAs: "nextTurn"` and no triggered turn.
  - `session_shutdown` clears the interval (no open handles).
  - No tool and no timer outside `tui` mode.
  - A label with newlines and ANSI codes is sanitised.
- `mock.timers` drives the interval. `ps` is injectable, for the unknown and pid-reuse cases.

## Size

About 180 lines in `extensions/watch.ts`, about 250 lines of tests, one README row and one `package.json` line. Optionally, about 10 lines in `delegate-fence.ts` for a path-level secret check.

## Not verified

- How `sendMessage` with `deliverAs: "nextTurn"` renders a `display: true` message before the next prompt. I read the docs summary, not the code.
- Whether `setStatus` triggers a footer re-render without other activity. Likely, but not checked.
- `ps -o lstart=` format stability. It is compared only for equality, within one boot, so the format only has to stay the same within a boot.
- How herdr displays `report-metadata`.
- What the agent in `w3:pCT` would want. I did not ask it: no design decision depended on its answer.

## Open questions for the user

1. **Exit file vs the launcher's `herdr agent prompt`.** With both, the model is woken twice when the work ends. I propose that launchers write `exit` and drop the prompt when they are watched. Or should the extension stay silent on `finished` and wake only on `died`, leaving the normal end to the launcher's prompt?
2. **A herdr pane as a second source** (`pane: "w3:pCT"`, done when `agent_status` leaves `working`), for watching other agents. Should it be in v1, or added when needed?
3. **When an ended watch leaves the footer:** on the next user prompt after notification, or only on `/watch drop`?
4. **Resume behaviour:** is "show it now, tell the model on the next prompt" right, or should a resume wake the model at once?
