import type { Component, MarkdownTheme } from "@mariozechner/pi-tui";
import { Markdown, visibleWidth } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message with a left accent border (claude-code style).
 * Replaces the heavy full-background box with a subtle left border + minimal padding.
 */
export class UserMessageComponent implements Component {
	private markdown: Markdown;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		this.markdown = new Markdown(text, 0, 0, markdownTheme, {
			color: (content: string) => theme.fg("userMessageText", content),
		});
	}

	invalidate(): void {
		this.markdown.invalidate?.();
	}

	render(width: number): string[] {
		const BORDER = theme.fg("accent", "│");
		const BORDER_WIDTH = 2; // "│ " = 2 visible chars
		const contentWidth = Math.max(1, width - BORDER_WIDTH - 1); // 1 right margin

		const contentLines = this.markdown.render(contentWidth);
		if (contentLines.length === 0) {
			return [];
		}

		const result: string[] = [];
		// Top spacer line (empty border)
		result.push(BORDER);

		for (const line of contentLines) {
			const vis = visibleWidth(line);
			const pad = Math.max(0, contentWidth - vis);
			const content = theme.bg("userMessageBg", ` ${line}${" ".repeat(pad)} `);
			result.push(`${BORDER}${content}`);
		}

		// Bottom spacer line (empty border)
		result.push(BORDER);

		if (result.length === 0) {
			return result;
		}

		const out = [...result];
		out[0] = OSC133_ZONE_START + out[0];
		out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
		return out;
	}
}
