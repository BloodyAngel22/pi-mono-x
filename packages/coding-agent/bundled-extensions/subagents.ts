import type {
	ExtensionAPI,
	SubagentConfig,
	SubagentSessionFactory,
	SubagentTask,
	SubagentToolCallEntry,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	createAgentSession,
	createExtensionRuntime,
	getGlobalSubagentManager,
	loadAgents,
	SessionManager,
	setGlobalSubagentManager,
	SubagentManager,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

type TaskToolDetails = {
	taskId?: string;
	status?: string;
	queuedAt?: number;
	activities?: string[];
	toolCalls?: SubagentToolCallEntry[];
	timedOut?: boolean;
	interrupted?: boolean;
};

function buildGuidance(agents: SubagentConfig[]): string {
	let guidance = `
## Sub-agent delegation (primary research path)

You have a \`task\` tool that runs work in an isolated sub-agent with a fresh context window.
The sub-agent has access to all built-in tools and MCP tools (web search, documentation lookup, code analysis).
Only the final result is returned to your context, saving significant tokens.
Sub-agents are your PRIMARY way to gather information — delegate early and in parallel.

**Delegate via \`task\` by default:**
- Any codebase exploration or analysis touching 2+ files
- Web research (docs, tutorials, error messages, solutions)
- Code review or security audit (fresh, unbiased perspective)
- Semantic code analysis via Serena MCP (references, type hierarchies, call graphs)
- Any work where you only need the final result, not every intermediate step
- Several independent questions → several \`task\` calls IN ONE turn (they run in parallel)

**Do directly (without task):**
- Pinpoint symbol lookup → fast_context
- One quick web query or a known URL → web_search
- Single targeted edits when you already know which file to change
- Short answers from already-visible context
- Simple commands (git status, npm test)

**Writing good task instructions:**
- State the goal, the starting points (paths, symbols), and EXACTLY what to return
- For code exploration ask for: exact file paths, line numbers, symbol names, key signatures
- Tell the sub-agent to stop early once it has enough to answer

**Critical rules:**
- NEVER read a whole codebase yourself — split it into parallel \`task\` calls
- NEVER narrate your process to the user ("I will now use a sub-agent...", "The sub-agent returned..."). Just present the result as your own answer.
- After \`task\` returns, answer the user directly and concisely. Do not explain what the sub-agent did.
- If a sub-agent fails twice, ask the user instead of retrying blindly.

**Managing running tasks:**
- \`cancel_task(taskId)\` stops a sub-agent you no longer need (its taskId is in the \`task\` result).
- \`background_task(taskId)\` lets a long-running sub-agent keep working without blocking on it.`.trim();

	if (agents.length > 0) {
		guidance += "\n\n**Available specialized agents:**\n";
		for (const agent of agents) {
			guidance += `- \`${agent.name}\`: ${agent.description}\n`;
		}
		guidance += "\nPass the agent name in the `agent` parameter of the `task` tool to use a specialized agent.";
	}

	return guidance;
}

export default function (pi: ExtensionAPI): void {
	let currentCtx: any = null;
	let manager: SubagentManager | null = null;
	let agents: SubagentConfig[] = [];
	let mcpToolDefs: ToolDefinition[] = [];

	const getManager = (): SubagentManager => {
		if (manager) return manager;

		const sessionFactory: SubagentSessionFactory = async (opts) => {
			// Build a NullResourceLoader inline
			const runtime = createExtensionRuntime();
			const nullLoader = {
				getExtensions: () => ({ extensions: [], errors: [], runtime }),
				getSkills: () => ({ skills: [] as any[], diagnostics: [] }),
				getPrompts: () => ({ prompts: [] as any[], diagnostics: [] }),
				getCommands: () => ({ commands: [] as any[] }),
				getHooks: () => ({ hooks: [] as any[] }),
				getThemes: () => ({ themes: [] as any[], diagnostics: [] }),
				getAgentsFiles: () => ({ agentsFiles: [] }),
				getSystemPrompt: () => opts.systemPrompt,
				getAppendSystemPrompt: () => [],
				extendResources: () => {},
				reload: async () => {},
			};

			const sessionManager = SessionManager.inMemory(opts.cwd);

			const { session } = await createAgentSession({
				cwd: opts.cwd,
				resourceLoader: nullLoader,
				sessionManager,
				tools: opts.tools,
				customTools: opts.customTools,
				model: opts.model,
				modelRegistry: currentCtx?.modelRegistry,
			});

			// Wire permissionAsk from the exact parent session/tab that launched this task.
			if (opts.permissionAsk) {
				session.permissionAsk = opts.permissionAsk;
			}

			return {
				prompt: (text: string) => session.prompt(text),
				abort: () => session.agent.abort(),
				getMessages: () =>
					session.state.messages.map((m: any) => ({
						role: m.role as string,
						content: m.content,
						usage: m.usage,
						stopReason: m.stopReason,
						errorMessage: m.errorMessage,
						toolName: m.toolName,
						isError: m.isError,
					})),
				subscribe: (listener: (event: { type: string; text?: string }) => void) =>
					session.subscribe((event: any) => listener(event)),
				subscribeAgentEvents: (listener: (event: { type: string; toolName?: string; args?: Record<string, unknown> }) => void) =>
					session.agent.subscribe((event: any) => listener(event)),
			};
		};

		manager = new SubagentManager(sessionFactory);
		setGlobalSubagentManager(manager);

		// Live-update ticker: refreshes elapsed times every second while tasks are running
		let liveTickTimer: NodeJS.Timeout | null = null;

		const formatSubagentStatus = (): string => {
			const tasks = manager?.getRecentTasks(10_000) ?? [];
			if (tasks.length === 0) return "";
			return tasks
				.map((t) => {
					const elapsed = Math.floor(((t.completedAt ?? Date.now()) - t.startedAt) / 1000);
					const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
					const dot =
						t.status === "done" ? (t.interrupted ? "\u25cf partial" : "\u25cf done") : t.status === "error" ? "\u25cf err" : "\u25cf";
					const lastActivity = t.recentActivities?.length ? ` (${t.recentActivities[t.recentActivities.length - 1]})` : "";
					return `${dot} ${t.label}${lastActivity} (${elapsedStr})`;
				})
				.join("  ");
		};

		const formatSubagentWidget = (): string[] => {
			const tasks = manager?.getRecentTasks(30_000) ?? [];
			if (tasks.length === 0) return [];
			const lines: string[] = [];
			for (const task of tasks) {
				const elapsed = Math.floor(((task.completedAt ?? Date.now()) - task.startedAt) / 1000);
				const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
				const dot =
					task.status === "running" || task.status === "background" ? "●" :
					task.status === "error" ? "●" : "●";
				const label = task.label || task.agentName || "sub-agent";
				lines.push(`${dot} ${label} (${elapsedStr})`);
				if (task.recentActivities?.length) {
					for (const activity of task.recentActivities) {
						lines.push(`  ⤷ ${activity}`);
					}
				}
			}
			return lines;
		};

		const startLiveTick = (ui: any) => {
			if (liveTickTimer) return;
			liveTickTimer = setInterval(() => {
				if (!currentCtx?.hasUI) return;
				const active = manager?.getActiveTasks() ?? [];
				if (active.length === 0) {
					clearInterval(liveTickTimer!);
					liveTickTimer = null;
					return;
				}
				ui.setStatus("subagent", formatSubagentStatus());
			}, 1000);
		};

		manager.onEvent((event) => {
			if (!currentCtx?.hasUI) return;
			const ui = currentCtx.ui;

			switch (event.type) {
				case "task_start":
					ui.setStatus("subagent", formatSubagentStatus());
					ui.setWidget("subagent-status", formatSubagentWidget(), { placement: "aboveEditor" });
					startLiveTick(ui);
					break;
				case "task_progress":
					ui.setStatus("subagent", formatSubagentStatus());
					ui.setWidget("subagent-status", formatSubagentWidget(), { placement: "aboveEditor" });
					break;
				case "task_complete": {
					ui.setStatus("subagent", formatSubagentStatus());
					ui.setWidget("subagent-status", formatSubagentWidget(), { placement: "aboveEditor" });
					setTimeout(() => {
						const active = manager?.getActiveTasks() ?? [];
						if (active.length === 0) {
							ui.setStatus("subagent", "");
							ui.setWidget("subagent-status", undefined);
						} else {
							ui.setStatus("subagent", formatSubagentStatus());
							ui.setWidget("subagent-status", formatSubagentWidget(), { placement: "aboveEditor" });
						}
					}, 5000);
					break;
				}
				case "task_error":
					ui.setStatus("subagent", formatSubagentStatus());
					ui.setWidget("subagent-status", formatSubagentWidget(), { placement: "aboveEditor" });
					ui.notify(`Sub-agent error: ${event.error}`, "error");
					setTimeout(() => {
						const active = manager?.getActiveTasks() ?? [];
						if (active.length === 0) {
							ui.setStatus("subagent", "");
							ui.setWidget("subagent-status", undefined);
						}
					}, 5000);
					break;
			}
		});

		return manager;
	};

	// Register the task tool
	pi.registerTool({
		name: "task",
		label: "Delegate to sub-agent",
		description: [
			"Delegate a task to an isolated sub-agent with a fresh context window.",
			"The sub-agent can read files, run commands, use MCP tools (web search, docs, code analysis), and return a summary.",
			"This is your PRIMARY tool for codebase exploration, web research, code review, security audit, and any multi-file information gathering.",
			"Only the final result is returned to your context, saving tokens.",
			"Multiple task calls execute in parallel.",
		].join(" "),
		promptSnippet: "task: Delegate research work (exploration, web research, review) to isolated sub-agents — the default for multi-file work",
		promptGuidelines: [
			"Delegating research to task sub-agents is the default for any exploration touching 2+ files; run independent tasks in parallel in one turn.",
			"In plan mode, use parallel task sub-agents to collect exact file paths and line numbers for the plan.",
		],
		parameters: {
			type: "object",
			properties: {
				description: {
					type: "string",
					description: "Short label for the task (shown in UI status)",
				},
				instructions: {
					type: "string",
					description: "Full instructions for the sub-agent. Be specific about what to do and what to return.",
				},
				agent: {
					type: "string",
					description: "Name of a specialized agent to use (from .pi/agents/). Optional.",
				},
			},
			required: ["description", "instructions"],
		} as any,
		executionMode: "parallel",
		renderResult: (result: { details?: TaskToolDetails }, _options: unknown, thm: any) => {
			const container = new Container();
			for (const activity of result.details?.activities ?? []) {
				container.addChild(new Text(thm.fg("dim", `  └─ ${activity}`), 0, 0));
			}
			return container;
		},
		execute: async (_toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => {
			const mgr = getManager();
			const cwd: string = ctx?.cwd ?? process.cwd();
			const permissionAsk = ctx?.ui?.__permissionAsk;

			let agentConfig: SubagentConfig | undefined;
			if (params.agent) {
				const knownAgents = mgr.getAgents();
				agentConfig = knownAgents.find((a) => a.name === params.agent);
				if (!agentConfig) {
					return {
						content: [{ type: "text" as const, text: `Unknown agent: ${params.agent}. Available: ${knownAgents.map((a) => a.name).join(", ") || "none"}` }],
					};
				}
			}

			try {
				const activities: string[] = [];
				let toolCalls: SubagentToolCallEntry[] = [];
				// Add result size limit to sub-agent instructions to reduce token waste
				const limitedInstructions =
					params.instructions +
					"\n\nIMPORTANT: Return a distilled summary. Preserve ALL exact file paths, line numbers and symbol names you found — these are the payload; compress everything else. Stop early if you have enough to answer the original question. Do NOT return verbose traces or full file contents.";
				const result = await mgr.run({
					instructions: limitedInstructions,
					label: params.description ?? "task",
					cwd,
					agent: agentConfig,
					parentMcpTools: mcpToolDefs.length > 0 ? mcpToolDefs : undefined,
					model: ctx?.model,
					permissionAsk,
					signal,
					onProgress: (activity: string) => {
						activities.push(activity);
						const recent = activities.slice(-5);
						onUpdate?.({
							content: [{ type: "text" as const, text: "" }],
							details: { activities: recent, toolCalls } satisfies TaskToolDetails,
						});
					},
					onToolCallUpdate: (entry: SubagentToolCallEntry) => {
						const idx = toolCalls.findIndex((e) => e.toolCallId === entry.toolCallId);
						toolCalls = idx === -1 ? [...toolCalls, entry] : toolCalls.map((e, i) => (i === idx ? entry : e));
						onUpdate?.({
							content: [{ type: "text" as const, text: "" }],
							details: { activities: activities.slice(-5), toolCalls } satisfies TaskToolDetails,
						});
					},
					onStatusChange: (task: SubagentTask) => {
						onUpdate?.({
							content: [{ type: "text" as const, text: "" }],
							details: {
								taskId: task.id,
								status: task.status,
								queuedAt: task.queuedAt,
								activities: activities.slice(-5),
								toolCalls,
							} satisfies TaskToolDetails,
						});
					},
				});

				const partialPrefix = result.timedOut
					? "[timeout — partial result]"
					: result.interrupted
						? "[interrupted — partial result]"
						: undefined;
				const outputText = partialPrefix ? `${partialPrefix}\n${result.text}` : result.text;

				return {
					content: [{ type: "text" as const, text: outputText }],
					details: {
						taskId: result.taskId,
						description: params.description,
						cwd,
						inputTokens: result.inputTokens,
						outputTokens: result.outputTokens,
						savedTokens: result.savedTokens,
						timedOut: result.timedOut,
						interrupted: result.interrupted,
						activities: activities.slice(-5),
						toolCalls,
					},
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Sub-agent error: ${message}` }],
				};
			}
		},
	});

	// Register the cancel_task tool
	pi.registerTool({
		name: "cancel_task",
		label: "Cancel sub-agent task",
		description: "Cancel a running or queued sub-agent task by its taskId (returned in the task tool's result details).",
		parameters: {
			type: "object",
			properties: { taskId: { type: "string", description: "The taskId to cancel" } },
			required: ["taskId"],
		} as any,
		execute: async (_toolCallId: string, params: any) => {
			const mgr = getManager();
			const ok = mgr.cancelTask(params.taskId);
			return {
				content: [
					{
						type: "text" as const,
						text: ok ? `Task ${params.taskId} cancelled.` : `Task ${params.taskId} not found or already finished.`,
					},
				],
			};
		},
	});

	// Register the background_task tool
	pi.registerTool({
		name: "background_task",
		label: "Background sub-agent task",
		description: "Let a running sub-agent task keep working without blocking on its result.",
		parameters: {
			type: "object",
			properties: { taskId: { type: "string", description: "The taskId to background" } },
			required: ["taskId"],
		} as any,
		execute: async (_toolCallId: string, params: any) => {
			const mgr = getManager();
			const ok = mgr.backgroundTask(params.taskId);
			return {
				content: [
					{
						type: "text" as const,
						text: ok ? `Task ${params.taskId} moved to background.` : `Task ${params.taskId} not found or not running.`,
					},
				],
			};
		},
	});

	// Load agents and inject guidance on session start
	pi.on("session_start", async (_event: any, ctx: any) => {
		currentCtx = ctx;

		// Store manager reference on session for RPC access
		const mgr = getManager();
		(ctx as any).__subagentManager = mgr;

		const agentDir = join(homedir(), ".pi", "agent");
		const cwd: string = ctx?.cwd ?? process.cwd();
		agents = loadAgents(cwd, agentDir);
		mgr.setAgents(agents);

		// Collect MCP tool definitions from the extension runner
		try {
			const allTools: any[] = ctx.getAllTools?.() ?? [];
			mcpToolDefs = allTools.filter((t: any) => {
				const name: string = t.name ?? "";
				return name.includes("_") && !["read", "bash", "edit", "write", "grep", "find", "ls", "task", "compress"].includes(name);
			});
		} catch {
			mcpToolDefs = [];
		}
	});

	pi.on("before_agent_start", async (event: any): Promise<any> => {
		const guidance = buildGuidance(manager?.getAgents() ?? agents);
		return {
			systemPrompt: event.systemPrompt + "\n\n" + guidance,
		};
	});

	pi.on("agent_end", async (_event: any, ctx: any) => {
		currentCtx = ctx;
	});

	// /tasks command
	pi.registerCommand("tasks", {
		description: "Show running and recent sub-agent tasks",
		handler: async (_args: string, ctx: any) => {
			const mgr = getManager();
			const tasks = mgr.getRecentTasks(300_000);

			if (tasks.length === 0) {
				ctx.ui.notify("No recent sub-agent tasks", "info");
				return;
			}

			await ctx.ui.custom((ui: any, theme: any, _keybindings: any, done: any) => {
				return {
					render: (width: number) => {
						const availWidth = Math.min(width, 70);
						const lines: string[] = [];
						const borderFg = (s: string) => theme.fg("border", s);

						lines.push(borderFg("+" + "-".repeat(availWidth - 2) + "+"));
						const title = " Sub-agent Tasks ";
						lines.push(borderFg("|") + theme.fg("accent", title) + " ".repeat(Math.max(0, availWidth - 2 - title.length)) + borderFg("|"));
						lines.push(borderFg("+" + "-".repeat(availWidth - 2) + "+"));

						for (const task of tasks) {
							const elapsed = task.completedAt
								? `${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s`
								: `${((Date.now() - task.startedAt) / 1000).toFixed(0)}s`;

							const statusColor =
								task.status === "done" ? "success" :
								task.status === "running" || task.status === "background" ? "warning" :
								task.status === "error" ? "error" : "muted";

							const statusText = task.interrupted ? "[partial]" : `[${task.status}]`;
							const info = ` ${statusText} ${task.label} (${elapsed})`;
							const padding = Math.max(0, availWidth - 3 - info.length);
							lines.push(borderFg("|") + " " + theme.fg(statusColor as any, info) + " ".repeat(padding) + borderFg("|"));

							if (task.status === "done" && task.savedTokens > 0) {
								const saved = task.savedTokens > 1000
									? `${(task.savedTokens / 1000).toFixed(1)}k`
									: String(task.savedTokens);
								const detail = `   saved ~${saved} tokens | in: ${task.inputTokens} out: ${task.outputTokens}`;
								const detailPad = Math.max(0, availWidth - 3 - detail.length);
								lines.push(borderFg("|") + " " + theme.fg("muted", detail) + " ".repeat(detailPad) + borderFg("|"));
							}

							if (task.status === "error" && task.error) {
								const truncated = task.error.length > availWidth - 7 ? task.error.substring(0, availWidth - 10) + "..." : task.error;
								const errPad = Math.max(0, availWidth - 5 - truncated.length);
								lines.push(borderFg("|") + "   " + theme.fg("error", truncated) + " ".repeat(errPad) + borderFg("|"));
							}
						}

						lines.push(borderFg("+" + "-".repeat(availWidth - 2) + "+"));
						const help = " Press any key to close ";
						lines.push(borderFg("|") + theme.fg("muted", help) + " ".repeat(Math.max(0, availWidth - 2 - help.length)) + borderFg("|"));
						lines.push(borderFg("+" + "-".repeat(availWidth - 2) + "+"));
						return lines;
					},
					handleInput: (_data: string) => done(undefined),
				} as any;
			}, { overlay: true, overlayOptions: { anchor: "center", width: 70 } });
		},
	});

	// /agents command
	pi.registerCommand("agents", {
		description: "List available specialized sub-agents",
		handler: async (_args: string, ctx: any) => {
			const currentAgents = manager?.getAgents() ?? agents;
			if (currentAgents.length === 0) {
				ctx.ui.notify("No custom agents found. Create .md files in .pi/agents/ or ~/.pi/agent/agents/", "info");
				return;
			}

			await ctx.ui.custom((ui: any, theme: any, _keybindings: any, done: any) => {
				return {
					render: (width: number) => {
						const availWidth = Math.min(width, 70);
						const lines: string[] = [];
						const borderFg = (s: string) => theme.fg("border", s);

						lines.push(borderFg("+" + "-".repeat(availWidth - 2) + "+"));
						const title = " Available Agents ";
						lines.push(borderFg("|") + theme.fg("accent", title) + " ".repeat(Math.max(0, availWidth - 2 - title.length)) + borderFg("|"));
						lines.push(borderFg("+" + "-".repeat(availWidth - 2) + "+"));

						for (const agent of currentAgents) {
							const name = ` ${agent.name} (${agent.source})`;
							const namePad = Math.max(0, availWidth - 3 - name.length);
							lines.push(borderFg("|") + " " + theme.fg("accent", name) + " ".repeat(namePad) + borderFg("|"));

							if (agent.description) {
								const desc = `   ${agent.description}`;
								const truncated = desc.length > availWidth - 3 ? desc.substring(0, availWidth - 6) + "..." : desc;
								const descPad = Math.max(0, availWidth - 3 - truncated.length);
								lines.push(borderFg("|") + " " + theme.fg("muted", truncated) + " ".repeat(descPad) + borderFg("|"));
							}
						}

						lines.push(borderFg("+" + "-".repeat(availWidth - 2) + "+"));
						const help = " Press any key to close ";
						lines.push(borderFg("|") + theme.fg("muted", help) + " ".repeat(Math.max(0, availWidth - 2 - help.length)) + borderFg("|"));
						lines.push(borderFg("+" + "-".repeat(availWidth - 2) + "+"));
						return lines;
					},
					handleInput: (_data: string) => done(undefined),
				} as any;
			}, { overlay: true, overlayOptions: { anchor: "center", width: 70 } });
		},
	});
}
