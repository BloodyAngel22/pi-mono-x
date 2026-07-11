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
import { completeSimple, type Message } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.js";
import type { AgentPresetConfig, AgentSession, AgentSessionEvent } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "../../core/auth-guidance.js";
import { fastContextSearch } from "../../core/context-search.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import { emitSessionShutdownEvent } from "../../core/extensions/runner.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { createAgentSession } from "../../core/sdk.js";
import { SessionManager } from "../../core/session-manager.js";
import { scoreSkillsByRelevance } from "../../core/skills.js";
import { getGlobalSubagentManager } from "../../core/subagent/index.js";
import { createWebSearchToolDefinition } from "../../core/tools/index.js";
import { getTextOutput } from "../../core/tools/render-utils.js";
import { stripFrontmatter } from "../../utils/frontmatter.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcMcpServerStatus,
	RpcMcpStatusResult,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";

// Mirrors bundled-extensions/mcp/index.ts's globalThis registries. Duplicated
// (not imported) because bundled extensions are loaded dynamically per
// session (see core/extensions/loader.ts) and must not be a static import
// dependency of core RPC code. Keep both files in sync manually.
const MCP_SHARED_CLIENTS_KEY = Symbol.for("pi-mono-x.mcp.sharedClients.v1");
const MCP_SESSION_SERVERS_KEY = Symbol.for("pi-mono-x.mcp.sessionServers.v1");

interface McpSharedEntryStatus {
	status: "connected" | "error" | "connecting" | "retrying";
	error?: string;
	attempt?: number;
	nextRetryAt?: number;
}

interface McpSharedEntry {
	tools: { name: string; description?: string }[] | null;
	status: McpSharedEntryStatus;
}

interface McpSessionServerInfo {
	name: string;
	disabled: boolean;
	key: string;
}

/**
 * Compares two cwd strings after path normalization, so a same-project
 * `create_session`/`fork`/`clone` can safely reuse the source session's
 * `resourceLoader` (see call sites below) instead of re-running every
 * extension's factory from scratch — some extensions (e.g. an OmniRoute-style
 * provider registration) do a network fetch on load, which is otherwise
 * repeated for every new tab even though nothing about the project changed.
 */
function sameCwd(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}

function getMcpSharedClientsRegistry(): Map<string, McpSharedEntry> {
	const g = globalThis as unknown as Record<symbol, Map<string, McpSharedEntry> | undefined>;
	return (g[MCP_SHARED_CLIENTS_KEY] as Map<string, McpSharedEntry> | undefined) ?? new Map();
}

function getMcpSessionServersRegistry(): Map<string, McpSessionServerInfo[]> {
	const g = globalThis as unknown as Record<symbol, Map<string, McpSessionServerInfo[]> | undefined>;
	return (g[MCP_SESSION_SERVERS_KEY] as Map<string, McpSessionServerInfo[]> | undefined) ?? new Map();
}

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.js";

// Every streaming delta event carries `assistantMessageEvent.partial` — the
// FULL accumulated AssistantMessage so far (see pi-ai's AssistantMessageEvent).
// Serializing that snapshot to stdout on every token is O(n²) CPU per turn,
// and each line then costs an IPC event in the host UI. pi-pine renders the
// complete text on message_end anyway, so by default message_update events
// are not emitted at all. Set PI_RPC_STREAM_UPDATES=1 to restore per-token
// streaming for clients that want it.
const STREAM_MESSAGE_UPDATES = process.env.PI_RPC_STREAM_UPDATES === "1";

