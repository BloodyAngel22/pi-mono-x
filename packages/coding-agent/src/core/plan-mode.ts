/**
 * Plan mode management.
 *
 * When active, the agent is restricted to read-only tools + writing to ~/tmp/.pi/plans/.
 * The agent writes a structured plan file that gets passed as context when /execute is run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLANS_DIR = join(homedir(), "tmp", ".pi", "plans");

export interface PlanModeState {
	active: boolean;
	planFilePath: string | undefined;
	planName: string | undefined;
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
## PLAN MODE

You are currently in PLAN MODE. In this mode:

1. **DO NOT** execute bash commands, write files, or edit files (outside of the plan file below).
2. **DO** read source files, search the codebase, and look up documentation.
3. **DO** create and update the plan file at: \`${this._planFilePath}\`

Your task is to analyze the codebase and write a detailed implementation plan.
The plan file uses this format:

\`\`\`markdown
# Plan: <name>
> Created: <timestamp>
> Status: planning

## Overview
<Brief description of what needs to be done>

## Tasks
- [ ] Task 1: description
  - [ ] Subtask 1.1
- [ ] Task 2: description

## Notes
<Relevant findings, design decisions, etc.>
\`\`\`

Update the plan file as you learn more. When done planning, inform the user.
The user will run /execute to start executing the plan.
`.trim();
	}

	/**
	 * Returns a message to inject at the start of an /execute session,
	 * instructing the agent to follow the plan.
	 */
	buildExecuteMessage(): string {
		if (!this._planFilePath) return "";
		return `Execute the plan at \`${this._planFilePath}\`. Read the plan file first, then implement each task in order, checking them off as you complete them (update the status field to "executing" and then "done"). Ask me if you need clarification on any task.`;
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
