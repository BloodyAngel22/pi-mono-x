import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, createExtensionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DEEP_RESEARCH_SKILL_PATH = join(EXTENSION_DIR, "deep-research", "SKILL.md");

type ResearchMode = "quick" | "balanced" | "deep";

interface DeepResearchParams {
	question: string;
	/** quick = minutes, balanced = default bounded research, deep = expensive/exhaustive */
	mode?: ResearchMode;
	depth?: number;
	breadth?: number;
	context?: string;
	focus?: string;
	/** Hard wall-clock budget. The tool stops gracefully at iteration/query boundaries. */
	timeBudgetMinutes?: number;
	/** Number of pages fetched and summarized per search query. 0 = use search result snippets only. */
	sourcesPerQuery?: number;
	/** Search results requested from web_search per query. */
	searchResults?: number;
	/** Global source cap across all iterations. */
	maxSources?: number;
}

interface SearchQuery {
	query: string;
	rationale: string;
}

interface SearchResult {
	url: string;
	title: string;
	summary: string;
	relevance: number;
}

interface ResearchFinding {
	topic: string;
	findings: string[];
	sources: string[];
	confidence: number;
}

interface KnowledgeGap {
	area: string;
	whyNeeded: string;
	suggestedQuery: string;
}

interface ResearchReport {
	question: string;
	executiveSummary: string;
	findings: ResearchFinding[];
	confidence: number;
	gaps: KnowledgeGap[];
	sources: string[];
	iterationCount: number;
	totalQueries: number;
}

interface IterationState {
	question: string;
	context: string;
	focus: string;
	breadth: number;
	maxIterations: number;
	iteration: number;
	findings: ResearchFinding[];
	sources: Set<string>;
	gaps: KnowledgeGap[];
	totalQueries: number;
	confidence: number;
	startedAt: number;
	deadline: number;
	stoppedReason?: string;
}

interface ResearchConfig {
	mode: ResearchMode;
	timeBudgetMinutes: number;
	sourcesPerQuery: number;
	searchResults: number;
	maxSources: number;
}

const QUERY_GENERATION_PROMPT = `You are a research strategist. Generate focused web search queries.

Rules:
- Each query must target a different aspect of the question.
- Prefer specific, source-discovering queries over broad generic queries.
- If gaps are provided, prioritize them.
- If context is provided, avoid re-searching what is already known.
- Output ONLY valid JSON: [{"query":"...","rationale":"..."}]`;

const SUMMARIZATION_PROMPT = `You are a research analyst. Summarize web content for a research task.

Extract:
- Key facts and data points
- Main arguments or findings
- Contradictions or debates
- Relevance to the research question

Keep the summary concise, factual, and under 200 words.`;

const GAP_ANALYSIS_PROMPT = `You are a research director evaluating research coverage.

Identify remaining knowledge gaps, conflicting information, and missing technical details.
Return ONLY valid JSON in this shape:
{"gaps":[{"area":"...","whyNeeded":"...","suggestedQuery":"..."}],"confidence":0.0}

If findings are sufficient, return an empty gaps array and confidence >= 0.8.`;

const REPORT_COMPILATION_PROMPT = `You are a research synthesizer. Compile findings into a structured report.

Return ONLY valid JSON in this shape:
{
  "executiveSummary":"...",
  "findings":[{"topic":"...","findings":["..."],"sources":["..."],"confidence":0.0}],
  "confidence":0.0,
  "gaps":[{"area":"...","whyNeeded":"...","suggestedQuery":"..."}]
}`;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.max(min, Math.min(max, n));
}

function normalizeMode(value: unknown): ResearchMode {
	return value === "quick" || value === "deep" || value === "balanced" ? value : "balanced";
}

function defaultModeFromEnvironment(): ResearchMode {
	return normalizeMode(process.env.PI_DEEP_RESEARCH_MODE);
}

