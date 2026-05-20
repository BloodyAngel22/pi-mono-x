import { describe, expect, it } from "vitest";
import { TUI } from "../../tui/src/tui.js";
import { defaultEditorTheme } from "../../tui/test/test-themes.js";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

describe("CustomEditor", () => {
	it("lets Shift+Enter insert a newline before app actions can submit", () => {
		const keybindings = new KeybindingsManager({
			"app.message.followUp": "shift+enter",
		});
		const editor = new CustomEditor(createTestTUI(), defaultEditorTheme, keybindings);
		let submitted = false;
		let followUp = false;
		editor.onSubmit = () => {
			submitted = true;
		};
		editor.onAction("app.message.followUp", () => {
			followUp = true;
		});

		editor.handleInput("a");
		editor.handleInput("\x1b[13;2u");
		editor.handleInput("b");

		expect(editor.getText()).toBe("a\nb");
		expect(submitted).toBe(false);
		expect(followUp).toBe(false);
	});

	it("lets Alt+Enter insert a newline before app actions can submit", () => {
		const keybindings = new KeybindingsManager({
			"app.message.followUp": "alt+enter",
		});
		const editor = new CustomEditor(createTestTUI(), defaultEditorTheme, keybindings);
		let submitted = false;
		let followUp = false;
		editor.onSubmit = () => {
			submitted = true;
		};
		editor.onAction("app.message.followUp", () => {
			followUp = true;
		});

		editor.handleInput("a");
		editor.handleInput("\x1b\r");
		editor.handleInput("b");

		expect(editor.getText()).toBe("a\nb");
		expect(submitted).toBe(false);
		expect(followUp).toBe(false);
	});

	it("lets Shift+Enter insert a newline in Vim insert mode before app actions can submit", () => {
		const keybindings = new KeybindingsManager({
			"app.message.followUp": "shift+enter",
		});
		const editor = new CustomEditor(createTestTUI(), defaultEditorTheme, keybindings);
		let submitted = false;
		let followUp = false;
		editor.onSubmit = () => {
			submitted = true;
		};
		editor.onAction("app.message.followUp", () => {
			followUp = true;
		});

		editor.setVimModeEnabled(true);
		editor.handleInput("a");
		editor.handleInput("\x1b[13;2u");
		editor.handleInput("b");

		expect(editor.getText()).toBe("a\nb");
		expect(submitted).toBe(false);
		expect(followUp).toBe(false);
		expect(editor.getVimInputMode()).toBe("insert");
	});
});
