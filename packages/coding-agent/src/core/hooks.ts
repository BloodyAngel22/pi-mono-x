import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";

/**
 * Supported hook event names. Each corresponds to a script file with the same
 * base name (e.g. "agent_end.sh" or "agent_end") placed in a hooks directory.
 */
export type HookEventName =
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "tool_execution_start"
	| "tool_execution_end";

export const HOOK_EVENT_NAMES: HookEventName[] = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
];

export interface HookDefinition {
	event: HookEventName;
	filePath: string;
	/** "global" = agentDir/hooks/, "project" = .pi/hooks/ */
	scope: "global" | "project";
}

function loadHooksFromDir(dir: string, scope: "global" | "project"): HookDefinition[] {
	const hooks: HookDefinition[] = [];

	if (!existsSync(dir)) {
		return hooks;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(join(dir, entry.name)).isFile();
				} catch {
					continue;
				}
			}
			if (!isFile) continue;

			const baseName = entry.name.replace(/\.sh$/, "") as HookEventName;
			if (HOOK_EVENT_NAMES.includes(baseName)) {
				hooks.push({ event: baseName, filePath: join(dir, entry.name), scope });
			}
		}
	} catch {
		// Ignore read failures
	}

	return hooks;
}

export interface LoadHooksOptions {
	cwd: string;
	agentDir: string;
}

/**
 * Discover hooks from:
 *   1. Global:  agentDir/hooks/
 *   2. Project: cwd/{CONFIG_DIR_NAME}/hooks/
 *
 * Both sets run for matching events (global first, then project).
 */
export function loadHooks(options: LoadHooksOptions): HookDefinition[] {
	const globalHooksDir = join(options.agentDir, "hooks");
	const projectHooksDir = resolve(options.cwd, CONFIG_DIR_NAME, "hooks");

	return [...loadHooksFromDir(globalHooksDir, "global"), ...loadHooksFromDir(projectHooksDir, "project")];
}

/**
 * Run all hooks registered for `eventName`.
 * Each script receives the event payload as a JSON string on stdin.
 * Environment variables expose key fields for convenience:
 *   PI_EVENT      — event name
 *   PI_CWD        — working directory
 *   PI_SESSION_ID — current session id
 *
 * Hooks run sequentially. Errors are silently swallowed so they never abort
 * the agent. A per-hook timeout of 30 s is enforced.
 */
export async function runHooks(
	hooks: HookDefinition[],
	eventName: HookEventName,
	data: Record<string, unknown>,
	options: { cwd: string; sessionId: string },
): Promise<void> {
	const matching = hooks.filter((h) => h.event === eventName);
	if (matching.length === 0) return;

	const stdinData = JSON.stringify(data);
	const env = {
		...process.env,
		PI_EVENT: eventName,
		PI_CWD: options.cwd,
		PI_SESSION_ID: options.sessionId,
	};

	for (const hook of matching) {
		await runSingleHook(hook.filePath, stdinData, env, options.cwd);
	}
}

const HOOK_TIMEOUT_MS = 30_000;

function runSingleHook(filePath: string, stdinData: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
	return new Promise((resolve) => {
		let done = false;

		const child = spawn(filePath, [], {
			cwd,
			env,
			stdio: ["pipe", "ignore", "ignore"],
			shell: false,
		});

		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				try {
					child.kill();
				} catch {
					// ignore
				}
				resolve();
			}
		}, HOOK_TIMEOUT_MS);

		child.on("close", () => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve();
			}
		});

		child.on("error", () => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve();
			}
		});

		try {
			child.stdin.write(stdinData);
			child.stdin.end();
		} catch {
			// stdin may have already closed
		}
	});
}
