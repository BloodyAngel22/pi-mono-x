import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateTokens, pruneStaleToolResults } from "../src/core/compaction/index.js";

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createToolCallBlock(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function createAssistantToolCallMessage(...calls: ToolCall[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function createToolResult(toolCallId: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

function createBashToolCallMessage(id: string, command: string): AssistantMessage {
	return createAssistantToolCallMessage(createToolCallBlock(id, "bash", { command }));
}

describe("pruneStaleToolResults", () => {
	it("marks an old read as stale when the same path is read again", () => {
		const messages: AgentMessage[] = [
			createUserMessage("read foo.ts twice"),
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" })),
			createToolResult("call-1", "read", "first read content".repeat(50)),
			createAssistantToolCallMessage(createToolCallBlock("call-2", "read", { path: "foo.ts" })),
			createToolResult("call-2", "read", "second read content".repeat(50)),
		];

		const result = pruneStaleToolResults(messages);

		expect(result.prunedToolCallIds).toEqual(["call-1"]);
		expect(result.paths).toEqual(["foo.ts"]);
		expect(result.tokensFreed).toBeGreaterThan(0);

		const firstResult = result.messages[2] as ToolResultMessage;
		expect(firstResult.content[0]).toMatchObject({ type: "text" });
		expect((firstResult.content[0] as { text: string }).text).toContain("Stale read result for foo.ts");

		const secondResult = result.messages[4] as ToolResultMessage;
		expect((secondResult.content[0] as { text: string }).text).toBe("second read content".repeat(50));
	});

	it("marks an old read as stale when the same path is later edited", () => {
		const messages: AgentMessage[] = [
			createUserMessage("read then edit foo.ts"),
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" })),
			createToolResult("call-1", "read", "original content"),
			createAssistantToolCallMessage(createToolCallBlock("call-2", "edit", { path: "foo.ts", old: "a", new: "b" })),
			createToolResult("call-2", "edit", "edited successfully"),
		];

		const result = pruneStaleToolResults(messages);

		expect(result.prunedToolCallIds).toEqual(["call-1"]);
		// The edit's own tool result is never pruned in v1.
		const editResult = result.messages[4] as ToolResultMessage;
		expect((editResult.content[0] as { text: string }).text).toBe("edited successfully");
	});

	it("marks an old read as stale when the same path is later written", () => {
		const messages: AgentMessage[] = [
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" })),
			createToolResult("call-1", "read", "original content"),
			createAssistantToolCallMessage(createToolCallBlock("call-2", "write", { path: "foo.ts", content: "new" })),
			createToolResult("call-2", "write", "written successfully"),
		];

		const result = pruneStaleToolResults(messages);
		expect(result.prunedToolCallIds).toEqual(["call-1"]);
	});

	it("does not prune reads of different paths", () => {
		const messages: AgentMessage[] = [
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "a.ts" })),
			createToolResult("call-1", "read", "content a"),
			createAssistantToolCallMessage(createToolCallBlock("call-2", "read", { path: "b.ts" })),
			createToolResult("call-2", "read", "content b"),
		];

		const result = pruneStaleToolResults(messages);
		expect(result.prunedToolCallIds).toEqual([]);
		expect(result.messages).toBe(messages);
	});

	it("treats a read after an edit as a fresh baseline, not immediately stale", () => {
		const messages: AgentMessage[] = [
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" })),
			createToolResult("call-1", "read", "before edit"),
			createAssistantToolCallMessage(createToolCallBlock("call-2", "edit", { path: "foo.ts" })),
			createToolResult("call-2", "edit", "edited"),
			createAssistantToolCallMessage(createToolCallBlock("call-3", "read", { path: "foo.ts" })),
			createToolResult("call-3", "read", "after edit"),
		];

		const result = pruneStaleToolResults(messages);

		expect(result.prunedToolCallIds).toEqual(["call-1"]);
		const thirdResult = result.messages[5] as ToolResultMessage;
		expect((thirdResult.content[0] as { text: string }).text).toBe("after edit");
	});

	it("never touches non-file tools like bash", () => {
		const messages: AgentMessage[] = [
			createBashToolCallMessage("call-1", "ls"),
			createToolResult("call-1", "bash", "file listing"),
		];

		const result = pruneStaleToolResults(messages);
		expect(result.prunedToolCallIds).toEqual([]);
		expect(result.messages).toBe(messages);
	});

	it("preserves object identity for untouched messages", () => {
		const untouchedUser = createUserMessage("hello");
		const staleAssistant = createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" }));
		const staleResult = createToolResult("call-1", "read", "stale content");
		const freshAssistant = createAssistantToolCallMessage(createToolCallBlock("call-2", "read", { path: "foo.ts" }));
		const freshResult = createToolResult("call-2", "read", "fresh content");

		const messages: AgentMessage[] = [untouchedUser, staleAssistant, staleResult, freshAssistant, freshResult];
		const result = pruneStaleToolResults(messages);

		expect(result.messages[0]).toBe(untouchedUser);
		expect(result.messages[1]).toBe(staleAssistant);
		expect(result.messages[2]).not.toBe(staleResult);
		expect(result.messages[3]).toBe(freshAssistant);
		expect(result.messages[4]).toBe(freshResult);
	});

	it("computes tokensFreed as the estimator delta for each pruned result", () => {
		const staleResult = createToolResult("call-1", "read", "x".repeat(4000));
		const messages: AgentMessage[] = [
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" })),
			staleResult,
			createAssistantToolCallMessage(createToolCallBlock("call-2", "read", { path: "foo.ts" })),
			createToolResult("call-2", "read", "y"),
		];

		const result = pruneStaleToolResults(messages);
		const replaced = result.messages[1] as ToolResultMessage;
		const expectedFreed = estimateTokens(staleResult) - estimateTokens(replaced);
		expect(result.tokensFreed).toBe(expectedFreed);
	});
});
