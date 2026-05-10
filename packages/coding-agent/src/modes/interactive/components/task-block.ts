import { Container, type TUI, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { theme } from "../theme/theme.js";
import type { ToolExecutionComponent } from "./tool-execution.js";

function formatElapsed(startMs: number, endMs?: number): string {
	const elapsed = Math.floor(((endMs ?? Date.now()) - startMs) / 1000);
	if (elapsed < 60) return `${elapsed}s`;
	return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

export interface TaskBlockSummary {
	filesChanged: number;
	commandsRun: number;
	testsPassed?: number;
	testsFailed?: number;
}

function getStringArg(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function parseTestCounts(
	command: string | undefined,
	output: string,
): { passed?: number; failed?: number } | undefined {
	const haystack = `${command ?? ""}\n${output}`;
	if (!/\b(test|pytest|vitest|jest|mocha)\b/i.test(haystack)) return undefined;
	const passed = [...output.matchAll(/(\d+)\s+passed/gi)].reduce((sum, match) => sum + Number(match[1]), 0);
	const failed = [...output.matchAll(/(\d+)\s+failed/gi)].reduce((sum, match) => sum + Number(match[1]), 0);
	if (passed === 0 && failed === 0) return undefined;
	return { passed, failed };
}

/**
 * Groups consecutive tool calls under a compact block, à la claude-code.
 *
 * Each tool renders as a single ◆ line.
 * Collapsed (default): shows ● header + last/active tool only.
 * Expanded (ctrl+o): shows ● header + all tools + "✓ Done in Ns" footer.
 */
export class TaskBlockComponent extends Container {
	private tools: ToolExecutionComponent[] = [];
	private _expanded = false;
	private label: string;
	private startTime: number;
	private endTime: number | undefined;
	private done = false;
	private hasError = false;
	private summary: TaskBlockSummary | undefined;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI;

	/**
	 * @param label     Initial label (updated as more tools accumulate)
	 * @param ui        TUI instance for requesting renders
	 * @param startTime Optional epoch ms to start elapsed from (e.g. agent_start time).
	 *                  Defaults to now if omitted.
	 */
	constructor(label: string, ui: TUI, startTime?: number) {
		super();
		this.label = label;
		this.startTime = startTime ?? Date.now();
		this.ui = ui;

		// Update elapsed every second while active
		this.intervalId = setInterval(() => {
			if (!this.done) {
				this.ui.requestRender();
			}
		}, 1000);
	}

	get toolNames(): string[] {
		return this.tools.map((t) => t.toolName);
	}

	addTool(component: ToolExecutionComponent): void {
		this.tools.push(component);
	}

	updateLabel(label: string): void {
		this.label = label;
	}

	/** Mark block as complete. Stops the elapsed timer. */
	finalize(isError = false, summary?: TaskBlockSummary): void {
		this.done = true;
		this.hasError = isError;
		this.summary = summary;
		this.endTime = Date.now();
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		// Tools always render in compact mode inside the task block.
		// The expanded flag only controls whether all tools are listed vs the last one.
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools) {
			tool.setShowImages(show);
		}
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools) {
			tool.setImageWidthCells(width);
		}
	}

	buildSummary(): TaskBlockSummary | undefined {
		const changedFiles = new Set<string>();
		let commandsRun = 0;
		let testsPassed = 0;
		let testsFailed = 0;
		let sawTests = false;

		for (const tool of this.tools) {
			if (tool.toolName === "write" || tool.toolName === "edit") {
				const filePath = getStringArg(tool.getArgs(), "path");
				if (filePath) changedFiles.add(filePath);
			}
			if (tool.toolName === "bash") {
				commandsRun++;
				const counts = parseTestCounts(getStringArg(tool.getArgs(), "command"), tool.getResultText());
				if (counts) {
					sawTests = true;
					testsPassed += counts.passed ?? 0;
					testsFailed += counts.failed ?? 0;
				}
			}
		}

		if (changedFiles.size === 0 && commandsRun === 0 && !sawTests) return undefined;
		return {
			filesChanged: changedFiles.size,
			commandsRun,
			testsPassed: sawTests ? testsPassed : undefined,
			testsFailed: sawTests ? testsFailed : undefined,
		};
	}

	override invalidate(): void {
		for (const tool of this.tools) {
			tool.invalidate();
		}
	}

	/**
	 * Extracts the first non-blank content line from a tool's render output and
	 * prepends a tree connector, e.g. "   └─ ◆ tool_name  arg".
	 * The tool's leading Spacer blank is silently skipped.
	 */
	private renderToolLine(tool: ToolExecutionComponent, connector: string, width: number): string {
		const connectorWidth = visibleWidth(connector);
		const contentWidth = Math.max(1, width - connectorWidth);
		for (const line of tool.render(contentWidth)) {
			const stripped = line.trimStart();
			if (stripAnsi(stripped).trim().length > 0) {
				return truncateToWidth(connector + stripped, width);
			}
		}
		return truncateToWidth(`${connector}◆ ${tool.toolName}`, width);
	}

	private renderFileChangeLines(tool: ToolExecutionComponent, width: number): string[] {
		if ((tool.toolName !== "write" && tool.toolName !== "edit") || !tool.hasResult() || tool.getIsError()) {
			return [];
		}
		const contentWidth = Math.max(1, width - 3);
		const rendered = tool.renderExpanded(contentWidth);
		const firstContentIndex = rendered.findIndex((line) => stripAnsi(line).trim().length > 0);
		if (firstContentIndex < 0) return [];
		let bodyStart = firstContentIndex + 1;
		while (bodyStart < rendered.length && stripAnsi(rendered[bodyStart]).trim().length === 0) {
			bodyStart++;
		}
		return rendered
			.slice(bodyStart)
			.filter((line) => stripAnsi(line).trim().length > 0)
			.map((line) => truncateToWidth(`   ${line}`, width, ""));
	}

	private formatSummary(): string | undefined {
		if (!this.summary) return undefined;
		const parts: string[] = [];
		if (this.summary.filesChanged > 0) {
			parts.push(`${this.summary.filesChanged} file${this.summary.filesChanged === 1 ? "" : "s"} changed`);
		}
		if (this.summary.commandsRun > 0) {
			parts.push(`${this.summary.commandsRun} command${this.summary.commandsRun === 1 ? "" : "s"} run`);
		}
		if (this.summary.testsPassed !== undefined || this.summary.testsFailed !== undefined) {
			const passed = this.summary.testsPassed ?? 0;
			const failed = this.summary.testsFailed ?? 0;
			parts.push(failed > 0 ? `tests: ${passed} passed, ${failed} failed` : `tests: ${passed} passed`);
		}
		return parts.length > 0 ? parts.join(" · ") : undefined;
	}

	override render(width: number): string[] {
		const lines: string[] = [];

		// Blank line before the block (visual separation)
		lines.push("");

		// ● header — live elapsed counter while running, plain label when done
		const headerIcon = this.done
			? theme.fg(this.hasError ? "error" : "success", this.hasError ? "✗" : "●")
			: theme.fg("accent", "●");

		let headerLine: string;
		if (this.done) {
			headerLine = ` ${headerIcon} ${theme.fg("muted", this.label)}`;
		} else {
			const elapsed = formatElapsed(this.startTime);
			headerLine = ` ${headerIcon} ${theme.bold(this.label)}${theme.fg("dim", ` · ${elapsed}`)}`;
		}
		lines.push(truncateToWidth(headerLine, width));

		if (this.tools.length === 0) {
			return lines;
		}

		if (this._expanded) {
			// All tools with ├─ / └─ tree connectors
			for (let i = 0; i < this.tools.length; i++) {
				const isLast = i === this.tools.length - 1;
				const connector = `   ${isLast ? "└─" : "├─"} `;
				lines.push(this.renderToolLine(this.tools[i], connector, width));
			}
		} else {
			// Collapsed: show only the most recent tool with └─
			const lastTool = this.tools[this.tools.length - 1];
			lines.push(this.renderToolLine(lastTool, "   └─ ", width));
		}

		// Elapsed footer — visible in both collapsed and expanded when done
		if (this.done) {
			const elapsed = formatElapsed(this.startTime, this.endTime);
			const footer = this.hasError
				? theme.fg("error", `   · Failed in ${elapsed}`)
				: theme.fg("dim", `   · Elapsed: ${elapsed}`);
			lines.push(truncateToWidth(footer, width));
			const summary = this.formatSummary();
			if (summary) {
				lines.push(truncateToWidth(theme.fg("dim", `   · ${summary}`), width));
			}
		}

		const fileChangeLines = this.tools.flatMap((tool) => this.renderFileChangeLines(tool, width));
		if (fileChangeLines.length > 0) {
			lines.push("");
			lines.push(...fileChangeLines);
		}

		return lines;
	}
}
