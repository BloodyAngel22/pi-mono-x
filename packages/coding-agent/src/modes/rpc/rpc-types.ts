/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentPresetConfig, SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { FastContextResult } from "../../core/context-search.js";
import type { PlanModeState } from "../../core/plan-mode.js";
import type { SessionTreeNode } from "../../core/session-manager.js";
import type { SourceInfo } from "../../core/source-info.js";
import type { SubagentConfig, SubagentTask } from "../../core/subagent/types.js";
import type { WebSearchToolDetails } from "../../core/tools/index.js";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	(
		| {
				id?: string;
				type: "prompt";
				message: string;
				images?: ImageContent[];
				streamingBehavior?: "steer" | "followUp";
		  }
		| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
		| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
		| { id?: string; type: "btw"; question: string }
		| { id?: string; type: "fast_context"; query: string; path?: string }
		| {
				id?: string;
				type: "web_search";
				query: string;
				mode?: "search" | "url";
				maxResults?: number;
				timeoutMs?: number;
		  }
		| { id?: string; type: "abort" }
		| { id?: string; type: "new_session"; parentSession?: string }

		// State
		| { id?: string; type: "get_state" }
		| { id?: string; type: "cd"; path: string }
		| { id?: string; type: "pwd" }
		| { id?: string; type: "ls"; path?: string }
		| { id?: string; type: "get_mcp_status" }

		// Model
		| { id?: string; type: "set_model"; provider: string; modelId: string }
		| { id?: string; type: "cycle_model" }
		| { id?: string; type: "get_available_models" }

		// Thinking
		| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
		| { id?: string; type: "cycle_thinking_level" }

		// Queue modes
		| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
		| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

		// Agent presets
		| { id?: string; type: "load_agent_preset"; presetName: string }
		| { id?: string; type: "set_custom_instructions"; instructions: string }

		// Compaction
		| { id?: string; type: "compact"; customInstructions?: string }
		| { id?: string; type: "set_auto_compaction"; enabled: boolean }
		| { id?: string; type: "set_context_pruning"; enabled: boolean }
		| { id?: string; type: "set_file_manifest"; enabled: boolean }

		// Notifications
		| { id?: string; type: "set_notification_enabled"; enabled: boolean }
		| { id?: string; type: "set_notification_sound_enabled"; enabled: boolean }
		| { id?: string; type: "set_notification_sound_path"; path?: string }

		// Plan mode
		| { id?: string; type: "enter_plan_mode"; name?: string }
		| { id?: string; type: "exit_plan_mode" }

		// Retry
		| { id?: string; type: "set_auto_retry"; enabled: boolean }
		| { id?: string; type: "abort_retry" }

		// Bash
		| { id?: string; type: "bash"; command: string }
		| { id?: string; type: "abort_bash" }

		// Session
		| { id?: string; type: "get_session_stats" }
		| { id?: string; type: "export_html"; outputPath?: string }
		| { id?: string; type: "switch_session"; sessionPath: string }
		| {
				id?: string;
				type: "navigate_tree";
				targetId: string;
				summarize?: boolean;
				customInstructions?: string;
				replaceInstructions?: boolean;
				label?: string;
				exact?: boolean;
		  }
		| { id?: string; type: "fork"; entryId: string; position?: "at" | "before" }
		| { id?: string; type: "clone" }
		| { id?: string; type: "get_fork_messages" }
		| { id?: string; type: "get_last_assistant_text" }
		| { id?: string; type: "set_session_name"; name: string }
		| { id?: string; type: "get_file_checkpoint_status" }
		| { id?: string; type: "get_file_checkpoint_turn_status"; turnIndex: number }
		| { id?: string; type: "restore_file_changes_to_turn"; turnIndex: number }
		| { id?: string; type: "get_session_tree" }

		// Messages
		| { id?: string; type: "get_messages" }
		| { id?: string; type: "get_full_history" }

		// Commands and skills (available for invocation via prompt)
		| { id?: string; type: "get_commands" }
		| { id?: string; type: "get_skill_detail"; name: string }
		| { id?: string; type: "get_command_detail"; name: string }
		| { id?: string; type: "suggest_skills"; query: string; limit?: number; minScore?: number }

		// Sub-agents
		| { id?: string; type: "get_subagent_tasks" }
		| { id?: string; type: "cancel_task"; taskId: string }
		| { id?: string; type: "background_task"; taskId: string }
		| { id?: string; type: "set_subagent_concurrency"; limit: number }
		| { id?: string; type: "set_subagent_timeout"; timeoutMs: number }

		// Custom sub-agent definitions (.pi/agents/*.md)
		| { id?: string; type: "list_agents" }
		| { id?: string; type: "get_agent"; name: string }
		| {
				id?: string;
				type: "save_agent";
				name: string;
				description: string;
				systemPrompt: string;
				tools?: string[];
				mcpTools?: string[];
				model?: string;
				source: "project" | "user";
				/** Present when renaming an existing agent — the old file is removed after the new one is written. */
				originalName?: string;
		  }
		| { id?: string; type: "delete_agent"; name: string; source: "project" | "user" }

		// Multi-session
		| {
				id?: string;
				type: "create_session";
				cwd?: string;
				mode?: "empty" | "copy";
				sourceSessionId?: string;
				sessionPath?: string;
		  }
		| { id?: string; type: "switch_active_session"; sessionId: string }
		| { id?: string; type: "close_session"; sessionId: string }
		| { id?: string; type: "list_sessions" }
	) & { sessionId?: string };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Optional categories for skill commands. */
	categories?: string[];
	/** Friendly location derived from sourceInfo.scope for skill commands. */
	location?: "user" | "project" | "path";
	/** Filesystem path for skill commands. */
	path?: string;
	/** What kind of command this is */
	source: "extension" | "markdown" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	contextPruningEnabled: boolean;
	fileManifestEnabled: boolean;
	notificationEnabled: boolean;
	notificationSoundEnabled: boolean;
	notificationSoundPath?: string;
	autoRetryEnabled: boolean;
	isRetrying: boolean;
	retryAttempt: number;
	messageCount: number;
	pendingMessageCount: number;
	cwd?: string;
	planMode: PlanModeState;
	subagentConcurrencyLimit: number;
	subagentDefaultTimeoutMs: number;
}

