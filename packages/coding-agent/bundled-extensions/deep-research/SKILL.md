---
name: deep-research
description: Use the deep_research tool for iterative web research, architecture comparisons, unfamiliar technologies, current best practices, and evidence-backed recommendations.
---

# Deep Research Skill

Use the `deep_research` tool when the task requires more than a quick answer and would benefit from iterative web research plus synthesis.

## When to use

- The user asks to research, investigate, compare, evaluate, or survey a topic.
- The answer depends on current documentation, ecosystem state, releases, or external evidence.
- The user needs architecture trade-offs, best practices, alternatives, or implementation strategy.
- The topic is unfamiliar, broad, controversial, or has many possible approaches.

## When not to use

- The answer is already available in the local codebase context.
- A single targeted `web_search` lookup is enough.
- The user explicitly asks not to use internet/web research.
- The task is a simple edit or mechanical refactor.

## Recommended invocation

For normal research, prefer the bounded default:

```json
{
  "question": "What is the best approach for rate limiting NestJS APIs with Redis in production?",
  "mode": "balanced",
  "context": "We use NestJS and deploy multiple app replicas.",
  "focus": "production reliability, Redis, distributed limits, security"
}
```

Use presets and budgets deliberately:

- `mode: "quick"` — about 5 minutes; uses search snippets only (`sourcesPerQuery: 0`), good for orientation.
- `mode: "balanced"` — default; about 10 minutes, usually `depth: 2`, `breadth: 3`, one page per query.
- `mode: "deep"` — expensive; about 20 minutes, more pages and iterations. Ask before using for routine work.

Prefer starting with `balanced`. Only use `depth: 4-5`, `sourcesPerQuery > 2`, or `timeBudgetMinutes > 20` when the user explicitly wants exhaustive research.

## How to use the report

After the tool returns:

1. Summarize the recommendation in your own words.
2. Connect findings to the user's codebase or constraints.
3. Call out uncertainties and remaining gaps.
4. If implementing code, translate the research into concrete steps before editing.
