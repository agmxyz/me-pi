---
name: task-first-ui
description: Design, implement, and review product interfaces with task-first UX judgment and production-minded frontend rigor. Use when the agent needs to create or revise web or app screens, flows, components, prototypes, marketing pages, or design systems; implement UI in an existing frontend codebase; critique UX/UI or frontend changes; improve accessibility, responsiveness, content hierarchy, or interaction states; or remove generic AI-designed patterns while preserving the product's conventions. For visual distinctiveness and aesthetic direction use `frontend-design`; for checklist-style compliance review use `web-design-guidelines`. Do not use for purely backend work or standalone brand, illustration, or graphic-design tasks.
---

# Product-Minded UX/UI

## Adopt the operating stance

- Optimize for the user completing the product's core task with minimal friction, uncertainty, and cognitive load.
- Build the minimal **complete** interface, not the fewest possible elements. Preserve affordances, orientation, error prevention, and necessary context.
- Derive density, tone, color, type, and motion from the product, audience, frequency of use, stakes, and environment. Do not make every product sparse, gray, playful, or enterprise-looking.
- Prefer familiar interaction patterns unless novelty creates a concrete product advantage.
- Extend the existing design system and code conventions before inventing new primitives or visual language. Treat visual trends as options, never defaults.
- Push back briefly when a request would harm usability. Explain the user cost and propose an in-scope alternative.

## Choose the mode

Identify the requested mode before acting:

- **Design:** Define or revise a screen, flow, information architecture, interaction model, or visual direction.
- **Implement:** Change frontend code to realize an agreed or inferred design.
- **Review:** Diagnose UX/UI or frontend issues and report prioritized, actionable findings. Do not edit unless the user also asks for changes.

For mixed requests, design only as much as needed to implement well. Do not turn a scoped frontend change into an unsolicited redesign. Mode-specific output formats — design, implementation, and review reports — are in [REFERENCE.md](REFERENCE.md).

## Follow the workflow

### 1. Establish the product frame

Inspect the available evidence before proposing pixels: product requirements, routes, screenshots, current UI, components, tokens, styles, content, data shape, analytics, and nearby screens.

Infer and state: the primary user; the job they are trying to complete; the single most important outcome of this screen or flow; relevant constraints such as frequency, risk, device, data density, and existing conventions.

Ask one concise question only when missing context would materially change the result and no safe assumption is available. Otherwise state the assumption and proceed.

### 2. Define the smallest complete solution

- Establish the information hierarchy before styling.
- Make the primary action unmistakable. Keep secondary actions subordinate and group true peer actions intentionally.
- Choose navigation and layout from the user's workflow, not from a stock page type. Do not assume "dashboard" means sidebar, cards, and charts.
- Use progressive disclosure for infrequent or advanced controls without hiding information needed for the core task.
- Remove duplicate labels, controls, containers, and explanations.
- Preserve useful context across steps and prevent avoidable errors before showing validation messages.
- Map the relevant states before implementation: initial, loading, partial, empty, error, success, disabled, permission-limited, and populated. Include destructive confirmation and recovery when applicable.

### 3. Shape a product-specific visual language

- Let typography, spacing, alignment, and grouping carry hierarchy before adding containers, borders, shadows, or color.
- Use color primarily for meaning, state, priority, and brand recognition. Restraint does not require grayscale.
- Set density from task frequency and scan behavior: frequent expert work may need compact controls; occasional high-stakes work may need more guidance and separation.
- Use borders, elevation, and surfaces only to communicate containment, layering, interaction, or state.
- Use recognizable icons from the existing icon system. Pair ambiguous icons with labels. Do not use emoji as interface icons unless the product language explicitly calls for them.
- Use motion for feedback, causality, and continuity. Respect reduced-motion preferences; avoid ambient animation that competes with the task.
- Write specific, useful interface copy. Avoid vague marketing claims, filler content, and invented proof.
- Avoid generic-AI design defaults — the known list and its escape hatch are in [REFERENCE.md](REFERENCE.md).

### 4. Implement within the product

- Reuse current components, tokens, typography, iconography, breakpoints, data conventions, and interaction patterns.
- Introduce a new primitive or dependency only when existing options cannot meet the requirement; explain the tradeoff.
- Use semantic structure and native controls where possible.
- Provide complete keyboard operation, visible focus, meaningful labels, logical focus order, adequate contrast, and accessible status/error announcements.
- Make responsive behavior express content priority. Recompose, collapse, or disclose intentionally instead of merely stacking the desktop layout.
- Handle long labels, localization expansion, zero and many items, slow operations, failed requests, and repeated actions.
- Preserve user input across recoverable failures and make irreversible actions explicit.
- Use real product content and data when available. For a prototype without data, use sparse, representative examples and identify assumptions; never present invented results as real.
- Keep the change scoped and maintainable. Follow the repository's formatting, testing, and component conventions.

### 5. Verify the result

Run the relevant build, type, lint, and test checks when available. Then inspect, or reason explicitly about: the core path from entry to successful completion; keyboard-only use and focus visibility; narrow, medium, and wide layouts; loading, empty, error, disabled, success, and overflow behavior; long content, validation, repeated actions, and large collections; consistency with nearby product patterns.

Report any verification that could not be performed. Do not call the work complete if a critical state is knowingly missing.

## Worked example

Request: "Add a settings page for notification preferences."

- **Frame:** returning account holder; job = control noise without missing critical alerts; outcome = "leave with the right channels set"; occasional use, medium stakes, existing form patterns.
- **Smallest complete solution:** one form grouped by category (Product / Billing / Security); per-row channel toggles; single primary **Save**; destructive "turn off all" behind confirmation.
- **States mapped:** loading, saving, saved, failed, signed-out.
- **Visual language:** reuse existing form rows and tokens; color only for state; no new cards, icons, or motion.
- **Generic-AI patterns avoided:** no "notifications sent this week" stat cards, no gradient hero, no onboarding tour — see [REFERENCE.md](REFERENCE.md).

## Use the definition of done

Consider the UI complete only when:

- the core action and current state are clear;
- hierarchy matches user priority;
- every visible element earns its place;
- relevant non-happy paths are handled;
- keyboard, focus, semantics, contrast, and responsive behavior are sound and preserve task priority;
- the result fits the product rather than a generic template;
- implementation matches existing code conventions;
- non-obvious decisions have brief, task-based rationales.
