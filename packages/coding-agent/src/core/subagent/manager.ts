import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../extensions/types.js";
import type { PermissionAskCallback } from "../permissions.js";
import type {
	SubagentConfig,
	SubagentEvent,
	SubagentEventListener,
	SubagentResult,
	SubagentRunOptions,
	SubagentTask,
	SubagentToolCallEntry,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_TASKS = 3;
const MAX_RECENT_ACTIVITIES = 5;
const MAX_PARTIAL_RESULT_CHARS = 6000;
const MAX_PARTIAL_TOOL_SNIPPET_CHARS = 1200;
const MAX_TOOL_CALL_ENTRIES = 20;
const MIN_CONCURRENCY_LIMIT = 1;
const MAX_CONCURRENCY_LIMIT = 10;
const MIN_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const QUEUE_POLL_INTERVAL_MS = 200;

function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Best-effort text extraction from a tool result/partialResult of unknown shape. */
function extractResultText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "object" && "content" in (value as Record<string, unknown>)) {
		const content = (value as { content?: unknown }).content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: string; text?: string } => typeof c === "object" && c !== null && "type" in c)
				.filter((c) => c.type === "text" && c.text)
				.map((c) => c.text ?? "")
				.join("\n")
				.trim();
		}
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatToolActivity(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "fast_context":
			return `fast_context "${String(args.query ?? "?").slice(0, 60)}"`;
		case "bash":
			return `bash: ${String(args.command ?? "?").slice(0, 80)}`;
		case "read":
			return `read: ${String(args.path ?? "?")}`;
		case "grep":
			return `grep: ${String(args.query ?? args.pattern ?? "?").slice(0, 60)}`;
		case "find":
			return `find: ${String(args.pattern ?? args.query ?? "?").slice(0, 60)}`;
		case "write":
			return `write: ${String(args.path ?? "?")}`;
		case "edit":
			return `edit: ${String(args.path ?? "?")}`;
		case "ls":
			return `ls: ${String(args.path ?? ".")}`;
		default:
			if (toolName.includes("_")) return `mcp: ${toolName}`;
			return `${toolName}`;
	}
}

/**
 * Factory function that creates an AgentSession for a subagent.
 * The bundled extension provides this, wiring in auth, model registry,
 * settings, and a NullResourceLoader. This avoids circular imports between
 * the subagent module and sdk.ts.
 */
export type SubagentSessionMessage = {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	usage?: { input: number; output: number };
	stopReason?: string;
	errorMessage?: string;
	toolName?: string;
	isError?: boolean;
};

export type SubagentSessionFactory = (options: {
	cwd: string;
	systemPrompt: string;
	tools: string[];
	customTools?: ToolDefinition[];
	model?: Model<any>;
	permissionAsk?: PermissionAskCallback;
}) => Promise<{
	prompt(text: string): Promise<void>;
	getMessages(): SubagentSessionMessage[];
	subscribe(listener: (event: { type: string; text?: string }) => void): () => void;
	subscribeAgentEvents?(
		listener: (event: {
			type: string;
			toolCallId?: string;
			toolName?: string;
			args?: Record<string, unknown>;
			result?: unknown;
			partialResult?: unknown;
			isError?: boolean;
		}) => void,
	): () => void;
	abort?(): void;
}>;

export class SubagentManager {
	private _tasks = new Map<string, SubagentTask>();
	private _abortControllers = new Map<string, AbortController>();
	private _listeners: SubagentEventListener[] = [];
	private _runningCount = 0;
	private _sessionFactory: SubagentSessionFactory;
	private _concurrencyLimit = MAX_CONCURRENT_TASKS;
	private _defaultTimeoutMs = DEFAULT_TIMEOUT_MS;
	private _agents: SubagentConfig[] = [];

	constructor(sessionFactory: SubagentSessionFactory) {
		this._sessionFactory = sessionFactory;
	}

	get tasks(): ReadonlyMap<string, SubagentTask> {
		return this._tasks;
	}

	get runningCount(): number {
		return this._runningCount;
	}

	setConcurrencyLimit(limit: number): void {
		this._concurrencyLimit = Math.min(MAX_CONCURRENCY_LIMIT, Math.max(MIN_CONCURRENCY_LIMIT, Math.round(limit)));
	}

	getConcurrencyLimit(): number {
		return this._concurrencyLimit;
	}

