// Hides the `Thinking...` label Pi shows in place of a hidden thinking block, and the blank lines around it.
// With thinking blocks shown (`hideThinkingBlock: false`) this changes nothing.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setHiddenThinkingLabel("");
	});
}
