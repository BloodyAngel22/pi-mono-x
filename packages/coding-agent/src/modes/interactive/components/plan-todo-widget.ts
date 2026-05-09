import { type Component, truncateToWidth } from "@mariozechner/pi-tui";
import type { PlanTask } from "../../../core/plan-mode.js";
import type { Theme } from "../theme/theme.js";

const BAR_WIDTH = 10;
const MAX_VISIBLE_PENDING = 5;
const MAX_VISIBLE_SUBTASKS = 5;

interface ActiveTaskGroup {
	parent: PlanTask;
	children: PlanTask[];
	start: number;
	end: number;
	activeChildIndex: number | undefined;
}

function formatBar(done: number, total: number): string {
	if (total === 0) return `[${"░".repeat(BAR_WIDTH)}]`;
	const filled = Math.round((done / total) * BAR_WIDTH);
	return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
}

function truncateLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width - 1));
}

function getActiveTaskGroup(tasks: PlanTask[], activeIdx: number): ActiveTaskGroup | undefined {
	if (activeIdx < 0) return undefined;
	let start = activeIdx;
	while (start > 0 && tasks[start]?.level !== 0) start--;
	const parent = tasks[start];
	if (!parent) return undefined;
	let end = start + 1;
	while (end < tasks.length && tasks[end]?.level !== 0) end++;
	const children = tasks.slice(start + 1, end);
	return {
		parent,
		children,
		start,
		end,
		activeChildIndex: activeIdx === start ? undefined : activeIdx - start - 1,
	};
}

export class PlanTodoWidgetComponent implements Component {
	private readonly startTime = Date.now();
	private readonly timer: NodeJS.Timeout;
	private completedAt: number | undefined;

	constructor(
		private tasks: PlanTask[],
		private readonly theme: Theme,
		private readonly getTokenCount: () => number,
		private readonly requestRender: () => void,
	) {
		this.timer = setInterval(() => this.requestRender(), 1000);
	}

	update(tasks: PlanTask[]): void {
		this.tasks = tasks;
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}

	render(width: number): string[] {
		if (this.tasks.length === 0) return [];
		const done = this.tasks.filter((task) => task.done).length;
		const total = this.tasks.length;
		const allDone = done === total;
		if (allDone && this.completedAt === undefined) {
			this.completedAt = Date.now();
			clearInterval(this.timer);
		}
		const elapsed = formatElapsed((this.completedAt ?? Date.now()) - this.startTime);
		const tokens = formatTokens(this.getTokenCount());
		const statusIcon = allDone ? this.theme.fg("success", "●") : this.theme.fg("accent", "*");
		const summaryText = allDone ? "Completed work tasks" : "Executing work tasks";
		const title = `${statusIcon} ${this.theme.fg(allDone ? "success" : "accent", summaryText)}`;
		const progress = this.theme.fg(done === total ? "success" : "muted", formatBar(done, total));
		const lines = [""];
		lines.push(truncateLine(`${title} ${this.theme.fg("dim", `(${elapsed} · ↓ ${tokens} tokens)`)}`, width));
		lines.push(truncateLine(`  L ${progress} ${this.theme.fg("muted", `${done}/${total} completed`)}`, width));

		const activeIdx = this.tasks.findIndex((t) => !t.done);

		if (done > 0 && activeIdx !== -1) {
			lines.push(
				truncateLine(`  L ${this.theme.fg("success", "✔")} ${this.theme.fg("dim", `${done} completed`)}`, width),
			);
		}

		if (activeIdx !== -1) {
			const activeGroup = getActiveTaskGroup(this.tasks, activeIdx);
			const task = activeGroup?.parent ?? this.tasks[activeIdx]!;
			const isFirst = done === 0;
			const prefix = isFirst ? "L " : "  ";
			const groupDone = activeGroup ? activeGroup.children.filter((t) => t.done).length : 0;
			const groupTotal = activeGroup?.children.length ?? 0;
			const groupProgress = groupTotal > 0 ? this.theme.fg("dim", ` (${groupDone}/${groupTotal})`) : "";
			lines.push(
				truncateLine(
					`  ${prefix}${this.theme.fg("accent", "■")} ${this.theme.fg("text", this.theme.bold(task.text))}${groupProgress} ${this.theme.fg("dim", "active")}`,
					width,
				),
			);

			const children = activeGroup?.children ?? [];
			const firstVisibleChild = activeGroup?.activeChildIndex
				? Math.min(activeGroup.activeChildIndex, Math.max(0, children.length - MAX_VISIBLE_SUBTASKS))
				: 0;
			const visibleChildren = children.slice(firstVisibleChild, firstVisibleChild + MAX_VISIBLE_SUBTASKS);
			if (firstVisibleChild > 0) {
				lines.push(truncateLine(`    ${this.theme.fg("dim", `… ${firstVisibleChild} earlier subtasks`)}`, width));
			}
			for (let i = 0; i < visibleChildren.length; i++) {
				const pt = visibleChildren[i]!;
				const isActiveChild = activeGroup?.activeChildIndex === firstVisibleChild + i;
				const marker = pt.done
					? this.theme.fg("success", "✔")
					: isActiveChild
						? this.theme.fg("accent", "■")
						: this.theme.fg("dim", "□");
				const text = pt.done
					? this.theme.fg("dim", this.theme.strikethrough(pt.text))
					: isActiveChild
						? this.theme.fg("text", this.theme.bold(pt.text))
						: this.theme.fg("muted", pt.text);
				const suffix = isActiveChild ? this.theme.fg("dim", " active") : "";
				lines.push(truncateLine(`    ${marker} ${text}${suffix}`, width));
			}
			if (children.length > visibleChildren.length) {
				const hiddenAfter = children.length - firstVisibleChild - visibleChildren.length;
				if (hiddenAfter > 0) {
					lines.push(truncateLine(`    ${this.theme.fg("dim", `… ${hiddenAfter} subtasks more`)}`, width));
				}
			}

			const pendingAfter = this.tasks
				.slice(activeGroup?.end ?? activeIdx + 1)
				.filter((t) => !t.done && t.level === 0);
			const visible = pendingAfter.slice(0, MAX_VISIBLE_PENDING);
			for (const pt of visible) {
				lines.push(truncateLine(`    ${this.theme.fg("dim", "□")} ${this.theme.fg("muted", pt.text)}`, width));
			}

			const remaining = pendingAfter.length - visible.length;
			if (remaining > 0) {
				lines.push(truncateLine(`    ${this.theme.fg("dim", `… ${remaining} more`)}`, width));
			}
		}

		lines.push("");
		return lines;
	}
}

function formatElapsed(elapsedMs: number): string {
	const seconds = Math.floor(elapsedMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
