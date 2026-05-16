import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import type { FastFetchSettings } from "../settings-manager.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { truncateHead } from "./truncate.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULTS = 5;

const fastFetchSchema = Type.Object({
	query: Type.String({ description: "Search query or URL to fetch" }),
	mode: Type.Optional(
		Type.Union([Type.Literal("search"), Type.Literal("url")], {
			description: "Use search for queries or url for direct URL fetch (default: auto-detect URL)",
		}),
	),
	maxResults: Type.Optional(Type.Number({ description: "Maximum search results to return (default: 5)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in milliseconds" })),
});

export type FastFetchToolInput = Static<typeof fastFetchSchema>;

export interface FastFetchToolDetails {
	url: string;
	mode: "search" | "url";
	status: number;
	contentType: string | undefined;
	truncated: boolean;
	bytes: number;
}

export interface FastFetchToolOptions {
	settings?: FastFetchSettings;
	fetch?: typeof fetch;
}

function isUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function buildUrl(query: string, mode: "search" | "url", settings: FastFetchSettings): string {
	if (mode === "url") return query;
	const endpoint = settings.searchUrl ?? "https://html.duckduckgo.com/html/";
	const url = new URL(endpoint);
	url.searchParams.set(settings.queryParam ?? "q", query);
	return url.toString();
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function stripHtml(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function formatSearchText(text: string, maxResults: number): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length > 1) return lines.slice(0, maxResults * 4).join("\n");
	const compact = stripHtml(text);
	return compact.length > 0 ? compact : text;
}

async function readResponseText(
	response: Response,
	maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
	const text = await response.text();
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return { text, bytes, truncated: false };
	const truncated = truncateHead(text, { maxBytes });
	return { text: truncated.content, bytes, truncated: true };
}

function createAbortSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
	const controller = new AbortController();
	const abort = (reason: unknown) => {
		if (!controller.signal.aborted) controller.abort(reason);
	};
	const timer = setTimeout(() => abort(new Error("fast_fetch timed out")), timeoutMs);
	controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	if (signal) {
		if (signal.aborted) {
			abort(signal.reason);
		} else {
			signal.addEventListener("abort", () => abort(signal.reason), { once: true });
		}
	}
	return controller.signal;
}

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

export function createFastFetchToolDefinition(
	_cwd: string,
	options?: FastFetchToolOptions,
): ToolDefinition<typeof fastFetchSchema, FastFetchToolDetails> {
	const settings = options?.settings ?? {};
	const fetchImpl = options?.fetch ?? fetch;
	return {
		name: "fast_fetch",
		label: "fast_fetch",
		description:
			"Fast internet fetch/search without MCP. Uses the configured fastFetch.searchUrl endpoint from settings.json, or DuckDuckGo HTML search by default, and returns compact text.",
		promptSnippet: "Fast web search or URL fetch without MCP",
		promptGuidelines: [
			"MUST use fast_fetch for web lookups instead of delegating to sub-agent — it is faster and cheaper.",
			"Only delegate to sub-agent if fast_fetch is unavailable or the task requires deep multi-page research.",
			"Use mode=url for known URLs; otherwise pass a concise search query. Prefer 1 fast_fetch over multiple MCP calls.",
		],
		parameters: fastFetchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, { query, mode, maxResults, timeoutMs }, signal) {
			const resolvedMode = mode ?? (isUrl(query) ? "url" : "search");
			const url = buildUrl(query, resolvedMode, settings);
			const timeout = clampInteger(timeoutMs ?? settings.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000);
			const maxBytes = clampInteger(settings.maxBytes, DEFAULT_MAX_BYTES, 4_096, 1024 * 1024);
			const resultLimit = clampInteger(maxResults ?? settings.maxResults, DEFAULT_MAX_RESULTS, 1, 20);
			const response = await fetchImpl(url, {
				headers: settings.headers,
				signal: createAbortSignal(timeout, signal),
			});
			const contentType = response.headers.get("content-type") ?? undefined;
			const body = await readResponseText(response, maxBytes);
			const text = resolvedMode === "search" ? formatSearchText(body.text, resultLimit) : body.text;
			const prefix = `fast_fetch ${resolvedMode} ${response.status} ${response.statusText}\nURL: ${url}\n\n`;
			return {
				content: [{ type: "text", text: prefix + text }],
				details: {
					url,
					mode: resolvedMode,
					status: response.status,
					contentType,
					truncated: body.truncated,
					bytes: body.bytes,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("fast_fetch")) +
					" " +
					theme.fg("accent", args?.query ? `"${args.query}"` : "<query>"),
			);
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResult(result as any, renderOptions, theme));
			return text;
		},
	};
}

export function createFastFetchTool(cwd: string, options?: FastFetchToolOptions): AgentTool<typeof fastFetchSchema> {
	return wrapToolDefinition(createFastFetchToolDefinition(cwd, options));
}
