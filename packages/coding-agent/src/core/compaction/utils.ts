/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Tool Result Compression
// ============================================================================

export interface ToolResultCompressionOptions {
	/** Tool results with text output below this threshold are considered trivial. */
	smallTextThreshold?: number;
	/**
	 * Drop trivial successful tool results entirely.
	 * Use only for summarization text, not provider conversation context, because
	 * provider APIs often require assistant tool calls to have matching tool results.
	 */
	dropSmallResults?: boolean;
}

const DEFAULT_SMALL_TOOL_RESULT_THRESHOLD = 200;

function extractToolResultStats(content: (TextContent | ImageContent)[]): { text: string; imageCount: number } {
	const textParts: string[] = [];
	let imageCount = 0;
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		} else if (block.type === "image") {
			imageCount += 1;
		}
	}
	return { text: textParts.join(""), imageCount };
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)}KB`;
	const mb = kb / 1024;
	return `${mb.toFixed(mb >= 10 ? 0 : 1)}MB`;
}

function formatCompressedToolResult(toolName: string, toolCallId: string, text: string, imageCount: number): string {
	const trimmed = text.trim();
	const lineCount = trimmed ? trimmed.split(/\r?\n/).length : 0;
	const parts = [`${lineCount} lines`, formatBytes(text.length)];
	if (imageCount > 0) parts.push(`${imageCount} image${imageCount === 1 ? "" : "s"}`);
	return `[Compressed successful tool result: ${toolName} (${toolCallId}) → ${parts.join(" / ")}]`;
}

/**
 * Algorithmically compress successful tool results in older context.
 *
 * Error tool results are preserved verbatim. For provider conversation context,
 * prefer metadata replacement over dropping so assistant tool calls still have a
 * matching tool result message.
 */
export function compressToolResults(
	messages: AgentMessage[],
	options: ToolResultCompressionOptions = {},
): AgentMessage[] {
	const smallTextThreshold = options.smallTextThreshold ?? DEFAULT_SMALL_TOOL_RESULT_THRESHOLD;
	const compressed: AgentMessage[] = [];

	for (const message of messages) {
		if (message.role !== "toolResult" || message.isError) {
			compressed.push(message);
			continue;
		}

		const { text, imageCount } = extractToolResultStats(message.content);
		const isSmall = text.trim().length < smallTextThreshold && imageCount === 0;
		if (isSmall && options.dropSmallResults) {
			continue;
		}

		compressed.push({
			...message,
			content: [
				{
					type: "text",
					text: formatCompressedToolResult(message.toolName, message.toolCallId, text, imageCount),
				},
			],
		});
	}

	return compressed;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
