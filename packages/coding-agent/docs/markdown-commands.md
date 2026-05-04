# Markdown Commands

Markdown commands are slash commands defined as Markdown files. They let you create reusable, parameterized prompts with optional tool and model overrides — without writing TypeScript extensions.

## Locations

Pi loads markdown commands from:

- Global: `~/.pi/agent/commands/*.md`
- Project: `.pi/commands/*.md` (project commands override global ones with the same name)

Subdirectories are not scanned.

## Format

```markdown
---
description: Check the codebase for security issues
argument-hint: [area]
allowed-tools: read,grep,find,ls
model: claude-opus-4
---

Review the code for security vulnerabilities. Focus on: $ARGUMENTS

Check for:
- SQL injection and input validation
- Hardcoded secrets and credentials
- Unsafe deserialization
- Dependency vulnerabilities
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | No | Short description shown in autocomplete. Defaults to the first non-empty line of the body (truncated to 60 chars). |
| `argument-hint` | No | Usage hint shown after the command name in autocomplete (e.g. `[area]` or `<file>`). |
| `allowed-tools` | No | Comma-separated list of tool names to activate for this command. Temporarily replaces the current active toolset; original tools are restored after the turn. |
| `model` | No | Model id to use for this command (e.g. `claude-opus-4`). Temporarily switches the model; the original model is restored after the turn. |

## Invocation

Type `/name [args]` in the editor. Autocomplete shows available commands with their descriptions.

```
/security                          # no arguments
/security authentication           # one argument
/security "authentication" "auth"  # multiple arguments
```

## Argument Substitution

The body supports the same substitutions as [Prompt Templates](prompt-templates.md):

| Placeholder | Value |
|-------------|-------|
| `$1`, `$2`, ... | Positional arguments |
| `$@` or `$ARGUMENTS` | All arguments joined with spaces |
| `${@:N}` | Arguments from position N (1-indexed) |
| `${@:N:L}` | L arguments starting at position N |

## Tool and Model Overrides

When `allowed-tools` is set, pi temporarily activates exactly those tools for the duration of the command's turn, then restores the previous toolset.

When `model` is set, pi temporarily switches to that model for the command's turn, then restores the original model. If the model id is not found in the registry, the override is silently skipped.

These overrides let you create focused commands that only use read-only tools (for safe code review) or a more capable model (for complex tasks) without changing your global settings.

## Example Commands

**Read-only code review** (`.pi/commands/review.md`):
```markdown
---
description: Review code for bugs and code quality
allowed-tools: read,grep,find,ls
---
Review $ARGUMENTS for bugs, edge cases, and code quality issues.
```

**Deep analysis with a powerful model** (`~/.pi/agent/commands/deep.md`):
```markdown
---
description: Deep analysis using a capable model
model: claude-opus-4
---
Perform a thorough analysis of: $ARGUMENTS
```

**Focused security audit** (`.pi/commands/audit.md`):
```markdown
---
description: Security audit
argument-hint: [path]
allowed-tools: read,grep,find,ls
---
Audit $ARGUMENTS for security vulnerabilities. Report findings with file:line references.
```
