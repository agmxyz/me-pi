/**
 * Compact model and context-usage footer.
 *
 * Adapted from disler/pi-vs-claude-code. See THIRD_PARTY_NOTICES.md.
 * Uses the rig's TUI package and preserves its configured theme and title.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function minimal(pi: ExtensionAPI): void {
	let modelId: string | undefined;
	let thinkingLevel: string | undefined;
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		modelId = ctx.model?.id;
		thinkingLevel = ctx.thinkingLevel;
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme) => {
			const render = () => tui.requestRender();
			requestRender = render;

			return {
				dispose() {
					if (requestRender === render) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const rawPercent = ctx.getContextUsage()?.percent;
					const percent =
						typeof rawPercent === "number" && Number.isFinite(rawPercent)
							? Math.round(Math.max(0, Math.min(100, rawPercent)))
							: undefined;
					const filled = percent === undefined ? 0 : Math.round(percent / 10);
					const bar =
						percent === undefined
							? "?".repeat(10)
							: "#".repeat(filled) + "-".repeat(10 - filled);

					const thinking = thinkingLevel ? ` (${thinkingLevel})` : "";
					const left = theme.fg("dim", ` ${modelId || "no-model"}${thinking}`);
					const meterText = percent === undefined ? "?" : `${percent}%`;
					const meter = theme.fg("dim", `[${bar}] ${meterText}`);
					const clippedMeter = truncateToWidth(meter, width, "");
					const meterWidth = visibleWidth(clippedMeter);
					const leftBudget = Math.max(0, width - meterWidth - 1);
					const clippedLeft = truncateToWidth(left, leftBudget, "");
					const gap = " ".repeat(Math.max(0, width - visibleWidth(clippedLeft) - meterWidth));

					return [clippedLeft + gap + clippedMeter];
				},
			};
		});
	});

	pi.on("model_select", (event) => {
		modelId = event.model.id;
		requestRender?.();
	});

	pi.on("thinking_level_select", (event) => {
		thinkingLevel = event.level;
		requestRender?.();
	});
}
