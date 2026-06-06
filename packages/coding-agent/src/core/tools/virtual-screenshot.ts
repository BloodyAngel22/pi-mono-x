import { spawn } from "node:child_process";
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
// Schema — no parameters needed, always captures :99
// ============================================================================

const virtualScreenshotSchema = Type.Object({});

export type VirtualScreenshotToolInput = Static<typeof virtualScreenshotSchema>;

export interface VirtualScreenshotToolDetails {
	path: string;
	width: number;
	height: number;
}

export interface VirtualScreenshotToolOptions {
	// No configuration needed for virtual tool
}

// ============================================================================
// Tool Definition Factory
// ============================================================================

export function createVirtualScreenshotToolDefinition(
	_cwd: string,
	_options?: VirtualScreenshotToolOptions,
): ToolDefinition<typeof virtualScreenshotSchema, VirtualScreenshotToolDetails> {
	return {
		name: "virtual_screenshot",
		label: "virtual_screenshot",
		description:
			"Take a screenshot of the agent's isolated virtual display (Xvfb :99). " +
			"The virtual display is a separate X11 session that does not affect the user's desktop. " +
			"Use this to see what applications look like inside the isolated environment.",
		promptSnippet: "Take a screenshot of the isolated virtual display",
		promptGuidelines: [
			"Use virtual_screenshot to see what's running in the isolated virtual display.",
			"The virtual display (:99) is separate from the user's desktop.",
			"After taking a screenshot, describe what you see before making changes.",
			"Launch applications with DISPLAY=:99 to make them appear in the virtual display.",
		],
		parameters: virtualScreenshotSchema,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			_params: VirtualScreenshotToolInput,
			signal: AbortSignal | undefined,
		): Promise<AgentToolResult<VirtualScreenshotToolDetails>> {
			// Generate temp file path
			const outputPath = join(tmpdir(), `vs-${Date.now()}.png`);

			// Run import (ImageMagick) to capture :99 display
			let stderrBuf = "";
			await new Promise<void>((resolve, reject) => {
				const child = spawn("import", ["-display", ":99", "-window", "root", outputPath], {
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 15_000,
					env: { ...process.env, DISPLAY: ":99" },
				});
				child.stdout?.on("data", () => {});
				child.stderr?.on("data", (chunk) => {
					stderrBuf += chunk.toString();
				});
				if (signal) {
					signal.addEventListener("abort", () => {
						child.kill();
						reject(new Error("Screenshot cancelled"));
					});
				}
				child.on("close", (code) => {
					if (code === 0) resolve();
					else {
						const detail = stderrBuf.trim() ? `: ${stderrBuf.trim().split("\n").pop()}` : "";
						reject(
							new Error(
								`import exited with code ${code}${detail}. Is Xvfb running on :99? Start it with: Xvfb :99 -screen 0 1920x1080x24 &`,
							),
						);
					}
				});
				child.on("error", reject);
			});

			// Read and process the image
			const mimeType = await detectSupportedImageMimeTypeFromFile(outputPath);
			if (!mimeType) {
				throw new Error(`Unsupported image format: ${outputPath}`);
			}

			const fileBuffer = await readFile(outputPath);
			const base64 = fileBuffer.toString("base64");

			const resized = await resizeImage(
				{ type: "image", data: base64, mimeType },
				{ maxWidth: 2000, maxHeight: 2000 },
			);

			let image: ImageContent;
			let dimensions: string;

			if (resized) {
				dimensions = `${resized.width}x${resized.height}`;
				const dimNote = resized.wasResized
					? ` (original ${resized.originalWidth}x${resized.originalHeight}, resized to ${dimensions})`
					: ` (${dimensions})`;
				image = { type: "image", data: resized.data, mimeType: resized.mimeType };
				dimensions = dimNote;
			} else {
				dimensions = `${fileBuffer.length} bytes`;
				image = { type: "image", data: base64, mimeType };
			}

			return {
				content: [
					{
						type: "text",
						text: `Virtual display (:99) screenshot captured${dimensions}`,
					},
					image,
				],
				details: {
					path: outputPath,
					width: resized ? resized.width : 0,
					height: resized ? resized.height : 0,
				},
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${theme.fg("toolTitle", theme.bold("virtual_screenshot"))}`);
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

export function createVirtualScreenshotTool(
	cwd: string,
	options?: VirtualScreenshotToolOptions,
): AgentTool<typeof virtualScreenshotSchema> {
	return wrapToolDefinition(createVirtualScreenshotToolDefinition(cwd, options));
}
