/**
 * Cheap, synchronous file manifest for the transient LLM-bound context.
 *
 * Complements pruning (prune.ts): as stale tool results get stubbed out over
 * the course of a session, the model can lose track of which files it has
 * read/written/edited so far. This recomputes a short "files touched" note
 * from the current transient message array on every transformContext call
 * and is meant to be re-injected each time (never persisted, never
 * accumulated) — see sdk.ts's transformContext wiring.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CustomMessage } from "../messages.js";
import { createCustomMessage } from "../messages.js";
import { isStalePlaceholderText } from "./prune.js";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "./utils.js";

export const FILE_MANIFEST_CUSTOM_TYPE = "file-manifest";

export interface FileManifestSections {
	modifiedFiles: string[];
	/** Read-only paths (never written/edited) with at least one non-stale read result still visible. */
	freshReadFiles: string[];
	/** Paths whose every read result is currently stubbed out (may also be a modified path). */
	prunedReadFiles: string[];
}

/** Build a toolCallId -> path map for `read` tool calls, mirroring the loops in prune.ts/utils.ts. */
function mapReadToolCallIdsToPaths(messages: AgentMessage[]): Map<string, string> {
	const readCallPaths = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (!("content" in message) || !Array.isArray(message.content)) continue;

		for (const block of message.content) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || block.type !== "toolCall") continue;
			if (!("arguments" in block) || !("name" in block) || !("id" in block)) continue;
			if (block.name !== "read") continue;

			const args = block.arguments as Record<string, unknown> | undefined;
			const path = args && typeof args.path === "string" ? args.path : undefined;
			if (!path) continue;
			readCallPaths.set(block.id as string, path);
		}
	}
	return readCallPaths;
}

/** Paths whose `read` tool result is currently visible (non-stale) somewhere in `messages`. */
function computeFreshReadPaths(messages: AgentMessage[], readCallPaths: Map<string, string>): Set<string> {
	const freshPaths = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const path = readCallPaths.get(message.toolCallId);
		if (!path) continue;

		const text = message.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text;
		if (text !== undefined && !isStalePlaceholderText(text)) {
			freshPaths.add(path);
		}
	}
	return freshPaths;
}

/**
 * Compute the file manifest sections from the current transient message array.
 * Returns undefined when no files have been touched at all (nothing to show).
 */
export function computeFileManifestSections(messages: AgentMessage[]): FileManifestSections | undefined {
	const fileOps = createFileOps();
	for (const message of messages) {
		extractFileOpsFromMessage(message, fileOps);
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	if (readFiles.length === 0 && modifiedFiles.length === 0) {
		return undefined;
	}

	const readCallPaths = mapReadToolCallIdsToPaths(messages);
	const freshPaths = computeFreshReadPaths(messages, readCallPaths);

	const freshReadFiles: string[] = [];
	const prunedReadFiles: string[] = [];
	for (const path of fileOps.read) {
		if (freshPaths.has(path)) {
			if (!fileOps.written.has(path) && !fileOps.edited.has(path)) {
				freshReadFiles.push(path);
			}
		} else {
			prunedReadFiles.push(path);
		}
	}
	freshReadFiles.sort();
	prunedReadFiles.sort();

	if (modifiedFiles.length === 0 && freshReadFiles.length === 0 && prunedReadFiles.length === 0) {
		return undefined;
	}

	return { modifiedFiles, freshReadFiles, prunedReadFiles };
}

/** Format file manifest sections as a short, plain-text note (not the compaction-summary XML format). */
export function formatFileManifest(sections: FileManifestSections): string {
	const lines: string[] = [];
	if (sections.modifiedFiles.length > 0) {
		lines.push(`Modified this session: ${sections.modifiedFiles.join(", ")}`);
	}
	if (sections.freshReadFiles.length > 0) {
		lines.push(`Read this session (still visible above): ${sections.freshReadFiles.join(", ")}`);
	}
	if (sections.prunedReadFiles.length > 0) {
		lines.push(
			`Read this session (content pruned from context — re-read if you need current contents): ${sections.prunedReadFiles.join(", ")}`,
		);
	}
	return lines.join("\n");
}

/**
 * Build the transient manifest message to inject, or undefined if there's nothing to show.
 * Never persisted: caller must only append this to the transient transformContext array.
 */
export function buildFileManifestMessage(messages: AgentMessage[], timestamp: string): CustomMessage | undefined {
	const sections = computeFileManifestSections(messages);
	if (!sections) return undefined;
	return createCustomMessage(FILE_MANIFEST_CUSTOM_TYPE, formatFileManifest(sections), false, sections, timestamp);
}
