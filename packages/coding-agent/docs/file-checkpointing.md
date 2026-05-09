# File Checkpointing

Pi automatically snapshots files before the agent modifies them. These snapshots let `/tree` and `/rewind` restore the working tree to the code state associated with a selected session point.

## How it works

1. When the agent calls `write` or `edit`, pi records the file state before that turn modifies it.
2. If the file did not exist, pi records it as created by that turn.
3. At the end of a turn, pi captures the resulting file state for later forward navigation.
4. `/tree` and `/rewind` use those per-turn snapshots to restore code backward or forward to the selected session entry.

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

Use /tree or /rewind to restore code to a previous session state.
```

### `/tree` and `/rewind`

Open the session tree selector. For a selected entry, choose:

```
Restore code only
Restore code + navigate
```

Both actions restore tracked files to the code state for that selected session point. Moving backward restores older code. Selecting a later tree entry restores the later code state again.

## Storage

Snapshots are stored at:

```
~/.pi/agent/checkpoints/<session-id>/
  files/                 ← original file contents (mirroring absolute paths)
  turns/                 ← pre-turn snapshots
  turn-ends/             ← post-turn snapshots
  created.json           ← list of files created by the agent
  turn-changes.json      ← per-turn modified/created file metadata
  meta.json              ← { createdAt }
```

Checkpoint files are session-scoped and persistent, so code restore can be used after `/reload`, switching sessions, or restarting pi. Legacy checkpoints from `/tmp/.pi/checkpoints/<session-id>/` are still loaded if no persistent checkpoint exists.

## Limitations

- Only `write` and `edit` tool calls are tracked. `bash`-based writes are not.
- Snapshotting is per-session: a new session starts a fresh checkpoint.
- Binary files are not supported — the tool only handles text files.
