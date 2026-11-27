I found **pi-durable**. It is a real, official package, but it is a framework for building durable agent apps, not a durable wrapper around the `pi` CLI or TUI. It does not drive or resume ordinary `pi` sessions.

## 1. What it is
- **`@earendil-works/pi-durable`**: "Durable conversation, task, and document runtime for Pi". It is by Earendil Works (Zechner's team) and lives in the monorepo at `packages/durable`. Licence MIT, latest version 1.6.1 (2026-11-25), first published 2026-09-19, released about daily. https://www.npmjs.com/package/@earendil-works/pi-durable · https://releasejam.com/npm/@earendil-works/pi-durable
- **Maturity**: the README says "**Experimental.** The API changes without notice between releases." It was announced alongside Pi 1.0 on 2026-10-01 and is about 15k lines of source. https://github.com/earendil-works/pi/blob/main/packages/durable/README.md · https://earendil.com/posts/pi-durable/
- **Other things with the name**:
  - `@hatchet-dev/pi-durable` runs it on the Hatchet cloud engine. It pins `~1.5.0` because "a minor release … can change its storage format". https://docs.hatchet.run/cookbooks/pi-durable-coding-agent
  - `earendil-works/pi-durable-cloudflare`, a Durable Object example. https://github.com/earendil-works/pi-durable-cloudflare/
  - The Cloudflare Agents Pi harness. https://developers.cloudflare.com/agents/harnesses/pi/

## 2. Model
- **What is durable**: conversations (immutable entries), model turns, tool calls (each its own task), tasks (checkpointed state machines), documents and queued submissions. Everything is committed before it is shown. (README)
- **Where state lives**: whatever storage you open. Options are `openNodeSqliteStorage(file)`, `openNodeJsonlStorage(dir)`, memory, IndexedDB or Durable Object SQLite. The README recommends SQLite for long-running agents.
- **Start and resume**: `Harness.open(storage, {models, registry, env})`, then `harness.root()` and `harness.resume()`. A `requestId` makes `submit()` exactly-once. `harness.submission(id)` picks a submission up again after a restart.
- **Session to session**: these are conversations inside one Harness, not separate Pi sessions.
  - Create them with `harness.createConversation` or `fork`, and send work with `conversation.submit({…, whenBusy:"steer"})`.
  - A `notify: {taskId,key}` option delivers a `SubmissionSettled` signal back to a waiting task. External input arrives through `harness.signal()`.
  - Example `22-subagent-background.ts` shows persistent subagents (spawn, steer, stop, list) whose answers come back as follow-ups and which survive a restart.
- **Daemon**: no cloud service is needed. However, "One process owns a storage at a time, and other clients attach to that process", so in practice you write your own long-lived host process. *(Inferred.)*
- **How it launches Pi**: it doesn't. It is an in-process library on `pi-ai`. Coding tools come from `@earendil-works/pi-durable/tools` (`CodingTools`), not from `pi --mode rpc` or the coding-agent SDK.

## 3. Attaching a TUI
- There is no `pi` TUI attach. The UI is yours to build from `watch()`, `viewState()` or `watchEvents()` ("the coding agent's familiar events"). A second process can open the storage with `readOnly: true`, but only to view it.
- At v1.0.0 there was a demo durable coding agent with a TUI borrowed from Pi, at `packages/coding-agent/src/experimental/durable`. That path was missing from the current main clone, so its status now is **unverified**. https://earendil.com/posts/pi-durable/

## 4. Limits
- "One process writes a storage at a time; there is no cross-process locking." (README)
- There are no built-in subagents, worktrees or multi-repo orchestration. Each conversation's `cwd` and environment can point at a worktree, but you build that yourself.
- Approvals are something you build: `beforeTool` gates that sleep on a `defineSignal`.
- The API changes without notice. A tool call that is not replay-safe and is interrupted by a crash comes back as an `interrupted` error result.

## 5. Alternatives in Pi itself (local docs v1.6.0, `~/.pi/agent/install/releases/1.6.0/.../docs/`)
- **RPC** (`rpc.md`): `pi --mode rpc` is a long-lived JSONL stdin/stdout child process. It has `prompt`, `steer`, `follow_up`, `abort` and `get_last_assistant_text`, and you wait for the `agent_settled` event. `RpcClient.promptAndWait()` does this from TypeScript. It needs no terminal.
- **SDK** (`sdk.md`): `createAgentSession({sessionManager})` gives an in-process session. `session.prompt()` resolves when the run finishes, and `subscribe()` and `waitForIdle()` are available.
- **JSON and print** (`cli-integration.md`): `pi --mode json` and `pi --print` run once and exit. You get the final text or JSONL events.
- **Session files** (`cli.md`): use `--session <path|id>`, `--session-id <id>`, `--continue`, `--fork`, `--session-dir` and `--no-session`. Any of these can be combined with RPC or print mode, so a crashed child can be relaunched on the same session file. Afterwards a user can open it in the TUI with `pi --session`. The docs I read say nothing about locking when two processes open the same session. *(Not checked.)*

**Verdict: partially fits.**
- It covers crash survival, a chief that delegates and gets reports back, and independence from any terminal multiplexer (tmux or herdr), all inside one owning host process.
- But it replaces the Pi CLI and TUI instead of managing Pi sessions. Coordinators would be pi-durable conversations, not Pi sessions you can attach a TUI to, and there is no cross-process locking. For a chief that keeps real Pi sessions, use `pi --mode rpc` or the SDK with `--session-id` and your own state.

Not verified: the npm download and dependent counts come from search snippets. I did not read the source of example 22 or confirm whether the durable coding-agent demo still exists on main.