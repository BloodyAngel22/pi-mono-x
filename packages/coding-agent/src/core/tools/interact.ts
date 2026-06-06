import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
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

const interactSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("click"), Type.Literal("type"), Type.Literal("key"), Type.Literal("move"), Type.Literal("scroll")],
		{ description: "Action to perform" },
	),
	x: Type.Optional(Type.Number({ description: "X coordinate (for click, move)" })),
	y: Type.Optional(Type.Number({ description: "Y coordinate (for click, move)" })),
	button: Type.Optional(
		Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")], {
			description: "Mouse button (default: left)",
		}),
	),
	text: Type.Optional(Type.String({ description: "Text to type (for type action)" })),
	keys: Type.Optional(
		Type.Array(Type.String(), { description: "Key combination (for key action), e.g. ['ctrl+c'] or ['alt+Tab']" }),
	),
	clicks: Type.Optional(Type.Number({ description: "Scroll clicks (for scroll). Positive = down, negative = up" })),
	screenshot: Type.Optional(
		Type.Boolean({ description: "Take a screenshot after the action and return it as an image" }),
	),
});

export type InteractToolInput = Static<typeof interactSchema>;

export interface InteractToolDetails {
	action: string;
	backend: string;
	platform: string;
	screenshot?: boolean;
}

export interface InteractToolOptions {
	which?: (cmd: string) => Promise<string | null>;
	execCommand?: (
		cmd: string,
		args: string[],
		timeoutMs?: number,
		signal?: AbortSignal,
	) => Promise<{ code: number | null; signal: boolean }>;
	outputDir?: string;
}

// ============================================================================
// Helpers
// ============================================================================

const PLATFORM = process.platform;

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
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});
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

function screenshotPath(outputDir?: string): string {
	const dir = outputDir ?? tmpdir();
	const timestamp = Date.now();
	const random = Math.random().toString(36).slice(2, 8);
	return join(dir, `pi-interact-${timestamp}-${random}.png`);
}

async function readScreenshotImage(filePath: string): Promise<ImageContent> {
	const mimeType = await detectSupportedImageMimeTypeFromFile(filePath);
	if (!mimeType) {
		throw new Error(`Unsupported image format: ${filePath}`);
	}
	const fileBuffer = await readFile(filePath);
	const base64 = fileBuffer.toString("base64");
	const resized = await resizeImage({ type: "image", data: base64, mimeType }, { maxWidth: 2000, maxHeight: 2000 });
	if (resized) {
		return { type: "image", data: resized.data, mimeType: resized.mimeType };
	}
	return { type: "image", data: base64, mimeType };
}

// ============================================================================
// Platform-specific command builders
// ============================================================================

interface ActionSpec {
	action: string;
	cmd: string;
	args: string[];
}

function buildXdotool(params: InteractToolInput): ActionSpec {
	const x = params.x ?? 0;
	const y = params.y ?? 0;
	const btn = params.button ?? "left";
	const btnMap: Record<string, string> = { left: "1", middle: "2", right: "3" };

	switch (params.action) {
		case "move":
			return { action: "move", cmd: "xdotool", args: ["mousemove", String(x), String(y)] };
		case "click":
			return {
				action: "click",
				cmd: "xdotool",
				args: ["mousemove", String(x), String(y), "click", btnMap[btn] ?? "1"],
			};
		case "type":
			return { action: "type", cmd: "xdotool", args: ["type", params.text ?? ""] };
		case "key": {
			const keyStr = (params.keys ?? []).join("+");
			return { action: "key", cmd: "xdotool", args: ["key", keyStr] };
		}
		case "scroll": {
			const clicks = params.clicks ?? 1;
			// xdotool: click 4 = scroll up, click 5 = scroll down
			const btnCode = clicks > 0 ? "5" : "4";
			const repeat = Math.abs(clicks);
			return {
				action: "scroll",
				cmd: "xdotool",
				args: ["click", "--repeat", String(repeat), btnCode],
			};
		}
		default:
			throw new Error(`Unknown action: ${params.action}`);
	}
}

