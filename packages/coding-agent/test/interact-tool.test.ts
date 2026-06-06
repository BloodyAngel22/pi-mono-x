import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAllToolDefinitions } from "../src/core/tools/index.js";
import { createInteractToolDefinition } from "../src/core/tools/interact.js";

// Minimal valid 1x1 red PNG
const MINI_PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
	0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01, 0x27, 0x34, 0x27, 0x0e,
	0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function extractPngPath(args: string[]): string | undefined {
	for (const arg of args) {
		const m = arg.match(/^--screenshot=(.+\.png)$/);
		if (m) return m[1];
		if (arg.endsWith(".png") && !arg.startsWith("-")) return arg;
	}
	for (let i = args.length - 1; i >= 0; i--) {
		if (!args[i]?.startsWith("-") && args[i]?.endsWith(".png")) return args[i];
	}
	return undefined;
}

function makeMockExec(writePng = false) {
	return async (_cmd: string, args: string[], _timeout?: number) => {
		if (writePng) {
			const p = extractPngPath(args);
			if (p && !existsSync(p)) {
				try {
					mkdirSync(join(p, ".."), { recursive: true });
				} catch {}
				writeFileSync(p, MINI_PNG);
			}
		}
		return { code: 0, signal: false };
	};
}

function makeMockWhich(available: string[]) {
	const set = new Set(available);
	return async (cmd: string) => (set.has(cmd) ? `/usr/bin/${cmd}` : null);
}

describe("interact tool", () => {
	it("is registered with all built-in tool definitions", () => {
		const defs = createAllToolDefinitions(process.cwd());
		expect(defs.interact.name).toBe("interact");
	});

	it("has correct name and description", () => {
		const tool = createInteractToolDefinition(process.cwd());
		expect(tool.name).toBe("interact");
		expect(tool.description).toContain("Control the desktop");
	});

	it("execution mode is sequential", () => {
		const tool = createInteractToolDefinition(process.cwd());
		expect(tool.executionMode).toBe("sequential");
	});

	it("schema has all parameters", () => {
		const tool = createInteractToolDefinition(process.cwd());
		const props = (tool.parameters as any).properties;
		expect(props.action).toBeDefined();
		expect(props.x).toBeDefined();
		expect(props.y).toBeDefined();
		expect(props.button).toBeDefined();
		expect(props.text).toBeDefined();
		expect(props.keys).toBeDefined();
		expect(props.clicks).toBeDefined();
		expect(props.screenshot).toBeDefined();
	});

	it("has promptSnippet and promptGuidelines for LLM", () => {
		const tool = createInteractToolDefinition(process.cwd());
		expect(tool.promptSnippet).toContain("Interact");
		expect(tool.promptGuidelines).toBeDefined();
		expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
	});

	it("click action works with xdotool mock", async () => {
		const tool = createInteractToolDefinition(process.cwd(), {
			which: makeMockWhich(["xdotool"]),
			execCommand: makeMockExec(),
		});
		const r = await tool.execute(
			"call",
			{ action: "click", x: 100, y: 200 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(r.content[0]?.type).toBe("text");
		expect((r.content[0] as any).text).toMatch(/Clicked.*xdotool/);
		expect(r.details.backend).toBe("xdotool");
		expect(r.details.action).toBe("click");
	});

	it("type action works", async () => {
		const tool = createInteractToolDefinition(process.cwd(), {
			which: makeMockWhich(["xdotool"]),
			execCommand: makeMockExec(),
		});
		const r = await tool.execute("call", { action: "type", text: "hello" }, undefined, undefined, undefined as never);
		expect((r.content[0] as any).text).toContain('Typed "hello"');
	});

	it("key action works", async () => {
		const tool = createInteractToolDefinition(process.cwd(), {
			which: makeMockWhich(["xdotool"]),
			execCommand: makeMockExec(),
		});
		const r = await tool.execute(
			"call",
			{ action: "key", keys: ["ctrl+c"] },
			undefined,
			undefined,
			undefined as never,
		);
		expect((r.content[0] as any).text).toContain("Pressed");
	});

	it("move action works", async () => {
		const tool = createInteractToolDefinition(process.cwd(), {
			which: makeMockWhich(["xdotool"]),
			execCommand: makeMockExec(),
		});
		const r = await tool.execute(
			"call",
			{ action: "move", x: 500, y: 300 },
			undefined,
			undefined,
			undefined as never,
		);
		expect((r.content[0] as any).text).toContain("Moved");
	});

	it("scroll action works", async () => {
		const tool = createInteractToolDefinition(process.cwd(), {
			which: makeMockWhich(["xdotool"]),
			execCommand: makeMockExec(),
		});
		const r = await tool.execute("call", { action: "scroll", clicks: 3 }, undefined, undefined, undefined as never);
		expect((r.content[0] as any).text).toContain("Scrolled");
	});

	it("click with screenshot returns image content", async () => {
		const tmpDir = join(tmpdir(), `pi-test-interact-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });

		const tool = createInteractToolDefinition(process.cwd(), {
			outputDir: tmpDir,
			which: makeMockWhich(["xdotool", "spectacle"]),
			execCommand: makeMockExec(true),
		});
		const r = await tool.execute(
			"call",
			{ action: "click", x: 10, y: 20, screenshot: true },
			undefined,
			undefined,
			undefined as never,
		);
		expect(r.content.filter((c) => c.type === "text").length).toBeGreaterThanOrEqual(1);
		expect(r.content.filter((c) => c.type === "image").length).toBeGreaterThanOrEqual(1);
	});

	it("throws when no tool found for platform", async () => {
		const tool = createInteractToolDefinition(process.cwd(), {
			which: makeMockWhich([]),
			execCommand: makeMockExec(),
		});
		// On linux without any tool, should throw
		await expect(tool.execute("call", { action: "click" }, undefined, undefined, undefined as never)).rejects.toThrow(
			/No desktop automation tool found/,
		);
	});

	it("cancels on abort signal", async () => {
		const ac = new AbortController();
		ac.abort();

		const tool = createInteractToolDefinition(process.cwd(), {
			which: makeMockWhich(["xdotool"]),
			execCommand: async () => ({ code: null, signal: true }),
		});
		await expect(tool.execute("call", { action: "click" }, ac.signal, undefined, undefined as never)).rejects.toThrow(
			/cancelled/,
		);
	});

	it("schema lists all five action types", () => {
		const tool = createInteractToolDefinition(process.cwd());
		const schema = tool.parameters as any;
		const anyOf = schema.properties.action.anyOf as Array<{ const: string }> | undefined;
		const values = anyOf?.map((a) => a.const) ?? [];
		expect(values).toEqual(expect.arrayContaining(["click", "type", "key", "move", "scroll"]));
	});
});
