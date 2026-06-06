import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAllToolDefinitions } from "../src/core/tools/index.js";
import { createScreenshotToolDefinition } from "../src/core/tools/screenshot.js";

// Minimal valid 1x1 red PNG
const MINI_PNG = Buffer.from([
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a, // PNG signature
	0x00,
	0x00,
	0x00,
	0x0d,
	0x49,
	0x48,
	0x44,
	0x52, // IHDR chunk
	0x00,
	0x00,
	0x00,
	0x01,
	0x00,
	0x00,
	0x00,
	0x01,
	0x08,
	0x02,
	0x00,
	0x00,
	0x00,
	0x90,
	0x77,
	0x53,
	0xde,
	0x00,
	0x00,
	0x00,
	0x0c,
	0x49,
	0x44,
	0x41,
	0x54,
	0x08,
	0xd7,
	0x63,
	0x60,
	0x60,
	0x60,
	0x00,
	0x00,
	0x00,
	0x04,
	0x00,
	0x01,
	0x27,
	0x34,
	0x27,
	0x0e,
	0x00,
	0x00,
	0x00,
	0x00,
	0x49,
	0x45,
	0x4e,
	0x44,
	0xae,
	0x42,
	0x60,
	0x82, // IEND chunk
]);

/** Extract an output file path from mock args that may contain `--screenshot=PATH` or `-o PATH` patterns. */
function extractPngPath(args: string[]): string | undefined {
	for (const arg of args) {
		// Handle --screenshot=/path/to/file.png
		const screenshotMatch = arg.match(/^--screenshot=(.+\.png)$/);
		if (screenshotMatch) return screenshotMatch[1];
		// Handle standalone .png path
		if (arg.endsWith(".png") && !arg.startsWith("-")) return arg;
	}
	// Check the last non-flag arg
	for (let i = args.length - 1; i >= 0; i--) {
		if (!args[i]?.startsWith("-") && args[i]?.endsWith(".png")) return args[i];
	}
	return undefined;
}