function buildYdotool(params: InteractToolInput): ActionSpec {
	const x = params.x ?? 0;
	const y = params.y ?? 0;
	const btn = params.button ?? "left";
	// ydotool uses evdev button codes (hex):
	// 0xC0 = left, 0xC1 = middle, 0xC2 = right
	const btnMap: Record<string, string> = { left: "0xC0", middle: "0xC1", right: "0xC2" };

	switch (params.action) {
		case "move":
			return { action: "move", cmd: "ydotool", args: ["mousemove", String(x), String(y)] };
		case "click":
			return {
				action: "click",
				cmd: "ydotool",
				args: ["mousemove", String(x), String(y), "click", btnMap[btn] ?? "0xC0"],
			};
		case "type":
			// ydotool type uses text input
			return { action: "type", cmd: "ydotool", args: ["type", params.text ?? ""] };
		case "key": {
			// ydotool requires raw keycodes via 'key' subcommand.
			// We try with the 'ydotool keys' subcommand that accepts key names.
			const keyStr = (params.keys ?? []).join("+");
			return { action: "key", cmd: "ydotool", args: ["keys", keyStr] };
		}
		case "scroll": {
			// ydotool: 0x60 = wheel up, 0x70 = wheel down
			const clicks = params.clicks ?? 1;
			const btnCode = clicks > 0 ? "0x70" : "0x60";
			const repeat = Math.abs(clicks);
			const results: ActionSpec[] = [];
			for (let i = 0; i < repeat; i++) {
				results.push({ action: "scroll", cmd: "ydotool", args: ["click", btnCode] });
			}
			// Return the last one (we'll handle multi-click in the runner)
			return { action: "scroll", cmd: "ydotool", args: ["click", btnCode] };
		}
		default:
			throw new Error(`Unknown action: ${params.action}`);
	}
}

function buildCliclick(params: InteractToolInput): ActionSpec {
	const x = params.x ?? 0;
	const y = params.y ?? 0;

	switch (params.action) {
		case "move":
			return { action: "move", cmd: "cliclick", args: [`m:${String(x)},${String(y)}`] };
		case "click": {
			const btn = params.button ?? "left";
			if (btn === "right") {
				return { action: "click", cmd: "cliclick", args: [`rc:${String(x)},${String(y)}`] };
			}
			return { action: "click", cmd: "cliclick", args: [`c:${String(x)},${String(y)}`] };
		}
		case "type":
			return { action: "type", cmd: "cliclick", args: [`t:${params.text ?? ""}`] };
		case "key": {
			const keyStr = (params.keys ?? []).map(normalizeMacKey).join("");
			return { action: "key", cmd: "cliclick", args: [`kp:${keyStr}`] };
		}
		case "scroll":
			// cliclick doesn't have a scroll command; use arrow keys or page keys
			return { action: "scroll", cmd: "cliclick", args: ["kp:page-down"] };
		default:
			throw new Error(`Unknown action: ${params.action}`);
	}
}

function normalizeMacKey(key: string): string {
	// cliclick uses "cmd" not "meta" or "super"
	const mapping: Record<string, string> = {
		ctrl: "ctrl",
		control: "ctrl",
		alt: "alt",
		option: "alt",
		cmd: "cmd",
		command: "cmd",
		meta: "cmd",
		super: "cmd",
		shift: "shift",
	};
	// Map each part of a combo like "ctrl+c"
	const parts = key.split("+");
	const mapped = parts.map((p) => mapping[p.toLowerCase()] ?? p);
	return mapped.join("");
}

function _buildOsascriptWindow(_params: InteractToolInput, appName?: string): ActionSpec | null {
	if (!appName) return null;
	return {
		action: "focus",
		cmd: "osascript",
		args: ["-e", `tell application "${appName}" to activate`],
	};
}

