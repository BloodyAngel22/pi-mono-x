/**
 * Integration tests for context pruning wired through AgentSession/Agent.
 *
 * Verifies that pruneStaleToolResults (test/prune.test.ts covers it in isolation)
 * is actually applied on the transient LLM-bound context via transformContext,
 * without ever touching persisted session state.
 */

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { pruneStaleReadOnlyToolResults, pruneStaleToolResults } from "../src/core/compaction/index.js";
import { createHarness, type Harness } from "./test-harness.js";

function fileContentsFor(path: string): string {
	return `contents of ${path}\n`.repeat(50);
}

function createFakeReadTool(): AgentTool {
	return {
		name: "read",
		label: "Read",
		description: "Read a file",
		parameters: Type.Object({ path: Type.String() }),
		execute: async (_id, params) => {
			const { path } = params as { path: string };
			return { content: [{ type: "text", text: fileContentsFor(path) }], details: {} };
		},
	};
}

function lsListingFor(path: string, generation: number): string {
	return `${path} listing (v${generation})\n`.repeat(50);
}

function createFakeLsTool(): AgentTool {
	let generation = 0;
	return {
		name: "ls",
		label: "List",
		description: "List a directory",
		parameters: Type.Object({ path: Type.Optional(Type.String()) }),
		execute: async (_id, params) => {
			const { path } = params as { path?: string };
			generation += 1;
			return { content: [{ type: "text", text: lsListingFor(path ?? ".", generation) }], details: {} };
		},
	};
}

function grepMatchFor(pattern: string, generation: number): string {
	return `match for ${pattern} (v${generation})\n`.repeat(50);
}

function createFakeGrepTool(): AgentTool {
	let generation = 0;
	return {
		name: "grep",
		label: "Grep",
		description: "Search file contents",
		parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
		execute: async (_id, params) => {
			const { pattern } = params as { pattern: string };
			generation += 1;
			return { content: [{ type: "text", text: grepMatchFor(pattern, generation) }], details: {} };
		},
	};
}

function createFakeWriteTool(): AgentTool {
	return {
		name: "write",
		label: "Write",
		description: "Write a file",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		execute: async () => {
			return { content: [{ type: "text", text: "written" }], details: {} };
		},
	};
}

/** Mirrors the transformContext wiring in core/sdk.ts, for a harness-backed session. */
function makeTransformContext(sessionRef: { current?: AgentSession }) {
	return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
		if (!sessionRef.current?.contextPruningEnabled) return messages;
		let working = messages;
		const pruned = pruneStaleToolResults(working);
		if (pruned.prunedToolCallIds.length > 0) {
			sessionRef.current.notifyContextPruned({
				prunedCount: pruned.prunedToolCallIds.length,
				tokensFreed: pruned.tokensFreed,
				paths: pruned.paths,
			});
			working = pruned.messages;
		}
		const prunedReadOnly = pruneStaleReadOnlyToolResults(working);
		if (prunedReadOnly.prunedToolCallIds.length > 0) {
			sessionRef.current.notifyContextPruned({
				prunedCount: prunedReadOnly.prunedToolCallIds.length,
				tokensFreed: prunedReadOnly.tokensFreed,
				paths: prunedReadOnly.paths,
			});
			working = prunedReadOnly.messages;
		}
		return working;
	};
}

