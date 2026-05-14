/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { completeSimple, type Message } from "@mariozechner/pi-ai";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "../../core/auth-guidance.js";
import { fastContextSearch } from "../../core/context-search.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { createFastFetchToolDefinition } from "../../core/tools/index.js";
import { getTextOutput } from "../../core/tools/render-utils.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.js";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	const expandHome = (p: string): string => {
		const h = os.homedir();
		return p.startsWith("~/") ? h + p.slice(1) : p === "~" ? h : p;
	};

	const shortPath = (p: string): string => {
		const h = os.homedir();
		return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
	};

	const listDir = (dir: string): string => {
		try {
			const all = fs.readdirSync(dir);
			const shown = all.slice(0, 30);
			const formatted = shown.map((entry) => {
				try {
					return fs.statSync(path.resolve(dir, entry)).isDirectory() ? `${entry}/` : entry;
				} catch {
					return entry;
				}
			});
			const suffix = all.length > 30 ? `\n  … (${all.length - 30} more)` : "";
			return formatted.join("  ") + suffix;
		} catch {
			return "(unreadable)";
		}
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		askUser: (question, options = [], allowMultiple = false, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "askUser", question, options, allowMultiple, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		requestRender(): void {
			// TUI re-render not supported in RPC mode
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		session.permissionAsk = async (info) =>
			createDialogPromise(
				undefined,
				{ decision: "deny-once" as const },
				{ method: "permission", permissionType: info.type, permissionValue: info.value },
				(response) => {
					if ("cancelled" in response && response.cancelled) return { decision: "deny-once" as const };
					if ("decision" in response) {
						return {
							decision: response.decision,
							scope: response.scope,
							match: response.match,
						};
					}
					return { decision: "deny-once" as const };
				},
			);
		// Set up event routing first so MCP status events reach the frontend
		// during async initialization (subscribe before bindExtensions resolves).
		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			output(event);
		});
		// Fire extension binding without awaiting — session switch/fork returns
		// immediately; MCPs initialize in the background.
		void session
			.bindExtensions({
				uiContext: createExtensionUIContext(),
				commandContextActions: {
					waitForIdle: () => session.agent.waitForIdle(),
					newSession: async (options) => runtimeHost.newSession(options),
					fork: async (entryId, forkOptions) => {
						const result = await runtimeHost.fork(entryId, forkOptions);
						return { cancelled: result.cancelled };
					},
					navigateTree: async (targetId, options) => {
						const result = await session.navigateTree(targetId, {
							summarize: options?.summarize,
							customInstructions: options?.customInstructions,
							replaceInstructions: options?.replaceInstructions,
							label: options?.label,
						});
						return { cancelled: result.cancelled };
					},
					switchSession: async (sessionPath, options) => {
						return runtimeHost.switchSession(sessionPath, options);
					},
					reload: async () => {
						await session.reload();
					},
				},
				shutdownHandler: () => {
					shutdownRequested = true;
				},
				onError: (err) => {
					output({
						type: "extension_error",
						extensionPath: err.extensionPath,
						event: err.event,
						error: err.error,
					});
				},
			})
			.catch((err: unknown) => {
				output({ type: "extension_error", extensionPath: "<rebind>", event: "session_start", error: String(err) });
			});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// -----------------------------------------------------------------
	// Fast Context / Fetch helpers
	// -----------------------------------------------------------------
	async function runFastContext(query: string) {
		const ui = createExtensionUIContext();
		ui.setStatus("fast-context", "searching...");
		try {
			const result = await fastContextSearch(session.activeCwd, query, { maxFiles: 12, includeSnippets: false });
			ui.setStatus("fast-context", `done: ${result.files.length} files`);
			return result;
		} catch (e) {
			ui.setStatus("fast-context", undefined);
			throw e;
		}
	}

	async function runFastFetch(command: Extract<RpcCommand, { type: "fast_fetch" }>) {
		const ui = createExtensionUIContext();
		ui.setStatus("fast-fetch", "fetching...");
		try {
			const tool = createFastFetchToolDefinition(session.activeCwd, {
				settings: session.settingsManager.getFastFetchSettings(),
			});
			const result = await tool.execute(
				"rpc-fast-fetch",
				{
					query: command.query,
					mode: command.mode,
					maxResults: command.maxResults,
					timeoutMs: command.timeoutMs,
				},
				undefined,
				undefined,
				undefined as never,
			);
			ui.setStatus("fast-fetch", `done: ${result.details?.status ?? "ok"}`);
			return { text: getTextOutput(result, false), details: result.details };
		} catch (e) {
			ui.setStatus("fast-fetch", undefined);
			throw e;
		}
	}

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				const message = command.message;
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "btw": {
				const question = command.question.trim();
				if (!question) {
					return error(id, "btw", "Usage: /btw <question>");
				}
				const model = session.model;
				if (!model) {
					return error(id, "btw", formatNoModelSelectedMessage());
				}
				const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) {
					return error(id, "btw", auth.ok ? formatNoApiKeyFoundMessage(model.provider) : auth.error);
				}
				const contextMessages = session.state.messages.filter(
					(message): message is Message =>
						message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				);
				const messages: Message[] = [
					...contextMessages,
					{
						role: "user",
						content: `Answer this side question briefly. Do not assume it should affect the ongoing task.\n\n${question}`,
						timestamp: Date.now(),
					},
				];
				const response = await completeSimple(
					model,
					{
						systemPrompt: session.systemPrompt,
						messages,
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						reasoning: session.thinkingLevel === "off" ? undefined : session.thinkingLevel,
					},
				);
				const text = response.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("")
					.trim();
				return success(id, "btw", { answer: text || "(no text response)" });
			}

			case "fast_context": {
				const query = command.query.trim();
				if (!query) {
					return error(id, "fast_context", "Usage: fast_context <query>");
				}
				try {
					const result = await runFastContext(query);
					return success(id, "fast_context", result);
				} catch (e) {
					return error(id, "fast_context", (e as Error).message);
				}
			}

			case "fast_fetch": {
				const query = command.query.trim();
				if (!query) {
					return error(id, "fast_fetch", "Usage: fast_fetch <query-or-url>");
				}
				try {
					const result = await runFastFetch(command);
					return success(id, "fast_fetch", result);
				} catch (e) {
					return error(id, "fast_fetch", (e as Error).message);
				}
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					autoRetryEnabled: session.autoRetryEnabled,
					isRetrying: session.isRetrying,
					retryAttempt: session.retryAttempt,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
					cwd: session.activeCwd,
				};
				return success(id, "get_state", state);
			}

			case "pwd": {
				return success(id, "pwd", { cwd: session.activeCwd });
			}

			case "ls": {
				const base = session.activeCwd;
				const dir = command.path ? path.resolve(base, expandHome(command.path)) : base;
				if (!fs.existsSync(dir)) {
					return error(id, "ls", `ls: no such path: ${dir}`);
				}
				return success(id, "ls", { path: dir, displayPath: shortPath(dir), entries: listDir(dir) });
			}

			case "cd": {
				const base = session.activeCwd;
				const arg = command.path.trim();
				if (!arg) {
					return success(id, "cd", { cwd: base, displayPath: shortPath(base), entries: listDir(base) });
				}
				const target = path.resolve(base, expandHome(arg));
				if (!fs.existsSync(target)) {
					return error(id, "cd", `cd: no such directory: ${target}`);
				}
				let isDir = false;
				try {
					isDir = fs.statSync(target).isDirectory();
				} catch {
					isDir = false;
				}
				if (!isDir) {
					return error(id, "cd", `cd: not a directory: ${target}`);
				}
				session.setCwd(target);
				await session.sendCustomMessage({
					customType: "cwd-change",
					content: `[Working directory changed to: ${target}]`,
					display: false,
				});
				return success(id, "cd", { cwd: target, displayPath: shortPath(target), entries: listDir(target) });
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				return success(id, "switch_session", result);
			}

			case "navigate_tree": {
				const result = await session.navigateTree(command.targetId, {
					summarize: command.summarize,
					customInstructions: command.customInstructions,
					replaceInstructions: command.replaceInstructions,
					label: command.label,
					exact: command.exact,
				});
				return success(id, "navigate_tree", result);
			}

			case "get_session_tree": {
				return success(id, "get_session_tree", {
					tree: session.sessionManager.getTree(),
					leafId: session.sessionManager.getLeafId(),
				});
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId, {
					position: command.position,
				});
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_file_checkpoint_status": {
				return success(id, "get_file_checkpoint_status", session.getFileCheckpointStatus());
			}

			case "get_file_checkpoint_turn_status": {
				return success(
					id,
					"get_file_checkpoint_turn_status",
					session.getFileCheckpointTurnStatus(command.turnIndex),
				);
			}

			case "restore_file_changes_to_turn": {
				const result = await session.restoreFileChangesToTurn(command.turnIndex);
				return success(id, "restore_file_changes_to_turn", result);
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				const rawMessages = session.messages;
				const entries = (session.sessionManager as any).getBranch() as Array<{
					type: string;
					message: unknown;
					id: string;
				}>;
				const annotated = rawMessages.map((msg) => {
					const entry = entries.find((e) => e.type === "message" && e.message === msg);
					return entry ? { ...msg, entryId: entry.id } : msg;
				});
				return success(id, "get_messages", { messages: annotated });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const command of session.resourceLoader.getCommands().commands) {
					commands.push({
						name: command.name,
						description: command.description,
						source: "markdown",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		unsubscribe?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