function buildPowershell(params: InteractToolInput): ActionSpec {
	const x = params.x ?? 0;
	const y = params.y ?? 0;
	const btn = params.button ?? "left";

	switch (params.action) {
		case "move":
			return {
				action: "move",
				cmd: "powershell",
				args: [
					"-NoProfile",
					"-Command",
					`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`,
				],
			};
		case "click": {
			const btnEvent =
				btn === "right"
					? "MOUSEEVENTF_RIGHTDOWN|MOUSEEVENTF_RIGHTUP"
					: btn === "middle"
						? "MOUSEEVENTF_MIDDLEDOWN|MOUSEEVENTF_MIDDLEUP"
						: "MOUSEEVENTF_LEFTDOWN|MOUSEEVENTF_LEFTUP";
			return {
				action: "click",
				cmd: "powershell",
				args: [
					"-NoProfile",
					"-Command",
					[
						"Add-Type -AssemblyName System.Windows.Forms;",
						`[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});`,
						`[System.Windows.Forms.MouseEvents]::${btnEvent}`,
						// Use user32 mouse_event as fallback
						`Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse {
	[DllImport("user32.dll")]
	public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
	public const uint ${btnEvent} = 0x0002${btn === "right" ? "|0x0008" : btn === "middle" ? "|0x0020" : ""};
}
"@;`,
						`[Mouse]::mouse_event([Mouse]::${btnEvent}, ${x}, ${y}, 0, 0)`,
					].join(" "),
				],
			};
		}
		case "type":
			return {
				action: "type",
				cmd: "powershell",
				args: [
					"-NoProfile",
					"-Command",
					`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${(params.text ?? "").replace(/'/g, "''")}')`,
				],
			};
		case "key": {
			const keyStr = (params.keys ?? []).map(powershellKeyCode).join("");
			return {
				action: "key",
				cmd: "powershell",
				args: [
					"-NoProfile",
					"-Command",
					`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keyStr}')`,
				],
			};
		}
		case "scroll": {
			const clicks = params.clicks ?? 1;
			const direction = clicks > 0 ? "DOWN" : "UP";
			const repeat = Math.abs(clicks);
			return {
				action: "scroll",
				cmd: "powershell",
				args: [
					"-NoProfile",
					"-Command",
					[
						"Add-Type -AssemblyName System.Windows.Forms;",
						`for($i=0;$i -lt ${repeat};$i++){`,
						`[System.Windows.Forms.SendKeys]::SendWait('{${direction}}');`,
						"Start-Sleep -Milliseconds 50",
						"}",
					].join(" "),
				],
			};
		}
		default:
			throw new Error(`Unknown action: ${params.action}`);
	}
}

function powershellKeyCode(key: string): string {
	// Map common key combinations for SendKeys format
	const parts = key.split("+");
	const specialKeys: Record<string, string> = {
		ctrl: "^",
		alt: "%",
		shift: "+",
		enter: "{ENTER}",
		tab: "{TAB}",
		escape: "{ESC}",
		backspace: "{BACKSPACE}",
		delete: "{DELETE}",
		home: "{HOME}",
		end: "{END}",
		up: "{UP}",
		down: "{DOWN}",
		left: "{LEFT}",
		right: "{RIGHT}",
		f1: "{F1}",
		f2: "{F2}",
		f3: "{F3}",
		f4: "{F4}",
		f5: "{F5}",
		f6: "{F6}",
		f7: "{F7}",
		f8: "{F8}",
		f9: "{F9}",
		f10: "{F10}",
		f11: "{F11}",
		f12: "{F12}",
	};

	if (parts.length === 1) {
		const p = parts[0]!.toLowerCase();
		return specialKeys[p] ?? p;
	}

	// Modifier + key: e.g., "ctrl+c" → "^c"
	const modifiers = parts.slice(0, -1).map((p) => specialKeys[p.toLowerCase()] ?? "");
	const lastKey = parts[parts.length - 1]!;
	const lastKeyMapped = specialKeys[lastKey.toLowerCase()] ?? lastKey;
	return `${modifiers.join("")}(${lastKeyMapped})`;
}

// ============================================================================
// Platform detection and tool selection
// ============================================================================

type BackendBuilder = (params: InteractToolInput) => ActionSpec;

interface PlatformBackend {
	name: string;
	platforms: string[];
	cmd: string;
	builder: BackendBuilder;
}

const BACKENDS: PlatformBackend[] = [
	{ name: "xdotool", platforms: ["linux"], cmd: "xdotool", builder: buildXdotool },
	{ name: "ydotool", platforms: ["linux"], cmd: "ydotool", builder: buildYdotool },
	{ name: "cliclick", platforms: ["darwin"], cmd: "cliclick", builder: buildCliclick },
	{ name: "powershell", platforms: ["win32"], cmd: "powershell", builder: buildPowershell },
];

async function selectBackend(whichFn: (cmd: string) => Promise<string | null>): Promise<PlatformBackend | null> {
	for (const backend of BACKENDS) {
		if (!backend.platforms.includes(PLATFORM)) continue;
		const found = await whichFn(backend.cmd);
		if (found) return backend;
	}
	return null;
}

