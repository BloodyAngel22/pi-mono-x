import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import { type FastContextResult, fastContextSearch, formatFastContextResult } from "../context-search.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const fastContextSchema = Type.Object({
	query: Type.String({ description: "What to find in the current codebase" }),
	path: Type.Optional(
		Type.String({ description: "Reserved for future scoped search; currently searches the project cwd" }),
	),
	maxFiles: Type.Optional(Type.Number({ description: "Maximum relevant files to return (default: 12)" })),
	includeSnippets: Type.Optional(
		Type.Boolean({ description: "Include compact matching line snippets (default: true)" }),
	),
});

export type FastContextToolInput = Static<typeof fastContextSchema>;
export type FastContextToolDetails = FastContextResult;

function formatResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const output = getTextOutput(result, false).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 18;
	const shown = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	const remaining = lines.length - maxLines;
	return shown.join("\n") + (remaining > 0 ? theme.fg("muted", `\n... (${remaining} more lines)`) : "");
}

export function createFastContextToolDefinition(
	cwd: string,
): ToolDefinition<typeof fastContextSchema, FastContextToolDetails> {
	return {
		name: "fast_context",
		label: "fast_context",
		description:
			"Quickly find relevant files, line ranges, and compact snippets in the current codebase before deeper reading. Uses grounded local lexical search (ripgrep/fd), query expansion, and source-file ranking. Use this before broad grep/find/read exploration.",
		promptSnippet: "Fast codebase context search for relevant files/ranges",
		promptGuidelines: [
			"MUST call fast_context before broad grep/find/read when finding code in a codebase — it is fast and designed exactly for this.",
			"Reading 3+ files without fast_context first is slow and wasteful — you are ignoring the optimized tool.",
			"After fast_context, read ONLY the top relevant returned files/ranges. Do NOT read many unrelated files.",
			"If fast_context returns weak or no results, THEN fall back to grep/find/read with refined terms.",
		],
		parameters: fastContextSchema,
		executionMode: "parallel",
		async execute(_toolCallId, { query, maxFiles, includeSnippets }, signal) {
			const result = await fastContextSearch(
				cwd,
				query,
				{ maxFiles, includeSnippets: includeSnippets ?? true },
				signal,
			);
			return {
				content: [{ type: "text", text: formatFastContextResult(result) }],
				details: result,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("fast_context")) +
					" " +
					theme.fg("accent", args?.query ? `"${args.query}"` : "<query>"),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResult(result as any, options, theme));
			return text;
		},
	};
}

export function createFastContextTool(cwd: string): AgentTool<typeof fastContextSchema> {
	return wrapToolDefinition(createFastContextToolDefinition(cwd));
}