	setDefaultTimeout(ms: number): void {
		this._defaultTimeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)));
	}

	getDefaultTimeout(): number {
		return this._defaultTimeoutMs;
	}

	setAgents(agents: SubagentConfig[]): void {
		this._agents = agents;
	}

	getAgents(): SubagentConfig[] {
		return this._agents;
	}

	onEvent(listener: SubagentEventListener): () => void {
		this._listeners.push(listener);
		return () => {
			const idx = this._listeners.indexOf(listener);
			if (idx !== -1) this._listeners.splice(idx, 1);
		};
	}

	private _emit(event: SubagentEvent): void {
		for (const listener of this._listeners) {
			try {
				listener(event);
			} catch {
				// ignore listener errors
			}
		}
	}

	async run(options: SubagentRunOptions): Promise<SubagentResult> {
		const taskId = randomUUID().slice(0, 8);
		const task: SubagentTask = {
			id: taskId,
			label: options.label,
			status: "queued",
			startedAt: Date.now(),
			queuedAt: Date.now(),
			agentName: options.agent?.name,
			inputTokens: 0,
			outputTokens: 0,
			savedTokens: 0,
		};
		this._tasks.set(taskId, task);

		const abortController = new AbortController();
		this._abortControllers.set(taskId, abortController);

		if (options.signal) {
			if (options.signal.aborted) {
				abortController.abort(options.signal.reason);
			} else {
				options.signal.addEventListener("abort", () => abortController.abort(options.signal!.reason), {
					once: true,
				});
			}
		}

		this._emit({ type: "task_queued", task: { ...task } });
		options.onStatusChange?.({ ...task });

		const failQueuedCancellation = (): never => {
			const message =
				abortController.signal.reason instanceof Error
					? abortController.signal.reason.message
					: "Task cancelled by user";
			task.status = "error";
			task.completedAt = Date.now();
			task.error = message;
			this._abortControllers.delete(taskId);
			this._emit({ type: "task_error", taskId, error: message });
			throw new Error(message);
		};

		// Wait for a concurrency slot, reacting immediately to cancellation instead of
		// waiting out the next poll tick.
		while (this._runningCount >= this._concurrencyLimit) {
			if (abortController.signal.aborted) failQueuedCancellation();
			await Promise.race([
				new Promise((r) => setTimeout(r, QUEUE_POLL_INTERVAL_MS)),
				new Promise<void>((resolve) =>
					abortController.signal.addEventListener("abort", () => resolve(), { once: true }),
				),
			]);
		}

		if (abortController.signal.aborted) failQueuedCancellation();

		task.status = "running";
		task.startedAt = Date.now();
		this._runningCount++;

		const timeoutMs = options.timeout ?? this._defaultTimeoutMs;
		const timer = setTimeout(() => abortController.abort(new Error("Sub-agent timed out")), timeoutMs);

		this._emit({ type: "task_start", task: { ...task } });
		options.onStatusChange?.({ ...task });

		try {
			const result = await this._execute(options, abortController.signal, task);

			task.status = "done";
			task.completedAt = Date.now();
			task.inputTokens = result.inputTokens;
			task.outputTokens = result.outputTokens;
			task.savedTokens = result.savedTokens;
			task.result = result.text;
			task.timedOut = result.timedOut;
			task.interrupted = result.interrupted;

			this._emit({ type: "task_complete", task: { ...task } });
			return { ...result, taskId };
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			task.status = "error";
			task.completedAt = Date.now();
			task.error = message;

			this._emit({ type: "task_error", taskId, error: message });
			throw err;
		} finally {
			clearTimeout(timer);
			this._abortControllers.delete(taskId);
			this._runningCount--;
		}
	}

	cancelTask(taskId: string): boolean {
		const controller = this._abortControllers.get(taskId);
		if (controller) {
			controller.abort(new Error("Task cancelled by user"));
			return true;
		}
		return false;
	}

	backgroundTask(taskId: string): boolean {
		const task = this._tasks.get(taskId);
		if (task && task.status === "running") {
			task.status = "background";
			return true;
		}
		return false;
	}

	getActiveTasks(): SubagentTask[] {
		return [...this._tasks.values()].filter(
			(t) => t.status === "running" || t.status === "background" || t.status === "queued",
		);
	}

	getRecentTasks(maxAge: number = 60_000): SubagentTask[] {
		const cutoff = Date.now() - maxAge;
		return [...this._tasks.values()].filter(
			(t) =>
				t.status === "running" ||
				t.status === "background" ||
				t.status === "queued" ||
				(t.completedAt && t.completedAt > cutoff),
		);
	}

	private async _execute(
		options: SubagentRunOptions,
		signal: AbortSignal,
		task: SubagentTask,
	): Promise<Omit<SubagentResult, "taskId">> {
		let systemPrompt: string;
		if (options.agent?.systemPrompt) {
			systemPrompt =
				options.agent.systemPrompt +
				`\n\nCurrent working directory: ${options.cwd}` +
				`\nCurrent date: ${new Date().toISOString().slice(0, 10)}`;
		} else {
			systemPrompt =
				"You are a sub-agent executing a specific task. Complete the task and provide a clear, concise result." +
				" Focus only on what was asked. Do not explain your process." +
				`\n\nCurrent working directory: ${options.cwd}` +
				`\nCurrent date: ${new Date().toISOString().slice(0, 10)}`;
		}
		systemPrompt +=
			"\n\nCodebase search policy: if you need to locate relevant code and the exact file is not already known, call fast_context first. " +
			"Use the returned files/ranges to choose targeted read calls. Avoid long broad exploration with ls/find/grep/read before fast_context." +
			"\nWeb fetch policy: use web_search for quick web lookups or URL reads when MCP web tools are unavailable, slow, or unnecessary.";

		// NOTE: recursive sub-agents are intentionally unsupported — "task" is deliberately
		// absent from this default tool set and must not be added without a depth-limit design.
		const toolNames = options.tools ??
			options.agent?.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls", "fast_context", "web_search"];

		// Filter MCP tools by agent glob patterns
		const customTools: ToolDefinition[] = [];
		if (options.parentMcpTools) {
			const mcpPatterns = options.agent?.mcpTools;
			for (const tool of options.parentMcpTools) {
				if (mcpPatterns && mcpPatterns.length > 0) {
					const match = mcpPatterns.some((pattern) => {
						if (pattern.endsWith("*")) {
							return tool.name.startsWith(pattern.slice(0, -1));
						}
						return tool.name === pattern;
					});
					if (!match) continue;
				}
				customTools.push(tool);
			}
		}

		const session = await this._sessionFactory({
			cwd: options.cwd,
			systemPrompt,
			tools: toolNames,
			customTools: customTools.length > 0 ? customTools : undefined,
			model: options.model,
			permissionAsk: options.permissionAsk,
		});

		const reportToolActivity = (toolName: string | undefined, args: Record<string, unknown> | undefined) => {
			if (!toolName || !args) return;
			const activity = formatToolActivity(toolName, args);
			if (!task.recentActivities) task.recentActivities = [];
			task.recentActivities.push(activity);
			if (task.recentActivities.length > MAX_RECENT_ACTIVITIES) {
				task.recentActivities = task.recentActivities.slice(-MAX_RECENT_ACTIVITIES);
			}
			this._emit({ type: "task_progress", taskId: task.id, chunk: activity });
			options.onProgress?.(activity);
		};

		const upsertToolCallEntry = (
			toolCallId: string | undefined,
			patch: Partial<SubagentToolCallEntry> & { toolName?: string },
		): void => {
			if (!toolCallId) return;
			if (!task.toolCalls) task.toolCalls = [];
			let entry = task.toolCalls.find((e) => e.toolCallId === toolCallId);
			if (!entry) {
				entry = {
					toolCallId,
					toolName: patch.toolName ?? "unknown",
					status: "running",
					startedAt: Date.now(),
				};
				task.toolCalls.push(entry);
				// Evict oldest completed entries first, never a still-running one.
				if (task.toolCalls.length > MAX_TOOL_CALL_ENTRIES) {
					const completedIdx = task.toolCalls.findIndex((e) => e.status !== "running");
					if (completedIdx !== -1) task.toolCalls.splice(completedIdx, 1);
				}
			}
			Object.assign(entry, patch);
			options.onToolCallUpdate?.({ ...entry });
		};

		const unsubscribeAgent = session.subscribeAgentEvents?.((event) => {
			if (event.type === "tool_execution_start") {
				reportToolActivity(event.toolName, event.args);
				upsertToolCallEntry(event.toolCallId, {
					toolName: event.toolName,
					args: event.args,
					status: "running",
					startedAt: Date.now(),
				});
			} else if (event.type === "tool_execution_update") {
				upsertToolCallEntry(event.toolCallId, {
					output: truncateText(
						compactWhitespace(extractResultText(event.partialResult)),
						MAX_PARTIAL_TOOL_SNIPPET_CHARS,
					),
				});
			} else if (event.type === "tool_execution_end") {
				upsertToolCallEntry(event.toolCallId, {
					status: event.isError ? "error" : "done",
					output: truncateText(compactWhitespace(extractResultText(event.result)), MAX_PARTIAL_TOOL_SNIPPET_CHARS),
					completedAt: Date.now(),
				});
			}
		});

		const throwAbortReason = (): never => {
			const reason = signal.reason;
			if (reason instanceof Error) throw reason;
			if (typeof reason === "string" && reason.length > 0) throw new Error(reason);
			throw new Error("Sub-agent aborted");
		};

		const abortPrompt = () => {
			session.abort?.();
		};

		let cleanupAbortListener: (() => void) | undefined;

		const isTimeoutAbort = (): boolean => {
			const reason = signal.reason;
			if (reason instanceof Error) return reason.message === "Sub-agent timed out";
			return reason === "Sub-agent timed out";
		};

		const buildCollectedToolOutput = (messages: ReturnType<typeof session.getMessages>): string => {
			const sections: string[] = [];

			if (task.recentActivities?.length) {
				sections.push(
					["Recent sub-agent activity:", ...task.recentActivities.map((activity) => `- ${activity}`)].join("\n"),
				);
			}

			const toolMessages = messages.filter((msg) => msg.role === "toolResult" && !msg.isError);
			for (const msg of toolMessages.slice(-6)) {
				const text = (msg.content ?? [])
					.filter((content) => content.type === "text" && content.text)
					.map((content) => content.text ?? "")
					.join("\n")
					.trim();
				if (!text) continue;

				const toolName = msg.toolName ? ` from ${msg.toolName}` : "";
				sections.push(
					`Collected output${toolName}:\n${truncateText(compactWhitespace(text), MAX_PARTIAL_TOOL_SNIPPET_CHARS)}`,
				);
			}

			if (sections.length === 0) return "";
			return `Partial findings before timeout/cancellation. The sub-agent did not produce a final summary, so this is compacted from completed tool calls.\n\n${truncateText(sections.join("\n\n"), MAX_PARTIAL_RESULT_CHARS)}`;
		};

		const buildResultFromMessages = (interrupted = false): Omit<SubagentResult, "taskId"> | undefined => {
			const messages = session.getMessages();
			let inputTokens = 0;
			let outputTokens = 0;

			for (const msg of messages) {
				if (msg.role === "assistant" && msg.usage) {
					inputTokens += msg.usage.input;
					outputTokens += msg.usage.output;
				}
			}

			const lastAssistant = [...messages].reverse().find((msg) => msg.role === "assistant");
			let resultText = "";
			for (const content of lastAssistant?.content ?? []) {
				if (content.type === "text" && content.text) {
					resultText += content.text;
				}
			}

			const assistantText = resultText.trim();
			const fallbackText = interrupted && !assistantText ? buildCollectedToolOutput(messages) : "";
			const trimmedText = assistantText || fallbackText.trim();
			if (!trimmedText) return undefined;

			const summaryTokens = Math.ceil(trimmedText.length / 4);
			const savedTokens = Math.max(0, inputTokens + outputTokens - summaryTokens);

			const wasInterrupted = interrupted || lastAssistant?.stopReason === "aborted";
			const timedOut = wasInterrupted && isTimeoutAbort();

			return {
				text: trimmedText,
				inputTokens,
				outputTokens,
				savedTokens,
				interrupted: wasInterrupted || undefined,
				timedOut: timedOut || undefined,
			};
		};

		const waitForPromptSettle = async (promptPromise: Promise<void>): Promise<void> => {
			await Promise.race([
				promptPromise.catch(() => undefined),
				new Promise<void>((resolve) => setTimeout(resolve, 100)),
			]);
		};

		try {
			if (signal.aborted) {
				abortPrompt();
				throwAbortReason();
			}

			const abortPromise = new Promise<never>((_resolve, reject) => {
				const onAbort = () => {
					abortPrompt();
					const reason = signal.reason;
					if (reason instanceof Error) {
						reject(reason);
					} else if (typeof reason === "string" && reason.length > 0) {
						reject(new Error(reason));
					} else {
						reject(new Error("Sub-agent aborted"));
					}
				};
				signal.addEventListener("abort", onAbort, { once: true });
				cleanupAbortListener = () => signal.removeEventListener("abort", onAbort);
			});

			const promptPromise = session.prompt(options.instructions);

			try {
				await Promise.race([promptPromise, abortPromise]);
			} catch (err: unknown) {
				if (!signal.aborted) throw err;

				await waitForPromptSettle(promptPromise);
				const partialResult = buildResultFromMessages(true);
				if (partialResult) return partialResult;

				throw err;
			}

			const messages = session.getMessages();
			const lastAssistant = [...messages].reverse().find((msg) => msg.role === "assistant");
			const result = buildResultFromMessages(lastAssistant?.stopReason === "aborted");

			if (lastAssistant?.stopReason === "error") {
				throw new Error(lastAssistant.errorMessage || "Sub-agent error");
			}

			if (lastAssistant?.stopReason === "aborted") {
				if (result) return result;
				throw new Error(lastAssistant.errorMessage || "Sub-agent aborted");
			}

			if (!result) {
				throw new Error("Sub-agent produced no text output");
			}

			return result;
		} finally {
			cleanupAbortListener?.();
			unsubscribeAgent?.();
		}
	}
}

/** Global registry so RPC mode can access the manager without importing the extension. */
let _globalManager: SubagentManager | undefined;

export function setGlobalSubagentManager(mgr: SubagentManager | undefined): void {
	_globalManager = mgr;
}

export function getGlobalSubagentManager(): SubagentManager | undefined {
	return _globalManager;
}
