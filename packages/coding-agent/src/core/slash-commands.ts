import { APP_NAME } from "../config.js";
import type { SourceInfo } from "./source-info.js";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "rewind", description: "Navigate session tree with code restore options" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
	{ name: "cd", description: "Change working directory. Example: /cd ~/projects/foo" },
	{ name: "pwd", description: "Print current working directory" },
	{ name: "ls", description: "List directory contents. Example: /ls  or  /ls ~/projects" },
	{ name: "permissions", description: "View and manage agent permission rules (allow/ask/deny)" },
	{ name: "yolo", description: "Toggle session-only YOLO permissions mode" },
	{ name: "vim", description: "Toggle Vim input mode" },
	{ name: "btw", description: "Ask an out-of-band question without adding it to session history" },
	{ name: "search", description: "Search prompt history" },
	{
		name: "plan",
		description: "Enter planning mode (agent writes a plan, no code execution). Example: /plan refactor auth",
	},
	{ name: "execute", description: "Exit planning mode and execute the current plan" },
	{ name: "checkpoint", description: "Show files modified/created by the agent in this session" },
];