// Fallback when primary tool is not found: try alternatives
async function selectFallbackBackend(
	whichFn: (cmd: string) => Promise<string | null>,
): Promise<PlatformBackend | null> {
	// On macOS, osascript is always available
	if (PLATFORM === "darwin") {
		return { name: "osascript", platforms: ["darwin"], cmd: "osascript", builder: makeOsascriptBuilder() };
	}
	// On Linux, try ydotool if xdotool not found (or vice versa)
	if (PLATFORM === "linux") {
		for (const backend of BACKENDS) {
			if (!backend.platforms.includes("linux")) continue;
			const found = await whichFn(backend.cmd);
			if (found) return backend;
		}
	}
	return null;
}

function makeOsascriptBuilder(): BackendBuilder {
	return (params: InteractToolInput): ActionSpec => {
		const x = params.x ?? 0;
		const y = params.y ?? 0;

		switch (params.action) {
			case "move":
				return {
					action: "move",
					cmd: "osascript",
					args: ["-e", `tell application "System Events" to set position of mouse to {${x}, ${y}}`],
				};
			case "click":
				return {
					action: "click",
					cmd: "osascript",
					args: ["-e", `tell application "System Events" to click at {${x}, ${y}}`],
				};
			case "type":
				return {
					action: "type",
					cmd: "osascript",
					args: [
						"-e",
						`tell application "System Events" to keystroke "${(params.text ?? "").replace(/"/g, '\\"')}"`,
					],
				};
			case "key": {
				const keyStr = (params.keys ?? []).join(" ");
				return {
					action: "key",
					cmd: "osascript",
					args: ["-e", `tell application "System Events" to keystroke "${keyStr}"`],
				};
			}
			case "scroll":
				return {
					action: "scroll",
					cmd: "osascript",
					args: ["-e", `tell application "System Events" to key code 124`], // right arrow
				};
			default:
				throw new Error(`Unknown action: ${params.action}`);
		}
	};
}

// ============================================================================
// Desktop screenshot (for the screenshot-after-action feature)
// ============================================================================

