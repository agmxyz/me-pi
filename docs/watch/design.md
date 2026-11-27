# Watch: background-work status in the managing session (design, v2)

**Recommendation.** Add one small private extension, `extensions/watch.ts`, with an estimated 150 lines of code and 200 lines of tests.

- **Registration.** When the model starts long background work, it calls a `watch` tool once with a label and the pid of the launcher's wrapper shell. It can also give a progress file, an item total, and an exit file.
- **Liveness.** A 30 s timer in the extension checks the process table and costs no tokens. "Alive" means the pid exists *and* has the same start time it had at registration. That makes a reboot or a reused pid read as dead.
- **Display.** Everything shows as one combined footer status, `ctx.ui.setStatus`, which Pi truncates to the terminal width.
- **End.** When the work ends, the extension wakes the model once.
- **Persistence.** Watches are stored as session entries, so they survive `/reload` and resume.
- **What it never does.** It never runs a command the model chose, and it never signals a process.

v1 of this design was reviewed by Fable 5.2 (high). This v2 applies that review's cuts and fixes, plus the results of the feasibility checks at the end.

## Rejected options

| Option | What it cannot do |
| --- | --- |
| Launcher runs `herdr agent prompt` per item | Each prompt costs a turn. There is nothing during an hour-long silent attempt. A dead launcher sends nothing, so silence reads as progress. |
| herdr pane metadata or title written by the launcher | Shows in herdr, not in the session. It freezes at its last value when the launcher dies. |
| A status file the extension reads | Something still has to tie the file to this session and to whoever gets woken. "Stopped changing" cannot tell a long attempt from a dead one. |
| `/watch` run by the user | The user must type a pid and paths that the model already knows. |
| A model-set shell command run on a timer | An unattended recurring exec outside the guard (the guard sees only the `bash` tool). |
| A widget like `steps`, or a merge into `steps` or delegate's activity widget | A custom component is what can overflow the width and crash the TUI. `steps` follows the model's turns. Delegate's widget tracks child processes it owns. |

Cut from v1 after review: a "quiet" state; the claim file for two sessions; the `/watch` command; the secret-path check; persisted byte offsets; the 90 s self-staleness rule (it could not fire, because only the same timer rewrites the line); and `deliverAs: "nextTurn"` on resume (it is held in memory only, so `/reload` before the next prompt would lose it).

## Observed inputs

The model chooses these when it writes the launch command, and registers them with `watch`:

