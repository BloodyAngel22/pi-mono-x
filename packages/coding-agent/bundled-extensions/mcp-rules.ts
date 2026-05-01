import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const GUIDANCE = `
## MCP Tool Selection Rules

You have several MCP servers available. Follow these rules to choose the right one:

### Web search
1. **searxng** \`searxng_web_search\` — use by default for all web searches.
   - Latest news, tutorials, blog posts, error messages, Stack Overflow answers
   - When you need current information not in your training data
   - Supports time_range ("day", "month", "year") — use it when recency matters
2. **ddg-search** — fallback only if searxng returns an error or no results.
3. **searxng** \`web_url_read\` — after finding a URL via search, use this to read the full page content as markdown. Prefer this over fetching raw HTML yourself.

### Library & framework documentation
1. **context7** \`resolve-library-id\` + \`query-docs\` — always use for:
   - API reference, function signatures, configuration options
   - "How do I use X in library Y" questions
   - Version-specific docs, migration guides
   - Any question about a specific package/SDK/framework
   - Use BEFORE writing code that depends on a library
2. Do NOT use searxng/ddg for library docs — context7 has structured, up-to-date docs with code examples.

### Decision tree
\`\`\`
Need docs for a specific library/framework?
  └─ YES → context7
Need current web info / search results?
  └─ YES → searxng (fallback: ddg-search)
      └─ Found a promising URL? → web_url_read to get full content
\`\`\`

### Efficiency rules
- For library questions, call context7 \`resolve-library-id\` first, then \`query-docs\` with a specific query.
- For web search, prefer specific queries over broad ones — fewer results but more relevant.
- Read the full page with \`web_url_read\` only when the snippet is insufficient.
- Do NOT call both context7 and searxng for the same question — pick one based on the rules above.
`.trim();

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event: any): Promise<any> => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + GUIDANCE,
    };
  });
}
