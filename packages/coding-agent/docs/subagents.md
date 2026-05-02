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

List available agents with `/agents`.

## Commands

- `/tasks` -- show running and recent sub-agent tasks with status, duration, and token savings
- `/agents` -- list available custom agents

## Concurrency

Up to 3 sub-agents can run in parallel. Additional tasks wait until a slot opens.

## Token savings

Sub-agents track token usage. When a sub-agent uses 50k tokens internally but returns a 2k token summary, the main context saves ~48k tokens. Token savings are displayed in `/tasks`.
