import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildFileManifestMessage,
	computeFileManifestSections,
	formatFileManifest,
	pruneStaleToolResults,
} from "../src/core/compaction/index.js";

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

describe("computeFileManifestSections", () => {
	it("returns undefined when no files were touched", () => {
		const messages: AgentMessage[] = [createUserMessage("hello"), createUserMessage("world")];
		expect(computeFileManifestSections(messages)).toBeUndefined();
	});

	it("reports a read-only file as fresh", () => {
		const messages: AgentMessage[] = [
			createUserMessage("read foo.ts"),
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" })),
			createToolResult("call-1", "read", "contents of foo.ts"),
		];

		expect(computeFileManifestSections(messages)).toEqual({
			modifiedFiles: [],
			freshReadFiles: ["foo.ts"],
			prunedReadFiles: [],
		});
	});

	it("reports a file read then written (no re-read) as modified and pruned", () => {
		const messages: AgentMessage[] = [
			createUserMessage("read then write foo.ts"),
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" })),
			createToolResult("call-1", "read", "original content"),
			createAssistantToolCallMessage(createToolCallBlock("call-2", "write", { path: "foo.ts", content: "new" })),
			createToolResult("call-2", "write", "written successfully"),
		];

		// Realistic composition: run the actual prune step first, exactly as sdk.ts's
		// transformContext does, so the manifest reflects genuinely stubbed content.
		const pruned = pruneStaleToolResults(messages).messages;

		expect(computeFileManifestSections(pruned)).toEqual({
			modifiedFiles: ["foo.ts"],
			freshReadFiles: [],
			prunedReadFiles: ["foo.ts"],
		});
	});

	it("keeps a twice-read file fresh (most recent read is never pruned)", () => {
		const messages: AgentMessage[] = [
			createUserMessage("read foo.ts twice"),
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" })),
			createToolResult("call-1", "read", "first read".repeat(50)),
			createAssistantToolCallMessage(createToolCallBlock("call-2", "read", { path: "foo.ts" })),
			createToolResult("call-2", "read", "second read".repeat(50)),
		];

		const pruned = pruneStaleToolResults(messages).messages;

		expect(computeFileManifestSections(pruned)).toEqual({
			modifiedFiles: [],
			freshReadFiles: ["foo.ts"],
			prunedReadFiles: [],
		});
	});

	it("splits multiple files across fresh-read, pruned-read, and modified buckets", () => {
		const messages: AgentMessage[] = [
			createUserMessage("read a.ts, then read+write b.ts"),
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "a.ts" })),
			createToolResult("call-1", "read", "contents of a.ts"),
			createAssistantToolCallMessage(createToolCallBlock("call-2", "read", { path: "b.ts" })),
			createToolResult("call-2", "read", "original b.ts"),
			createAssistantToolCallMessage(createToolCallBlock("call-3", "edit", { path: "b.ts", old: "x", new: "y" })),
			createToolResult("call-3", "edit", "edited successfully"),
		];

		const pruned = pruneStaleToolResults(messages).messages;

		expect(computeFileManifestSections(pruned)).toEqual({
			modifiedFiles: ["b.ts"],
			freshReadFiles: ["a.ts"],
			prunedReadFiles: ["b.ts"],
		});
	});
});

describe("formatFileManifest", () => {
	it("omits empty sections", () => {
		const text = formatFileManifest({ modifiedFiles: ["a.ts"], freshReadFiles: [], prunedReadFiles: [] });
		expect(text).toBe("Modified this session: a.ts");
	});

	it("includes all non-empty sections", () => {
		const text = formatFileManifest({
			modifiedFiles: ["a.ts"],
			freshReadFiles: ["b.ts"],
			prunedReadFiles: ["c.ts"],
		});
		expect(text).toContain("Modified this session: a.ts");
		expect(text).toContain("Read this session (still visible above): b.ts");
		expect(text).toContain(
			"Read this session (content pruned from context — re-read if you need current contents): c.ts",
		);
	});
});

describe("buildFileManifestMessage", () => {
	it("returns undefined when there's nothing to show", () => {
		expect(buildFileManifestMessage([createUserMessage("hi")], new Date().toISOString())).toBeUndefined();
	});

	it("builds a custom message with the formatted manifest as content", () => {
		const messages: AgentMessage[] = [
			createAssistantToolCallMessage(createToolCallBlock("call-1", "read", { path: "foo.ts" })),
			createToolResult("call-1", "read", "contents"),
		];

		const message = buildFileManifestMessage(messages, new Date().toISOString());
		expect(message).toBeDefined();
		expect(message?.role).toBe("custom");
		expect(message?.customType).toBe("file-manifest");
		expect(message?.content).toBe("Read this session (still visible above): foo.ts");
	});
});
