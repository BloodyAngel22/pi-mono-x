/**
 * Cheap, synchronous context pruning.
 *
 * Unlike full compaction (compaction.ts), this never calls an LLM and never
 * touches persisted session state. It runs on every transformContext call
 * (i.e. before every LLM request, not just at turn boundaries) and replaces
 * stale/superseded `read` tool results with a short placeholder in the
 * transient message array handed to the provider. The original messages in
 * agent.state.messages and the on-disk session log are never mutated.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTokens } from "./compaction.js";

export interface PruneResult {
	/** New array; untouched messages keep their original object identity. */
	messages: AgentMessage[];
	prunedToolCallIds: string[];
	tokensFreed: number;
	paths: string[];
}

/** Shared prefix for all stale-tool-result placeholder text, used to detect pruned results elsewhere (e.g. manifest.ts). */
export const STALE_PLACEHOLDER_PREFIX = "[Stale ";

/** True if `text` is a placeholder produced by `replaceWithPlaceholder` / `pruneStaleToolResults`. */
export function isStalePlaceholderText(text: string): boolean {
	return text.startsWith(STALE_PLACEHOLDER_PREFIX);
}

/** Replace a toolResult's content with a short placeholder, tracking tokens freed. */
function replaceWithPlaceholder(
	message: ToolResultMessage,
	reason: string,
): { replaced: ToolResultMessage; freed: number } {
	const before = estimateTokens(message);
	const replaced: ToolResultMessage = {
		...message,
		content: [
			{
				type: "text" as const,
				text: `${STALE_PLACEHOLDER_PREFIX}${message.toolName} result — ${reason}; original content omitted from context to save space. Full content is still in the session log.]`,
			},
		],
	};
	const freed = Math.max(0, before - estimateTokens(replaced));
	return { replaced, freed };
}

const FILE_READ_TOOL = "read";
const FILE_INVALIDATING_TOOLS = new Set(["write", "edit"]);

/**
 * Find `read` tool results superseded by a later read, write, or edit of the
 * same file path, and replace their content with a short placeholder.
 *
 * Only `read` results are pruned: write/edit results are small
 * confirmations/diffs that are cheap to keep and more useful to a later
 * summarizer verbatim.
 */
export function pruneStaleToolResults(messages: AgentMessage[]): PruneResult {
	const lastLiveReadForPath = new Map<string, string>(); // path -> toolCallId
	const staleToolCallIds = new Set<string>();
	const staleToolCallPath = new Map<string, string>();

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (!("content" in message) || !Array.isArray(message.content)) continue;

		for (const block of message.content) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || block.type !== "toolCall") continue;
			if (!("arguments" in block) || !("name" in block) || !("id" in block)) continue;

			const args = block.arguments as Record<string, unknown> | undefined;
			const path = args && typeof args.path === "string" ? args.path : undefined;
			if (!path) continue;

			const priorReadId = lastLiveReadForPath.get(path);
			if (priorReadId && priorReadId !== block.id) {
				staleToolCallIds.add(priorReadId);
				staleToolCallPath.set(priorReadId, path);
			}

			if (block.name === FILE_READ_TOOL) {
				lastLiveReadForPath.set(path, block.id as string);
			} else if (FILE_INVALIDATING_TOOLS.has(block.name as string)) {
				lastLiveReadForPath.delete(path);
			}
		}
	}

	if (staleToolCallIds.size === 0) {
		return { messages, prunedToolCallIds: [], tokensFreed: 0, paths: [] };
	}

	let tokensFreed = 0;
	const paths = new Set<string>();
	const out = messages.map((message) => {
		if (message.role !== "toolResult" || !staleToolCallIds.has(message.toolCallId)) {
			return message;
		}
		const path = staleToolCallPath.get(message.toolCallId) ?? message.toolName;
		paths.add(path);

		const before = estimateTokens(message);
		const replaced = {
			...message,
			content: [
				{
					type: "text" as const,
					text: `${STALE_PLACEHOLDER_PREFIX}${message.toolName} result for ${path} — superseded by a later read/write/edit of the same file; original content omitted from context to save space. Full content is still in the session log.]`,
				},
			],
		};
		tokensFreed += Math.max(0, before - estimateTokens(replaced));
		return replaced;
	});

	return {
		messages: out,
		prunedToolCallIds: [...staleToolCallIds],
		tokensFreed,
		paths: [...paths],
	};
}

// ============================================================================
// Read-only tool result pruning (bash / grep / find / ls)
// ============================================================================

type ReadOnlySupersedableTool = "bash" | "grep" | "find" | "ls";
const READONLY_SUPERSEDABLE_TOOLS = new Set<ReadOnlySupersedableTool>(["bash", "grep", "find", "ls"]);
/**
 * Tools whose structured `path` argument can invalidate a live ls/find/grep entry
 * scoped to an overlapping path. `bash` is deliberately excluded everywhere in this
 * file: arbitrary shell commands can't be reliably parsed for the paths they touch
 * (pipes, quoting, aliases, `&&`), so it is only ever superseded by a later
 * byte-identical command, never invalidated by write/edit.
 */
const READONLY_SCOPE_INVALIDATING_TOOLS = new Set(["write", "edit"]);

interface ReadOnlyKeyInfo {
	/** Identity key: two calls with the same key are considered "the same query". */
	key: string;
	/**
	 * Directory/file scope this call's result depends on, for write/edit invalidation.
	 * Undefined means "never invalidated by write/edit" (used for bash).
	 */
	scopePath?: string;
	/** Human-readable label used in the placeholder text and PruneResult.paths. */
	descriptor: string;
}

