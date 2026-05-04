# Shell Hooks

Shell hooks let you run executable scripts in response to agent lifecycle events — without writing TypeScript extensions.

## Locations

Pi discovers hooks from:

- Global: `~/.pi/agent/hooks/`
- Project: `.pi/hooks/`

Both directories are scanned. When the same event has hooks in both locations, global hooks run first.

## Naming

Name the script after the event, with or without the `.sh` extension:

```
agent_end.sh       # or just: agent_end
turn_end.sh
tool_execution_end
```

Scripts must be executable:

```bash
chmod +x ~/.pi/agent/hooks/agent_end.sh
```

## Supported Events

| Event | When it fires |
|-------|---------------|
| `agent_start` | Agent begins processing a prompt |
| `agent_end` | Agent finishes all work for a prompt |
| `turn_start` | A new turn begins (one LLM request + tool calls) |
| `turn_end` | A turn completes |
| `tool_execution_start` | Before a tool runs |
| `tool_execution_end` | After a tool runs |

## Input

Each script receives two input channels:

**stdin** — JSON object with event-specific fields:

| Event | Fields |
|-------|--------|
| `agent_start` | `{ type, cwd }` |
| `agent_end` | `{ type, cwd, messageCount }` |
| `turn_start` | `{ type, turnIndex }` |
| `turn_end` | `{ type, turnIndex }` |
| `tool_execution_start` | `{ type, tool, input }` |
| `tool_execution_end` | `{ type, tool, isError }` |

**Environment variables:**

| Variable | Value |
|----------|-------|
| `PI_EVENT` | Event name (e.g. `agent_end`) |
| `PI_CWD` | Current working directory |
| `PI_SESSION_ID` | Current session id |

## Behavior

- Hooks run sequentially in discovery order (global first, then project).
- Each hook has a **30-second timeout**. Slow hooks are killed.
- Errors and non-zero exit codes are silently ignored.
- Hooks run **fire-and-forget** — they do not block the agent.

## Examples

**Auto-commit after agent finishes** (`~/.pi/agent/hooks/agent_end.sh`):
```bash
#!/usr/bin/env bash
set -e
cd "$PI_CWD"
git add -A
git commit -m "checkpoint [pi]" --allow-empty
```

**Log every tool call** (`.pi/hooks/tool_execution_end.sh`):
```bash
#!/usr/bin/env bash
# Append tool name and timestamp to a log file
EVENT=$(cat)
echo "$(date -Iseconds) $PI_EVENT $(echo "$EVENT" | jq -r '.tool')" >> .pi/tool-log.txt
```

**Send a desktop notification when done** (`~/.pi/agent/hooks/agent_end.sh`):
```bash
#!/usr/bin/env bash
EVENT=$(cat)
MSG_COUNT=$(echo "$EVENT" | jq -r '.messageCount')
notify-send "Pi finished" "$MSG_COUNT messages in $PI_CWD"
```

**Block writes during specific tool calls** (`.pi/hooks/tool_execution_start.sh`):
```bash
#!/usr/bin/env bash
EVENT=$(cat)
TOOL=$(echo "$EVENT" | jq -r '.tool')
if [ "$TOOL" = "write" ] || [ "$TOOL" = "edit" ]; then
    # Custom logic — exit 0 to proceed (hooks cannot block tool execution)
    echo "Write tool called at $(date)" >> .pi/write-log.txt
fi
```

> Hooks cannot block tool execution or modify agent behavior. Use [Extensions](extensions.md) for that.