function sanitizeRpcEvent(
	event: AgentSessionEvent,
): Omit<AgentSessionEvent, "messages" | "args" | "message"> | AgentSessionEvent {
	if (event.type === "agent_end") {
		const { messages: _messages, ...rest } = event;
		return rest;
	}
	if (event.type === "tool_execution_update") {
		const { args: _args, ...rest } = event;
		return rest;
	}
	if (event.type === "message_update") {
		const { message: _message, ...rest } = event;
		return rest;
	}
	return event;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	const sessions = new Map<string, AgentSession>();
	const sessionSubscriptions = new Map<string, () => void>();
	let activeSessionId: string | null = null;
	let sessionCounter = 0;

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

	const presetPath = (name: string): string => {
		const fileName = `${path.basename(name).replace(/\.json$/i, "")}.json`;
		return path.join(getAgentDir(), "agents", fileName);
	};

	const readAgentPreset = (name: string): AgentPresetConfig => {
		const file = presetPath(name);
		if (!fs.existsSync(file)) {
			throw new Error(`Agent preset not found: ${name}`);
		}
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as AgentPresetConfig;
		if (!parsed || typeof parsed.name !== "string" || !parsed.name.trim()) {
			throw new Error(`Invalid agent preset: ${name}`);
		}
		return parsed;
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

	const extractUserMessageText = (content: string | Array<{ type: string; text?: string }>): string => {
		if (typeof content === "string") return content;
		return content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("");
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
		sessionId: string | undefined,
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
			output({
				type: "extension_ui_request",
				id,
				...request,
				...(sessionId ? { sessionId } : {}),
			} as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (sessionId?: string): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(
				sessionId,
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		confirm: (title, message, opts) =>
			createDialogPromise(
				sessionId,
				opts,
				false,
				{ method: "confirm", title, message, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(
				sessionId,
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		askUser: (question, options = [], allowMultiple = false, opts) =>
			createDialogPromise(
				sessionId,
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
				...(sessionId ? { sessionId } : {}),
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
				...(sessionId ? { sessionId } : {}),
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
					...(sessionId ? { sessionId } : {}),
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
				...(sessionId ? { sessionId } : {}),
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
				...(sessionId ? { sessionId } : {}),
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
				output({
					type: "extension_ui_request",
					id,
					method: "editor",
					title,
					prefill,
					...(sessionId ? { sessionId } : {}),
				} as RpcExtensionUIRequest);
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

	const nextSessionId = (): string => `session-${++sessionCounter}`;

	const getActiveSession = (): AgentSession | undefined =>
		activeSessionId ? sessions.get(activeSessionId) : undefined;

	const makeRpcSessionState = (sessionId: string, target: AgentSession): RpcSessionState => ({
		model: target.model,
		thinkingLevel: target.thinkingLevel,
		isStreaming: target.isStreaming,
		isCompacting: target.isCompacting,
		steeringMode: target.steeringMode,
		followUpMode: target.followUpMode,
		sessionFile: target.sessionFile,
		sessionId,
		sessionName: target.sessionName,
		autoCompactionEnabled: target.autoCompactionEnabled,
		contextPruningEnabled: target.contextPruningEnabled,
		fileManifestEnabled: target.fileManifestEnabled,
		autoRetryEnabled: target.autoRetryEnabled,
		isRetrying: target.isRetrying,
		retryAttempt: target.retryAttempt,
		messageCount: target.messages.length,
		pendingMessageCount: target.pendingMessageCount,
		cwd: target.activeCwd,
		planMode: target.planMode.state,
	});

	function subscribeSession(sessionId: string, target: AgentSession): void {
		const existing = sessionSubscriptions.get(sessionId);
		existing?.();
		const unsubscribe = target.subscribe((event) => {
			if (!STREAM_MESSAGE_UPDATES && event.type === "message_update") return;
			output({ ...sanitizeRpcEvent(event), sessionId });
		});
		sessionSubscriptions.set(sessionId, unsubscribe);
	}

	function unsubscribeSession(sessionId: string): void {
		sessionSubscriptions.get(sessionId)?.();
		sessionSubscriptions.delete(sessionId);
	}

	function registerSession(sessionId: string, target: AgentSession): void {
		target.permissionAsk = async (info) =>
			createDialogPromise(
				sessionId,
				{ signal: target.agent.signal },
				{ decision: "deny-once" as const },
				{
					method: "permission",
					permissionType: info.type,
					permissionValue: info.value,
					permissionToolName: info.toolName,
					permissionToolArgs: info.toolArgs,
				},
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
		subscribeSession(sessionId, target);

		// Fire extension binding without awaiting — session switch/fork returns
		// immediately; MCPs initialize in the background.
		const uiContext = createExtensionUIContext(sessionId);
		// Private bridge for bundled extensions that need to create child sessions
		// from the current tab/session (for example the task sub-agent tool).
		(uiContext as any).__permissionAsk = target.permissionAsk;

		void target
			.bindExtensions({
				uiContext,
				commandContextActions: {
					waitForIdle: () => target.agent.waitForIdle(),
					newSession: async (options) => runtimeHost.newSession(options),
					fork: async (entryId, forkOptions) => {
						const result = await runtimeHost.fork(entryId, forkOptions);
						return { cancelled: result.cancelled };
					},
					navigateTree: async (targetId, options) => {
						const result = await target.navigateTree(targetId, {
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
						await target.reload();
					},
				},
				shutdownHandler: () => {
					shutdownRequested = true;
				},
				onError: (err) => {
					output({
						type: "extension_error",
						sessionId,
						extensionPath: err.extensionPath,
						event: err.event,
						error: err.error,
					});
				},
			})
			.catch((err: unknown) => {
				output({
					type: "extension_error",
					sessionId,
					extensionPath: "<rebind>",
					event: "session_start",
					error: String(err),
				});
			});
	}

	const rebindSession = async (): Promise<void> => {
		const replacement = runtimeHost.session;
		const sid = activeSessionId ?? nextSessionId();
		const previous = sessions.get(sid);
		if (previous && previous !== replacement) {
			unsubscribeSession(sid);
		}
		sessions.set(sid, replacement);
		activeSessionId = sid;
		session = replacement;
		registerSession(sid, replacement);
	};

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

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
	async function runFastContext(
		query: string,
		scopePath: string | undefined,
		targetSessionId: string,
		targetSession: AgentSession,
	) {
		const ui = createExtensionUIContext(targetSessionId);
		ui.setStatus("fast-context", "searching...");
		try {
			const result = await fastContextSearch(targetSession.activeCwd, query, {
				maxFiles: 12,
				includeSnippets: false,
				path: scopePath,
			});
			ui.setStatus("fast-context", `done: ${result.files.length} files`);
			return result;
		} catch (e) {
			ui.setStatus("fast-context", undefined);
			throw e;
		}
	}

	async function runWebSearch(
		command: Extract<RpcCommand, { type: "web_search" }>,
		targetSessionId: string,
		targetSession: AgentSession,
	) {
		const ui = createExtensionUIContext(targetSessionId);
		ui.setStatus("web-search", "fetching...");
		try {
			const tool = createWebSearchToolDefinition(targetSession.activeCwd, {
				settings: targetSession.settingsManager.getWebSearchSettings(),
			});
			const result = await tool.execute(
				"rpc-web-search",
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
			ui.setStatus("web-search", `done: ${result.details?.status ?? "ok"}`);
			return { text: getTextOutput(result, false), details: result.details };
		} catch (e) {
			ui.setStatus("web-search", undefined);
			throw e;
		}
	}

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		if (command.type === "list_sessions") {
			return success(id, "list_sessions", {
				sessions: Array.from(sessions.entries()).map(([sid, target]) => ({
					sessionId: sid,
					name: target.sessionName,
					messageCount: target.messages.length,
					isActive: sid === activeSessionId,
					cwd: target.activeCwd,
					isStreaming: target.isStreaming,
				})),
			});
		}

		if (command.type === "create_session") {
			const sourceSession = command.sourceSessionId ? sessions.get(command.sourceSessionId) : undefined;
			const baseSession = sourceSession ?? getActiveSession() ?? session;
			const sid = nextSessionId();
			const newCwd = command.cwd || baseSession.activeCwd;
			const sessionManager = command.sessionPath
				? SessionManager.open(command.sessionPath)
				: SessionManager.create(newCwd, baseSession.sessionManager.getSessionDir());
			if (!command.sessionPath && command.mode === "copy") {
				for (const message of baseSession.messages) {
					sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
				}
			}
			const effectiveCwd = command.cwd || sessionManager.getCwd() || baseSession.activeCwd;
			const { session: newSession } = await createAgentSession({
				cwd: effectiveCwd,
				sessionManager,
				modelRegistry: baseSession.modelRegistry,
				settingsManager: baseSession.settingsManager,
				resourceLoader: sameCwd(effectiveCwd, baseSession.activeCwd) ? baseSession.resourceLoader : undefined,
				model: baseSession.model,
				thinkingLevel: baseSession.thinkingLevel,
				tools: baseSession.getActiveToolNames(),
			});
			sessions.set(sid, newSession);
			activeSessionId = sid;
			session = newSession;
			registerSession(sid, newSession);
			return success(id, "create_session", { sessionId: sid });
		}

		const requestedSessionId = command.sessionId;
		const targetSessionId = requestedSessionId || activeSessionId;
		if (!targetSessionId) {
			return error(id, command.type, "No active session");
		}
		const targetSession = sessions.get(targetSessionId);
		if (!targetSession) {
			return error(id, command.type, `Session not found: ${targetSessionId}`);
		}

		if (command.type === "close_session") {
			if (sessions.size <= 1) {
				return error(id, "close_session", "Cannot close last session");
			}
			const wasActive = activeSessionId === targetSessionId;
			unsubscribeSession(targetSessionId);
			// Give extensions (e.g. bundled MCP) a chance to close their child
			// processes/handles before the session is torn down — without this,
			// MCP server processes spawned for this session leak for the
			// lifetime of the `pi --mode rpc` process.
			await emitSessionShutdownEvent(targetSession.extensionRunner, { type: "session_shutdown", reason: "close" });
			targetSession.dispose();
			sessions.delete(targetSessionId);
			if (wasActive) {
				const first = sessions.keys().next().value as string | undefined;
				activeSessionId = first ?? null;
				if (first) session = sessions.get(first)!;
			}
			return success(id, "close_session");
		}

		switch (command.type) {
			case "switch_active_session": {
				activeSessionId = targetSessionId;
				session = targetSession;
				return success(id, "switch_active_session");
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				const message = command.message;
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void targetSession
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
				await targetSession.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await targetSession.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "btw": {
				const question = command.question.trim();
				if (!question) {
					return error(id, "btw", "Usage: /btw <question>");
				}
				const model = targetSession.model;
				if (!model) {
					return error(id, "btw", formatNoModelSelectedMessage());
				}
				const auth = await targetSession.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) {
					return error(id, "btw", auth.ok ? formatNoApiKeyFoundMessage(model.provider) : auth.error);
				}
				const contextMessages = targetSession.state.messages.filter(
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
						systemPrompt: targetSession.systemPrompt,
						messages,
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						reasoning: targetSession.thinkingLevel === "off" ? undefined : targetSession.thinkingLevel,
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
					const result = await runFastContext(query, command.path, targetSessionId, targetSession);
					return success(id, "fast_context", result);
				} catch (e) {
					return error(id, "fast_context", (e as Error).message);
				}
			}

			case "web_search": {
				const query = command.query.trim();
				if (!query) {
					return error(id, "web_search", "Usage: web_search <query-or-url>");
				}
				try {
					const result = await runWebSearch(command, targetSessionId, targetSession);
					return success(id, "web_search", result);
				} catch (e) {
					return error(id, "web_search", (e as Error).message);
				}
			}

			case "abort": {
				// abortCompaction() cancels an in-progress manual/auto compaction (its own
				// AbortController); abort() only touches the agent's run and never reaches it.
				targetSession.abortCompaction();
				await targetSession.abort();
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
				return success(id, "get_state", makeRpcSessionState(targetSessionId, targetSession));
			}

			case "get_mcp_status": {
				const sharedClients = getMcpSharedClientsRegistry();
				const sessionServers = getMcpSessionServersRegistry().get(targetSession.sessionId) ?? [];
				const servers: RpcMcpServerStatus[] = sessionServers.map(({ name, disabled, key }) => {
					if (disabled) return { name, status: "disabled", tools: [] };
					const entry = sharedClients.get(key);
					return {
						name,
						status: entry?.status.status ?? "connecting",
						error: entry?.status.error,
						attempt: entry?.status.attempt,
						nextRetryAt: entry?.status.nextRetryAt,
						tools: (entry?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
					};
				});
				const result: RpcMcpStatusResult = { servers };
				return success(id, "get_mcp_status", result);
			}

			case "pwd": {
				return success(id, "pwd", { cwd: targetSession.activeCwd });
			}

			case "ls": {
				const base = targetSession.activeCwd;
				const dir = command.path ? path.resolve(base, expandHome(command.path)) : base;
				if (!fs.existsSync(dir)) {
					return error(id, "ls", `ls: no such path: ${dir}`);
				}
				return success(id, "ls", { path: dir, displayPath: shortPath(dir), entries: listDir(dir) });
			}

			case "cd": {
				const base = targetSession.activeCwd;
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
				targetSession.setCwd(target);
				await targetSession.sendCustomMessage({
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
				const models = await targetSession.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await targetSession.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await targetSession.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await targetSession.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				targetSession.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = targetSession.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				targetSession.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				targetSession.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Agent Presets
			// =================================================================

			case "load_agent_preset": {
				const preset = readAgentPreset(command.presetName);
				await targetSession.applyPreset(preset);
				return success(id, "load_agent_preset", preset);
			}

			case "set_custom_instructions": {
				targetSession.setCustomInstructions(command.instructions);
				return success(id, "set_custom_instructions");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await targetSession.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				targetSession.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			case "set_context_pruning": {
				targetSession.setContextPruningEnabled(command.enabled);
				return success(id, "set_context_pruning");
			}

			case "set_file_manifest": {
				targetSession.setFileManifestEnabled(command.enabled);
				return success(id, "set_file_manifest");
			}

			// =================================================================
			// Plan Mode
			// =================================================================

			case "enter_plan_mode": {
				const planFilePath = targetSession.enterPlanMode(command.name);
				return success(id, "enter_plan_mode", { planFilePath });
			}

			case "exit_plan_mode": {
				const planFilePath = targetSession.exitPlanMode();
				return success(id, "exit_plan_mode", { planFilePath });
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				targetSession.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				targetSession.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await targetSession.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				targetSession.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = targetSession.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await targetSession.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				return success(id, "switch_session", result);
			}

			case "navigate_tree": {
				const result = await targetSession.navigateTree(command.targetId, {
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
					tree: targetSession.sessionManager.getTree(),
					leafId: targetSession.sessionManager.getLeafId(),
				});
			}

			case "fork": {
				const position = command.position ?? "before";
				const selectedEntry = targetSession.sessionManager.getEntry(command.entryId);
				if (!selectedEntry) {
					return error(id, "fork", "Invalid entry ID for forking");
				}
				let targetLeafId: string | null;
				let selectedText: string | undefined;
				if (position === "at") {
					targetLeafId = selectedEntry.id;
				} else {
					if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
						return error(id, "fork", "Invalid entry ID for forking");
					}
					targetLeafId = selectedEntry.parentId;
					selectedText = extractUserMessageText(selectedEntry.message.content);
				}

				const currentSessionFile = targetSession.sessionFile;
				let nextManager: SessionManager;
				if (!targetLeafId) {
					nextManager = SessionManager.create(
						targetSession.activeCwd,
						targetSession.sessionManager.getSessionDir(),
					);
					nextManager.newSession({ parentSession: currentSessionFile });
				} else {
					// Use the live manager, not a freshly opened JSONL file: in a just-created
					// parallel tab the branch entries may exist in memory before the file is
					// flushed to disk. We replace this tab's session immediately below, so
					// mutating the current manager is safe.
					const forkedSessionPath = targetSession.sessionManager.createBranchedSession(targetLeafId);
					if (!forkedSessionPath && targetSession.sessionManager.isPersisted()) {
						return error(id, "fork", "Failed to create forked session");
					}
					nextManager = targetSession.sessionManager;
				}

				unsubscribeSession(targetSessionId);
				targetSession.dispose();
				const { session: forkedSession } = await createAgentSession({
					cwd: nextManager.getCwd(),
					sessionManager: nextManager,
					modelRegistry: targetSession.modelRegistry,
					settingsManager: targetSession.settingsManager,
					// fork always keeps the source session's cwd, so its already-loaded
					// extensions (skills, providers, etc.) are still valid — no need to
					// re-run every extension factory (see sameCwd doc comment above).
					resourceLoader: targetSession.resourceLoader,
					model: targetSession.model,
					thinkingLevel: targetSession.thinkingLevel,
					tools: targetSession.getActiveToolNames(),
				});
				sessions.set(targetSessionId, forkedSession);
				activeSessionId = targetSessionId;
				session = forkedSession;
				registerSession(targetSessionId, forkedSession);
				return success(id, "fork", { text: selectedText, cancelled: false });
			}

			case "clone": {
				const leafId = targetSession.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const forkedSessionPath = targetSession.sessionManager.createBranchedSession(leafId);
				if (!forkedSessionPath && targetSession.sessionManager.isPersisted()) {
					return error(id, "clone", "Failed to clone session");
				}
				const nextManager = targetSession.sessionManager;
				unsubscribeSession(targetSessionId);
				targetSession.dispose();
				const { session: clonedSession } = await createAgentSession({
					cwd: nextManager.getCwd(),
					sessionManager: nextManager,
					modelRegistry: targetSession.modelRegistry,
					settingsManager: targetSession.settingsManager,
					// clone always keeps the source session's cwd — see fork above.
					resourceLoader: targetSession.resourceLoader,
					model: targetSession.model,
					thinkingLevel: targetSession.thinkingLevel,
					tools: targetSession.getActiveToolNames(),
				});
				sessions.set(targetSessionId, clonedSession);
				activeSessionId = targetSessionId;
				session = clonedSession;
				registerSession(targetSessionId, clonedSession);
				return success(id, "clone", { cancelled: false });
			}

			case "get_fork_messages": {
				const messages = targetSession.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_file_checkpoint_status": {
				return success(id, "get_file_checkpoint_status", targetSession.getFileCheckpointStatus());
			}

			case "get_file_checkpoint_turn_status": {
				return success(
					id,
					"get_file_checkpoint_turn_status",
					targetSession.getFileCheckpointTurnStatus(command.turnIndex),
				);
			}

			case "restore_file_changes_to_turn": {
				const result = await targetSession.restoreFileChangesToTurn(command.turnIndex);
				return success(id, "restore_file_changes_to_turn", result);
			}

			case "get_last_assistant_text": {
				const text = targetSession.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				targetSession.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				const rawMessages = targetSession.messages;
				const entries = (targetSession.sessionManager as any).getBranch() as Array<{
					type: string;
					message?: unknown;
					id: string;
				}>;
				const messageEntries = entries.filter((e) => e.type === "message");
				const annotated = rawMessages.map((msg, index) => {
					const entry = messageEntries.find((e) => e.message === msg) ?? messageEntries[index];
					return entry ? { ...msg, entryId: entry.id } : msg;
				});
				return success(id, "get_messages", { messages: annotated });
			}

			case "get_full_history": {
				const rawMessages = targetSession.sessionManager.buildFullHistory().messages;
				const entries = (targetSession.sessionManager as any).getBranch() as Array<{
					type: string;
					message?: unknown;
					id: string;
				}>;
				const messageEntries = entries.filter((e) => e.type === "message");
				const annotated = rawMessages.map((msg, index) => {
					const entry = messageEntries.find((e) => e.message === msg) ?? messageEntries[index];
					return entry ? { ...msg, entryId: entry.id } : msg;
				});
				return success(id, "get_full_history", { messages: annotated });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of targetSession.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of targetSession.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const command of targetSession.resourceLoader.getCommands().commands) {
					commands.push({
						name: command.name,
						description: command.description,
						source: "markdown",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const skill of targetSession.resourceLoader.getSkills().skills) {
					const scope = skill.sourceInfo.scope;
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						categories: skill.categories,
						location: scope === "user" || scope === "project" ? scope : "path",
						path: skill.filePath,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			case "get_skill_detail": {
				const rawName = command.name.trim();
				const name = rawName.startsWith("skill:") ? rawName.slice(6) : rawName;
				const skill = targetSession.resourceLoader.getSkills().skills.find((s) => s.name === name);
				if (!skill) {
					return error(id, "get_skill_detail", `Skill not found: ${name}`);
				}
				const content = stripFrontmatter(fs.readFileSync(skill.filePath, "utf-8")).trim();
				return success(id, "get_skill_detail", {
					name: skill.name,
					description: skill.description,
					categories: skill.categories,
					path: skill.filePath,
					baseDir: skill.baseDir,
					content,
				});
			}

			case "get_command_detail": {
				const rawName = command.name.trim();
				const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;
				const found =
					targetSession.promptTemplates.find((t) => t.name === name) ??
					targetSession.resourceLoader.getCommands().commands.find((c) => c.name === name);
				if (!found) {
					return error(id, "get_command_detail", `Command not found: ${name}`);
				}
				return success(id, "get_command_detail", {
					name: found.name,
					description: found.description,
					path: found.filePath,
					content: found.content,
				});
			}

			case "suggest_skills": {
				const scored = scoreSkillsByRelevance(command.query, targetSession.resourceLoader.getSkills().skills, {
					limit: command.limit,
					minScore: command.minScore,
				});
				return success(id, "suggest_skills", {
					skills: scored.map(({ skill, score, reasons }) => ({
						name: skill.name,
						description: skill.description,
						categories: skill.categories,
						path: skill.filePath,
						score,
						reasons,
					})),
				});
			}

			// =================================================================
			// Sub-agents
			// =================================================================

			case "get_subagent_tasks": {
				const mgr = getGlobalSubagentManager();
				const tasks = mgr ? [...mgr.tasks.values()] : [];
				return success(id, "get_subagent_tasks", { tasks });
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
		for (const [, unsubscribe] of sessionSubscriptions) {
			unsubscribe();
		}
		sessionSubscriptions.clear();
		const hostSession = runtimeHost.session;
		for (const [, target] of sessions) {
			if (target !== hostSession) {
				target.dispose();
			}
		}
		sessions.clear();
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
