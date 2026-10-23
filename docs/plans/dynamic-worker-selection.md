# Dynamic delegate worker selection

## Specification

Allow the user or coordinator to select a one-off delegate model and/or thinking level using the existing runs fields, without editing delegate.json. Configured pools are defaults, not an allowlist.

- Scouts remain restricted to thinking low or off; preserve the existing cap semantics.
- For workers, an explicitly supplied model overrides model selection, and explicit thinking overrides thinking selection independently. Omitted fields use delegate.json defaults: thinking-only retains ordered pool model selection; model-only retains configured thinking defaults. Keep existing per-model versus pool thinking precedence for configured models. For an unlisted model, use the role's configured pool thinking default. Preserve existing no-config behavior if no configured thinking exists, with clear errors when no default can be resolved.
- An explicit model outside configured pools is accepted as a one-off exact catalog model ID (provider/model). Validate against Pi's model registry and usable authentication through public APIs where possible; failures must clearly identify unavailable/unknown/unauthenticated models. Do not access credential files or print secrets. Ambiguous human-friendly names must not silently select another model; the coordinator resolves conversational names to exact IDs before calling the tool.
- Any explicitly named model has no automatic pool fallback, whether listed in delegate.json or not. Only default pool model selection retains ordered fallback. Explicit thinking applies consistently across default-pool fallback candidates, subject to scout restrictions. This supersedes the original configured-explicit-model fallback behavior implemented in the first ticket.
- Preserve cancellation, worker limits, budgets, non-TUI behavior, actual model/thinking reporting, and UI activity. Do not persist one-off selections to delegate.json. No new commands, flags, or dependencies are needed.

## Ticket: implement dynamic worker selection

Status: closed

Paths: extensions/delegate.ts, extensions/delegate-command.ts only if sharing existing availability validation is necessary, test/delegate.test.mjs and relevant fixtures, docs/delegate.md.

Acceptance: specification above; existing tool model schema must no longer enum-restrict selection to configured pools. Confirmed test seams: resolver/schema and worker execution tests in test/delegate.test.mjs with existing fake Pi/registry fixtures; extend fixtures for catalog/auth lookup as necessary. Cover explicit listed/unlisted model with and without explicit thinking, thinking-only pool defaults, no overrides, configured per-model thinking precedence, scouts low/off cap, unknown/unauthenticated model rejection without spawning, no implicit fallback for unlisted models, unchanged fallback for configured/default pool models, and no config mutation. Keep tests meaningful; use existing public registry APIs and fail loudly where unsupported. The original configured-explicit-model fallback assertion is superseded by the follow-up ticket below.

The implementer must not ask questions; decide per this specification and list unresolved questions as BLOCKED. Close this ticket only in its passing commit. Full check: npm run check --prefix extensions. Do not run install.sh. The user subsequently requested the widget in the same PR; the main session owns pushes and PR operations.

## Ticket: stop on explicit model failure

Status: closed

Superseding requirement: every explicit runs[].model selection must run only that model, including configured pool members. No availability/execution failure may silently choose another model. When model is omitted, retain existing ordered role pool fallback and independent thinking override semantics.

Paths: extensions/delegate.ts, test/delegate.test.mjs, docs/delegate.md. Confirmed test seams: existing resolver/execution fixtures; assert explicit configured and unlisted failure does not spawn a fallback, while omitted-model default pool still falls back; preserve thinking selection and scout caps. Update previous assertions only where superseded by this user-approved behavior. Close only in passing commit. Check: npm run check --prefix extensions.

## Widget specification

Add a compact panel near the main prompt using Pi's existing setWidget API, listing all active delegate workers across foreground and background calls. Show chef 🧑‍🍳, call/job ID and role, actual model, thinking level, elapsed seconds, and latest sanitized tool name. Keep existing tool expansion via Ctrl + letter o unchanged. No second job registry, no task content, raw arguments, outputs, stderr, or reasoning in the widget. Reuse active-call ownership and internal progress hooks; background jobs need internal progress even without a tool onUpdate callback. Follow current model/fallback/rebuttal state. Bound rows (at most four worker rows plus a concise overflow count if needed), width-safe at narrow terminal sizes, semantic theme colors. Hide when idle. Update elapsed time once per second only while active, TUI-only; clean up timers/widget on idle, completion, cancellation, shutdown/reload, and session replacement. Guard non-TUI modes and do not assume UI in print/JSON workers. No new dependency or separate screen/shortcut.

## Ticket: main-session delegate activity widget

Status: open

Depends on: stop on explicit model failure.

Paths: extensions/delegate.ts, extensions/delegate-render.ts, extensions/delegate-command.ts if active record shape sharing requires it, test/delegate.test.mjs, test/delegate-render.test.mjs, docs/delegate.md. Follow Widget specification above. Confirmed test seams: existing fake worker event streams and UI context mock for both background and foreground execution; add widget rendering assertions and lifecycle tests. Cover foreground plus background updates on tool start before turn completion, multiple simultaneous workers/jobs with stable IDs, model/thinking/role, fallback transitions when allowed, row limits, narrow Unicode widths, sanitized fields/no payload leaks, idle hiding, cancellation and session shutdown cleanup, non-TUI no widget/timer behavior. Ensure no dangling interval keeps tests/process alive; use existing disposal seams. Preserve spend accounting, worker limits, output and custom tool render behavior. Close only in passing commit. Final full-suite check: npm run check --prefix extensions.

