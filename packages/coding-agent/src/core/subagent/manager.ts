import { randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "../extensions/types.js";
import type {
	SubagentEvent,
	SubagentEventListener,
	SubagentResult,
	SubagentRunOptions,
	SubagentTask,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_TASKS = 3;

/**
 * Factory function that creates an AgentSession for a subagent.
 * The bundled extension provides this, wiring in auth, model registry,
 * settings, and a NullResourceLoader. This avoids circular imports between
 * the subagent module and sdk.ts.
 */
export type SubagentSessionFactory = (options: {
	cwd: string;
	systemPrompt: string;
	tools: string[];
	customTools?: ToolDefinition[];
	model?: Model<any>;
}) => Promise<{
	prompt(text: string): Promise<void>;
	getMessages(): Array<{
		role: string;
		content?: Array<{ type: string; text?: string }>;
		usage?: { input: number; output: number };
		stopReason?: string;
		errorMessage?: string;
	}>;
	subscribe(listener: (event: { type: string; text?: string }) => void): () => void;
}>;

export class SubagentManager {
	private _tasks = new Map<string, SubagentTask>();
	private _abortControllers = new Map<string, AbortController>();
	private _listeners: SubagentEventListener[] = [];
	private _runningCount = 0;
	private _sessionFactory: SubagentSessionFactory;

	constructor(sessionFactory: SubagentSessionFactory) {
		this._sessionFactory = sessionFactory;
	}

	get tasks(): ReadonlyMap<string, SubagentTask> {
		return this._tasks;
	}

	get runningCount(): number {
		return this._runningCount;
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
		while (this._runningCount >= MAX_CONCURRENT_TASKS) {
			await new Promise((r) => setTimeout(r, 200));
		}

		const taskId = randomUUID().slice(0, 8);
		const task: SubagentTask = {
			id: taskId,
			label: options.label,
			status: "running",
			startedAt: Date.now(),
			agentName: options.agent?.name,
			inputTokens: 0,
			outputTokens: 0,
			savedTokens: 0,
		};
		this._tasks.set(taskId, task);
		this._runningCount++;

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

		const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
		const timer = setTimeout(() => abortController.abort(new Error("Sub-agent timed out")), timeoutMs);

		this._emit({ type: "task_start", task: { ...task } });

		try {
			const result = await this._execute(options);

			task.status = "done";
			task.completedAt = Date.now();
			task.inputTokens = result.inputTokens;
			task.outputTokens = result.outputTokens;
			task.savedTokens = result.savedTokens;
			task.result = result.text;

			this._emit({ type: "task_complete", task: { ...task } });
			return result;
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
		return [...this._tasks.values()].filter((t) => t.status === "running" || t.status === "background");
	}

	getRecentTasks(maxAge: number = 60_000): SubagentTask[] {
		const cutoff = Date.now() - maxAge;
		return [...this._tasks.values()].filter(
			(t) => t.status === "running" || t.status === "background" || (t.completedAt && t.completedAt > cutoff),
		);
	}

	private async _execute(options: SubagentRunOptions): Promise<SubagentResult> {
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
			"Use the returned files/ranges to choose targeted read calls. Avoid long broad exploration with ls/find/grep/read before fast_context.";

		const toolNames = options.tools ??
			options.agent?.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls", "fast_context"];

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
		});

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update" && options.onProgress && event.text) {
				options.onProgress(event.text);
			}
		});

		try {
			await session.prompt(options.instructions);

			const messages = session.getMessages();
			let resultText = "";
			let inputTokens = 0;
			let outputTokens = 0;

			for (const msg of messages) {
				if (msg.role === "assistant" && msg.usage) {
					inputTokens += msg.usage.input;
					outputTokens += msg.usage.output;
				}
			}

			const lastMessage = messages[messages.length - 1];
			if (lastMessage?.role === "assistant") {
				if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
					throw new Error(lastMessage.errorMessage || `Sub-agent ${lastMessage.stopReason}`);
				}
				for (const content of lastMessage.content ?? []) {
					if (content.type === "text" && content.text) {
						resultText += content.text;
					}
				}
			}

			if (!resultText) {
				throw new Error("Sub-agent produced no text output");
			}

			const summaryTokens = Math.ceil(resultText.length / 4);
			const savedTokens = Math.max(0, inputTokens + outputTokens - summaryTokens);

			return {
				text: resultText.trim(),
				inputTokens,
				outputTokens,
				savedTokens,
			};
		} finally {
			unsubscribe();
		}
	}
}
