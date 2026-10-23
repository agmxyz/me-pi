# Dynamic delegate worker selection

## Specification

Allow the user or coordinator to select a one-off delegate model and/or thinking level using the existing runs fields, without editing delegate.json. Configured pools are defaults, not an allowlist.

- Scouts remain restricted to thinking low or off; preserve the existing cap semantics.
- For workers, an explicitly supplied model overrides model selection, and explicit thinking overrides thinking selection independently. Omitted fields use delegate.json defaults: thinking-only retains ordered pool model selection; model-only retains configured thinking defaults. Keep existing per-model versus pool thinking precedence for configured models. For an unlisted model, use the role's configured pool thinking default. Preserve existing no-config behavior if no configured thinking exists, with clear errors when no default can be resolved.
- An explicit model outside configured pools is accepted as a one-off exact catalog model ID (provider/model). Validate against Pi's model registry and usable authentication through public APIs where possible; failures must clearly identify unavailable/unknown/unauthenticated models. Do not access credential files or print secrets. Ambiguous human-friendly names must not silently select another model; the coordinator resolves conversational names to exact IDs before calling the tool.
- An unlisted one-off model has no automatic pool fallback. Preserve existing ordered fallback for configured pool models and default pool selection. Explicit thinking applies consistently across fallback candidates, subject to scout restrictions.
- Preserve cancellation, worker limits, budgets, non-TUI behavior, actual model/thinking reporting, and UI activity. Do not persist one-off selections to delegate.json. No new commands, flags, or dependencies are needed.

## Ticket: implement dynamic worker selection

Status: closed

Paths: extensions/delegate.ts, extensions/delegate-command.ts only if sharing existing availability validation is necessary, test/delegate.test.mjs and relevant fixtures, docs/delegate.md.

Acceptance: specification above; existing tool model schema must no longer enum-restrict selection to configured pools. Confirmed test seams: resolver/schema and worker execution tests in test/delegate.test.mjs with existing fake Pi/registry fixtures; extend fixtures for catalog/auth lookup as necessary. Cover explicit listed/unlisted model with and without explicit thinking, thinking-only pool defaults, no overrides, configured per-model thinking precedence, scouts low/off cap, unknown/unauthenticated model rejection without spawning, no implicit fallback for unlisted models, unchanged fallback for configured/default pool models, and no config mutation. Keep tests meaningful; use existing public registry APIs and fail loudly where unsupported.

The implementer must not ask questions; decide per this specification and list unresolved questions as BLOCKED. Close this ticket only in its passing commit. Full check: npm run check --prefix extensions. No push, PR, or install.sh requested.
