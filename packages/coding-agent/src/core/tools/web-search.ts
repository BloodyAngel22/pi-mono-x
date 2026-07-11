import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import type { WebSearchSettings } from "../settings-manager.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { truncateHead } from "./truncate.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_HEADLESS_TIMEOUT_MS = 30_000;

// A realistic modern desktop Chrome/Linux fingerprint. Sites that gate on missing/robotic
// headers (rather than full JS challenges) usually pass once these look like a real browser.
const DEFAULT_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Accept-Encoding": "gzip, deflate, br",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
	"Sec-Ch-Ua": '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"Linux"',
};

const RETRYABLE_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
const SUSPICIOUS_STATUSES = new Set([403, 429, 503]);

interface ChallengeContext {
	bodySnippet: string;
	getHeader?: (name: string) => string | null;
}

const CHALLENGE_SIGNATURES: Array<{ name: string; test: (ctx: ChallengeContext) => boolean }> = [
	{
		name: "cloudflare",
		test: (ctx) =>
			ctx.getHeader?.("cf-mitigated") != null ||
			/just a moment/i.test(ctx.bodySnippet) ||
			/cf-browser-verification|__cf_chl|checking your browser/i.test(ctx.bodySnippet),
	},
	{
		name: "akamai",
		test: (ctx) =>
			/akamaighost/i.test(ctx.getHeader?.("server") ?? "") ||
			(/access denied/i.test(ctx.bodySnippet) && /reference #\d/i.test(ctx.bodySnippet)),
	},
	{
		name: "perimeterx",
		test: (ctx) =>
			/perimeterx|press\s*&\s*hold/i.test(ctx.bodySnippet) ||
			(ctx.getHeader?.("set-cookie")?.includes("_px") ?? false),
	},
	{
		name: "datadome",
		test: (ctx) =>
			/datadome/i.test(ctx.bodySnippet) || (ctx.getHeader?.("set-cookie")?.includes("datadome") ?? false),
	},
	{
		name: "generic-captcha",
		test: (ctx) =>
			/unusual traffic from your computer network|verify you are human|hcaptcha|recaptcha/i.test(ctx.bodySnippet),
	},
];

function matchChallengeSignature(ctx: ChallengeContext): string | undefined {
	return CHALLENGE_SIGNATURES.find((sig) => sig.test(ctx))?.name;
}

function detectChallenge(
	status: number,
	bodySnippet: string,
	getHeader: (name: string) => string | null,
): string | undefined {
	if (!SUSPICIOUS_STATUSES.has(status)) return undefined;
	return matchChallengeSignature({ bodySnippet, getHeader });
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelay(attempt: number, retryAfterHeader: string | null): number {
	if (retryAfterHeader) {
		const seconds = Number(retryAfterHeader);
		if (Number.isFinite(seconds) && seconds > 0) return Math.min(8_000, seconds * 1000);
		const dateMs = Date.parse(retryAfterHeader);
		if (!Number.isNaN(dateMs)) {
			const delta = dateMs - Date.now();
			if (delta > 0) return Math.min(8_000, delta);
		}
	}
	const base = Math.min(8_000, 500 * 2 ** attempt);
	return base * (0.8 + Math.random() * 0.4);
}

// Loaded via a non-literal specifier on purpose: playwright is NOT a package.json dependency
// (its browser download is ~300MB), so this must not be statically resolved by tsc/bundlers.
const PLAYWRIGHT_MODULE_NAME = "playwright";

interface MinimalPlaywrightPage {
	goto(url: string, opts: { waitUntil: "networkidle"; timeout: number }): Promise<unknown>;
	waitForTimeout(ms: number): Promise<void>;
	content(): Promise<string>;
}
interface MinimalPlaywrightContext {
	newPage(): Promise<MinimalPlaywrightPage>;
	close(): Promise<void>;
}
interface MinimalPlaywrightBrowser {
	newContext(opts: Record<string, unknown>): Promise<MinimalPlaywrightContext>;
	close(): Promise<void>;
}
interface MinimalPlaywrightModule {
	chromium: { launch(opts: { headless: boolean; args?: string[] }): Promise<MinimalPlaywrightBrowser> };
}

let playwrightModulePromise: Promise<MinimalPlaywrightModule | null> | null = null;

function loadPlaywright(): Promise<MinimalPlaywrightModule | null> {
	if (!playwrightModulePromise) {
		playwrightModulePromise = (async () => {
			try {
				return (await import(PLAYWRIGHT_MODULE_NAME)) as MinimalPlaywrightModule;
			} catch {
				return null;
			}
		})();
	}
	return playwrightModulePromise;
}

async function fetchWithHeadlessBrowser(
	url: string,
	headlessTimeoutMs: number,
): Promise<{ html: string; blocked: boolean } | { error: string }> {
	const playwright = await loadPlaywright();
	if (!playwright) {
		return {
			error: "playwright is not installed. Run 'npm install playwright && npx playwright install chromium' inside packages/coding-agent to enable webSearch.headlessFallback.",
		};
	}
	const browser = await playwright.chromium.launch({
		headless: true,
		args: ["--disable-blink-features=AutomationControlled"],
	});
	try {
		const context = await browser.newContext({
			userAgent: DEFAULT_HEADERS["User-Agent"],
			viewport: { width: 1366, height: 768 },
			locale: "en-US",
		});
		try {
			const page = await context.newPage();
			await page.goto(url, { waitUntil: "networkidle", timeout: headlessTimeoutMs });
			await page.waitForTimeout(1500);
			let html = await page.content();
			if (matchChallengeSignature({ bodySnippet: html.slice(0, 4096) })) {
				await page.waitForTimeout(2000);
				html = await page.content();
			}
			const blocked = matchChallengeSignature({ bodySnippet: html.slice(0, 4096) }) !== undefined;
			return { html, blocked };
		} finally {
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query or URL to fetch" }),
	mode: Type.Optional(
		Type.Union([Type.Literal("search"), Type.Literal("url")], {
			description: "Use search for queries or url for direct URL fetch (default: auto-detect URL)",
		}),
	),
	maxResults: Type.Optional(Type.Number({ description: "Maximum search results to return (default: 5)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in milliseconds" })),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	url: string;
	mode: "search" | "url";
	status: number;
	contentType: string | undefined;
	truncated: boolean;
	bytes: number;
	blocked?: boolean;
	challengeType?: string;
	headlessAttempted?: boolean;
	headlessUsed?: boolean;
	retries?: number;
}

export interface WebSearchToolOptions {
	settings?: WebSearchSettings;
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

function buildUrl(query: string, mode: "search" | "url", settings: WebSearchSettings): string {
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

function truncateBody(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return { text, bytes, truncated: false };
	const truncated = truncateHead(text, { maxBytes });
	return { text: truncated.content, bytes, truncated: true };
}

async function readResponseText(
	response: Response,
	maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
	const text = await response.text();
	return truncateBody(text, maxBytes);
}

function createAbortSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
	const controller = new AbortController();
	const abort = (reason: unknown) => {
		if (!controller.signal.aborted) controller.abort(reason);
	};
	const timer = setTimeout(() => abort(new Error("web_search timed out")), timeoutMs);
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

export function createWebSearchToolDefinition(
	_cwd: string,
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	const settings = options?.settings ?? {};
	const fetchImpl = options?.fetch ?? fetch;
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Web search or direct URL fetch without MCP. Uses the configured webSearch.searchUrl endpoint from settings.json, or DuckDuckGo HTML search by default. Sends browser-like headers, retries transient failures, and detects common bot-protection challenges (Cloudflare, Akamai, PerimeterX, DataDome, captchas), optionally falling back to a headless browser when webSearch.headlessFallback is enabled.",
		promptSnippet: "Web search or URL fetch without MCP, with bot-protection handling",
		promptGuidelines: [
			"web_search takes priority over MCP search servers (searxng, ddg-search) — use those only as fallback when web_search fails or is blocked.",
			"MUST use web_search for web lookups instead of delegating to sub-agent — it is faster and cheaper.",
			"Only delegate to sub-agent if web_search is unavailable or the task requires deep multi-page research.",
			"Use mode=url for known URLs; otherwise pass a concise search query. Prefer 1 web_search over multiple MCP calls.",
			"If the result says the page was blocked by bot protection, try a different query/source, or suggest the user enable webSearch.headlessFallback.",
		],
		parameters: webSearchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, { query, mode, maxResults, timeoutMs }, signal, onUpdate) {
			const resolvedMode = mode ?? (isUrl(query) ? "url" : "search");
			const url = buildUrl(query, resolvedMode, settings);
			const timeout = clampInteger(timeoutMs ?? settings.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000);
			const maxBytes = clampInteger(settings.maxBytes, DEFAULT_MAX_BYTES, 4_096, 1024 * 1024);
			const resultLimit = clampInteger(maxResults ?? settings.maxResults, DEFAULT_MAX_RESULTS, 1, 20);
			const maxRetries = clampInteger(settings.maxRetries, DEFAULT_MAX_RETRIES, 0, 5);
			const headlessTimeoutMs = clampInteger(
				settings.headlessTimeoutMs,
				DEFAULT_HEADLESS_TIMEOUT_MS,
				5_000,
				120_000,
			);
			const requestHeaders = { ...DEFAULT_HEADERS, ...settings.headers };

			let response: Response | undefined;
			let lastError: unknown;
			let retries = 0;
			let challengeType: string | undefined;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				try {
					response = await fetchImpl(url, {
						headers: requestHeaders,
						signal: createAbortSignal(timeout, signal),
					});
				} catch (e) {
					lastError = e;
					response = undefined;
					if (attempt >= maxRetries) break;
					retries++;
					await sleep(computeRetryDelay(attempt, null));
					continue;
				}

				challengeType = undefined;
				if (SUSPICIOUS_STATUSES.has(response.status)) {
					const peekText = await response.clone().text();
					const currentResponse = response;
					challengeType = detectChallenge(response.status, peekText.slice(0, 4096), (name) =>
						currentResponse.headers.get(name),
					);
				}
				if (challengeType) break;
				if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
					retries++;
					await sleep(computeRetryDelay(attempt, response.headers.get("retry-after")));
					continue;
				}
				break;
			}

			if (!response) {
				throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "web_search request failed"));
			}

			const contentType = response.headers.get("content-type") ?? undefined;

			if (challengeType) {
				if (settings.headlessFallback) {
					if (onUpdate) {
						onUpdate({
							content: [
								{ type: "text", text: `web_search: blocked by ${challengeType}, trying headless fallback…` },
							],
							details: {
								url,
								mode: resolvedMode,
								status: response.status,
								contentType,
								truncated: false,
								bytes: 0,
								blocked: true,
								challengeType,
								headlessAttempted: true,
							},
						});
					}
					const headlessResult = await fetchWithHeadlessBrowser(url, headlessTimeoutMs);
					if ("error" in headlessResult) {
						return {
							content: [
								{
									type: "text",
									text: `web_search ${resolvedMode} blocked by ${challengeType}\nURL: ${url}\n\n${headlessResult.error}`,
								},
							],
							details: {
								url,
								mode: resolvedMode,
								status: response.status,
								contentType,
								truncated: false,
								bytes: 0,
								blocked: true,
								challengeType,
								headlessAttempted: true,
								headlessUsed: false,
								retries,
							},
						};
					}
					// Rendered DOM HTML is far noisier than server-sent HTML, so always strip it here
					// regardless of mode (the plain-fetch path below preserves the original raw-text behavior).
					const stripped = stripHtml(headlessResult.html);
					const searchText = resolvedMode === "search" ? formatSearchText(stripped, resultLimit) : stripped;
					const body = truncateBody(searchText, maxBytes);
					const blocked = headlessResult.blocked;
					const prefix = blocked
						? `web_search ${resolvedMode} still blocked by ${challengeType} after headless fallback\nURL: ${url}\n\n`
						: `web_search ${resolvedMode} ${response.status} ${response.statusText} (headless fallback)\nURL: ${url}\n\n`;
					return {
						content: [{ type: "text", text: prefix + body.text }],
						details: {
							url,
							mode: resolvedMode,
							status: response.status,
							contentType,
							truncated: body.truncated,
							bytes: body.bytes,
							blocked,
							challengeType,
							headlessAttempted: true,
							headlessUsed: !blocked,
							retries,
						},
					};
				}

				return {
					content: [
						{
							type: "text",
							text:
								`web_search ${resolvedMode} blocked by ${challengeType}\nURL: ${url}\n\n` +
								"Enable webSearch.headlessFallback (requires 'npm install playwright && npx playwright install chromium' " +
								"in packages/coding-agent) to bypass this, or use an MCP search tool instead.",
						},
					],
					details: {
						url,
						mode: resolvedMode,
						status: response.status,
						contentType,
						truncated: false,
						bytes: 0,
						blocked: true,
						challengeType,
						headlessAttempted: false,
						retries,
					},
				};
			}

			const body = await readResponseText(response, maxBytes);
			const text = resolvedMode === "search" ? formatSearchText(body.text, resultLimit) : body.text;
			const prefix = `web_search ${resolvedMode} ${response.status} ${response.statusText}\nURL: ${url}\n\n`;
			return {
				content: [{ type: "text", text: prefix + text }],
				details: {
					url,
					mode: resolvedMode,
					status: response.status,
					contentType,
					truncated: body.truncated,
					bytes: body.bytes,
					blocked: false,
					retries,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("web_search")) +
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

export function createWebSearchTool(cwd: string, options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd, options));
}
