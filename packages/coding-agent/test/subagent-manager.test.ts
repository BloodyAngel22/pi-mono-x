import { describe, expect, it, vi } from "vitest";
import { SubagentManager, type SubagentSessionFactory } from "../src/core/subagent/index.js";

function createHangingFactory(): { factory: SubagentSessionFactory; abort: ReturnType<typeof vi.fn> } {
	const abort = vi.fn();
	const factory: SubagentSessionFactory = async () => ({
		prompt: () => new Promise<void>(() => {}),
		getMessages: () => [],
		subscribe: () => () => {},
		abort,
	});
	return { factory, abort };
}

function createPartialOnAbortFactory(): { factory: SubagentSessionFactory; abort: ReturnType<typeof vi.fn> } {
	const partialMessages = [
		{
			role: "assistant",
			content: [{ type: "text", text: "partial findings before timeout" }],
			usage: { input: 100, output: 50 },
			stopReason: "aborted",
		},
	];
	let messages: typeof partialMessages = [];
	const abort = vi.fn(() => {
		messages = partialMessages;
	});
	const factory: SubagentSessionFactory = async () => ({
		prompt: () => new Promise<void>(() => {}),
		getMessages: () => messages,
		subscribe: () => () => {},
		abort,
	});
	return { factory, abort };
}

function createToolResultOnAbortFactory(): { factory: SubagentSessionFactory; abort: ReturnType<typeof vi.fn> } {
	const partialMessages = [
		{
			role: "toolResult",
			toolName: "web_search",
			content: [
				{
					type: "text",
					text: "Result 1: content-visibility helps skip offscreen rendering.\nResult 2: requestAnimationFrame chunking keeps UI responsive.",
				},
			],
			isError: false,
		},
		{
			role: "toolResult",
			toolName: "read",
			content: [
				{
					type: "text",
					text: "Relevant file: src/lib/useChunkedRender.ts implements chunked incremental rendering.",
				},
			],
			isError: false,
		},
	];
	let messages: typeof partialMessages = [];
	const abort = vi.fn(() => {
		messages = partialMessages;
	});
	const factory: SubagentSessionFactory = async () => ({
		prompt: () => new Promise<void>(() => {}),
		getMessages: () => messages,
		subscribe: () => () => {},
		abort,
	});
	return { factory, abort };
}

describe("SubagentManager", () => {
	it("aborts the underlying session when a task times out", async () => {
		const { factory, abort } = createHangingFactory();
		const manager = new SubagentManager(factory);

		await expect(
			manager.run({
				instructions: "hang",
				label: "timeout test",
				cwd: process.cwd(),
				timeout: 10,
			}),
		).rejects.toThrow("Sub-agent timed out");

		expect(abort).toHaveBeenCalledOnce();
		expect(manager.runningCount).toBe(0);
	});

	it("returns partial output when a timed out task has streamed assistant text", async () => {
		const { factory, abort } = createPartialOnAbortFactory();
		const manager = new SubagentManager(factory);

		const result = await manager.run({
			instructions: "hang after partial",
			label: "partial timeout test",
			cwd: process.cwd(),
			timeout: 10,
		});

		expect(result.text).toBe("partial findings before timeout");
		expect(result.inputTokens).toBe(100);
		expect(result.outputTokens).toBe(50);
		expect(result.timedOut).toBe(true);
		expect(abort).toHaveBeenCalledOnce();
		expect(manager.runningCount).toBe(0);
	});

	it("returns compact collected tool output when a timed out task has no assistant summary", async () => {
		const { factory, abort } = createToolResultOnAbortFactory();
		const manager = new SubagentManager(factory);

		const result = await manager.run({
			instructions: "research and hang before final summary",
			label: "tool partial timeout test",
			cwd: process.cwd(),
			timeout: 10,
		});

		expect(result.text).toContain("Partial findings before timeout");
		expect(result.text).toContain("web_search");
		expect(result.text).toContain("content-visibility");
		expect(result.text).toContain("useChunkedRender.ts");
		expect(result.timedOut).toBe(true);
		expect(result.interrupted).toBe(true);
		expect(abort).toHaveBeenCalledOnce();
		expect(manager.runningCount).toBe(0);
	});

	it("limits fallback tool-output partial results on timeout", async () => {
		const longText = "important finding ".repeat(1000);
		let messages: Array<{
			role: string;
			toolName: string;
			content: Array<{ type: string; text: string }>;
			isError: boolean;
		}> = [];
		const abort = vi.fn(() => {
			messages = [
				{
					role: "toolResult",
					toolName: "read",
					content: [{ type: "text", text: longText }],
					isError: false,
				},
			];
		});
		const factory: SubagentSessionFactory = async () => ({
			prompt: () => new Promise<void>(() => {}),
			getMessages: () => messages,
			subscribe: () => () => {},
			abort,
		});
		const manager = new SubagentManager(factory);

		const result = await manager.run({
			instructions: "read huge file and hang",
			label: "compact limit timeout test",
			cwd: process.cwd(),
			timeout: 10,
		});

		expect(result.text).toContain("Partial findings before timeout");
		expect(result.text).toContain("important finding");
		expect(result.text.length).toBeLessThanOrEqual(6500);
		expect(result.timedOut).toBe(true);
	});

	it("returns interrupted partial output without marking it as a timeout when the parent signal aborts", async () => {
		const { factory, abort } = createPartialOnAbortFactory();
		const manager = new SubagentManager(factory);
		const controller = new AbortController();

		const run = manager.run({
			instructions: "hang after partial",
			label: "partial cancel test",
			cwd: process.cwd(),
			signal: controller.signal,
			timeout: 1000,
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort(new Error("parent cancelled"));

		const result = await run;
		expect(result.text).toBe("partial findings before timeout");
		expect(result.interrupted).toBe(true);
		expect(result.timedOut).toBeUndefined();
		expect(abort).toHaveBeenCalledOnce();
		expect(manager.runningCount).toBe(0);
	});

	it("aborts the underlying session when the parent signal aborts without partial output", async () => {
		const { factory, abort } = createHangingFactory();
		const manager = new SubagentManager(factory);
		const controller = new AbortController();

		const run = manager.run({
			instructions: "hang",
			label: "cancel test",
			cwd: process.cwd(),
			signal: controller.signal,
			timeout: 1000,
		});

		controller.abort(new Error("parent cancelled"));

		await expect(run).rejects.toThrow("parent cancelled");
		expect(abort).toHaveBeenCalledOnce();
		expect(manager.runningCount).toBe(0);
	});
});
