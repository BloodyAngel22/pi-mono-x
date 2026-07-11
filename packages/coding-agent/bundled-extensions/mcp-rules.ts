import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDANCE = `
## Search & Docs Tool Selection Rules

Follow these rules to choose the right search/docs tool:

### Library & framework documentation
1. **context7** \`resolve-library-id\` + \`query-docs\` — always use FIRST for:
   - API reference, function signatures, configuration options
   - "How do I use X in library Y" questions
   - Version-specific docs, migration guides
   - Any question about a specific package/SDK/framework
   - Use BEFORE writing code that depends on a library
2. Do NOT use web search for library docs — context7 has structured, up-to-date docs with code examples.

### Web search & URL reads
1. Built-in \`web_search\` — the DEFAULT for all web searches and URL fetches (use mode=url for known URLs). It is faster and cheaper than MCP search servers.
2. **searxng** \`searxng_web_search\` / \`web_url_read\` — FALLBACK ONLY when web_search errors, stays blocked by bot protection after its headless fallback, or returns nothing useful. Exception: searxng supports time_range ("day", "month", "year") — reach for it directly when strict recency filtering is critical.
3. **ddg-search** — last resort if both web_search and searxng failed.

### Deep research
- \`deep_research\` or a \`task\` sub-agent — for multi-page/multi-source research where one search is not enough.
- One quick question → web_search, never deep_research.

### Decision tree
\`\`\`
Need docs for a specific library/framework?
  └─ YES → context7
Need current web info / read a URL?
  └─ YES → web_search (fallback: searxng → ddg-search)
Broad multi-source research?
  └─ YES → deep_research or task sub-agent
\`\`\`

### Efficiency rules
- For library questions, call context7 \`resolve-library-id\` first, then \`query-docs\` with a specific query.
- For web search, prefer specific queries over broad ones — fewer results but more relevant.
- Fetch the full page (web_search mode=url) only when the snippet is insufficient.
- Do NOT call both context7 and web search for the same question — pick one based on the rules above.
`.trim();

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event: any): Promise<any> => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + GUIDANCE,
    };
  });
}