describe("screenshot tool", () => {
	it("is registered with all built-in tool definitions", () => {
		const defs = createAllToolDefinitions(process.cwd());
		expect(defs.screenshot.name).toBe("screenshot");
	});

	it("has correct name and description", () => {
		const tool = createScreenshotToolDefinition(process.cwd());
		expect(tool.name).toBe("screenshot");
		expect(tool.description).toContain("Capture a screenshot");
		expect(tool.description).toContain("desktop");
		expect(tool.description).toContain("web page");
	});

	it("execution mode is sequential", () => {
		const tool = createScreenshotToolDefinition(process.cwd());
		expect(tool.executionMode).toBe("sequential");
	});

	it("schema has url, fullPage, width, height parameters", () => {
		const tool = createScreenshotToolDefinition(process.cwd());
		const params = tool.parameters as any;
		expect(params.properties?.url).toBeDefined();
		expect(params.properties?.url.type).toBe("string");
		expect(params.properties?.fullPage).toBeDefined();
		expect(params.properties?.fullPage.type).toBe("boolean");
		expect(params.properties?.width).toBeDefined();
		expect(params.properties?.width.type).toBe("number");
		expect(params.properties?.height).toBeDefined();
		expect(params.properties?.height.type).toBe("number");
	});

	it("url is optional", () => {
		const tool = createScreenshotToolDefinition(process.cwd());
		const params = tool.parameters as any;
		const required = params.required as string[] | undefined;
		expect(required).toBeUndefined();
	});

	it("has promptSnippet and promptGuidelines for LLM", () => {
		const tool = createScreenshotToolDefinition(process.cwd());
		expect(tool.promptSnippet).toContain("screenshot");
		expect(tool.promptGuidelines).toBeDefined();
		expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
	});

	it("desktop screenshot succeeds with mocked which and execCommand", async () => {
		const tmpDir = join(tmpdir(), `pi-test-shot-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });

		const tool = createScreenshotToolDefinition(process.cwd(), {
			outputDir: tmpDir,
			which: async (cmd) => {
				if (cmd === "screencapture" || cmd === "spectacle") return `/usr/bin/${cmd}`;
				return null;
			},
			execCommand: async (_cmd, args) => {
				const outputPath = extractPngPath(args);
				if (outputPath && !existsSync(outputPath)) {
					writeFileSync(outputPath, MINI_PNG);
				}
				return { code: 0, signal: false };
			},
		});

		const result = await tool.execute("call", {}, undefined, undefined, undefined as never);

		const textContent = result.content.find((c) => c.type === "text");
		const imageContent = result.content.find((c) => c.type === "image");
		expect(textContent).toBeDefined();
		expect((textContent as any).text).toContain("Desktop screenshot");
		expect(imageContent).toBeDefined();
		expect((imageContent as any).mimeType).toMatch(/^image\//);
		expect(result.details.mode).toBe("desktop");
		expect(result.details.tool).toBeDefined();
	});

	it("web screenshot succeeds with mocked Chrome", async () => {
		const tmpDir = join(tmpdir(), `pi-test-shot-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });

		const tool = createScreenshotToolDefinition(process.cwd(), {
			outputDir: tmpDir,
			which: async (cmd) => {
				if (cmd === "google-chrome" || cmd === "chromium") return `/usr/bin/${cmd}`;
				return null;
			},
			execCommand: async (_cmd, args) => {
				const outputPath = extractPngPath(args);
				if (outputPath && !existsSync(outputPath)) {
					writeFileSync(outputPath, MINI_PNG);
				}
				return { code: 0, signal: false };
			},
		});

		const result = await tool.execute(
			"call",
			{ url: "https://example.com", width: 800, height: 600 },
			undefined,
			undefined,
			undefined as never,
		);

		const textContent = result.content.find((c) => c.type === "text");
		const imageContent = result.content.find((c) => c.type === "image");
		expect(textContent).toBeDefined();
		expect((textContent as any).text).toContain("Web screenshot");
		expect(imageContent).toBeDefined();
		expect((imageContent as any).mimeType).toMatch(/^image\//);
		expect(result.details.mode).toBe("web");
	});

	it("rejects cancelled screenshot", async () => {
		const ac = new AbortController();
		ac.abort();

		const tool = createScreenshotToolDefinition(process.cwd(), {
			which: async (cmd) => {
				if (cmd === "screencapture" || cmd === "spectacle") return `/usr/bin/${cmd}`;
				return null;
			},
			execCommand: async () => ({ code: null, signal: true }),
		});

		await expect(tool.execute("call", {}, ac.signal, undefined, undefined as never)).rejects.toThrow(/cancelled/);
	});

	it("throws error when no desktop screenshot tool found", async () => {
		const tool = createScreenshotToolDefinition(process.cwd(), {
			which: async () => null,
			execCommand: async () => ({ code: 1, signal: false }),
		});

		await expect(tool.execute("call", {}, undefined, undefined, undefined as never)).rejects.toThrow(
			/No screenshot tool found/,
		);
	});

	it("throws error when Chrome not found for web screenshot", async () => {
		const tool = createScreenshotToolDefinition(process.cwd(), {
			which: async () => null,
			execCommand: async () => ({ code: 1, signal: false }),
		});

		await expect(
			tool.execute("call", { url: "https://example.com" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/Chrome\/Chromium not found/);
	});

	it("tries next candidate when one fails", async () => {
		const tmpDir = join(tmpdir(), `pi-test-shot-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });

		const tool = createScreenshotToolDefinition(process.cwd(), {
			outputDir: tmpDir,
			which: async (cmd) => {
				// spectacle and gnome-screenshot exist, xfce4-screenshooter also exists
				if (["spectacle", "gnome-screenshot", "xfce4-screenshooter"].includes(cmd)) return `/usr/bin/${cmd}`;
				return null;
			},
			execCommand: async (cmd, args) => {
				// First two candidates fail
				if (cmd.includes("spectacle") || cmd.includes("gnome-screenshot")) {
					return { code: 1, signal: false };
				}
				// xfce4-screenshooter succeeds
				const outputPath = extractPngPath(args);
				if (outputPath && !existsSync(outputPath)) {
					writeFileSync(outputPath, MINI_PNG);
				}
				return { code: 0, signal: false };
			},
		});

		const result = await tool.execute("call", {}, undefined, undefined, undefined as never);

		expect(result.details.tool).toBe("xfce4-screenshooter");
	});
});
