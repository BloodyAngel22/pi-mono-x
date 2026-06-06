import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { resizeImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import type { ToolDefinition } from "../extensions/types.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

// ============================================================================
// Schema
// ============================================================================

const screenshotSchema = Type.Object({
	url: Type.Optional(
		Type.String({
			description:
				"URL to take a screenshot of (e.g. https://example.com). When omitted, captures the desktop screen.",
		}),
	),
	fullPage: Type.Optional(
		Type.Boolean({
			description: "Capture full page height (web mode only, requires Chrome DevTools Protocol). Default: false.",
		}),
	),
	width: Type.Optional(
		Type.Number({
			description: "Viewport width for web screenshots (default: 1280).",
		}),
	),
	height: Type.Optional(
		Type.Number({
			description: "Viewport height for web screenshots (default: 800).",
		}),
	),
});

export type ScreenshotToolInput = Static<typeof screenshotSchema>;

export interface ScreenshotToolDetails {
	mode: "desktop" | "web";
	tool?: string;
	path: string;
	width: number;
	height: number;
}

export interface ScreenshotToolOptions {
	/** Custom output directory for screenshots. Default: system temp directory. */
	outputDir?: string;
	/**
	 * Custom `which()` function for finding executables on PATH.
	 * Default: runs `which <cmd>` via child_process.
	 * Override in tests to mock tool discovery.
	 */
	which?: (cmd: string) => Promise<string | null>;
	/**
	 * Custom command executor.
	 * Override in tests to avoid spawning real processes.
	 * Default: spawns child process and waits for exit.
	 */
	execCommand?: (
		cmd: string,
		args: string[],
		timeoutMs?: number,
		signal?: AbortSignal,
	) => Promise<{ code: number | null; signal: boolean }>;
}

// ============================================================================
// Platform/OS detection helpers
// ============================================================================

const PLATFORM = process.platform;

function isMacOS(): boolean {
	return PLATFORM === "darwin";
}

function isWindows(): boolean {
	return PLATFORM === "win32";
}

function isLinux(): boolean {
	return PLATFORM === "linux";
}

// ============================================================================
// Screenshot tool definitions for Linux (by priority)
// ============================================================================

interface ScreenshotToolCandidate {
	name: string;
	cmd: string;
	args: (outputPath: string) => string[];
}

const LINUX_CANDIDATES: ScreenshotToolCandidate[] = [
	{
		name: "spectacle",
		cmd: "spectacle",
		args: (outputPath) => ["-b", "-o", outputPath],
	},
	{
		name: "gnome-screenshot",
		cmd: "gnome-screenshot",
		args: (outputPath) => ["-f", outputPath],
	},
	{
		name: "xfce4-screenshooter",
		cmd: "xfce4-screenshooter",
		args: (outputPath) => ["-f", "-s", outputPath],
	},
	{
		name: "maim",
		cmd: "maim",
		args: (outputPath) => [outputPath],
	},
	{
		name: "scrot",
		cmd: "scrot",
		args: (outputPath) => [outputPath],
	},
	{
		name: "import",
		cmd: "import",
		args: (outputPath) => ["-window", "root", outputPath],
	},
	{
		name: "grim",
		cmd: "grim",
		args: (outputPath) => [outputPath],
	},
];

const MACOS_CANDIDATES: ScreenshotToolCandidate[] = [
	{
		name: "screencapture",
		cmd: "screencapture",
		args: (outputPath) => ["-x", outputPath],
	},
];

const WINDOWS_CANDIDATES: ScreenshotToolCandidate[] = [
	{
		name: "powershell",
		cmd: "powershell",
		args: (outputPath) => [
			"-NoProfile",
			"-Command",
			[
				"Add-Type -AssemblyName System.Windows.Forms;",
				"$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
				"$bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height;",
				"$graphics = [System.Drawing.Graphics]::FromImage($bitmap);",
				"$graphics.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bitmap.Size);",
				`$bitmap.Save('${outputPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
				"$graphics.Dispose();",
				"$bitmap.Dispose();",
			].join(" "),
		],
	},
];

// ============================================================================
// Chrome/Chromium candidates for web screenshots
// ============================================================================

const CHROME_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find an executable on PATH by trying each candidate.
 * Returns the full path if found, or null.
 */
async function which(cmd: string): Promise<string | null> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execFileAsync = promisify(execFile);

	try {
		const { stdout } = await execFileAsync("which", [cmd], { timeout: 5000 });
		const path = stdout.trim();
		return path.length > 0 ? path : null;
	} catch {
		return null;
	}
}

/**
 * Generate a unique temp file path for a screenshot.
 */
function screenshotPath(outputDir?: string): string {
	const dir = outputDir ?? tmpdir();
	const timestamp = Date.now();
	const random = Math.random().toString(36).slice(2, 8);
	return join(dir, `pi-screenshot-${timestamp}-${random}.png`);
}

/**
 * Execute a command and wait for it to finish.
 * Returns { code: exit code or null if signal killed, signal: boolean }
 */
function execCommand(
	cmd: string,
	args: string[],
	timeoutMs?: number,
	signal?: AbortSignal,
): Promise<{ code: number | null; signal: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});

		// Collect output for potential debugging
		let _stdout = "";
		let _stderr = "";

		child.stdout?.on("data", (data: Buffer) => {
			_stdout += data.toString();
		});

		child.stderr?.on("data", (data: Buffer) => {
			_stderr += data.toString();
		});

		if (signal) {
			if (signal.aborted) {
				child.kill();
				resolve({ code: null, signal: true });
				return;
			}
			signal.addEventListener(
				"abort",
				() => {
					child.kill();
					resolve({ code: null, signal: true });
				},
				{ once: true },
			);
		}

		child.on("close", (code) => {
			resolve({ code, signal: false });
		});

		child.on("error", (err) => {
			reject(err);
		});
	});
}

// ============================================================================
// Desktop screenshot capture
// ============================================================================

async function captureDesktop(
	outputPath: string,
	signal?: AbortSignal,
	whichFn?: (cmd: string) => Promise<string | null>,
	execFn?: (
		cmd: string,
		args: string[],
		timeoutMs?: number,
		signal?: AbortSignal,
	) => Promise<{ code: number | null; signal: boolean }>,
): Promise<ScreenshotToolDetails> {
	if (isMacOS()) {
		return captureWithCandidates(outputPath, MACOS_CANDIDATES, signal, whichFn, execFn);
	}
	if (isWindows()) {
		return captureWithCandidates(outputPath, WINDOWS_CANDIDATES, signal, whichFn, execFn);
	}
	if (isLinux()) {
		return captureWithCandidates(outputPath, LINUX_CANDIDATES, signal, whichFn, execFn);
	}
	throw new Error(`Unsupported platform: ${PLATFORM}`);
}

async function captureWithCandidates(
	outputPath: string,
	candidates: ScreenshotToolCandidate[],
	signal?: AbortSignal,
	whichFn?: (cmd: string) => Promise<string | null>,
	execFn?: (
		cmd: string,
		args: string[],
		timeoutMs?: number,
		signal?: AbortSignal,
	) => Promise<{ code: number | null; signal: boolean }>,
): Promise<ScreenshotToolDetails> {
	const findTool = whichFn ?? which;
	const run = execFn ?? execCommand;

	for (const candidate of candidates) {
		const found = await findTool(candidate.cmd);
		if (!found) continue;

		try {
			const result = await run(found, candidate.args(outputPath), 15_000, signal);

			if (result.signal) {
				throw new Error("Screenshot cancelled");
			}

			if (result.code !== 0) {
				continue; // try next candidate
			}

			if (!existsSync(outputPath)) {
				continue; // try next candidate
			}

			return {
				mode: "desktop",
				tool: candidate.name,
				path: outputPath,
				width: 0,
				height: 0,
			};
		} catch (err) {
			if (err instanceof Error && err.message === "Screenshot cancelled") throw err;
		}
	}

	// Build helpful error message
	const pkgManagers = [
		{ name: "spectacle", pkg: "spectacle", pm: "sudo pacman -S spectacle" },
		{ name: "gnome-screenshot", pkg: "gnome-screenshot", pm: "sudo apt install gnome-screenshot" },
		{ name: "xfce4-screenshooter", pkg: "xfce4-screenshooter", pm: "sudo apt install xfce4-screenshooter" },
		{ name: "maim", pkg: "maim", pm: "sudo pacman -S maim" },
		{ name: "scrot", pkg: "scrot", pm: "sudo apt install scrot" },
		{ name: "import", pkg: "imagemagick", pm: "sudo apt install imagemagick" },
	];
	const hints = pkgManagers.map((t) => `  - ${t.name}: ${t.pm}`).join("\n");

	throw new Error(
		`No screenshot tool found on this system.\nInstall one of:\n${hints}\n\nOr use a URL to screenshot a web page (requires Chrome/Chromium).`,
	);
}

// ============================================================================
// Web screenshot capture via Chrome headless
// ============================================================================

async function captureWeb(
	url: string,
	outputPath: string,
	width: number,
	height: number,
	_fullPage: boolean,
	signal?: AbortSignal,
	whichFn?: (cmd: string) => Promise<string | null>,
	execFn?: (
		cmd: string,
		args: string[],
		timeoutMs?: number,
		signal?: AbortSignal,
	) => Promise<{ code: number | null; signal: boolean }>,
): Promise<ScreenshotToolDetails> {
	const findTool = whichFn ?? which;
	const run = execFn ?? execCommand;

	// Find Chrome
	let chromePath: string | null = null;
	for (const candidate of CHROME_CANDIDATES) {
		chromePath = await findTool(candidate);
		if (chromePath) break;
	}

	if (!chromePath) {
		throw new Error(
			`Chrome/Chromium not found. Install one:\n` +
				`  - Manjaro/Arch: sudo pacman -S chromium\n` +
				`  - Ubuntu/Debian: sudo apt install chromium-browser\n` +
				`  - macOS: brew install --cask google-chrome\n` +
				`  - Or configure Playwright MCP for browser automation.`,
		);
	}

	// Note: --screenshot flag doesn't support fullPage. For fullPage,
	// we'd need Chrome DevTools Protocol (requires puppeteer-core or chrome-launcher).
	const args = [
		"--headless",
		"--disable-gpu",
		"--no-sandbox",
		"--disable-dev-shm-usage",
		`--window-size=${width},${height}`,
		`--screenshot=${outputPath}`,
		url,
	];

	const result = await run(chromePath, args, 30_000, signal);

	if (result.signal) {
		throw new Error("Web screenshot cancelled");
	}

	if (result.code !== 0) {
		throw new Error(`Chrome exited with code ${result.code}. URL may be unreachable or invalid.`);
	}

	if (!existsSync(outputPath)) {
		throw new Error("Chrome did not produce a screenshot. The page may be blank or the URL invalid.");
	}

	return {
		mode: "web",
		tool: "chrome",
		path: outputPath,
		width,
		height,
	};
}

// ============================================================================
// Image reading and resizing
// ============================================================================

interface ScreenshotImageResult {
	image: ImageContent;
	dimensions: string;
}

async function readScreenshotImage(filePath: string): Promise<ScreenshotImageResult> {
	const mimeType = await detectSupportedImageMimeTypeFromFile(filePath);
	if (!mimeType) {
		throw new Error(`Unsupported image format in screenshot: ${filePath}`);
	}

	const fileBuffer = await readFile(filePath);
	const base64 = fileBuffer.toString("base64");

	// Auto-resize
	const resized = await resizeImage({ type: "image", data: base64, mimeType }, { maxWidth: 2000, maxHeight: 2000 });

	if (resized) {
		const dims = `${resized.width}x${resized.height}`;
		const dimNote = resized.wasResized
			? ` (original ${resized.originalWidth}x${resized.originalHeight}, resized to ${dims})`
			: ` (${dims})`;
		return {
			image: { type: "image", data: resized.data, mimeType: resized.mimeType },
			dimensions: dimNote,
		};
	}

	// fallback: return raw
	const dims = `${fileBuffer.length} bytes`;
	return {
		image: { type: "image", data: base64, mimeType },
		dimensions: dims,
	};
}

// ============================================================================
// Tool Definition Factory
// ============================================================================

export function createScreenshotToolDefinition(
	_cwd: string,
	options?: ScreenshotToolOptions,
): ToolDefinition<typeof screenshotSchema, ScreenshotToolDetails> {
	const outputDir = options?.outputDir;
	const whichFn = options?.which ?? which;
	const execFn = options?.execCommand ?? execCommand;

	return {
		name: "screenshot",
		label: "screenshot",
		description:
			"Capture a screenshot and return it as an image for visual analysis. " +
			"Without a URL, captures the desktop screen (requires permission). " +
			"With a URL, captures a web page using headless Chrome. " +
			"Useful for UI analysis, e2e test generation, debugging visual issues, and game development feedback loops.",
		promptSnippet: "Take a screenshot (desktop or web page) and analyze it visually",
		promptGuidelines: [
			"Use screenshot without URL to capture the desktop (e.g., running app, game, or IDE).",
			"Use screenshot with a URL to capture a web page for UI analysis.",
			"After taking a screenshot, describe what you see before making changes.",
			"For game development: use bash to launch the game, then screenshot to capture the output.",
		],
		parameters: screenshotSchema,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params: ScreenshotToolInput,
			signal: AbortSignal | undefined,
		): Promise<AgentToolResult<ScreenshotToolDetails>> {
			const width = params.width ?? 1280;
			const height = params.height ?? 1280;

			let details: ScreenshotToolDetails;

			if (params.url) {
				// Web screenshot mode
				const outputPath = screenshotPath(outputDir);
				details = await captureWeb(
					params.url,
					outputPath,
					width,
					height,
					params.fullPage ?? false,
					signal,
					whichFn,
					execFn,
				);
			} else {
				// Desktop screenshot mode (permission checked externally in agent-session.ts)
				const outputPath = screenshotPath(outputDir);
				details = await captureDesktop(outputPath, signal, whichFn, execFn);
			}

			// Read and process the image
			const { image, dimensions } = await readScreenshotImage(details.path);

			const modeLabel = details.mode === "desktop" ? "Desktop screenshot" : `Web screenshot (${params.url})`;
			const toolLabel = details.tool ? ` via ${details.tool}` : "";

			return {
				content: [
					{
						type: "text",
						text: `${modeLabel}${toolLabel} captured at ${details.path}${dimensions}`,
					},
					image,
				],
				details: {
					...details,
					width: dimensions.includes("x") ? Number.parseInt(dimensions.split("x")[0]?.trim() ?? "0", 10) : 0,
					height: dimensions.includes("x")
						? Number.parseInt(dimensions.split("x")[1]?.split(")")[0]?.trim() ?? "0", 10)
						: 0,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (args?.url) {
				text.setText(`${theme.fg("toolTitle", theme.bold("screenshot"))} ${theme.fg("accent", `"${args.url}"`)}`);
			} else {
				text.setText(`${theme.fg("toolTitle", theme.bold("screenshot"))} ${theme.fg("accent", "desktop")}`);
			}
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const output = getTextOutput(result as any, false).trim();
			if (!output) return (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const lines = output.split("\n");
			const maxLines = renderOptions.expanded ? lines.length : 5;
			const shown = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
			const remaining = lines.length - maxLines;
			text.setText(shown.join("\n") + (remaining > 0 ? theme.fg("muted", `\n... (${remaining} more lines)`) : ""));
			return text;
		},
	};
}

export function createScreenshotTool(cwd: string, options?: ScreenshotToolOptions): AgentTool<typeof screenshotSchema> {
	return wrapToolDefinition(createScreenshotToolDefinition(cwd, options));
}
