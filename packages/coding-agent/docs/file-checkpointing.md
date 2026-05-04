# File Checkpointing

Pi automatically snapshots every file before the agent modifies it for the first time in a session. This lets you undo all agent changes in a single command.

## How it works

1. When the agent calls `write` or `edit` on a file, pi copies the original to a temp directory (`/tmp/.pi/checkpoints/<session-id>/`) before the write happens.
2. If the file did not exist (the agent is creating a new file), its path is recorded instead.
3. Run `/undo` at any point to revert everything back to the pre-session state.

> **Scope**: only `write` and `edit` tool calls are tracked. Changes made through `bash` (e.g. `sed -i`, `git checkout`) are not snapshotted.

## Slash commands

### `/checkpoint`

Shows all files tracked so far in this session:

```
Modified (2):
  ~/project/src/app.ts
  ~/project/src/utils.ts
Created (1):
  ~/project/src/new-feature.ts

Use /undo to revert all these changes.
```

### `/undo`

Restores all tracked files to their original state and deletes any new files created by the agent:

```
Undoing 3 file changes...
Restored (2):
  ~/project/src/app.ts
  ~/project/src/utils.ts
Deleted (1):
  ~/project/src/new-feature.ts
```

If the agent has not modified any files yet, `/undo` reports "Nothing to undo."

## Storage

Snapshots are stored at:

```
/tmp/.pi/checkpoints/<session-id>/
  files/                 ← original file contents (mirroring absolute paths)
  created.json           ← list of files created by the agent
  meta.json              ← { createdAt }
```

Temp files are cleaned up by the OS on reboot. They are not cleaned up automatically during a session, so `/undo` can be called multiple times or after a `/reload`.

## Limitations

- Only `write` and `edit` tool calls are tracked. `bash`-based writes are not.
- Snapshotting is per-session: a new session starts a fresh checkpoint.
- Binary files are not supported — the tool only handles text files.
