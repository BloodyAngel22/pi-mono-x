import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { generalizeBashPermissionMatch, type PermissionsConfig, PermissionsManager } from "../src/core/permissions.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

function writeLocalPermissions(cwd: string, config: PermissionsConfig): void {
	const piDir = join(cwd, ".pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(join(piDir, "permissions.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

describe("PermissionsManager bash policies", () => {
	let tempDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-permissions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("treats command-star bash rules as command-wide prefix rules", () => {
		writeLocalPermissions(tempDir, {
			defaultPolicy: "ask",
			bash: { allow: ["rg *"] },
		});

		const permissions = new PermissionsManager(tempDir);

		expect(permissions.checkPolicy("bash", "rg pattern")).toBe("allow");
		expect(permissions.checkPolicy("bash", "rg -n pattern")).toBe("allow");
		expect(permissions.checkPolicy("bash", "rg pattern -n")).toBe("allow");
		expect(permissions.checkPolicy("bash", 'rg -n "foo" packages/coding-agent/src')).toBe("allow");
		expect(permissions.checkPolicy("bash", 'rg -n "foo bar" src')).toBe("allow");
		expect(permissions.checkPolicy("bash", "grep pattern")).toBe("ask");
		expect(permissions.checkPolicy("bash", "rgx foo")).toBe("ask");
		expect(permissions.checkPolicy("bash", "rga foo")).toBe("ask");
	});

	it("checks compound commands independently and returns the most restrictive policy", () => {
		writeLocalPermissions(tempDir, {
			defaultPolicy: "ask",
			bash: {
				allow: ["ls *", "pwd", "rg *", "head *", "sort"],
				deny: ["rm *"],
			},
		});

		const permissions = new PermissionsManager(tempDir);

		expect(permissions.checkPolicy("bash", "ls -la && pwd")).toBe("allow");
		expect(permissions.checkPolicy("bash", "ls -la && pwd && rm -rf tmp")).toBe("deny");
		expect(permissions.checkPolicy("bash", "rg -n foo | head -20")).toBe("allow");
		expect(permissions.checkPolicy("bash", "rg -n foo || grep foo")).toBe("ask");
		expect(permissions.checkPolicy("bash", "pwd; rm -rf tmp")).toBe("deny");
		expect(
			permissions.checkPolicy(
				"bash",
				"rg -n --hidden --glob '!node_modules' --glob '!dist' 'permissions?|Permissions?|PERMISSIONS?' . | sort",
			),
		).toBe("allow");
	});

	it("keeps a single ask subcommand from allowing a compound command", () => {
		writeLocalPermissions(tempDir, {
			defaultPolicy: "ask",
			bash: { allow: ["ls *", "pwd"] },
		});

		const permissions = new PermissionsManager(tempDir);

		expect(permissions.checkPolicy("bash", "ls -la && pwd && rm -rf tmp")).toBe("ask");
	});
});

describe("bash permission rule generalization", () => {
	let tempDir: string;
	let previousAgentDir: string | undefined;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(
			tmpdir(),
			`pi-permission-generalization-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function createSession(): AgentSession {
		writeLocalPermissions(tempDir, { defaultPolicy: "ask" });
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
		});
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, tempDir),
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	async function checkBash(session: AgentSession, command: string) {
		const beforeToolCall = session.agent.beforeToolCall;
		if (!beforeToolCall) throw new Error("beforeToolCall was not installed");
		return await beforeToolCall(
			{
				assistantMessage: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "mock",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				toolCall: { type: "toolCall", id: "tool-call", name: "bash", arguments: { command } },
				args: { command },
				context: { systemPrompt: "Test", messages: [], tools: [] },
			},
			undefined,
		);
	}

	it("generalizes approved bash rules for local and global scopes", async () => {
		const currentSession = createSession();
		currentSession.permissionAsk = vi.fn().mockResolvedValue({ decision: "allow-always", scope: "local" });

		expect(await checkBash(currentSession, "rg -n foo src")).toBeUndefined();
		expect(currentSession.permissionsManager?.getAllRules()).toContainEqual({
			type: "bash",
			match: "rg *",
			policy: "allow",
			scope: "local",
		});
		expect(currentSession.permissionsManager?.checkPolicy("bash", "rg other -n")).toBe("allow");
		expect(currentSession.permissionsManager?.checkPolicy("bash", "rg -n other")).toBe("allow");
		expect(currentSession.permissionsManager?.checkPolicy("bash", "rgx -n other")).toBe("ask");

		currentSession.permissionAsk = vi.fn().mockResolvedValue({ decision: "allow-always", scope: "global" });
		expect(await checkBash(currentSession, "grep -n foo src")).toBeUndefined();
		expect(currentSession.permissionsManager?.getAllRules()).toContainEqual({
			type: "bash",
			match: "grep *",
			policy: "allow",
			scope: "global",
		});
	});

	it("generalizes approved bash rules for session scope", async () => {
		const currentSession = createSession();
		currentSession.permissionAsk = vi.fn().mockResolvedValue({ decision: "allow-always", scope: "session" });

		expect(await checkBash(currentSession, "rg -n foo src")).toBeUndefined();
		expect(currentSession.permissionsManager?.getAllRules()).toContainEqual({
			type: "bash",
			match: "rg *",
			policy: "allow",
			scope: "session",
		});
		expect(currentSession.permissionsManager?.checkPolicy("bash", "rg -n other")).toBe("allow");
		expect(currentSession.permissionsManager?.checkPolicy("bash", "rg other -n")).toBe("allow");
		expect(currentSession.permissionsManager?.checkPolicy("bash", "rgx other -n")).toBe("ask");
	});

	it("does not generalize compound commands into one broad rule", () => {
		expect(generalizeBashPermissionMatch("ls -la && rm -rf tmp")).toBe("ls -la && rm -rf tmp");
	});
});
