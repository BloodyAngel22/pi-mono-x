import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

export class HistorySearchSelectorComponent extends Container implements Focusable {
	private searchInput = new Input();
	private listContainer = new Container();
	private filtered: string[] = [];
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		private tui: TUI,
		private history: string[],
		private onSelectCallback: (prompt: string) => void,
		private onCancelCallback: () => void,
	) {
		super();
		this.searchInput.onSubmit = () => {
			const selected = this.filtered[this.selectedIndex];
			if (selected !== undefined) this.onSelectCallback(selected);
		};
		this.searchInput.onEscape = () => this.onCancelCallback();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Search prompt history")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				keyHint("tui.select.up", "up") +
					"  " +
					keyHint("tui.select.down", "down") +
					"  " +
					keyHint("tui.select.confirm", "use") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.filter();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(Math.max(0, this.filtered.length - 1), this.selectedIndex + 1);
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.filtered[this.selectedIndex];
			if (selected !== undefined) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		this.searchInput.handleInput(data);
		this.filter();
		this.tui.requestRender();
	}

	private filter(): void {
		const query = this.searchInput.getValue();
		this.filtered = fuzzyFilter(this.history, query, (entry) => entry);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const shown = this.filtered.slice(0, 8);
		if (shown.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("dim", "No matching prompts"), 1, 0));
			return;
		}
		for (let i = 0; i < shown.length; i++) {
			const prompt = shown[i] ?? "";
			const firstLine = prompt
				.replace(/[\r\n\t]/g, " ")
				.replace(/ +/g, " ")
				.trim();
			const text = truncateToWidth(firstLine, 100, "...");
			const prefix = i === this.selectedIndex ? theme.fg("accent", "→ ") : "  ";
			this.listContainer.addChild(
				new Text(prefix + theme.fg(i === this.selectedIndex ? "accent" : "text", text), 1, 0),
			);
		}
	}
}
