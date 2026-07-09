import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	type BranchSummaryEntry,
	buildFullSessionHistory,
	buildSessionContext,
	type CompactionEntry,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../../src/core/session-manager.js";

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") {
		return { ...base, message: { role, content: text, timestamp: 1 } };
	}
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function compaction(id: string, parentId: string | null, summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

function branchSummary(id: string, parentId: string | null, summary: string, fromId: string): BranchSummaryEntry {
	return { type: "branch_summary", id, parentId, timestamp: "2025-01-01T00:00:00Z", summary, fromId };
}

function thinkingLevel(id: string, parentId: string | null, level: string): ThinkingLevelChangeEntry {
	return { type: "thinking_level_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", thinkingLevel: level };
}

function modelChange(id: string, parentId: string | null, provider: string, modelId: string): ModelChangeEntry {
	return { type: "model_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", provider, modelId };
}

describe("buildSessionContext", () => {
	describe("trivial cases", () => {
		it("empty entries returns empty context", () => {
			const ctx = buildSessionContext([]);
			expect(ctx.messages).toEqual([]);
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toBeNull();
		});

		it("single user message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello")];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(1);
			expect(ctx.messages[0].role).toBe("user");
		});

		it("simple conversation", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				msg("2", "1", "assistant", "hi there"),
				msg("3", "2", "user", "how are you"),
				msg("4", "3", "assistant", "great"),
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(4);
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		});

		it("tracks thinking level changes", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				thinkingLevel("2", "1", "high"),
				msg("3", "2", "assistant", "thinking hard"),
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.thinkingLevel).toBe("high");
			expect(ctx.messages).toHaveLength(2);
		});

		it("tracks model from assistant message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "1", "assistant", "hi")];
			const ctx = buildSessionContext(entries);
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
		});

		it("tracks model from model change entry", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				modelChange("2", "1", "openai", "gpt-4"),
				msg("3", "2", "assistant", "hi"),
			];
			const ctx = buildSessionContext(entries);
			// Assistant message overwrites model change
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
		});
	});

	describe("with compaction", () => {
		it("includes summary before kept messages", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response1"),
				msg("3", "2", "user", "second"),
				msg("4", "3", "assistant", "response2"),
				compaction("5", "4", "Summary of first two turns", "3"),
				msg("6", "5", "user", "third"),
				msg("7", "6", "assistant", "response3"),
			];
			const ctx = buildSessionContext(entries);

			// Should have: summary + kept (3,4) + after (6,7) = 5 messages
			expect(ctx.messages).toHaveLength(5);
			expect((ctx.messages[0] as any).summary).toContain("Summary of first two turns");
			expect((ctx.messages[1] as any).content).toBe("second");
			expect((ctx.messages[2] as any).content[0].text).toBe("response2");
			expect((ctx.messages[3] as any).content).toBe("third");
			expect((ctx.messages[4] as any).content[0].text).toBe("response3");
		});

		it("handles compaction keeping from first message", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response"),
				compaction("3", "2", "Empty summary", "1"),
				msg("4", "3", "user", "second"),
			];
			const ctx = buildSessionContext(entries);

			// Summary + all messages (1,2,4)
			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[0] as any).summary).toContain("Empty summary");
		});

		it("multiple compactions uses latest", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "a"),
				msg("2", "1", "assistant", "b"),
				compaction("3", "2", "First summary", "1"),
				msg("4", "3", "user", "c"),
				msg("5", "4", "assistant", "d"),
				compaction("6", "5", "Second summary", "4"),
				msg("7", "6", "user", "e"),
			];
			const ctx = buildSessionContext(entries);

			// Should use second summary, keep from 4
			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[0] as any).summary).toContain("Second summary");
		});
	});

	describe("with branches", () => {
		it("follows path to specified leaf", () => {
			// Tree:
			//   1 -> 2 -> 3 (branch A)
			//         \-> 4 (branch B)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "branch A"),
				msg("4", "2", "user", "branch B"),
			];

			const ctxA = buildSessionContext(entries, "3");
			expect(ctxA.messages).toHaveLength(3);
			expect((ctxA.messages[2] as any).content).toBe("branch A");

			const ctxB = buildSessionContext(entries, "4");
			expect(ctxB.messages).toHaveLength(3);
			expect((ctxB.messages[2] as any).content).toBe("branch B");
		});

		it("includes branch summary in path", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "abandoned path"),
				branchSummary("4", "2", "Summary of abandoned work", "3"),
				msg("5", "4", "user", "new direction"),
			];
			const ctx = buildSessionContext(entries, "5");

			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[2] as any).summary).toContain("Summary of abandoned work");
			expect((ctx.messages[3] as any).content).toBe("new direction");
		});

		it("complex tree with multiple branches and compaction", () => {
			// Tree:
			//   1 -> 2 -> 3 -> 4 -> compaction(5) -> 6 -> 7 (main path)
			//              \-> 8 -> 9 (abandoned branch)
			//                    \-> branchSummary(10) -> 11 (resumed from 3)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "r1"),
				msg("3", "2", "user", "q2"),
				msg("4", "3", "assistant", "r2"),
				compaction("5", "4", "Compacted history", "3"),
				msg("6", "5", "user", "q3"),
				msg("7", "6", "assistant", "r3"),
				// Abandoned branch from 3
				msg("8", "3", "user", "wrong path"),
				msg("9", "8", "assistant", "wrong response"),
				// Branch summary resuming from 3
				branchSummary("10", "3", "Tried wrong approach", "9"),
				msg("11", "10", "user", "better approach"),
			];

			// Main path to 7: summary + kept(3,4) + after(6,7)
			const ctxMain = buildSessionContext(entries, "7");
			expect(ctxMain.messages).toHaveLength(5);
			expect((ctxMain.messages[0] as any).summary).toContain("Compacted history");
			expect((ctxMain.messages[1] as any).content).toBe("q2");
			expect((ctxMain.messages[2] as any).content[0].text).toBe("r2");
			expect((ctxMain.messages[3] as any).content).toBe("q3");
			expect((ctxMain.messages[4] as any).content[0].text).toBe("r3");

			// Branch path to 11: 1,2,3 + branch_summary + 11
			const ctxBranch = buildSessionContext(entries, "11");
			expect(ctxBranch.messages).toHaveLength(5);
			expect((ctxBranch.messages[0] as any).content).toBe("start");
			expect((ctxBranch.messages[1] as any).content[0].text).toBe("r1");
			expect((ctxBranch.messages[2] as any).content).toBe("q2");
			expect((ctxBranch.messages[3] as any).summary).toContain("Tried wrong approach");
			expect((ctxBranch.messages[4] as any).content).toBe("better approach");
		});
	});

	describe("edge cases", () => {
		it("uses last entry when leafId not found", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "1", "assistant", "hi")];
			const ctx = buildSessionContext(entries, "nonexistent");
			expect(ctx.messages).toHaveLength(2);
		});

		it("handles orphaned entries gracefully", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				msg("2", "missing", "assistant", "orphan"), // parent doesn't exist
			];
			const ctx = buildSessionContext(entries, "2");
			// Should only get the orphan since parent chain is broken
			expect(ctx.messages).toHaveLength(1);
		});
	});

	describe("compression in pre-compaction kept messages", () => {
		function toolMsg(
			id: string,
			parentId: string | null,
			fields: { toolName: string; text: string; isError?: boolean },
		): SessionMessageEntry {
			const msg: AgentMessage = {
				role: "toolResult",
				toolCallId: `tc-${id}`,
				toolName: fields.toolName,
				content: [{ type: "text", text: fields.text }],
				isError: fields.isError ?? false,
				timestamp: 1,
			};
			return { type: "message", id, parentId, timestamp: "2025-01-01T00:00:00Z", message: msg };
		}

		it("compresses successful tool results in kept pre-compaction messages", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "r1"),
				toolMsg("3", "2", { toolName: "read", text: "line1\nline2\n" }),
				msg("4", "3", "user", "second"),
				compaction("5", "4", "Compacted", "3"),
				msg("6", "5", "user", "third"),
			];
			const ctx = buildSessionContext(entries);

			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[3] as any).content).toBe("third");

			const compressed = ctx.messages[1];
			expect(compressed.role).toBe("toolResult");
			if ("content" in compressed && Array.isArray(compressed.content)) {
				const text = compressed.content.find((c) => c.type === "text") as { text: string } | undefined;
				expect(text?.text).toMatch(/\[Compressed successful tool result: read/);
			}
		});

		it("leaves messages after compaction uncompressed", () => {
			// firstKeptEntryId = "1" means entry 1 is kept before compaction.
			// Entry 3 is after compaction. It should NOT be compressed.
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				compaction("2", "1", "Compacted", "1"),
				toolMsg("3", "2", { toolName: "bash", text: "output\n".repeat(100) }),
			];
			const ctx = buildSessionContext(entries);

			expect(ctx.messages).toHaveLength(3); // summary + kept user + after-compaction toolResult
			const toolResultMsg = ctx.messages[2];
			expect(toolResultMsg.role).toBe("toolResult");
			if ("content" in toolResultMsg && Array.isArray(toolResultMsg.content)) {
				const text = toolResultMsg.content.find((c) => c.type === "text") as { text: string } | undefined;
				expect(text?.text).not.toMatch(/Compressed successful/);
				expect(text?.text).toContain("output");
			}
		});

		it("leaves error tool results uncompressed even in kept zone", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				toolMsg("2", "1", { toolName: "bash", text: "ERROR: something broke", isError: true }),
				msg("3", "2", "assistant", "r1"),
				compaction("4", "3", "Compacted", "2"),
			];
			const ctx = buildSessionContext(entries);

			expect(ctx.messages).toHaveLength(3);
			const errMsg = ctx.messages[1];
			expect(errMsg.role).toBe("toolResult");
			if ("isError" in errMsg) expect(errMsg.isError).toBe(true);
			if ("content" in errMsg && Array.isArray(errMsg.content)) {
				const text = errMsg.content.find((c) => c.type === "text") as { text: string } | undefined;
				expect(text?.text).toBe("ERROR: something broke");
			}
		});

		it("does not compress anything when no compaction entry exists", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				toolMsg("2", "1", { toolName: "bash", text: "output" }),
			];
			const ctx = buildSessionContext(entries);

			expect(ctx.messages).toHaveLength(2);
			expect(ctx.messages[1].role).toBe("toolResult");
			if ("content" in ctx.messages[1] && Array.isArray(ctx.messages[1].content)) {
				const text = ctx.messages[1].content.find((c) => c.type === "text") as { text: string } | undefined;
				expect(text?.text).toBe("output");
			}
		});

		it("compresses multiple tool results in kept zone", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "r1"),
				toolMsg("3", "2", { toolName: "read", text: "content1\n" }),
				msg("4", "3", "user", "second"),
				msg("5", "4", "assistant", "r2"),
				toolMsg("6", "5", { toolName: "bash", text: "done" }),
				compaction("7", "6", "Compacted", "3"),
			];
			const ctx = buildSessionContext(entries);

			expect(ctx.messages).toHaveLength(5);

			const compressedTool1 = ctx.messages[1];
			expect(compressedTool1.role).toBe("toolResult");
			if ("toolName" in compressedTool1) expect(compressedTool1.toolName).toBe("read");

			const compressedTool2 = ctx.messages[4];
			expect(compressedTool2.role).toBe("toolResult");
			if ("toolName" in compressedTool2) expect(compressedTool2.toolName).toBe("bash");
		});

		it("[BEFORE vs AFTER] same message — raw in recent zone, compressed in kept zone", () => {
			// Two identical tool results. One before compaction (kept zone), one after (recent zone).
			// BEFORE: both are raw. AFTER: only the one in recent zone stays raw.
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "r1"),
				toolMsg("3", "2", { toolName: "bash", text: "\n".repeat(100) }), // ← before compaction
				compaction("4", "3", "Compacted", "3"),
				msg("5", "4", "user", "again"),
				msg("6", "5", "assistant", "r2"),
				toolMsg("7", "6", { toolName: "bash", text: "\n".repeat(100) }), // ← after compaction
			];
			const ctx = buildSessionContext(entries);

			// summary + compressed(3: bash) + user(5) + assistant(6) + raw(7: bash) = 6
			// Actually: summary + bash(3) + user(5) + assistant(6) + bash(7)
			// = 5
			expect(ctx.messages).toHaveLength(5);

			// ── Index 1: BEFORE COMPACTION → content REPLACED with metadata
			const keptZone = ctx.messages[1];
			expect(keptZone.role).toBe("toolResult");
			if ("content" in keptZone && Array.isArray(keptZone.content)) {
				const text = keptZone.content.find((c) => c.type === "text") as { text: string } | undefined;
				expect(text?.text).toMatch(/^\[Compressed successful tool result: bash/);
				expect(text?.text).not.toContain("\n".repeat(100)); // raw content gone
			}

			// ── Index 4: AFTER COMPACTION → content UNCHANGED
			const recentZone = ctx.messages[4];
			expect(recentZone.role).toBe("toolResult");
			if ("content" in recentZone && Array.isArray(recentZone.content)) {
				const text = recentZone.content.find((c) => c.type === "text") as { text: string } | undefined;
				expect(text?.text).not.toMatch(/^\[Compressed successful/);
				expect(text?.text).toContain("\n".repeat(100)); // raw content intact
			}
		});
	});
});