// ============================================================================
// RPC MCP Status
// ============================================================================

export interface RpcMcpToolInfo {
	name: string;
	description?: string;
}

export interface RpcMcpServerStatus {
	name: string;
	status: "connected" | "connecting" | "retrying" | "error" | "disabled";
	error?: string;
	attempt?: number;
	nextRetryAt?: number;
	tools: RpcMcpToolInfo[];
}

export interface RpcMcpStatusResult {
	servers: RpcMcpServerStatus[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "btw"; success: true; data: { answer: string } }
	| { id?: string; type: "response"; command: "fast_context"; success: true; data: FastContextResult }
	| {
			id?: string;
			type: "response";
			command: "web_search";
			success: true;
			data: { text: string; details: WebSearchToolDetails | undefined };
	  }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// Multi-session
	| { id?: string; type: "response"; command: "create_session"; success: true; data: { sessionId: string } }
	| { id?: string; type: "response"; command: "switch_active_session"; success: true }
	| { id?: string; type: "response"; command: "close_session"; success: true }
	| {
			id?: string;
			type: "response";
			command: "list_sessions";
			success: true;
			data: {
				sessions: Array<{
					sessionId: string;
					name?: string;
					messageCount: number;
					isActive: boolean;
					cwd?: string;
					isStreaming: boolean;
				}>;
			};
	  }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "cd";
			success: true;
			data: { cwd: string; displayPath: string; entries: string };
	  }
	| { id?: string; type: "response"; command: "pwd"; success: true; data: { cwd: string } }
	| {
			id?: string;
			type: "response";
			command: "ls";
			success: true;
			data: { path: string; displayPath: string; entries: string };
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Agent presets
	| { id?: string; type: "response"; command: "load_agent_preset"; success: true; data: AgentPresetConfig }
	| { id?: string; type: "response"; command: "set_custom_instructions"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }
	| { id?: string; type: "response"; command: "set_context_pruning"; success: true }
	| { id?: string; type: "response"; command: "set_file_manifest"; success: true }
	| { id?: string; type: "response"; command: "set_notification_enabled"; success: true }
	| { id?: string; type: "response"; command: "set_notification_sound_enabled"; success: true }
	| { id?: string; type: "response"; command: "set_notification_sound_path"; success: true }

	// Plan mode
	| { id?: string; type: "response"; command: "enter_plan_mode"; success: true; data: { planFilePath: string } }
	| { id?: string; type: "response"; command: "exit_plan_mode"; success: true; data: { planFilePath?: string } }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "navigate_tree"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_session_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_file_checkpoint_status";
			success: true;
			data: { modified: string[]; created: string[] } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_file_checkpoint_turn_status";
			success: true;
			data: { modified: string[]; created: string[] } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "restore_file_changes_to_turn";
			success: true;
			data: { restored: string[]; deleted: string[]; errors: string[] } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| {
			id?: string;
			type: "response";
			command: "get_full_history";
			success: true;
			data: { messages: AgentMessage[] };
	  }

	// Commands and skills
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_skill_detail";
			success: true;
			data: {
				name: string;
				description: string;
				categories: string[];
				path: string;
				baseDir: string;
				content: string;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "get_command_detail";
			success: true;
			data: {
				name: string;
				description: string;
				path: string;
				content: string;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "suggest_skills";
			success: true;
			data: {
				skills: Array<{
					name: string;
					description: string;
					categories: string[];
					path: string;
					score: number;
					reasons: string[];
				}>;
			};
	  }

	// Sub-agents
	| {
			id?: string;
			type: "response";
			command: "get_subagent_tasks";
			success: true;
			data: { tasks: SubagentTask[] };
	  }
	| { id?: string; type: "response"; command: "cancel_task"; success: true }
	| { id?: string; type: "response"; command: "background_task"; success: true }
	| { id?: string; type: "response"; command: "set_subagent_concurrency"; success: true }
	| { id?: string; type: "response"; command: "set_subagent_timeout"; success: true }

	// Custom sub-agent definitions
	| { id?: string; type: "response"; command: "list_agents"; success: true; data: { agents: SubagentConfig[] } }
	| { id?: string; type: "response"; command: "get_agent"; success: true; data: { agent: SubagentConfig | null } }
	| { id?: string; type: "response"; command: "save_agent"; success: true; data: { agents: SubagentConfig[] } }
	| { id?: string; type: "response"; command: "delete_agent"; success: true; data: { agents: SubagentConfig[] } }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "askUser";
			question: string;
			options: string[];
			allowMultiple: boolean;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "permission";
			permissionType: "bash" | "file" | "mcp";
			permissionValue: string;
			permissionToolName?: string;
			permissionToolArgs?: unknown;
	  }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| {
			type: "extension_ui_response";
			id: string;
			decision: "allow-once" | "allow-always" | "deny-once" | "deny-always";
			scope?: "local" | "global" | "session";
			match?: string;
	  }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
