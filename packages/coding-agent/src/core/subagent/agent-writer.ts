import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

/** Directory that holds `.md` custom sub-agent definitions for a given source scope. */
export function agentsDir(agentDir: string, cwd: string, source: "project" | "user"): string {
	return source === "project" ? join(cwd, ".pi", "agents") : join(agentDir, "agents");
}

function slugify(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "agent";
}

/** Full path to a custom sub-agent's `.md` file for a given source scope. */
export function agentFilePath(agentDir: string, cwd: string, name: string, source: "project" | "user"): string {
	return join(agentsDir(agentDir, cwd, source), `${slugify(name)}.md`);
}

export interface AgentFileConfig {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	mcpTools?: string[];
	model?: string;
}

/** Write a custom sub-agent `.md` file (YAML frontmatter + system prompt body). */
export function writeAgentFile(filePath: string, config: AgentFileConfig): void {
	const frontmatter: Record<string, unknown> = { name: config.name, description: config.description };
	if (config.tools?.length) frontmatter.tools = config.tools;
	if (config.mcpTools?.length) frontmatter.mcpTools = config.mcpTools;
	if (config.model) frontmatter.model = config.model;

	const content = `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${config.systemPrompt.trim()}\n`;
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf-8");
}

/** Delete a custom sub-agent `.md` file, if present. */
export function deleteAgentFile(filePath: string): void {
	rmSync(filePath, { force: true });
}
