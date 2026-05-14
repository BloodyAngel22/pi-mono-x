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

	it("aborts the underlying session when the parent signal aborts", async () => {
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
