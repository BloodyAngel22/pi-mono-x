/**
 * Tests for tool result compression (Level 1 + Level 2).
 *
 * Level 1: drop trivial successful tool results entirely (summarization-only).
 * Level 2: replace successful tool result content with metadata (lines / size).
 *
 * Error tool results are always preserved verbatim.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { compressToolResults } from "../src/core/compaction/utils.js";

// ============================================================================
// Helpers
// ============================================================================

function toolResult(overrides: {
	toolName: string;
	content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
	timestamp?: number;
}): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		isError: false,
		timestamp: Date.now(),
		content: [{ type: "text", text: "" }],
		...overrides,
	} as AgentMessage;
}

function textContent(m: AgentMessage): string | undefined {
	if ("content" in m && Array.isArray(m.content)) {
		const block = m.content.find((c) => c.type === "text");
		return (block as { text?: string } | undefined)?.text;
	}
	return undefined;
}

function getIsError(m: AgentMessage): boolean | undefined {
	return "isError" in m ? (m as { isError: boolean }).isError : undefined;
}

// ============================================================================
// compressToolResults
// ============================================================================

describe("compressToolResults", () => {
	it("keeps non-toolResult messages verbatim", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } as AgentMessage,
			{
				role: "assistant",
				content: [{ type: "text", text: "response" }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			} as AgentMessage,
		];
		const result = compressToolResults(messages);
		expect(result).toHaveLength(2);
		expect(result[0]).toBe(messages[0]);
		expect(result[1]).toBe(messages[1]);
	});

	it("preserves error tool results unchanged", () => {
		const messages: AgentMessage[] = [
			toolResult({
				toolName: "bash",
				content: [{ type: "text", text: "permission denied" }],
				isError: true,
			}),
		];
		const result = compressToolResults(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("toolResult");
		expect(getIsError(result[0])).toBe(true);
		expect(textContent(result[0])).toBe("permission denied");
	});

	it("compresses non-trivial successful tool result to metadata (Level 2)", () => {
		const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		const messages: AgentMessage[] = [
			toolResult({
				toolName: "read",
				content: [{ type: "text", text: longOutput }],
			}),
		];
		const result = compressToolResults(messages);
		expect(result).toHaveLength(1);
		expect(textContent(result[0])).toMatch(/^\[Compressed successful tool result: read \(tc-1\) → 50 lines/);
	});

	it("replaces content array entirely so no images remain in compressed tool result", () => {
		const messages: AgentMessage[] = [
			toolResult({
				toolName: "bash",
				content: [
					{ type: "text", text: "output" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
			}),
		];
		const result = compressToolResults(messages);
		expect(result).toHaveLength(1);
		if ("content" in result[0] && Array.isArray(result[0].content)) {
			expect(result[0].content.every((c) => c.type === "text")).toBe(true);
		}
		expect(textContent(result[0])).toMatch(/1 image/);
	});

	it("drops trivial successful tool results with dropSmallResults=true (Level 1)", () => {
		const messages: AgentMessage[] = [
			toolResult({
				toolName: "write",
				content: [{ type: "text", text: "ok" }],
			}),
		];
		const result = compressToolResults(messages, { dropSmallResults: true });
		expect(result).toHaveLength(0);
	});

	it("does not drop trivial results by default (keep them as metadata)", () => {
		const messages: AgentMessage[] = [
			toolResult({
				toolName: "write",
				content: [{ type: "text", text: "ok" }],
			}),
		];
		const result = compressToolResults(messages);
		expect(result).toHaveLength(1);
	});

	it("drops only trivial results near threshold boundary (dropSmallResults=true)", () => {
		const messages: AgentMessage[] = [
			toolResult({
				toolName: "edit",
				content: [{ type: "text", text: " ".repeat(50) }],
			}),
			toolResult({
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(250) }],
			}),
		];
		const result = compressToolResults(messages, { dropSmallResults: true });
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("toolResult");
		if ("toolName" in result[0]) {
			expect(result[0].toolName).toBe("read");
		}
	});

	it("applies custom smallTextThreshold", () => {
		const messages: AgentMessage[] = [
			toolResult({
				toolName: "write",
				content: [{ type: "text", text: "x".repeat(300) }],
			}),
		];
		const result = compressToolResults(messages, { dropSmallResults: true, smallTextThreshold: 500 });
		expect(result).toHaveLength(0);
	});

	it("preserves error tool results even when dropSmallResults=true", () => {
		const messages: AgentMessage[] = [
			toolResult({
				toolName: "bash",
				content: [{ type: "text", text: "err" }],
				isError: true,
			}),
		];
		const result = compressToolResults(messages, { dropSmallResults: true });
		expect(result).toHaveLength(1);
		expect(getIsError(result[0])).toBe(true);
	});

	it("compresses empty tool result to metadata as well", () => {
		const messages: AgentMessage[] = [
			toolResult({
				toolName: "bash",
				content: [{ type: "text", text: "" }],
			}),
		];
		const result = compressToolResults(messages);
		expect(result).toHaveLength(1);
		expect(textContent(result[0])).toMatch(/0 lines/);
	});

	it("handles mixed sequence: user, toolResult, assistant, toolResult", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "read file.ts" }], timestamp: 1 } as AgentMessage,
			toolResult({
				toolName: "read",
				content: [{ type: "text", text: "file content\n".repeat(40) }],
			}),
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			} as AgentMessage,
			toolResult({
				toolName: "bash",
				content: [{ type: "text", text: "" }],
			}),
		];
		const result = compressToolResults(messages, { dropSmallResults: true });
		expect(result).toHaveLength(3);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("toolResult");
		if ("toolName" in result[1]) {
			expect(result[1].toolName).toBe("read");
		}
		expect(result[2].role).toBe("assistant");
	});

	// ============================================================
	// Before/After contrast tests
	// ============================================================

	it("[BEFORE vs AFTER] content: raw multi-line output -> metadata one-liner", () => {
		const rawContent = ["function hello() {", '  console.log("world");', "}", "", "export default hello;"].join("\n");

		const messages: AgentMessage[] = [
			toolResult({ toolName: "read", content: [{ type: "text", text: rawContent }] }),
		];

		// BEFORE: content is the raw file
		expect(textContent(messages[0])).toBe(rawContent);

		// AFTER: replaced with metadata line
		const result = compressToolResults(messages);
		expect(result).toHaveLength(1);
		const after = textContent(result[0]);
		expect(after).toMatch(/^\[Compressed successful tool result: read/);
		expect(after).not.toContain("function hello");
		expect(after).not.toContain("console.log");
	});

	it("[BEFORE vs AFTER] successful is compressed, error is not", () => {
		const successMsg = toolResult({
			toolName: "read",
			content: [{ type: "text", text: "const x = 1;\n" }],
			isError: false,
		});
		const errorMsg = toolResult({
			toolName: "bash",
			content: [{ type: "text", text: "ls: cannot access 'foo': No such file or directory" }],
			isError: true,
		});

		// BEFORE: both have raw content
		expect(textContent(successMsg)).toBe("const x = 1;\n");
		expect(textContent(errorMsg)).toBe("ls: cannot access 'foo': No such file or directory");

		const result = compressToolResults([successMsg, errorMsg]);
		expect(result).toHaveLength(2);

		// AFTER: success is compressed
		expect(getIsError(result[0])).toBe(false);
		expect(textContent(result[0])).toMatch(/^\[Compressed successful tool result: read/);

		// AFTER: error is unchanged
		expect(getIsError(result[1])).toBe(true);
		expect(textContent(result[1])).toBe("ls: cannot access 'foo': No such file or directory");
	});

	it("[BEFORE vs AFTER] dropSmallResults=true removes trivial results entirely", () => {
		const messages: AgentMessage[] = [
			toolResult({ toolName: "write", content: [{ type: "text", text: "Created file.ts" }] }),
		];

		expect(messages).toHaveLength(1);

		const result = compressToolResults(messages, { dropSmallResults: true });
		expect(result).toHaveLength(0);
	});

	// ============================================================
	// Size reduction in percent
	// ============================================================

	it("quantifies size reduction: raw 100% -> compressed ~0.1 % for large reads", () => {
		const line = "x".repeat(100);
		const rawContent = Array.from({ length: 500 }, (_, i) => `${i}: ${line}`).join("\n");
		const beforeLen = rawContent.length;

		const messages: AgentMessage[] = [
			toolResult({ toolName: "read", content: [{ type: "text", text: rawContent }] }),
		];

		// BEFORE: 100% of original content
		expect(textContent(messages[0])).toBe(rawContent);

		const result = compressToolResults(messages);
		const afterText = textContent(result[0]);
		const afterLen = afterText!.length;
		const afterPct = (afterLen / beforeLen) * 100;

		// AFTER: metadata ~80 chars / 50000 chars = ~0.16 %
		expect(afterPct).toBeLessThan(0.2);
	});

	it("quantifies size reduction: bash output 15KB -> ~0.6 %", () => {
		const rawContent = Array.from({ length: 300 }, (_, i) => `line-${i}: some text here for context`).join("\n");
		const beforeLen = rawContent.length;

		const result = compressToolResults([
			toolResult({ toolName: "bash", content: [{ type: "text", text: rawContent }] }),
		]);
		const afterText = textContent(result[0]);
		const afterLen = afterText!.length;
		const afterPct = (afterLen / beforeLen) * 100;

		expect(afterPct).toBeLessThan(1.0);
		expect(afterPct).toBeGreaterThan(0.4);
	});

	it("quantifies size reduction: error result stays 100 %", () => {
		const rawContent = "bash: line 1: some-command: command not found";
		const beforeLen = rawContent.length;

		const result = compressToolResults([
			toolResult({ toolName: "bash", content: [{ type: "text", text: rawContent }], isError: true }),
		]);
		const afterText = textContent(result[0]);
		expect(afterText!.length).toBe(beforeLen);
		expect(afterText).toBe(rawContent);
	});

	it("quantifies size reduction: tiny successful result dropped to 0 %", () => {
		const result = compressToolResults([toolResult({ toolName: "write", content: [{ type: "text", text: "Ok" }] })], {
			dropSmallResults: true,
		});
		expect(result).toHaveLength(0);
	});
});