describe("buildFullSessionHistory", () => {
	it("matches buildSessionContext when there is no compaction", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "hello"),
			msg("2", "1", "assistant", "hi there"),
			msg("3", "2", "user", "how are you"),
			msg("4", "3", "assistant", "great"),
		];
		const full = buildFullSessionHistory(entries);
		const trimmed = buildSessionContext(entries);
		expect(full.messages).toHaveLength(4);
		expect(full.messages).toEqual(trimmed.messages);
		expect(full.thinkingLevel).toBe(trimmed.thinkingLevel);
		expect(full.model).toEqual(trimmed.model);
	});

	it("keeps messages before firstKeptEntryId that buildSessionContext drops", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first"),
			msg("2", "1", "assistant", "response1"),
			msg("3", "2", "user", "second"),
			msg("4", "3", "assistant", "response2"),
			compaction("5", "4", "Summary of first two turns", "3"),
			msg("6", "5", "user", "third"),
			msg("7", "6", "assistant", "response3"),
		];

		// buildSessionContext drops entries 1-2 (before firstKeptEntryId "3")
		const trimmed = buildSessionContext(entries);
		expect(trimmed.messages).toHaveLength(5);

		// buildFullSessionHistory keeps everything in chronological order:
		// first, response1, second, response2, marker (compaction happened here), third, response3
		const full = buildFullSessionHistory(entries);
		expect(full.messages).toHaveLength(7);
		expect((full.messages[0] as any).content).toBe("first");
		expect((full.messages[1] as any).content[0].text).toBe("response1");
		expect((full.messages[2] as any).content).toBe("second");
		expect((full.messages[3] as any).content[0].text).toBe("response2");
		expect((full.messages[4] as any).summary).toContain("Summary of first two turns");
		expect((full.messages[5] as any).content).toBe("third");
		expect((full.messages[6] as any).content[0].text).toBe("response3");
	});

	it("includes an inline marker for every past compaction, not just the latest", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "a"),
			msg("2", "1", "assistant", "b"),
			compaction("3", "2", "First summary", "1"),
			msg("4", "3", "user", "c"),
			msg("5", "4", "assistant", "d"),
			compaction("6", "5", "Second summary", "4"),
			msg("7", "6", "user", "e"),
		];

		// buildSessionContext only honors the latest compaction
		const trimmed = buildSessionContext(entries);
		expect(trimmed.messages).toHaveLength(4);

		// buildFullSessionHistory keeps both markers and all 5 real messages = 7
		const full = buildFullSessionHistory(entries);
		expect(full.messages).toHaveLength(7);
		expect((full.messages[0] as any).content).toBe("a");
		expect((full.messages[1] as any).content[0].text).toBe("b");
		expect((full.messages[2] as any).summary).toContain("First summary");
		expect((full.messages[3] as any).content).toBe("c");
		expect((full.messages[4] as any).content[0].text).toBe("d");
		expect((full.messages[5] as any).summary).toContain("Second summary");
		expect((full.messages[6] as any).content).toBe("e");
	});
});
