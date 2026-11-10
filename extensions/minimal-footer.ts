// Minimal one-line footer: "folder (branch)  ctx%/window (auto)" left, "model • thinking" right.
// Extension statuses (e.g. delegate jobs) still get their own line when present.
import { basename } from "node:path";
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		let autoCompact = true;
		try {
			autoCompact = SettingsManager.create(ctx.cwd).getCompactionEnabled();
		} catch (error) {
			ctx.ui.notify(`minimal-footer: could not read compaction setting (${String(error)})`, "warning");
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch();
					const location = `${basename(ctx.sessionManager.getCwd())}${branch ? ` (${branch})` : ""}`;

					const usage = ctx.getContextUsage();
					const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = usage?.percent;
					const contextText = `${percent == null ? "?" : `${percent.toFixed(1)}%`}/${formatTokens(window)}${autoCompact ? " (auto)" : ""}`;
					const color = (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "dim";
					const left = `${theme.fg("dim", `${location}  `)}${theme.fg(color, contextText)}`;

					const model = ctx.model;
					let rightText = model?.id ?? "no-model";
					if (model?.reasoning) {
						const level = pi.getThinkingLevel();
						rightText += level === "off" ? " • thinking off" : ` • ${level}`;
					}
					const available = width - visibleWidth(left) - 2;
					const right = available > 0 ? theme.fg("dim", truncateToWidth(rightText, available, "")) : "";
					const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));

					const lines = [truncateToWidth(left + padding + right, width, theme.fg("dim", "..."))];
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/\s+/g, " ").trim());
					if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
					return lines;
				},
			};
		});
	});
}
