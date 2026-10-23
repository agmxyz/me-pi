# Delegate live activity

## Specification

Improve the delegate tool's existing terminal rendering without replacing Pi's UI or binding another shortcut. The existing Ctrl+O tool expansion must reveal bounded recent per-worker activity while work is running. Collapsed progress stays compact. Show actual model and thinking level in live rows (including fallbacks). Use `🧑‍🍳` for active workers until Slack `dusty_stick` can be supported; this user-requested choice supersedes the previously specified portable ASCII marker `--*`. Preserve completion success/failure markers and completed expanded answers.

Activity consists of concise, sanitized tool labels, not raw arguments, tool output, or worker reasoning. Emit progress promptly on tool start, before an assistant turn completes. Keep per-run recent history bounded and coalesce bursts if needed so rendering remains responsive; flush final state and clean up any timers. Use existing tool-result details/onUpdate/renderResult seams. Keep non-TUI execution working. Inspect existing background-widget behavior and preserve it; do not add an unrelated background activity dashboard. If an existing seam can show equivalent detail for background jobs, use it without replacing Ctrl+O.

## Ticket: implement live activity

Status: done

Paths: extensions/delegate.ts, extensions/delegate-render.ts, relevant test fixtures/tests under test/, docs/delegate.md if user-facing documentation needs updating.

Acceptance criteria:
- Collapsed live per-run progress includes the actual model, thinking, `🧑‍🍳`, and latest tool label.
- Expanded partial progress reveals bounded recent activity independently for each worker, without exposing raw arguments/output/reasoning.
- Tool-start events update activity before the worker completes its turn.
- Existing complete answers, fallback/error/cancellation behavior, and non-TUI execution retain their semantics.
- Narrow-width output remains within terminal width, including unusual characters.
- All checks pass.

Confirmed test seams: renderer unit tests in test/delegate-render.test.mjs; event-stream/progress tests in test/delegate.test.mjs and existing fixtures. Test expanded versus collapsed partial output, model/thinking, marker and completion icons, bounded history, tool-start updates, independent runs, sanitization, and narrow widths. Full check: npm run check --prefix extensions.

The implementer closes this ticket only in its passing commit. No remote push or PR requested.
