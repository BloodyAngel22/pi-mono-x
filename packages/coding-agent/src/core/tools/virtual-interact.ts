import { spawn } from "node:child_process";
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

const virtualInteractSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("click"), Type.Literal("type"), Type.Literal("key"), Type.Literal("move"), Type.Literal("scroll")],
		{ description: "Action to perform in the virtual display" },
	),
	x: Type.Optional(Type.Number({ description: "X coordinate (for click, move)" })),
	y: Type.Optional(Type.Number({ description: "Y coordinate (for click, move)" })),
	button: Type.Optional(
		Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")], {
			description: "Mouse button (default: left)",
		}),
	),
	text: Type.Optional(Type.String({ description: "Text to type (for type action)" })),
	keys: Type.Optional(Type.Array(Type.String(), { description: "Key combination (for key action), e.g. ['ctrl+c']" })),
	clicks: Type.Optional(Type.Number({ description: "Scroll clicks (positive=down, negative=up)" })),
	screenshot: Type.Optional(Type.Boolean({ description: "Take a screenshot after the action" })),
});

export type VirtualInteractToolInput = Static<typeof virtualInteractSchema>;

export interface VirtualInteractToolDetails {
	action: string;
	screenshot?: boolean;
}

export interface VirtualInteractToolOptions {
	// No configuration needed
}

// ============================================================================
// Helper: detect non-ASCII text
// ============================================================================

function hasNonAscii(text: string): boolean {
	return /[^\x00-\x7F]/.test(text);
}

// ============================================================================
// Helper: write text to X11 clipboard using xclip
// ============================================================================

function writeToClipboard(text: string, display: string, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn("xclip", ["-selection", "clipboard"], {
			stdio: ["pipe", "ignore", "pipe"],
			timeout: 5_000,
			env: { ...process.env, DISPLAY: display },
		});
		if (signal) {
			signal.addEventListener("abort", () => {
				child.kill();
				reject(new Error("Clipboard write cancelled"));
			});
		}
		let stderrBuf = "";
		child.stderr?.on("data", (chunk) => {
			stderrBuf += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(`xclip exited with code ${code}${stderrBuf ? `: ${stderrBuf.trim().split("\n").pop()}` : ""}`),
				);
		});
		child.stdin?.end(text);
	});
}

// ============================================================================
// Helper: build xdotool command
// ============================================================================

function buildXdotoolCommand(params: VirtualInteractToolInput): { cmd: string; args: string[] } {
	switch (params.action) {
		case "click": {
			const x = params.x ?? 0;
			const y = params.y ?? 0;
			const btn = params.button === "right" ? "3" : params.button === "middle" ? "2" : "1";
			return { cmd: "xdotool", args: ["mousemove", String(x), String(y), "click", btn] };
		}
		case "move": {
			const x = params.x ?? 0;
			const y = params.y ?? 0;
			return { cmd: "xdotool", args: ["mousemove", String(x), String(y)] };
		}
		case "type": {
			return { cmd: "xdotool", args: ["type", params.text ?? ""] };
		}
		case "key": {
			const keyStr = (params.keys ?? []).join("+");
			return { cmd: "xdotool", args: ["key", keyStr] };
		}
		case "scroll": {
			const clicks = params.clicks ?? 1;
			const btn = clicks > 0 ? "5" : "4";
			const count = Math.abs(clicks);
			return { cmd: "xdotool", args: ["click", "--repeat", String(count), btn] };
		}
		default:
			throw new Error(`Unknown action: ${params.action}`);
	}
}

function describeAction(params: VirtualInteractToolInput): string {
	switch (params.action) {
		case "click":
			return `Clicked (${params.x ?? 0}, ${params.y ?? 0}) with ${params.button ?? "left"} button`;
		case "move":
			return `Moved mouse to (${params.x ?? 0}, ${params.y ?? 0})`;
		case "type":
			return `Typed "${params.text ?? ""}"`;
		case "key":
			return `Pressed ${(params.keys ?? []).join(" + ")}`;
		case "scroll":
			return `Scrolled ${(params.clicks ?? 1) > 0 ? "down" : "up"} (${Math.abs(params.clicks ?? 1)} clicks)`;
		default:
			return `Performed ${params.action}`;
	}
}

// ============================================================================
// Tool Definition Factory
// ============================================================================

