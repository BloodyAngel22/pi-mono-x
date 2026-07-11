# Sub-agents

Sub-agents are isolated agent sessions with fresh context windows that execute tasks independently and return only the final result. They save context tokens and enable parallel work.

## How it works

The `task` tool delegates work to a sub-agent. The sub-agent:
1. Starts with a fresh, empty context window
2. Has access to all built-in tools (read, bash, edit, write, grep, find, ls)
3. Has access to MCP tools from the parent session (searxng, context7, serena, ddg-search)
4. Executes the instructions and produces a result
5. Only the final text result is returned to the main context

The intermediate file reads, search results, and tool calls stay in the sub-agent's context and are discarded.

## Use cases

### Codebase exploration
```
task: "Explore the authentication system in this project. Read all relevant files and return a summary of how auth works, including the flow from login to session management."
```

### Web research via MCP
```
task: "Search for the latest Next.js 15 App Router migration guide using context7 and searxng. Return a step-by-step migration checklist."
```

### Code review
```
task: "Review the staged git changes for security vulnerabilities. Run `git diff --staged` and analyze each changed file. Return findings with file:line references."
```

### Parallel tasks
The LLM can call `task` multiple times -- they execute in parallel:
```
task 1: "Find all API endpoints in src/routes/"
task 2: "Analyze the database schema in src/models/"
task 3: "Review test coverage in test/"
```

## Custom agents

Create specialized sub-agents by adding `.md` files to:
- `<project>/.pi/agents/` -- project-level (shared with team)
- `~/.pi/agent/agents/` -- user-level (cross-project)

### Format

```markdown
---
name: security-reviewer
description: Reviews code for security vulnerabilities. Use before commits touching auth or payments.
tools: [read, grep, find, ls, bash]
mcpTools: [searxng_*, context7_*]
model: sonnet
---
You are a security-focused code reviewer. Analyze code for:
- SQL injection, XSS, command injection
- Authentication and authorization gaps
- Sensitive data exposure
- Insecure cryptography

Return prioritized findings with file:line references.
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Agent name (defaults to filename without `.md`) |
| `description` | No | Description shown in `/agents` and system prompt |
| `tools` | No | Built-in tools to enable (defaults to all) |
| `mcpTools` | No | MCP tool glob patterns (e.g. `["context7_*"]`) |
| `model` | No | Override model (defaults to parent's model) |

### Using custom agents

The LLM automatically sees available agents in the system prompt and can invoke them:
```
task(agent: "security-reviewer", instructions: "Review the changes in src/auth/")
```

List available agents with `/agents`. Agents can also be listed/created/edited/deleted programmatically via the `list_agents` / `get_agent` / `save_agent` / `delete_agent` RPC commands (used by GUI clients such as pi-pine's Agents panel) -- edits immediately update the in-memory agent list used by `task(agent: "...")`, no session restart needed.

## Commands

- `/tasks` -- show running and recent sub-agent tasks with status, duration, and token savings
- `/agents` -- list available custom agents

## Task statuses

A task's `status` transitions through: `queued` (waiting for a concurrency slot) -> `running` -> `done` / `error` / `background`. Tasks are visible (including while `queued`) as soon as they're created, not just once they start running.

## Managing running tasks

- `cancel_task(taskId)` -- cancel a running or queued task. The `taskId` is returned in the `task` tool's result `details.taskId`.
- `background_task(taskId)` -- let a running task keep working without blocking on its result.

These are also exposed as `cancel_task` / `background_task` RPC commands for GUI clients.

## Concurrency

Up to 3 sub-agents run in parallel by default. Additional tasks are queued (visible with `status: "queued"`) until a slot opens. The limit and the default per-task timeout (5 minutes) are configurable at runtime via the `set_subagent_concurrency` / `set_subagent_timeout` RPC commands (1-10 concurrent tasks, 30s-30min timeout).

## Tool-call transcript

Each task's result carries a structured `toolCalls` list (in addition to the older `activities` string summary) with one entry per tool call the sub-agent made: `{ toolCallId, toolName, args, status, output, startedAt, completedAt }`. This lets clients render the sub-agent's own tool calls live, not just a short trailing summary. The list is capped (newest completed entries evicted first; still-running entries are never evicted).

Recursive delegation is intentionally unsupported: a sub-agent's own tool set never includes `task`, so sub-agents cannot spawn further sub-agents.

## Token savings

Sub-agents track token usage. When a sub-agent uses 50k tokens internally but returns a 2k token summary, the main context saves ~48k tokens. Token savings are displayed in `/tasks`.