const SCREENSHOT_CANDIDATES: Array<{
	name: string;
	platforms: string[];
	cmd: string;
	args: (outputPath: string) => string[];
}> = [
	{
		name: "screencapture",
		platforms: ["darwin"],
		cmd: "screencapture",
		args: (outputPath) => ["-x", outputPath],
	},
	{
		name: "spectacle",
		platforms: ["linux"],
		cmd: "spectacle",
		args: (outputPath) => ["-b", "-o", outputPath],
	},
	{
		name: "gnome-screenshot",
		platforms: ["linux"],
		cmd: "gnome-screenshot",
		args: (outputPath) => ["-f", outputPath],
	},
	{
		name: "powershell-screen",
		platforms: ["win32"],
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

async function captureScreenshot(
	outputPath: string,
	whichFn: (cmd: string) => Promise<string | null>,
	execFn: (
		cmd: string,
		args: string[],
		timeoutMs?: number,
		signal?: AbortSignal,
	) => Promise<{ code: number | null; signal: boolean }>,
	signal?: AbortSignal,
): Promise<void> {
	for (const candidate of SCREENSHOT_CANDIDATES) {
		if (!candidate.platforms.includes(PLATFORM)) continue;
		const found = await whichFn(candidate.cmd);
		if (!found) continue;

		const result = await execFn(found, candidate.args(outputPath), 15_000, signal);
		if (result.signal) throw new Error("Screenshot cancelled");
		if (result.code === 0 && existsSync(outputPath)) return;
	}
	throw new Error("No screenshot tool found. Install one: screencapture (macOS), spectacle (Linux), or similar.");
}

// ============================================================================
// Tool Definition Factory
// ============================================================================

export function createInteractToolDefinition(
	_cwd: string,
	options?: InteractToolOptions,
): ToolDefinition<typeof interactSchema, InteractToolDetails> {
	const whichFn = options?.which ?? which;
	const execFn = options?.execCommand ?? execCommand;
	const outputDir = options?.outputDir;

	return {
		name: "interact",
		label: "interact",
		description:
			"Control the desktop by moving the mouse, clicking, typing, pressing keys, or scrolling. " +
			"Requires xdotool (Linux/X11), ydotool (Linux/Wayland), cliclick (macOS), or PowerShell (Windows). " +
			"Combine with screenshot to create a visual feedback loop: click a button, then screenshot to verify the result. " +
			"Use after screenshot() to act on visual analysis.",
		promptSnippet: "Interact with the desktop: click, type, key, move, scroll",
		promptGuidelines: [
			"Use interact after screenshot to click on UI elements by coordinates.",
			"The screenshot shows the desktop at full resolution. Coordinates in interact(x,y) map directly to pixels in the screenshot.",
			"For text input, use interact(type: 'text') after focusing the target field with a click.",
			"Use interact(key: ['ctrl+s']) for keyboard shortcuts.",
			"Set screenshot: true to capture the result after an action in one call.",
			"Permission is required for all interact actions.",
		],
		parameters: interactSchema,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params: InteractToolInput,
			signal: AbortSignal | undefined,
		): Promise<AgentToolResult<InteractToolDetails>> {
			// Find the right backend for this platform
			let backend = await selectBackend(whichFn);
			if (!backend) {
				backend = await selectFallbackBackend(whichFn);
			}
			if (!backend) {
				const platformNames: Record<string, string> = {
					linux: "xdotool or ydotool",
					darwin: "cliclick",
					win32: "PowerShell (built-in)",
				};
				const hint = platformNames[PLATFORM] ?? "a desktop automation tool";
				throw new Error(
					`No desktop automation tool found for ${PLATFORM}. Install ${hint}.\n` +
						`  - Arch: sudo pacman -S xdotool\n` +
						`  - macOS: brew install cliclick\n` +
						`  - Windows: built-in PowerShell is used automatically`,
				);
			}

			// Build the command
			const spec = backend.builder(params);

			// For ydotool scroll with multiple clicks, run multiple times
			if (params.action === "scroll" && backend.name === "ydotool") {
				const clicks = Math.abs(params.clicks ?? 1);
				for (let i = 0; i < clicks; i++) {
					const result = await execFn(spec.cmd, spec.args, 10_000, signal);
					if (result.signal) throw new Error("Interact cancelled");
					if (result.code !== 0) {
						throw new Error(`${backend.name} ${params.action} failed (exit code ${result.code})`);
					}
				}
			} else {
				// Execute normally
				const result = await execFn(spec.cmd, spec.args, 10_000, signal);
				if (result.signal) throw new Error("Interact cancelled");
				if (result.code !== 0) {
					throw new Error(`${backend.name} ${params.action} failed (exit code ${result.code})`);
				}
			}

			// Build result content
			const content: (TextContent | ImageContent)[] = [];
			const actionDesc = describeAction(params, backend.name);
			content.push({ type: "text" as const, text: actionDesc });

			// Optional screenshot after action
			if (params.screenshot) {
				const shotPath = screenshotPath(outputDir);
				await captureScreenshot(shotPath, whichFn, execFn, signal);
				const image = await readScreenshotImage(shotPath);
				content.push(image);
			}

			return {
				content,
				details: {
					action: params.action,
					backend: backend.name,
					platform: PLATFORM,
					screenshot: params.screenshot,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const action = args?.action ?? "?";
			const detail = action === "click" ? ` (${args?.x},${args?.y})` : action === "type" ? ` "${args?.text}"` : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("interact"))} ${theme.fg("accent", action)}${detail}`);
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

function describeAction(params: InteractToolInput, backend: string): string {
	switch (params.action) {
		case "click":
			return `Clicked (${params.x}, ${params.y}) with ${params.button ?? "left"} button via ${backend}`;
		case "move":
			return `Moved mouse to (${params.x}, ${params.y}) via ${backend}`;
		case "type":
			return `Typed "${params.text}" via ${backend}`;
		case "key":
			return `Pressed ${(params.keys ?? []).join(" + ")} via ${backend}`;
		case "scroll":
			return `Scrolled ${(params.clicks ?? 1) > 0 ? "down" : "up"} (${Math.abs(params.clicks ?? 1)} clicks) via ${backend}`;
		default:
			return `Performed ${params.action} via ${backend}`;
	}
}

export function createInteractTool(cwd: string, options?: InteractToolOptions): AgentTool<typeof interactSchema> {
	return wrapToolDefinition(createInteractToolDefinition(cwd, options));
}
