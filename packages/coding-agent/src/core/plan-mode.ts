/**
 * Plan mode management.
 *
 * When active, the agent is restricted to read-only tools + writing to ~/tmp/.pi/plans/.
 * The agent writes a structured plan file that gets passed as context when /execute is run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLANS_DIR = join(homedir(), "tmp", ".pi", "plans");

export interface PlanModeState {
	active: boolean;
	planFilePath: string | undefined;
	planName: string | undefined;
}

export interface PlanTask {
	text: string;
	done: boolean;
	level: number;
}

export class PlanMode {
	private _active = false;
	private _planFilePath: string | undefined;
	private _planName: string | undefined;

	get active(): boolean {
		return this._active;
	}

	get planFilePath(): string | undefined {
		return this._planFilePath;
	}

	get planName(): string | undefined {
		return this._planName;
	}

	get state(): PlanModeState {
		return {
			active: this._active,
			planFilePath: this._planFilePath,
			planName: this._planName,
		};
	}

	/**
	 * Enter plan mode. Creates the plan file and returns its path.
	 * @param name Optional descriptive name for the plan
	 */
	enter(name?: string): string {
		this._active = true;
		this._planName = name;
		this._planFilePath = this._createPlanFile(name);
		return this._planFilePath;
	}

	/** Exit plan mode. Returns the path to the plan file (for /execute context). */
	exit(): string | undefined {
		const path = this._planFilePath;
		this._active = false;
		return path;
	}

	/** Toggle between plan and execute modes. */
	toggle(name?: string): { entered: boolean; planFilePath?: string } {
		if (this._active) {
			this.exit();
			return { entered: false };
		}
		const filePath = this.enter(name);
		return { entered: true, planFilePath: filePath };
	}

	/**
	 * Returns the system prompt appendix that tells the agent it is in plan mode.
	 * Should be appended to the base system prompt when plan mode is active.
	 */
	buildSystemPromptAppend(): string {
		if (!this._active || !this._planFilePath) return "";
		return `
## ⚠ PLAN MODE — READ-ONLY

You are in PLAN MODE. Your ONLY job is to understand the task and write a plan file.

### STRICTLY ALLOWED
- Read files (read, grep, find, ls, cat, head, tail, rg)
- Ask the user clarifying questions using the **ask_user tool** (REQUIRED before planning if anything is ambiguous)
- Write/edit the single plan file at: \`${this._planFilePath}\`

### STRICTLY FORBIDDEN — DO NOT EVEN ATTEMPT
- **NEVER** call the write, edit, or bash tools for anything other than read-only commands
- **NEVER** write, create, or modify any file except the plan file above
- **NEVER** run npm, git, or any state-changing command
- **NEVER** write actual implementation code, even as a preview or example

If you are tempted to write code or edit a file, STOP. Write the intent into the plan file instead.

### REQUIRED WORKFLOW
1. If requirements are unclear → call **ask_user** tool with 2–4 option-based questions FIRST
2. Explore the codebase with read-only tools
3. Write a detailed plan into \`${this._planFilePath}\`
4. Tell the user the plan is ready and they can run /execute

### Plan file format
\`\`\`markdown
# Plan: <name>
> Created: <timestamp>
> Status: planning

## Overview
<Brief description>

## Tasks
- [ ] Task 1: description
  - [ ] Subtask 1.1
- [ ] Task 2: description

## Notes
<Findings, decisions, open questions>
\`\`\`
`.trim();
	}

	/**
	 * Returns a message to inject at the start of an /execute session,
	 * instructing the agent to follow the plan.
	 */
	buildExecuteMessage(): string {
		if (!this._planFilePath) return "";
		return `Execute the plan at \`${this._planFilePath}\`. Read the plan file first, then implement each task in order, checking off each task in the plan file as you complete it (change [ ] to [x]) and update the status field to "executing" and then "done". Ask me if you need clarification on any task.`;
	}

	getTasks(): PlanTask[] {
		if (!this._planFilePath || !existsSync(this._planFilePath)) return [];
		const content = readFileSync(this._planFilePath, "utf-8");
		const tasks: PlanTask[] = [];
		let inTasksSection = false;
		for (const line of content.split(/\r?\n/)) {
			if (/^##\s/.test(line)) {
				inTasksSection = /^##\s+tasks\b/i.test(line);
				continue;
			}
			if (!inTasksSection) continue;
			const match = line.match(/^(\s*)-\s+\[([ xX])\]\s+(.+)$/);
			if (!match) continue;
			const text = match[3]?.trim();
			if (!text) continue;
			tasks.push({
				text,
				done: match[2]?.toLowerCase() === "x",
				level: Math.floor((match[1]?.length ?? 0) / 2),
			});
		}
		return tasks;
	}

	private _createPlanFile(name?: string): string {
		mkdirSync(PLANS_DIR, { recursive: true });

		const now = new Date();
		const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const safeName = name
			? `-${name
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "")}`
			: "";
		const fileName = `${timestamp}${safeName}.md`;
		const filePath = join(PLANS_DIR, fileName);

		const displayName = name ?? "untitled";
		const isoNow = now.toISOString();

		const content = [
			`# Plan: ${displayName}`,
			`> Created: ${isoNow}`,
			`> Status: planning`,
			``,
			`## Overview`,
			``,
			`<!-- AI: describe what needs to be done -->`,
			``,
			`## Tasks`,
			``,
			`<!-- AI: list tasks as checkboxes -->`,
			`- [ ] Task 1`,
			``,
			`## Notes`,
			``,
			`<!-- AI: relevant findings, design decisions, open questions -->`,
			``,
		].join("\n");

		writeFileSync(filePath, content, "utf-8");
		return filePath;
	}
}
