import type { Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../extensions/types.js";
import type { PermissionAskCallback } from "../permissions.js";

// ============================================================================
// Task lifecycle
// ============================================================================

export type SubagentTaskStatus = "pending" | "running" | "done" | "error" | "background";

export interface SubagentTask {
	id: string;
	label: string;
	status: SubagentTaskStatus;
	startedAt: number;
	completedAt?: number;
	agentName?: string;
	inputTokens: number;
	outputTokens: number;
	savedTokens: number;
	result?: string;
	error?: string;
	/** true if the task ended due to timeout but produced a partial result. */
	timedOut?: boolean;
	/** true if the task ended due to timeout/cancellation but produced a partial result. */
	interrupted?: boolean;
	/** Last 5 human-readable activity descriptions (newest last). */
	recentActivities?: string[];
}

// ============================================================================
// Custom agent definitions (.pi/agents/*.md)
// ============================================================================

export interface SubagentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	mcpTools?: string[];
	model?: string;
	/** File path the config was loaded from. */
	sourcePath: string;
	/** Whether this is a project-level or user-level agent. */
	source: "project" | "user";
}

// ============================================================================
// Run options
// ============================================================================

export interface SubagentRunOptions {
	instructions: string;
	label: string;
	cwd: string;
	agent?: SubagentConfig;
	/** Override built-in tool set. Defaults to all tools when absent. */
	tools?: string[];
	/** MCP tool definitions from the parent session to pass through. */
	parentMcpTools?: ToolDefinition[];
	/** Override model. When absent the parent model is used. */
	model?: Model<any>;
	/** Parent session permission prompt callback, scoped to the tab that launched this sub-agent. */
	permissionAsk?: PermissionAskCallback;
	/** Timeout in ms. Default: 5 minutes. */
	timeout?: number;
	signal?: AbortSignal;
	onProgress?: (chunk: string) => void;
}

export interface SubagentResult {
	text: string;
	inputTokens: number;
	outputTokens: number;
	savedTokens: number;
	/** true if the sub-agent timed out but returned partial output. */
	timedOut?: boolean;
	/** true if the sub-agent was interrupted but returned partial output. */
	interrupted?: boolean;
}

// ============================================================================
// Events
// ============================================================================

export type SubagentEvent =
	| { type: "task_start"; task: SubagentTask }
	| { type: "task_progress"; taskId: string; chunk: string }
	| { type: "task_complete"; task: SubagentTask }
	| { type: "task_error"; taskId: string; error: string };

export type SubagentEventListener = (event: SubagentEvent) => void;
