import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { pruneStaleReadOnlyToolResults } from "../src/core/compaction/index.js";

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

function textOf(message: AgentMessage): string {
	return ((message as ToolResultMessage).content[0] as { text: string }).text;
}

describe("pruneStaleReadOnlyToolResults", () => {
	describe("ls", () => {
		it("marks an old ls as stale when the same path+limit is listed again", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", { path: "src" })),
				createToolResult("call-1", "ls", "a.ts\nb.ts".repeat(50)),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "ls", { path: "src" })),
				createToolResult("call-2", "ls", "a.ts\nb.ts\nc.ts".repeat(50)),
			];

			const result = pruneStaleReadOnlyToolResults(messages);

			expect(result.prunedToolCallIds).toEqual(["call-1"]);
			expect(result.paths).toEqual(["src"]);
			expect(textOf(result.messages[1])).toContain("Stale ls result");
			expect(textOf(result.messages[3])).toBe("a.ts\nb.ts\nc.ts".repeat(50));
		});

		it("does not dedup ls calls with different paths", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", { path: "src" })),
				createToolResult("call-1", "ls", "src listing"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "ls", { path: "test" })),
				createToolResult("call-2", "ls", "test listing"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual([]);
			expect(result.messages).toBe(messages);
		});

		it("does not dedup ls calls with different limits", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", { path: "src", limit: 100 })),
				createToolResult("call-1", "ls", "listing 100"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "ls", { path: "src", limit: 500 })),
				createToolResult("call-2", "ls", "listing 500"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual([]);
		});

		it("defaults missing path to '.' for dedup purposes", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", {})),
				createToolResult("call-1", "ls", "root listing"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "ls", {})),
				createToolResult("call-2", "ls", "root listing again"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual(["call-1"]);
			expect(result.paths).toEqual(["."]);
		});
	});

	describe("find", () => {
		it("marks an old find as stale when pattern+path+limit match", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "find", { pattern: "*.ts", path: "src" })),
				createToolResult("call-1", "find", "a.ts"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "find", { pattern: "*.ts", path: "src" })),
				createToolResult("call-2", "find", "a.ts\nb.ts"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual(["call-1"]);
		});

		it("does not dedup find calls with different patterns", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "find", { pattern: "*.ts", path: "src" })),
				createToolResult("call-1", "find", "a.ts"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "find", { pattern: "*.json", path: "src" })),
				createToolResult("call-2", "find", "package.json"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual([]);
		});
	});

	describe("grep", () => {
		it("marks an old grep as stale when all query-shaping args match", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(
					createToolCallBlock("call-1", "grep", { pattern: "foo", path: "src", glob: "*.ts" }),
				),
				createToolResult("call-1", "grep", "match 1"),
				createAssistantToolCallMessage(
					createToolCallBlock("call-2", "grep", { pattern: "foo", path: "src", glob: "*.ts" }),
				),
				createToolResult("call-2", "grep", "match 1\nmatch 2"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual(["call-1"]);
		});

		it("does not dedup grep calls that differ only in ignoreCase", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "grep", { pattern: "foo", path: "src" })),
				createToolResult("call-1", "grep", "match"),
				createAssistantToolCallMessage(
					createToolCallBlock("call-2", "grep", { pattern: "foo", path: "src", ignoreCase: true }),
				),
				createToolResult("call-2", "grep", "match, Match"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual([]);
		});

		it("does not dedup grep calls that differ only in context lines", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "grep", { pattern: "foo", path: "src" })),
				createToolResult("call-1", "grep", "match"),
				createAssistantToolCallMessage(
					createToolCallBlock("call-2", "grep", { pattern: "foo", path: "src", context: 3 }),
				),
				createToolResult("call-2", "grep", "match with context"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual([]);
		});
	});

	describe("bash", () => {
		it("marks an old bash result as stale when the exact same command is run again", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "bash", { command: "git status" })),
				createToolResult("call-1", "bash", "clean"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "bash", { command: "git status" })),
				createToolResult("call-2", "bash", "1 file changed"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual(["call-1"]);
			expect(result.paths).toEqual(["git status"]);
		});

		it("does not dedup different bash commands", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "bash", { command: "git status" })),
				createToolResult("call-1", "bash", "clean"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "bash", { command: "git log -1" })),
				createToolResult("call-2", "bash", "commit abc"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual([]);
		});

		it("is never invalidated by an intervening write/edit (documented limitation)", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "bash", { command: "cat foo.txt" })),
				createToolResult("call-1", "bash", "old contents"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "write", { path: "foo.txt", content: "new" })),
				createToolResult("call-2", "write", "written"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual([]);
			expect(result.messages).toBe(messages);
		});
	});

	describe("write/edit invalidation of ls/find/grep scope", () => {
		it("invalidates an ls scoped exactly at the write/edit path", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", { path: "src" })),
				createToolResult("call-1", "ls", "old listing"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "write", { path: "src", content: "x" })),
				createToolResult("call-2", "write", "written"),
				createAssistantToolCallMessage(createToolCallBlock("call-3", "ls", { path: "src" })),
				createToolResult("call-3", "ls", "new listing"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual(["call-1"]);
			expect(textOf(result.messages[5])).toBe("new listing");
		});

		it("invalidates an ls/find/grep scoped at a parent directory of the write/edit path", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "grep", { pattern: "foo", path: "src" })),
				createToolResult("call-1", "grep", "old match"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "edit", { path: "src/foo.ts" })),
				createToolResult("call-2", "edit", "edited"),
			];

			// Mirrors read/write/edit semantics: the edit itself marks the overlapping grep
			// result stale immediately, without needing a later repeat grep call.
			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual(["call-1"]);
		});

		it("does not invalidate scopes unrelated to the write/edit path", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", { path: "src" })),
				createToolResult("call-1", "ls", "old listing"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "write", { path: "docs/readme.md" })),
				createToolResult("call-2", "write", "written"),
				createAssistantToolCallMessage(createToolCallBlock("call-3", "ls", { path: "src" })),
				createToolResult("call-3", "ls", "still stale-able"),
			];

			// call-1 survives the unrelated write, so the later identical ls still supersedes it
			// through ordinary dedup (not through the write-invalidation path).
			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual(["call-1"]);
		});

		it("invalidates a default-scope ('.') ls/find/grep on any write/edit", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "find", { pattern: "*.ts" })),
				createToolResult("call-1", "find", "old results"),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "write", { path: "anywhere/deep/file.ts" })),
				createToolResult("call-2", "write", "written"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.prunedToolCallIds).toEqual(["call-1"]);
		});
	});

	describe("error results", () => {
		it("never replaces an isError toolResult even when its call is superseded", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", { path: "src" })),
				createToolResult("call-1", "ls", "permission denied", true),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "ls", { path: "src" })),
				createToolResult("call-2", "ls", "a.ts"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			// call-1 is tracked as stale bookkeeping-wise, but its error result must survive verbatim.
			expect(textOf(result.messages[1])).toBe("permission denied");
			expect(result.prunedToolCallIds).toEqual([]);
		});

		it("never replaces an isError toolResult invalidated via write/edit scope overlap", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", { path: "src" })),
				createToolResult("call-1", "ls", "permission denied", true),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "write", { path: "src" })),
				createToolResult("call-2", "write", "written"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(textOf(result.messages[1])).toBe("permission denied");
			expect(result.prunedToolCallIds).toEqual([]);
		});
	});

	describe("identity and accounting", () => {
		it("preserves object identity for untouched messages", () => {
			const untouchedUser = createUserMessage("hello");
			const staleAssistant = createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", { path: "src" }));
			const staleResult = createToolResult("call-1", "ls", "stale listing");
			const freshAssistant = createAssistantToolCallMessage(createToolCallBlock("call-2", "ls", { path: "src" }));
			const freshResult = createToolResult("call-2", "ls", "fresh listing");

			const messages: AgentMessage[] = [untouchedUser, staleAssistant, staleResult, freshAssistant, freshResult];
			const result = pruneStaleReadOnlyToolResults(messages);

			expect(result.messages[0]).toBe(untouchedUser);
			expect(result.messages[1]).toBe(staleAssistant);
			expect(result.messages[2]).not.toBe(staleResult);
			expect(result.messages[3]).toBe(freshAssistant);
			expect(result.messages[4]).toBe(freshResult);
		});

		it("computes tokensFreed as a positive delta for pruned results", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "ls", { path: "src" })),
				createToolResult("call-1", "ls", "x".repeat(4000)),
				createAssistantToolCallMessage(createToolCallBlock("call-2", "ls", { path: "src" })),
				createToolResult("call-2", "ls", "y"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.tokensFreed).toBeGreaterThan(0);
		});

		it("returns the original array unchanged when nothing is pruned", () => {
			const messages: AgentMessage[] = [
				createAssistantToolCallMessage(createToolCallBlock("call-1", "bash", { command: "echo hi" })),
				createToolResult("call-1", "bash", "hi"),
			];

			const result = pruneStaleReadOnlyToolResults(messages);
			expect(result.messages).toBe(messages);
			expect(result.prunedToolCallIds).toEqual([]);
			expect(result.tokensFreed).toBe(0);
			expect(result.paths).toEqual([]);
		});
	});
});