function buildConfig(params: DeepResearchParams): ResearchConfig {
	const mode = params.mode ? normalizeMode(params.mode) : defaultModeFromEnvironment();
	const defaults =
		mode === "quick"
			? { timeBudgetMinutes: 5, sourcesPerQuery: 0, searchResults: 4, maxSources: 8 }
			: mode === "deep"
				? { timeBudgetMinutes: 20, sourcesPerQuery: 2, searchResults: 6, maxSources: 24 }
				: { timeBudgetMinutes: 10, sourcesPerQuery: 1, searchResults: 5, maxSources: 12 };
	return {
		mode,
		timeBudgetMinutes: clampInteger(params.timeBudgetMinutes, defaults.timeBudgetMinutes, 1, 60),
		sourcesPerQuery: clampInteger(params.sourcesPerQuery, defaults.sourcesPerQuery, 0, 5),
		searchResults: clampInteger(params.searchResults, defaults.searchResults, 1, 10),
		maxSources: clampInteger(params.maxSources, defaults.maxSources, 1, 50),
	};
}

function elapsedSeconds(state: IterationState): number {
	return Math.round((Date.now() - state.startedAt) / 1000);
}

function remainingSeconds(state: IterationState): number {
	return Math.max(0, Math.round((state.deadline - Date.now()) / 1000));
}

function isBudgetExceeded(state: IterationState): boolean {
	return Date.now() >= state.deadline;
}

function formatDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function stripJsonFences(text: string): string {
	return text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```$/i, "")
		.trim();
}

function extractJsonCandidate(text: string): string {
	const stripped = stripJsonFences(text);
	if (stripped.startsWith("{") || stripped.startsWith("[")) return stripped;
	const arrayStart = stripped.indexOf("[");
	const objectStart = stripped.indexOf("{");
	const start = arrayStart === -1 ? objectStart : objectStart === -1 ? arrayStart : Math.min(arrayStart, objectStart);
	if (start === -1) return stripped;
	const endChar = stripped[start] === "[" ? "]" : "}";
	const end = stripped.lastIndexOf(endChar);
	return end === -1 ? stripped.slice(start) : stripped.slice(start, end + 1);
}

function parseJson<T>(text: string, fallback: T): T {
	try {
		return JSON.parse(extractJsonCandidate(text)) as T;
	} catch {
		return fallback;
	}
}

async function runLlmText(ctx: ExtensionContext, systemPrompt: string, userPrompt: string): Promise<string> {
	const runtime = createExtensionRuntime();
	const nullLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime }),
		getSkills: () => ({ skills: [] as any[], diagnostics: [] }),
		getPrompts: () => ({ prompts: [] as any[], diagnostics: [] }),
		getCommands: () => ({ commands: [] as any[] }),
		getHooks: () => ({ hooks: [] as any[] }),
		getThemes: () => ({ themes: [] as any[], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		resourceLoader: nullLoader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		tools: [],
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
	});

	await session.prompt(userPrompt);
	const messages = session.state.messages as AgentMessage[];
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return "";
	return (last.content ?? [])
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

async function runLlmJson<T>(ctx: ExtensionContext, systemPrompt: string, userPrompt: string, fallback: T): Promise<T> {
	const text = await runLlmText(ctx, systemPrompt, `${userPrompt}\n\nReturn ONLY valid JSON. No markdown fences.`);
	return parseJson<T>(text, fallback);
}

function findingsSummary(findings: ResearchFinding[], maxChars = 6000): string {
	const text = findings
		.map(
			(f) =>
				`### ${f.topic} (confidence ${Math.round(f.confidence * 100)}%)\n${f.findings.map((x) => `- ${x}`).join("\n")}\nSources: ${f.sources.join(", ")}`,
		)
		.join("\n\n");
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n...` : text;
}

async function generateQueries(ctx: ExtensionContext, state: IterationState): Promise<SearchQuery[]> {
	const gapQueries = state.gaps.map((gap) => ({ query: gap.suggestedQuery, rationale: gap.whyNeeded }));
	if (gapQueries.length >= state.breadth) return gapQueries.slice(0, state.breadth);

	const prompt = `Research question: ${state.question}