describe("context pruning integration", () => {
	let harness: Harness;

	afterEach(() => {
		harness?.cleanup();
	});

	it("replaces a stale read result in the transient LLM context, but not in persisted state", async () => {
		const readTool = createFakeReadTool();
		const sessionRef: { current?: AgentSession } = {};
		harness = createHarness({
			responses: [
				{ toolCalls: [{ id: "call-1", name: "read", args: { path: "foo.ts" } }] },
				{ toolCalls: [{ id: "call-2", name: "read", args: { path: "foo.ts" } }] },
				"done",
			],
			tools: [readTool],
			baseToolsOverride: { read: readTool },
			transformContext: makeTransformContext(sessionRef),
		});
		sessionRef.current = harness.session;

		await harness.session.prompt("read foo.ts twice");

		// Three LLM calls: first read, second read (nothing to prune yet), then final text
		// (with the first read's result already pruned in that third call's context).
		expect(harness.faux.callCount).toBe(3);

		const thirdCallContext = harness.faux.contexts[2];
		const toolResultsInThirdCall = thirdCallContext.messages.filter((m) => m.role === "toolResult");
		expect(toolResultsInThirdCall).toHaveLength(2);

		const [firstReadInContext, secondReadInContext] = toolResultsInThirdCall;
		const firstText = (firstReadInContext.content[0] as { text: string }).text;
		const secondText = (secondReadInContext.content[0] as { text: string }).text;
		expect(firstText).toContain("Stale read result for foo.ts");
		expect(secondText).toBe(fileContentsFor("foo.ts"));

		// Persisted agent state must retain the original, unmodified content.
		const persistedToolResults = harness.session.messages.filter((m) => m.role === "toolResult");
		expect(persistedToolResults).toHaveLength(2);
		for (const m of persistedToolResults) {
			expect((m.content[0] as { text: string }).text).toBe(fileContentsFor("foo.ts"));
		}

		// And the on-disk-equivalent session entries (in-memory session manager here) too.
		const entries = harness.sessionManager.getEntries();
		const toolResultEntries = entries.filter((e) => e.type === "message" && e.message.role === "toolResult");
		for (const e of toolResultEntries) {
			if (e.type === "message" && e.message.role === "toolResult") {
				expect((e.message.content[0] as { text: string }).text).toBe(fileContentsFor("foo.ts"));
			}
		}

		const prunedEvents = harness.eventsOfType("context_pruned");
		expect(prunedEvents).toHaveLength(1);
		expect(prunedEvents[0]).toMatchObject({ prunedCount: 1, paths: ["foo.ts"] });
		expect(prunedEvents[0].tokensFreed).toBeGreaterThan(0);
	});

	it("does not prune when contextPruningEnabled is set to false", async () => {
		const readTool = createFakeReadTool();
		const sessionRef: { current?: AgentSession } = {};
		harness = createHarness({
			responses: [
				{ toolCalls: [{ id: "call-1", name: "read", args: { path: "foo.ts" } }] },
				{ toolCalls: [{ id: "call-2", name: "read", args: { path: "foo.ts" } }] },
				"done",
			],
			tools: [readTool],
			baseToolsOverride: { read: readTool },
			transformContext: makeTransformContext(sessionRef),
		});
		sessionRef.current = harness.session;

		harness.session.setContextPruningEnabled(false);
		expect(harness.session.contextPruningEnabled).toBe(false);

		await harness.session.prompt("read foo.ts twice");

		const thirdCallContext = harness.faux.contexts[2];
		const toolResultsInThirdCall = thirdCallContext.messages.filter((m) => m.role === "toolResult");
		for (const m of toolResultsInThirdCall) {
			expect((m.content[0] as { text: string }).text).toBe(fileContentsFor("foo.ts"));
		}

		expect(harness.eventsOfType("context_pruned")).toHaveLength(0);
	});

	it("replaces a stale ls result in the transient LLM context, but not in persisted state", async () => {
		const lsTool = createFakeLsTool();
		const sessionRef: { current?: AgentSession } = {};
		harness = createHarness({
			responses: [
				{ toolCalls: [{ id: "call-1", name: "ls", args: { path: "src" } }] },
				{ toolCalls: [{ id: "call-2", name: "ls", args: { path: "src" } }] },
				"done",
			],
			tools: [lsTool],
			baseToolsOverride: { ls: lsTool },
			transformContext: makeTransformContext(sessionRef),
		});
		sessionRef.current = harness.session;

		await harness.session.prompt("list src twice");

		const thirdCallContext = harness.faux.contexts[2];
		const toolResultsInThirdCall = thirdCallContext.messages.filter((m) => m.role === "toolResult");
		expect(toolResultsInThirdCall).toHaveLength(2);

		const [firstLsInContext, secondLsInContext] = toolResultsInThirdCall;
		expect((firstLsInContext.content[0] as { text: string }).text).toContain("Stale ls result");
		expect((secondLsInContext.content[0] as { text: string }).text).toBe(lsListingFor("src", 2));

		// Persisted agent state must retain the original, unmodified content.
		const persistedToolResults = harness.session.messages.filter((m) => m.role === "toolResult");
		expect(persistedToolResults).toHaveLength(2);
		expect((persistedToolResults[0].content[0] as { text: string }).text).toBe(lsListingFor("src", 1));

		const prunedEvents = harness.eventsOfType("context_pruned");
		expect(prunedEvents).toHaveLength(1);
		expect(prunedEvents[0]).toMatchObject({ prunedCount: 1, paths: ["src"] });
	});

	it("invalidates a live grep result when a write touches the same path", async () => {
		const grepTool = createFakeGrepTool();
		const writeTool = createFakeWriteTool();
		const sessionRef: { current?: AgentSession } = {};
		harness = createHarness({
			responses: [
				{ toolCalls: [{ id: "call-1", name: "grep", args: { pattern: "foo", path: "src" } }] },
				{ toolCalls: [{ id: "call-2", name: "write", args: { path: "src/bar.ts", content: "x" } }] },
				"done",
			],
			tools: [grepTool, writeTool],
			baseToolsOverride: { grep: grepTool, write: writeTool },
			transformContext: makeTransformContext(sessionRef),
		});
		sessionRef.current = harness.session;

		await harness.session.prompt("grep foo in src, then write src/bar.ts");

		const thirdCallContext = harness.faux.contexts[2];
		const grepResultInContext = thirdCallContext.messages
			.filter((m) => m.role === "toolResult")
			.find((m) => m.toolCallId === "call-1");
		expect(grepResultInContext).toBeDefined();
		expect((grepResultInContext?.content[0] as { text: string }).text).toContain("Stale grep result");

		// Persisted state keeps the original grep match.
		const persistedGrepResult = harness.session.messages
			.filter((m) => m.role === "toolResult")
			.find((m) => m.toolCallId === "call-1");
		expect((persistedGrepResult?.content[0] as { text: string }).text).toBe(grepMatchFor("foo", 1));

		const prunedEvents = harness.eventsOfType("context_pruned");
		expect(prunedEvents.length).toBeGreaterThanOrEqual(1);
	});

	it("does not prune ls/grep results when contextPruningEnabled is set to false", async () => {
		const lsTool = createFakeLsTool();
		const sessionRef: { current?: AgentSession } = {};
		harness = createHarness({
			responses: [
				{ toolCalls: [{ id: "call-1", name: "ls", args: { path: "src" } }] },
				{ toolCalls: [{ id: "call-2", name: "ls", args: { path: "src" } }] },
				"done",
			],
			tools: [lsTool],
			baseToolsOverride: { ls: lsTool },
			transformContext: makeTransformContext(sessionRef),
		});
		sessionRef.current = harness.session;

		harness.session.setContextPruningEnabled(false);

		await harness.session.prompt("list src twice");

		const thirdCallContext = harness.faux.contexts[2];
		const toolResultsInThirdCall = thirdCallContext.messages.filter((m) => m.role === "toolResult");
		expect((toolResultsInThirdCall[0].content[0] as { text: string }).text).toBe(lsListingFor("src", 1));

		expect(harness.eventsOfType("context_pruned")).toHaveLength(0);
	});
});
