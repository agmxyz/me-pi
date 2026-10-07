# Coding standards

## Scope
- Keep changes within the request; avoid speculative features, abstractions, configuration, or compatibility shims. Remove code made unused by the change and leave unrelated code untouched.
- State assumptions that materially affect the implementation; ask when ambiguity could change behavior.
- Match established project patterns, names, libraries, and style. Add a dependency only when it is clearly cheaper than implementing the needed behavior directly.

## Failure handling
- Handle plausible input, I/O, network, and external-tool failures with clear errors.
- Propagate failures; do not swallow errors or use fallbacks that hide them.
- Guard reachable invalid states; omit guards for impossible states.

## Verification
- Define observable success from the request and verify changed behavior against it.
- Keep tests faithful to behavior; do not weaken, skip, or special-case tests to pass.

## Readability
- Use descriptive names, name non-obvious constants, and give complex conditions clear names.
- Prefer early returns to deep nesting. Keep interfaces small and add layers when they clarify responsibility.
- Prefer composition over inheritance. Accept small duplication when abstraction would obscure behavior.
- Write comments to explain why, intent, or tricky behavior rather than restating code.