${state.focus ? `Focus areas: ${state.focus}` : ""}
${state.context ? `Known context: ${state.context}` : ""}
${state.findings.length ? `Findings so far:\n${findingsSummary(state.findings, 4000)}` : ""}
${state.gaps.length ? `Gaps to fill:\n${state.gaps.map((g) => `- ${g.area}: ${g.suggestedQuery}`).join("\n")}` : ""}

Generate ${state.breadth} web search queries.`;

	const queries = await runLlmJson<SearchQuery[]>(ctx, QUERY_GENERATION_PROMPT, prompt, []);
	return [...gapQueries, ...queries]
		.filter((q) => typeof q.query === "string" && q.query.trim().length > 0)
		.slice(0, state.breadth);
}

function extractUrls(text: string): string[] {
	const urls = text.match(/https?:\/\/[^\s)\]}>,"']+/g) ?? [];
	return [...new Set(urls.map((url) => url.replace(/[.,;:]+$/, "")))];
}

function extractTitle(searchText: string, url: string): string {
	const line = searchText.split("\n").find((candidate) => candidate.includes(url));
	if (!line) return url;
	const before = line.split(url)[0]?.replace(/[|\-–—]+\s*$/, "").trim();
	return before && before.length < 160 ? before : url;
}

async function summarizeSources(
	ctx: ExtensionContext,
	question: string,
	query: string,
	sources: Array<{ url: string; title: string; content: string }>,
): Promise<Array<{ url: string; title: string; summary: string; relevance: number }>> {
	const prompt = `Research question: ${question}
Search query: ${query}

Sources:
${sources
	.map(
		(source, index) =>
			`SOURCE ${index + 1}\nURL: ${source.url}\nTitle: ${source.title}\nContent:\n${source.content.slice(0, 4500)}`,
	)
	.join("\n\n---\n\n")}

Summarize each source for the research question.
Return JSON: [{"url":"...","title":"...","summary":"...","relevance":0.0}]`;
	return runLlmJson<Array<{ url: string; title: string; summary: string; relevance: number }>>(
		ctx,
		SUMMARIZATION_PROMPT,
		prompt,
		[],
	);
}

function estimateRelevance(summary: string, query: string): number {
	const words = query.toLowerCase().split(/\W+/).filter((word) => word.length > 3);
	if (words.length === 0) return 0.5;
	const summaryLower = summary.toLowerCase();
	const matches = words.filter((word) => summaryLower.includes(word)).length;
	return Math.max(0.2, Math.min(1, matches / words.length + 0.25));
}

function buildProgressDetails(
	state: IterationState,
	currentPhase: string,
	config: ResearchConfig,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		currentPhase,
		iteration: state.iteration,
		maxIterations: state.maxIterations,
		confidence: state.confidence,
		sourcesCount: state.sources.size,
		totalQueries: state.totalQueries,
		elapsedSeconds: elapsedSeconds(state),
		remainingSeconds: remainingSeconds(state),
		timeBudgetMinutes: config.timeBudgetMinutes,
		mode: config.mode,
		stoppedReason: state.stoppedReason,
		...extra,
	};
}

async function executeQuery(
	ctx: ExtensionContext,
	question: string,
	query: SearchQuery,
	config: ResearchConfig,
	state: IterationState,
	onUpdate?: any,
): Promise<SearchResult[]> {
	onUpdate?.({
		content: [{ type: "text", text: `    ↳ searching: ${query.query}` }],
		details: buildProgressDetails(state, "search", config, { currentQuery: query.query, currentStep: "search" }),
	});
	const searchText = await ctx.invokeTool("web_search", {
		query: query.query,
		mode: "search",
		maxResults: config.searchResults,
		timeoutMs: 20_000,
	});

	const urls = extractUrls(searchText).filter((url) => !state.sources.has(url)).slice(0, config.sourcesPerQuery);
	if (config.sourcesPerQuery === 0 || urls.length === 0) {
		return [
			{
				url: "search-results",
				title: query.query,
				summary: searchText.slice(0, 1800),
				relevance: estimateRelevance(searchText, query.query),
			},
		];
	}

	onUpdate?.({
		content: [{ type: "text", text: `    ↳ fetching ${urls.length} page(s) for: ${query.query}` }],
		details: buildProgressDetails(state, "fetch", config, {
			currentQuery: query.query,
			currentStep: "fetch",
			currentUrls: urls,
		}),
	});
	const sourcePayloads = await Promise.all(
		urls.map(async (url) => {
			try {
				const pageText = await ctx.invokeTool("web_search", { query: url, mode: "url", timeoutMs: 20_000 });
				return { url, title: extractTitle(searchText, url), content: pageText };
			} catch {
				return null;
			}
		}),
	);
	const sources = sourcePayloads.filter((source): source is { url: string; title: string; content: string } => source !== null);
	if (sources.length === 0) return [];

	onUpdate?.({
		content: [{ type: "text", text: `    ↳ summarizing ${sources.length} page(s) for: ${query.query}` }],
		details: buildProgressDetails(state, "summarize", config, { currentQuery: query.query, currentStep: "summarize" }),
	});
	const summaries = await summarizeSources(ctx, question, query.query, sources);
	return summaries
		.filter((summary) => summary.summary && summary.url)
		.map((summary) => ({
			url: summary.url,
			title: summary.title || summary.url,
			summary: summary.summary,
			relevance:
				typeof summary.relevance === "number"
					? Math.max(0.1, Math.min(1, summary.relevance))
					: estimateRelevance(summary.summary, query.query),
		}));
}

async function analyzeGaps(
	ctx: ExtensionContext,
	question: string,
	findings: ResearchFinding[],
): Promise<{ gaps: KnowledgeGap[]; confidence: number }> {
	const prompt = `Research question: ${question}

