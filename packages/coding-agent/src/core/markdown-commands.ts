import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, resolve, sep } from "path";
import { CONFIG_DIR_NAME } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { parseCommandArgs, substituteArgs } from "./prompt-templates.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

/**
 * A slash command defined by a markdown file with optional frontmatter overrides.
 *
 * File locations:
 *   ~/.pi/agent/commands/   (global)
 *   .pi/commands/           (project-level, merged with global)
 *
 * Frontmatter fields:
 *   description:    Short description shown in the command list.
 *   argument-hint:  Hint shown after the command name (e.g. "[area]").
 *   allowed-tools:  Comma-separated list of tool names to restrict during this command.
 *   model:          Model id to use for this command (e.g. "claude-opus-4").
 */
export interface MarkdownCommand {
	name: string;
	description: string;
	argumentHint?: string;
	/** Tool names to temporarily activate; undefined means "keep current tools". */
	allowedTools?: string[];
	/** Model id to temporarily switch to; undefined means "keep current model". */
	model?: string;
	content: string;
	sourceInfo: SourceInfo;
	filePath: string;
}

function loadCommandFromFile(filePath: string, sourceInfo: SourceInfo): MarkdownCommand | null {
	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent);

		const name = basename(filePath).replace(/\.md$/, "");

		let description = frontmatter.description ?? "";
		if (!description) {
			const firstLine = body.split("\n").find((line) => line.trim());
			if (firstLine) {
				description = firstLine.slice(0, 60);
				if (firstLine.length > 60) description += "...";
			}
		}

		const rawTools = frontmatter["allowed-tools"];
		const allowedTools = rawTools
			? rawTools
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: undefined;

		const model = frontmatter.model?.trim() || undefined;

		return {
			name,
			description,
			...(frontmatter["argument-hint"] && { argumentHint: frontmatter["argument-hint"] }),
			...(allowedTools && { allowedTools }),
			...(model && { model }),
			content: body,
			sourceInfo,
			filePath,
		};
	} catch {
		return null;
	}
}

function loadCommandsFromDir(dir: string, getSourceInfo: (filePath: string) => SourceInfo): MarkdownCommand[] {
	const commands: MarkdownCommand[] = [];

	if (!existsSync(dir)) {
		return commands;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			if (isFile && entry.name.endsWith(".md")) {
				const cmd = loadCommandFromFile(fullPath, getSourceInfo(fullPath));
				if (cmd) {
					commands.push(cmd);
				}
			}
		}
	} catch {
		return commands;
	}

	return commands;
}

export interface LoadMarkdownCommandsOptions {
	cwd: string;
	agentDir: string;
}

/**
 * Load markdown commands from:
 *   1. Global:  agentDir/commands/
 *   2. Project: cwd/{CONFIG_DIR_NAME}/commands/  (project overrides global on name conflict)
 */
export function loadMarkdownCommands(options: LoadMarkdownCommandsOptions): MarkdownCommand[] {
	const globalCommandsDir = join(options.agentDir, "commands");
	const projectCommandsDir = resolve(options.cwd, CONFIG_DIR_NAME, "commands");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) return true;
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSourceInfo = (resolvedPath: string): SourceInfo => {
		if (isUnderPath(resolvedPath, globalCommandsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "user",
				baseDir: globalCommandsDir,
			});
		}
		if (isUnderPath(resolvedPath, projectCommandsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "project",
				baseDir: projectCommandsDir,
			});
		}
		return createSyntheticSourceInfo(resolvedPath, { source: "local" });
	};

	const globalCommands = loadCommandsFromDir(globalCommandsDir, getSourceInfo);
	const projectCommands = loadCommandsFromDir(projectCommandsDir, getSourceInfo);

	// Project commands override global ones with the same name
	const merged = new Map<string, MarkdownCommand>();
	for (const cmd of globalCommands) {
		merged.set(cmd.name, cmd);
	}
	for (const cmd of projectCommands) {
		merged.set(cmd.name, cmd);
	}

	return Array.from(merged.values());
}

/**
 * If `text` is a markdown command invocation, return the expanded prompt and matched command.
 * Returns null if no command matches.
 */
export function matchMarkdownCommand(
	text: string,
	commands: MarkdownCommand[],
): { command: MarkdownCommand; expandedText: string } | null {
	if (!text.startsWith("/")) return null;

	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const command = commands.find((c) => c.name === commandName);
	if (!command) return null;

	const args = parseCommandArgs(argsString);
	const expandedText = substituteArgs(command.content, args);

	return { command, expandedText };
}
