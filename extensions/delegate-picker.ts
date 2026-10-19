/**
 * Searchable model-pool picker for `/delegate models`, built like Pi's /model selector: type to filter
 * (pi-tui's fuzzyFilter), arrows to move, Enter to add or remove a model, Ctrl+S to save, Esc to cancel.
 * The order in which models are added is the pool's order; the first model is tried first.
 */

import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { shortModel as short } from "./delegate-render.ts";

export interface PickerModel {
	/** `provider/id`, as the pool stores it. */
	id: string;
	name: string;
	/** Missing for a set model that is not available now. */
	cost?: { input: number; output: number };
}

type Fg = (color: any, text: string) => string;

const VISIBLE = 10;

/**
 * Models that contain every typed word come first, in list order; then the other fuzzy matches.
 * fuzzyFilter alone ranks `anthropic/claude-sonnet` above `anthropic/claude-opus` for "opus".
 */
export function matching(models: PickerModel[], query: string): PickerModel[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return models;
	const text = (m: PickerModel) => `${m.id} ${m.name}`;
	const exact = models.filter((m) => words.every((w) => text(m).toLowerCase().includes(w)));
	return [...exact, ...fuzzyFilter(models, query, text).filter((m) => !exact.includes(m))];
}

export class ModelSetPicker implements Component, Focusable {
	private readonly search = new Input();
	private readonly models: PickerModel[];
	private readonly fg: Fg;
	private readonly done: (ids: string[] | null) => void;
	private readonly title: string;
	private chosen: string[];
	private matches: PickerModel[];
	private index = 0;
	private _focused = false;

	constructor(
		models: PickerModel[],
		chosen: string[],
		fg: Fg,
		done: (ids: string[] | null) => void,
		title = "Delegate model pool",
	) {
		// A set model that is not available now gets a row first, so Enter can remove it.
		const missing = chosen.filter((id) => !models.some((m) => m.id === id));
		this.models = [...missing.map((id) => ({ id, name: short(id) })), ...models];
		this.chosen = [...chosen];
		this.fg = fg;
		this.done = done;
		this.title = title;
		this.matches = this.models;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.done([...this.chosen]);
			return;
		}
		const count = this.matches.length;
		if (kb.matches(data, "tui.select.up")) {
			if (count) this.index = (this.index - 1 + count) % count;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (count) this.index = (this.index + 1) % count;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const model = this.matches[this.index];
			if (!model) return;
			this.chosen = this.chosen.includes(model.id)
				? this.chosen.filter((id) => id !== model.id)
				: [...this.chosen, model.id];
			return;
		}
		const before = this.search.getValue();
		this.search.handleInput(data);
		// Cursor keys reach the input too; only a changed search resets the list.
		if (this.search.getValue() === before) return;
		this.matches = matching(this.models, this.search.getValue());
		this.index = 0;
	}

	render(width: number): string[] {
		const fg = this.fg;
		const fit = (line: string) => truncateToWidth(line, Math.max(1, width));
		const set = this.chosen.length
			? this.chosen.map((id, i) => `${i + 1}. ${short(id)}${i === 0 ? " (first tried)" : ""}`).join("  ")
			: "none yet";
		const lines = [fit(fg("accent", this.title)), fit(`${fg("muted", "Set:")} ${set}`), ...this.search.render(width)];
		// A window of VISIBLE rows that keeps the selected row in view.
		const start = Math.max(0, Math.min(this.index - Math.floor(VISIBLE / 2), this.matches.length - VISIBLE));
		for (const [offset, m] of this.matches.slice(start, start + VISIBLE).entries()) {
			const selected = start + offset === this.index;
			const position = this.chosen.indexOf(m.id);
			const mark = position >= 0 ? fg("success", `[${position + 1}]`) : fg("dim", "[ ]");
			const price = m.cost ? fg("dim", `$${m.cost.input}/$${m.cost.output} per M`) : fg("warning", "unavailable");
			const id = selected ? fg("accent", m.id) : m.id;
			lines.push(fit(`${selected ? fg("accent", "→") : " "} ${mark} ${id}  ${price}`));
		}
		if (!this.matches.length) lines.push(fit(fg("muted", "  no model matches")));
		else if (this.matches.length > VISIBLE) lines.push(fit(fg("dim", `  ${this.index + 1}/${this.matches.length}`)));
		lines.push(fit(fg("dim", "type to search · ↑↓ move · enter add/remove · ctrl+s save · esc cancel")));
		return lines;
	}

	invalidate(): void {
		this.search.invalidate();
	}
}
