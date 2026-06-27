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