export function createVirtualInteractToolDefinition(
	_cwd: string,
	_options?: VirtualInteractToolOptions,
): ToolDefinition<typeof virtualInteractSchema, VirtualInteractToolDetails> {
	return {
		name: "virtual_interact",
		label: "virtual_interact",
		description:
			"Control the mouse and keyboard inside the agent's isolated virtual display (Xvfb :99). " +
			"Supports click, move, type, key, and scroll actions. " +
			"All actions are performed in the virtual display using xdotool, " +
			"so they do NOT affect the user's desktop. " +
			"Use after virtual_screenshot to act on what you see.",
		promptSnippet: "Interact with the isolated virtual display: click, type, key, move, scroll",
		promptGuidelines: [
			"Use virtual_interact after virtual_screenshot to click on UI elements by coordinates.",
			"The screenshot shows the virtual display at full resolution. Coordinates map directly to pixels.",
			"For text input, use type action after focusing the target field with a click.",
			"Non-ASCII text (cyrillic, unicode) is automatically typed via clipboard (xclip + Ctrl+V) for reliability.",
			"Use key action for keyboard shortcuts, e.g. keys: ['ctrl+s'].",
			"Set screenshot: true to capture the result after an action in one call.",
			"All actions happen in the isolated virtual display and do not affect the user.",
		],
		parameters: virtualInteractSchema,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params: VirtualInteractToolInput,
			signal: AbortSignal | undefined,
		): Promise<AgentToolResult<VirtualInteractToolDetails>> {
			const display = ":99";

			// For type action with non-ASCII text: use clipboard trick instead of xdotool type
			let spec = buildXdotoolCommand(params);
			if (params.action === "type" && params.text && hasNonAscii(params.text)) {
				await writeToClipboard(params.text, display, signal);
				spec = { cmd: "xdotool", args: ["key", "ctrl+v"] };
			}

			// Execute xdotool with DISPLAY=:99
			let stderrBuf = "";
			await new Promise<void>((resolve, reject) => {
				const child = spawn(spec.cmd, spec.args, {
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 10_000,
					env: { ...process.env, DISPLAY: display },
				});
				child.stdout?.on("data", () => {});
				child.stderr?.on("data", (chunk) => {
					stderrBuf += chunk.toString();
				});
				if (signal) {
					signal.addEventListener("abort", () => {
						child.kill();
						reject(new Error("Interact cancelled"));
					});
				}
				child.on("close", (code) => {
					if (code === 0) resolve();
					else {
						const detail = stderrBuf.trim() ? `: ${stderrBuf.trim().split("\n").pop()}` : "";
						reject(
							new Error(
								`xdotool exited with code ${code}${detail}. Is Xvfb running on :99? Start it with: Xvfb :99 -screen 0 1920x1080x24 &`,
							),
						);
					}
				});
				child.on("error", reject);
			});

			// Build result content
			const content: (TextContent | ImageContent)[] = [];
			const actionDesc = describeAction(params);
			const viaClipboard = params.action === "type" && params.text && hasNonAscii(params.text);
			const actionDetail = viaClipboard ? `${actionDesc} (via clipboard: xclip → Ctrl+V)` : actionDesc;
			content.push({ type: "text" as const, text: `[virtual display :99] ${actionDetail}` });

			// Optional screenshot after action
			if (params.screenshot) {
				const outputPath = join(tmpdir(), `vi-${Date.now()}.png`);

				await new Promise<void>((resolve, reject) => {
					const child = spawn("import", ["-display", ":99", "-window", "root", outputPath], {
						stdio: ["ignore", "pipe", "pipe"],
						timeout: 15_000,
					});
					child.stdout?.on("data", () => {});
					child.stderr?.on("data", () => {});
					if (signal) {
						signal.addEventListener("abort", () => {
							child.kill();
							reject(new Error("Screenshot cancelled"));
						});
					}
					child.on("close", (code) => {
						if (code === 0) resolve();
						else reject(new Error(`import exited with code ${code}`));
					});
					child.on("error", reject);
				});

				const mimeType = await detectSupportedImageMimeTypeFromFile(outputPath);
				if (mimeType) {
					const fileBuffer = await readFile(outputPath);
					const base64 = fileBuffer.toString("base64");
					const resized = await resizeImage(
						{ type: "image", data: base64, mimeType },
						{ maxWidth: 2000, maxHeight: 2000 },
					);
					if (resized) {
						content.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
					} else {
						content.push({ type: "image", data: base64, mimeType });
					}
				}
			}

			return {
				content,
				details: {
					action: params.action,
					screenshot: params.screenshot,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const action = args?.action ?? "?";
			const detail =
				action === "click"
					? ` (${args?.x},${args?.y})`
					: action === "type"
						? ` "${args?.text}"`
						: action === "move"
							? ` (${args?.x},${args?.y})`
							: action === "key"
								? ` ${(args?.keys ?? []).join("+")}`
								: action === "scroll"
									? ` ${args?.clicks} clicks`
									: "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("virtual_interact"))} ${theme.fg("accent", action)}${detail}`,
			);
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

export function createVirtualInteractTool(
	cwd: string,
	options?: VirtualInteractToolOptions,
): AgentTool<typeof virtualInteractSchema> {
	return wrapToolDefinition(createVirtualInteractToolDefinition(cwd, options));
}
