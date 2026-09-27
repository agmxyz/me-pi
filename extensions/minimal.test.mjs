import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import minimal from "./minimal.ts";

function createFooter({ mode = "tui", modelId = "openai/gpt-6-luna", thinkingLevel = "xhigh", percent = 21.3 } = {}) {
	const handlers = new Map();
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
	};
	minimal(pi);

	let factory;
	let renderRequests = 0;
	const ctx = {
		mode,
		model: modelId ? { id: modelId } : undefined,
		thinkingLevel,
		ui: {
			setFooter(value) {
				factory = value;
			},
		},
		getContextUsage() {
			return percent === null ? undefined : { percent };
		},
	};
	handlers.get("session_start")({}, ctx);

	const footer = factory?.(
		{ requestRender() { renderRequests++; } },
		{ fg: (_color, text) => text },
	);
	return { footer, handlers, getRenderRequests: () => renderRequests };
}

test("renders the selected model and context meter within the available width", () => {
	const { footer } = createFooter();
	const line = footer.render(60)[0];

	assert.match(line, /openai\/gpt-6-luna \(xhigh\)/);
	assert.match(line, /\[##--------\] 21%/);
	assert.equal(visibleWidth(line), 60);
});

test("updates the displayed model and requests a render after model selection", () => {
	const session = createFooter();
	session.handlers.get("model_select")({ model: { id: "openai/o3" } });

	assert.equal(session.getRenderRequests(), 1);
	assert.match(session.footer.render(60)[0], /openai\/o3/);
});

test("updates the thinking level and requests a render after selection", () => {
	const session = createFooter();
	session.handlers.get("thinking_level_select")({ level: "medium" });

	assert.equal(session.getRenderRequests(), 1);
	assert.match(session.footer.render(60)[0], / \(medium\)/);
});

test("shows unknown usage instead of implying an empty context", () => {
	const { footer } = createFooter({ percent: null });
	const line = footer.render(60)[0];

	assert.ok(line.includes("[??????????] ?"));
	assert.ok(!line.includes("] 0%"));
});

test("bounds usage and keeps the meter within narrow terminal widths", () => {
	const { footer } = createFooter({ modelId: "x".repeat(120), percent: 150 });

	assert.match(footer.render(60)[0], /\[##########\] 100%/);
	assert.equal(visibleWidth(footer.render(12)[0]), 12);
});

test("skips the terminal footer outside interactive mode", () => {
	const session = createFooter({ mode: "rpc" });

	assert.equal(session.footer, undefined);
});