Findings so far:
${findingsSummary(findings) || "(no findings yet)"}

Evaluate coverage and suggest remaining search gaps.`;
	const result = await runLlmJson<{ gaps: KnowledgeGap[]; confidence: number }>(ctx, GAP_ANALYSIS_PROMPT, prompt, {
		gaps: [],
		confidence: findings.length > 0 ? 0.6 : 0.1,
	});
	return {
		gaps: Array.isArray(result.gaps) ? result.gaps.filter((gap) => gap.suggestedQuery) : [],
		confidence: typeof result.confidence === "number" ? Math.max(0, Math.min(1, result.confidence)) : 0.5,
	};
}

async function compileReport(ctx: ExtensionContext, state: IterationState): Promise<ResearchReport> {
	const allSources = [...state.sources];
	const prompt = `Research question: ${state.question}
${state.focus ? `Focus areas: ${state.focus}` : ""}

Findings:
${findingsSummary(state.findings, 12000) || "(no findings)"}

Remaining gaps:
${state.gaps.map((gap) => `- ${gap.area}: ${gap.whyNeeded}`).join("\n") || "(none)"}

Compile the final research report.`;

	const report = await runLlmJson<{
		executiveSummary: string;
		findings: ResearchFinding[];
		confidence: number;
		gaps: KnowledgeGap[];
	}>(ctx, REPORT_COMPILATION_PROMPT, prompt, {
		executiveSummary:
			state.findings.length > 0
				? `Research completed with ${state.findings.length} finding groups.`
				: "Research did not find enough source material to produce a confident synthesis.",
		findings: state.findings,
		confidence: state.confidence,
		gaps: state.gaps,
	});

	return {
		question: state.question,
		executiveSummary: report.executiveSummary,
		findings: Array.isArray(report.findings) && report.findings.length > 0 ? report.findings : state.findings,
		confidence: typeof report.confidence === "number" ? Math.max(0, Math.min(1, report.confidence)) : state.confidence,
		gaps: Array.isArray(report.gaps) ? report.gaps : state.gaps,
		sources: allSources,
		iterationCount: state.iteration,
		totalQueries: state.totalQueries,
	};
}

function formatReport(report: ResearchReport): string {
	const lines: string[] = [];
	lines.push("## Deep Research Report");
	lines.push("");
	lines.push(`**Question:** ${report.question}`);
	lines.push(`**Iterations:** ${report.iterationCount}`);
	lines.push(`**Queries:** ${report.totalQueries}`);
	lines.push(`**Sources:** ${report.sources.length}`);
	lines.push(`**Confidence:** ${Math.round(report.confidence * 100)}%`);
	lines.push("");
	lines.push("### Executive Summary");
	lines.push(report.executiveSummary);
	lines.push("");
	lines.push("### Key Findings");
	for (const finding of report.findings) {
		lines.push("");
		lines.push(`#### ${finding.topic}`);
		lines.push(`Confidence: ${Math.round(finding.confidence * 100)}%`);
		for (const item of finding.findings) lines.push(`- ${item}`);
		if (finding.sources.length > 0) lines.push(`Sources: ${finding.sources.join(", ")}`);
	}
	if (report.gaps.length > 0) {
		lines.push("");
		lines.push("### Remaining Gaps");
		for (const gap of report.gaps) lines.push(`- **${gap.area}:** ${gap.whyNeeded}`);
	}
	if (report.sources.length > 0) {
		lines.push("");
		lines.push("### Sources");
		for (const source of report.sources) lines.push(`- ${source}`);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI): void {
	pi.on("resources_discover", () => ({
		skillPaths: [DEEP_RESEARCH_SKILL_PATH],
	}));

	const tool: any = {
		name: "deep_research",
		label: "Deep Research",
		description: [
			"Run a bounded iterative research loop on a topic.",
			"Uses web_search for web search/page fetches, summarizes findings, identifies knowledge gaps,",
			"and loops with refined queries before compiling a structured report.",
			"Defaults are intentionally time-bounded; use mode=deep or larger budgets only when needed.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "The research question or topic to investigate." },
				mode: {
					type: "string",
					enum: ["quick", "balanced", "deep"],
					description: "Research preset. quick≈5m/search snippets; balanced≈10m/1 page per query; deep≈20m/2 pages per query. Default: balanced.",
					default: "balanced",
				},
				depth: { type: "number", description: "Max iterations, 1-5. Defaults: quick=1, balanced=2, deep=3.", default: 2 },
				breadth: { type: "number", description: "Search directions per iteration, 1-5. Defaults: quick=2, balanced=3, deep=4.", default: 3 },
				timeBudgetMinutes: { type: "number", description: "Hard wall-clock budget. Defaults: quick=5, balanced=10, deep=20.", default: 10 },
				sourcesPerQuery: { type: "number", description: "Pages fetched/summarized per query. 0 uses search snippets only. Defaults: quick=0, balanced=1, deep=2.", default: 1 },
				searchResults: { type: "number", description: "Search results requested from web_search per query. Default depends on mode." },
				maxSources: { type: "number", description: "Global source cap across all iterations. Default depends on mode." },
				context: { type: "string", description: "Optional prior context to avoid redundant searching." },
				focus: { type: "string", description: "Optional focus areas, e.g. security, performance, cost." },
			},
			required: ["question"],
		} as any,
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: DeepResearchParams,
			signal: AbortSignal | undefined,
			onUpdate: any,
			ctx: ExtensionContext | undefined,
		) => {
			if (!ctx) throw new Error("deep_research requires an extension context");
			const config = buildConfig(params);
			const defaultDepth = config.mode === "quick" ? 1 : config.mode === "deep" ? 3 : 2;
			const defaultBreadth = config.mode === "quick" ? 2 : config.mode === "deep" ? 4 : 3;
			const depth = clampInteger(params.depth, defaultDepth, 1, 5);
			const breadth = clampInteger(params.breadth, defaultBreadth, 1, 5);
			const question = params.question.trim();
			const startedAt = Date.now();
			const state: IterationState = {
				question,
				context: params.context ?? "",
				focus: params.focus ?? "",
				breadth,
				maxIterations: depth,
				iteration: 0,
				findings: [],
				sources: new Set<string>(),
				gaps: [],
				totalQueries: 0,
				confidence: 0,
				startedAt,
				deadline: startedAt + config.timeBudgetMinutes * 60_000,
			};

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `🔍 Starting deep research: ${question}\nMode: ${config.mode} · budget ${config.timeBudgetMinutes}m · depth ${depth} · breadth ${breadth} · pages/query ${config.sourcesPerQuery}`,
					},
				],
				details: buildProgressDetails(state, "starting", config),
			});

			while (state.iteration < state.maxIterations) {
				if (signal?.aborted) throw new Error("Deep research aborted");
				if (isBudgetExceeded(state)) {
					state.stoppedReason = "time_budget_exceeded";
					break;
				}
				if (state.sources.size >= config.maxSources) {
					state.stoppedReason = "max_sources_reached";
					break;
				}
				state.iteration += 1;
				const iterLabel = `${state.iteration}/${state.maxIterations}`;

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `📡 Iteration ${iterLabel}: generating queries (${formatDuration(elapsedSeconds(state))} elapsed, ${formatDuration(remainingSeconds(state))} left)...`,
						},
					],
					details: buildProgressDetails(state, "query_generation", config),
				});

				const queries = await generateQueries(ctx, state);
				if (queries.length === 0) break;
				state.totalQueries += queries.length;

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `🔎 Iteration ${iterLabel}: searching ${queries.length} queries · ${config.sourcesPerQuery} page(s)/query · ${formatDuration(remainingSeconds(state))} left`,
						},
					],
					details: buildProgressDetails(state, "search", config, {
						queriesFound: queries.length,
						queries: queries.map((query) => query.query),
					}),
				});

				for (const query of queries) {
					if (signal?.aborted) throw new Error("Deep research aborted");
					if (isBudgetExceeded(state)) {
						state.stoppedReason = "time_budget_exceeded";
						break;
					}
					if (state.sources.size >= config.maxSources) {
						state.stoppedReason = "max_sources_reached";
						break;
					}
					const results = await executeQuery(ctx, question, query, config, state, onUpdate);
					if (results.length === 0) continue;
					for (const result of results) {
						if (result.url !== "search-results") state.sources.add(result.url);
					}
					state.findings.push({
						topic: query.query,
						findings: results.map((result) => result.summary),
						sources: results.map((result) => result.url),
						confidence: results.reduce((max, result) => Math.max(max, result.relevance), 0),
					});
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `  ✓ ${query.query} → ${results.length} result(s), sources ${state.sources.size}/${config.maxSources}, ${formatDuration(remainingSeconds(state))} left`,
							},
						],
						details: buildProgressDetails(state, "search", config, { currentQuery: query.query }),
					});
				}

				if (state.stoppedReason === "time_budget_exceeded") break;

				onUpdate?.({
					content: [{ type: "text", text: `🧠 Iteration ${iterLabel}: analyzing gaps (${state.findings.length} finding group(s))...` }],
					details: buildProgressDetails(state, "gap_analysis", config),
				});

				const analysis = await analyzeGaps(ctx, question, state.findings);
				state.gaps = analysis.gaps;
				state.confidence = analysis.confidence;

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `📊 Iteration ${iterLabel}: confidence ${Math.round(state.confidence * 100)}%, gaps ${state.gaps.length}, elapsed ${formatDuration(elapsedSeconds(state))}`,
						},
					],
					details: buildProgressDetails(state, "gap_analysis", config, {
						gaps: state.gaps.map((gap) => gap.area),
					}),
				});

				if (state.confidence >= 0.8 || state.gaps.length === 0) break;
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `📝 Compiling final research report...${state.stoppedReason ? ` stopped: ${state.stoppedReason}` : ""}`,
					},
				],
				details: buildProgressDetails(state, "compiling", config),
			});

			const report = await compileReport(ctx, state);
			return {
				content: [{ type: "text", text: formatReport(report) }],
				details: {
					question: report.question,
					confidence: report.confidence,
					iterationCount: report.iterationCount,
					totalQueries: report.totalQueries,
					sourceCount: report.sources.length,
					findingCount: report.findings.length,
					gapCount: report.gaps.length,
					elapsedSeconds: elapsedSeconds(state),
					stoppedReason: state.stoppedReason,
					mode: config.mode,
				},
			};
		},
	};
	pi.registerTool(tool);
}