/** Default path arg to "." (cwd) and strip a trailing slash. No fs/cwd resolution — raw string only. */
function normalizeDirArg(path: unknown): string {
	const raw = typeof path === "string" && path.length > 0 ? path : ".";
	return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
}

function computeReadOnlyKey(name: string, args: Record<string, unknown>): ReadOnlyKeyInfo | undefined {
	switch (name as ReadOnlySupersedableTool) {
		case "ls": {
			const scopePath = normalizeDirArg(args.path);
			const limit = typeof args.limit === "number" ? args.limit : "-";
			return { key: `ls::${scopePath}::limit=${limit}`, scopePath, descriptor: scopePath };
		}
		case "find": {
			if (typeof args.pattern !== "string") return undefined;
			const scopePath = normalizeDirArg(args.path);
			const limit = typeof args.limit === "number" ? args.limit : "-";
			return {
				key: `find::${scopePath}::pattern=${args.pattern}::limit=${limit}`,
				scopePath,
				descriptor: `${args.pattern} in ${scopePath}`,
			};
		}
		case "grep": {
			if (typeof args.pattern !== "string") return undefined;
			const scopePath = normalizeDirArg(args.path);
			const glob = typeof args.glob === "string" ? args.glob : "-";
			const ignoreCase = Boolean(args.ignoreCase);
			const literal = Boolean(args.literal);
			const context = typeof args.context === "number" ? args.context : "-";
			const limit = typeof args.limit === "number" ? args.limit : "-";
			return {
				key: `grep::${scopePath}::pattern=${args.pattern}::glob=${glob}::ic=${ignoreCase}::lit=${literal}::ctx=${context}::limit=${limit}`,
				scopePath,
				descriptor: `${args.pattern} in ${scopePath}`,
			};
		}
		case "bash": {
			if (typeof args.command !== "string") return undefined;
			const descriptor = args.command.length > 60 ? `${args.command.slice(0, 60)}…` : args.command;
			// No scopePath: bash is never invalidated by write/edit, see module notes above.
			return { key: `bash::${args.command}`, descriptor };
		}
		default:
			return undefined;
	}
}

/** True if a write/edit at `writePath` should invalidate a live entry scoped to `scopePath`. */
function scopeOverlaps(scopePath: string, writePath: string): boolean {
	return scopePath === "." || writePath === scopePath || writePath.startsWith(`${scopePath}/`);
}

/**
 * Find `bash`/`grep`/`find`/`ls` tool results superseded by a later call with the same
 * (strictly, string-equal) arguments, or invalidated by a `write`/`edit` whose path
 * overlaps the call's scope, and replace their content with a short placeholder.
 *
 * Composes with `pruneStaleToolResults`: both operate on toolResult content only, never
 * on toolCall blocks, so they can run in either order over the same transient array.
 * Only applies to the transient LLM-bound message array — see module docstring.
 */
export function pruneStaleReadOnlyToolResults(messages: AgentMessage[]): PruneResult {
	const lastLiveCallForKey = new Map<string, { toolCallId: string; scopePath?: string; descriptor: string }>();
	const staleToolCallIds = new Set<string>();
	const staleDescriptorForId = new Map<string, string>();

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (!("content" in message) || !Array.isArray(message.content)) continue;

		for (const block of message.content) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || block.type !== "toolCall") continue;
			if (!("arguments" in block) || !("name" in block) || !("id" in block)) continue;

			const name = block.name as string;
			const args = (block.arguments as Record<string, unknown> | undefined) ?? {};

			if (READONLY_SCOPE_INVALIDATING_TOOLS.has(name)) {
				const writePath = typeof args.path === "string" ? args.path : undefined;
				if (writePath !== undefined) {
					for (const [key, entry] of lastLiveCallForKey) {
						if (entry.scopePath !== undefined && scopeOverlaps(entry.scopePath, writePath)) {
							staleToolCallIds.add(entry.toolCallId);
							staleDescriptorForId.set(entry.toolCallId, entry.descriptor);
							lastLiveCallForKey.delete(key);
						}
					}
				}
				continue;
			}

			if (!READONLY_SUPERSEDABLE_TOOLS.has(name as ReadOnlySupersedableTool)) continue;

			const computed = computeReadOnlyKey(name, args);
			if (!computed) continue;

			const prior = lastLiveCallForKey.get(computed.key);
			if (prior && prior.toolCallId !== block.id) {
				staleToolCallIds.add(prior.toolCallId);
				staleDescriptorForId.set(prior.toolCallId, prior.descriptor);
			}
			lastLiveCallForKey.set(computed.key, {
				toolCallId: block.id as string,
				scopePath: computed.scopePath,
				descriptor: computed.descriptor,
			});
		}
	}

	if (staleToolCallIds.size === 0) {
		return { messages, prunedToolCallIds: [], tokensFreed: 0, paths: [] };
	}

	let tokensFreed = 0;
	const prunedToolCallIds: string[] = [];
	const descriptors = new Set<string>();
	const out = messages.map((message) => {
		if (message.role !== "toolResult" || !staleToolCallIds.has(message.toolCallId)) {
			return message;
		}
		// Never silently drop error results, matching compressToolResults' convention.
		if (message.isError) {
			return message;
		}

		const descriptor = staleDescriptorForId.get(message.toolCallId) ?? message.toolName;
		descriptors.add(descriptor);
		prunedToolCallIds.push(message.toolCallId);

		const { replaced, freed } = replaceWithPlaceholder(
			message,
			`${descriptor} — superseded by a later identical call or a write/edit to the same scope`,
		);
		tokensFreed += freed;
		return replaced;
	});

	return {
		messages: out,
		prunedToolCallIds,
		tokensFreed,
		paths: [...descriptors],
	};
}
