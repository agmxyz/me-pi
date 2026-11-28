## 1. Core model and crash recovery

- **Conversations** are transcripts; **documents** are typed JSON state; **tasks** are checkpointed state machines owned by a conversation or another task. Entries, document changes, and task creation can commit atomically. `README.md:92–104`
- The host chooses storage and its path: SQLite is one database file; JSONL, IndexedDB, memory, and Cloudflare SQLite are alternatives. For a long-lived agent the README recommends SQLite over JSONL. `README.md:115–127,1020–1028`
- Reopening and calling `harness.resume()` resumes pending work from checkpoints, **not an interrupted model stream in place**: an interrupted model request counts as a failed attempt and is retried under retry policy. A tool interrupted mid-call reruns only if declared `replay: "safe"`; otherwise it returns an interrupted error. External effects still need their own idempotency keys. `README.md:124–127,263–265,333–336,384–387`
- SQLite WAL with `synchronous = NORMAL` survives process crashes, but newest commits may be lost on power or host failure. Deferred streamed progress can also lose roughly its persistence window on crash. `README.md:628,1025–1027`

## 2. Process model

- **Library, not a packaged daemon or CLI.** The host opens storage, calls `Harness.open(...)`, gets `harness.root(...)`, and calls `resume()`. The package exports the root, environment, tools, storage and other subpaths; `package.json` declares no `bin`. `README.md:115–127`; `package.json:6–130`
- A host can run without a terminal multiplexer, but must supply process lifecycle and restart supervision.

## 3. Multi-agent orchestration

- A custom subagent tool can create a task-owned conversation using `tx.createConversation`, configure it, `submit` work, and wait for the answer. Background anchor and reporter tasks support persistent children and report-back; the README describes these as example product code, not a ready-made chief. `README.md:882–927`
- `tx.createTask`, waiting policies `allSettled` / `failFast` / `any`, `runtime.outcomes`, and `waitForTask()` provide task coordination. Durable sleeps, signals, `harness.signal`, `harness.wake()` / `onWake`, and `SubmissionSettled` notifications support wakeups. `README.md:140–166,214–260,429,929–954`; `CHANGELOG.md:35–43`
- A separate mailbox or recurring-schedule API was **not verified**; queued submissions and explicit tasks/timers are the documented primitives.

## 4. Tools and environments

- Ships `read`, `bash`, `edit`, `write` and `CodingTools`. Per-conversation `cwd` and a host-supplied `env` factory using `NodeExecutionEnv` can bind a coordinator to a worktree. Child conversations inherit agent configuration initially. `README.md:294–296,481–503,531–541,895–905`
- Its own extension registry has `ToolTask` `beforeTool` / `afterTool` hooks, including blocking and rewriting. These are **not established as Pi coding-agent extension hooks**. `README.md:273–292,760–785`
- Automatic loading of Pi extensions, skills, `AGENTS.md`, or the coding-agent TUI was **not verified**; plan on a separate runtime and integration work, not session compatibility.

## 5. Human interaction

- The host can `submit`, wait, and watch conversation views; no packaged user-facing TUI or web server is evidenced by the package exports. `README.md:578–628,630–671`; `package.json:6–130`
- Human approval can be built with a `beforeTool` gate that sleeps on a typed signal and resumes upon a decision or timeout. The host must provide the approval interface. `README.md:783–810`

## 6. Single owner

- **Not enforced:** one process must write a storage at a time; the README explicitly says there is **no cross-process locking**. SQLite file locking makes a read-only viewer safe beside a writer, not a chief lease. Build an external per-repo ownership lock/lease and recovery policy. `README.md:127,1051`

## 7. Stability

- Explicitly experimental: API may change without notice. Both `1.6.1` and `1.6.0` list breaking changes; `1.6.0` also warns about older harnesses opening newer task data. Pin versions and plan migrations. `README.md:3`; `CHANGELOG.md:3–12,20–29`
- Stated non-goals were **not verified**.

**Verdict:** Yes—as a persistence and orchestration foundation, without tmux. The chief still needs a supervised host, per-repo exclusive ownership, user interface/API, repository-awareness policy, worktree lifecycle and coordinator/reporting glue, security guards, and any desired Pi-session compatibility. **Unverified:** runtime behavior and tests were not executed; findings are based on the inspected package documentation.