- **`pid`** (required): the wrapper shell, not the job inside it. The wrapper writes the exit file before it exits, so "pid gone and no exit file" can only mean the wrapper was killed, or the machine went down.
- **`progress`** (optional): a file that gains one line per finished item. The extension counts its newlines and reads its mtime. It never puts file content in a message.
- **`stream`** (optional, added for #195): the Pi JSON event stream of a headless run (`pi -p --mode json … > stream.jsonl`). While the watch runs, its footer fragment also shows the run's last tool call. See [Stream](#stream).
- **`total`** (optional): the item count.
- **`exitFile`** (optional): where the wrapper writes `$?`. **The tool refuses an `exitFile` that already exists.** A rerun into the same directory would otherwise read the old file as a clean finish.

Launcher, for example the sweep:

```sh
rm -f run/exit; sh -c 'echo $$ > run/pid; node evals/ab.ts … --resume run/record.jsonl > run/log 2>&1; echo $? > run/exit' &
```

A watched launcher drops its final `herdr agent prompt`, because the extension owns the end signal.

## States

| State | Rule | Footer fragment |
| --- | --- | --- |
| running | pid has its recorded start time | `⏵ sweep 7/24 · last +1 23m · 2h41m`; with a `stream`, `⏵ t181 · bash npm run check 2m ago · 25m` |
| finished | pid gone or start time changed; `exitFile` holds an integer | `✓ sweep exit 0 · 24/24 · 3h02m` (`✗ … exit 1` when non-zero) |
| died | pid gone on **two checks in a row**, and no valid `exitFile` | `✗ sweep died, no exit status · 7/24` |
| unknown | `ps` failed for a reason other than "no such pid", or timed out (2 s); or the progress or stream file can't be read (the end is still detected) | `? sweep unchecked (<reason>)` |

- **"Last +1 23m"** is the age of the progress file's mtime. For a serial sweep this is the age of the current item. With parallel workers it is the time since any item finished, and the label claims no more than that.
- **The second check before "died"** covers the window between the job's exit and the wrapper's `echo $? > exit`. A finish read on the second check still counts as `finished`.
- **Sleep and reboot.** The timer pauses with the machine. The first check after wake or restart reports the truth: still running, finished, or died (the pid is gone, or was reused with a different start time).
- **Stale progress** is shown as an age, and never judged as death.

## Stream

A headless Pi run is silent for tens of minutes; `stream` shows what it is doing without a second process.

- **What is shown.** The last `tool_execution_start` event in the stream: its `toolName` and one short argument, the first of `command`, `path`, `task` or `name` that is a string. Both are stripped of escape sequences and control characters, whitespace is collapsed, and they are capped at 24 and 40 characters (a cut ends in `…`). Then the age: `⏵ t181 · bash npm run check 2m ago · 25m`.
- **Age.** Counted from when this session's check first saw that tool call (by its `toolCallId`), so it is accurate to one 30 s check. The file's mtime cannot date a call: it moves with every `message_update` delta. After `/reload` or resume the age restarts at the first check.
- **Bounded read.** A stream is mostly `message_update` lines, each repeating the whole partial message (lines of up to ~270 KB; one 12.7 MB sample run had 41 tool calls in 23,700 lines, with up to 2.4 MB between two calls). A check reads only the last 1 MiB; the first check after registration or `/reload`, while no call is known yet, reads the last 8 MiB. A tail with no tool call keeps the last call seen. The window's first line (cut by the window), a half-written last line, a line that is not JSON and the marker text quoted inside a message are all skipped. A tool call before the window is not found.
- **No count.** With `stream` and no `progress`, no item count is shown: counting tool calls would mean reading the whole file, or every byte as it grows and the whole file again after `/reload`. Pass a `progress` file for a count.
- **Errors.** A missing stream shows nothing yet. An unreadable one shows the watch as `? t181 unchecked (stream: <reason>)`, like an unreadable progress file, and never keeps the check from seeing the end.
- **Never in a message.** The tool name and argument go to the footer only. They are held in memory, not in the `watch` entries, and never enter the wake message or the tool result. `stream` and `progress` are independent.

## Footer

- One status key, `watch`. Each watch contributes one fragment, joined with `  `; ended watches come first, then running ones.
- At most 3 watches; the tool refuses a fourth.
- Labels are stripped of control characters and newlines and capped at 24 characters. Pi's footer and `minimal-footer.ts` truncate the line to the width (`footer.js:253-260`; `minimal-footer.ts:55-58`).
- No custom component, so no `render(width)` code that could overflow.

## Waking the model

- **End seen while the session is live.** The extension first appends a `watch` entry with `{ state, notified: true }`, then calls `pi.sendMessage({ customType: "watch", content, display: true }, { triggerTurn: true, deliverAs: "followUp" })`. While idle this starts a turn; while streaming it queues after the current turn.
- **End found on `session_start`** (the work ended while no Pi was watching). The extension sends the same message without `triggerTurn`. When idle, that appends the message to the session at once, durably, without a turn (`agent-session.js:1976-1990`). The model reads it on the user's next prompt. This includes a death whose first miss came from the `session_start` check and whose second came from the timer: the work still ended unwatched. *(Added in implementation review: without it, resuming an old session whose launcher was killed started a turn on its own.)*
- A watch reaches an end state once. Running states never wake the model.
- **Two sessions watching one pid** each wake their own model once. That is rare and harmless, so there is no lock.
- Message text: `[watch] sweep finished: exit 0, 24/24 items, 3h02m (progress: run/record.jsonl)`.

## Lifecycle

- **`session_start`**, any reason, `ctx.mode === "tui"` only (no tool and no timer in delegate workers or print/JSON):
  - Rebuild the watches from the latest `watch` entries on `ctx.sessionManager.getBranch()`.
  - Check at once, then every 30 s with an `unref` interval.
  - Skip a tick while the previous one is still pending.
  - Wrap each watch's check in its own try/catch, so a failed check sets that watch to `unknown`.
- **`session_shutdown`** fires on `/reload`, exit, `/new`, `/fork` and resume: clear the interval. In-memory state is never trusted across `session_start`.
- **`/fork`** starts a new instance through `session_start` with reason `"fork"`, which restores from the branch. No `session_tree` handling is needed beyond `steps`-style restore for `/tree`.
- **`/new`** starts with no watches; the work continues unwatched. This is documented.
- **Clearing.** An ended watch leaves the footer on the next user prompt after its message. `watch({ label, drop: true })` removes any watch.

## Interface

```ts
watch({ label: string, pid?: number, progress?: string, stream?: string, total?: number, exitFile?: string, drop?: boolean })
// → "watching sweep (pid 4242, started Thu Nov 26 14:57:15 2026)" | an error
```

Guideline: "After starting long background work, call `watch` once with the wrapper shell's pid and, when it has them, its progress and exit files, and for a headless Pi run (`pi -p --mode json > file`) that file as `stream`. Don't poll it: a message arrives when it ends."

There are no settings and no command. Without a watch there is nothing on screen and no timer.

## Security

- **Runs:** only `ps -o lstart= -p <int>` through `execFile`, with fixed argv, no shell, `LC_ALL=C`, `TZ=UTC` (so a Pi restored under another time zone reads the same start time, not a reused pid), and a 2 s timeout.
- **Reads:** the size, mtime and newline count of `progress`, one integer from `exitFile`, and a bounded tail of `stream`. No content enters a model message: the stream's tool name and argument reach the footer only.
- **Writes:** only session entries.
- **Guard:** not involved. The launcher itself goes through the `bash` tool, which the guard sees.

## Tests

The file is `test/watch.test.ts` (node:test), using a fake Pi as in `test/steps.test.ts`, inside a `mkdtemp` fixture with `HOME`, `TMPDIR` and `PI_CODING_AGENT_DIR` pointed there.

- **Pure state function.** `assess(watch, observation)` covers each state: a non-zero exit, pid reuse, `ps` errors, the first and second missing check, and a finish read on the second check.
- **Real processes.** A real `sh -c 'echo $$ > pid; sleep …; echo 0 > exit'` child, run through finished, killed (died after two checks) and running with a growing progress file.
- **Single wake.**
  - Exactly one `sendMessage` with `triggerTurn` per end.
  - None after a restore from entries already marked notified.
  - An end found on `session_start` sends without `triggerTurn`.
- **Refusals.** An existing `exitFile`, a missing pid, a fourth watch, and non-`tui` mode (which also has no timer).
- **Lifecycle and footer.**
  - `session_shutdown` clears the interval.
  - A label with ANSI codes and newlines is sanitised.
  - The footer orders ended watches first.
- **Timers.** `mock.timers` drives the interval, and `ps` is injectable.

Done when `npm run check --prefix extensions` passes. Add one README row under `## Extensions` and one line in the root `package.json` `pi.extensions`.

## Feasibility checks (2026-11-26, Pi 1.6.0, macOS 27)

| Check | Result |
| --- | --- |
| `ps -o lstart= -p <pid>` on a live pid / a gone pid | Prints the start time, exit 0 / prints nothing, exit 1. The exit code tells "gone" from "error". |
| `ps` locale | **Locale-dependent**: `LC_ALL=de_DE.UTF-8` prints `Mi. 25 Nov. …`. It must run with `LC_ALL=C`. |
| `ps -o etimes` | Not available on macOS; `lstart` is the portable choice. |
| Wrapper `sh -c 'echo $$ > pid; …; echo $? > exit'` | The pid file matches the wrapper. A normal end writes `exit` before the pid is gone. After `kill -9` the pid is gone and there is no `exit`. |
| Live prototype in Pi TUI (tmux, `-e` extension): timer and `setStatus` | The footer line updated every tick with no turn and no other activity. |
| Same prototype: `sendMessage` with `triggerTurn` and `followUp` while idle | The `[watch]` message was shown and a turn started. The model call itself failed for an account reason that has nothing to do with the design. |
| `sendMessage` without `triggerTurn` on `session_start` (`reason: "reload"`) | The message was shown, with no turn. |
| Session persistence | Pi writes the session file only once an assistant message exists (`session-manager.js:802-819`). A watch is created by a tool call, so one always exists. |

**Not verified:**
- `lstart` staying equal across a real sleep and wake. It is expected to, because the process start time is kernel-fixed.
- A real reboot.
- Whether a triggered turn disturbs half-typed editor text.
- Colour codes inside status text.
- A wake queued as `followUp` while a turn streams is dropped if the user aborts that turn: Pi's abort clears the agent's queue (`interactive-mode.js` `restoreQueuedMessagesToEditor`, which puts back only typed prompts), but the entry is already `notified`. Read from code, not reproduced live. The footer still shows the end until the next prompt. Accepted for v1.

## Open questions (decided defaults, change if wrong)

1. Clear an ended watch on the next user prompt (the default), not only on `drop`.
2. A herdr-pane source (`agent_status`) for watching other agents: deferred to after v1.
