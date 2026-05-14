import { type Component, type TUI, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { SubagentManager } from "../../../core/subagent/manager.js";
import type { SubagentTask } from "../../../core/subagent/types.js";
import { theme } from "../theme/theme.js";

function formatElapsed(startedAt: number, completedAt?: number): string {
	const elapsed = Math.floor(((completedAt ?? Date.now()) - startedAt) / 1000);
	if (elapsed < 60) return `${elapsed}s`;
	return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

/**
 * Displays active and recently completed subagent tasks above the footer.
 * Each task shows: dot indicator + label + elapsed time.
 * Hides itself when there are no tasks to show.
 */
export class SubagentStatusComponent implements Component {
	private manager: SubagentManager;
	private ui: TUI;
	private tickTimer: NodeJS.Timeout | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(manager: SubagentManager, ui: TUI) {
		this.manager = manager;
		this.ui = ui;
	}

	/** Start listening to subagent events and updating the display. */
	start(): void {
		this.unsubscribe = this.manager.onEvent(() => {
			this.ui.requestRender();
		});

		// Tick every second to keep elapsed times live while tasks are running
		this.tickTimer = setInterval(() => {
			if (this.manager.runningCount > 0) {
				this.ui.requestRender();
			}
		}, 1000);
	}

	/** Stop listening and clean up timers. */
	stop(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const tasks = this.manager.getRecentTasks(30_000);
		if (tasks.length === 0) return [];

		const lines: string[] = [];

		for (const task of tasks) {
			lines.push(this.renderTask(task, width));
			for (const activity of task.recentActivities ?? []) {
				lines.push(this.renderActivity(activity, width));
			}
		}

		return lines;
	}

	private renderTask(task: SubagentTask, width: number): string {
		const dot =
			task.status === "running" || task.status === "background"
				? theme.fg("muted", "●")
				: task.status === "error"
					? theme.fg("error", "●")
					: theme.fg("success", "●");

		const label = task.label || task.agentName || "sub-agent";
		const elapsed = theme.fg("dim", `(${formatElapsed(task.startedAt, task.completedAt)})`);

		const statusSuffix =
			task.status === "background"
				? theme.fg("dim", " [bg]")
				: task.status === "error"
					? theme.fg("error", " [err]")
					: "";

		const line = `${dot} ${theme.fg("dim", label)} ${elapsed}${statusSuffix}`;
		return this.padAndTruncate(line, width);
	}

	private renderActivity(activity: string, width: number): string {
		return this.padAndTruncate(theme.fg("dim", `  ↳ ${activity}`), width);
	}

	private padAndTruncate(line: string, width: number): string {
		const lineVisible = visibleWidth(line);
		const padded = line + " ".repeat(Math.max(0, width - lineVisible));
		return truncateToWidth(padded, width, theme.fg("dim", "..."));
	}
}
