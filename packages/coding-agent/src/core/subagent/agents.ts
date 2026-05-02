import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import type { SubagentConfig } from "./types.js";

interface AgentFrontmatter extends Record<string, unknown> {
	name?: string;
	description?: string;
	tools?: string[];
	mcpTools?: string[];
	model?: string;
}

/**
 * Load custom agent definitions from `.pi/agents/` directories.
 *
 * Searches two locations:
 * - `<cwd>/.pi/agents/` (project-level, shared with team)
 * - `<agentDir>/agents/` (user-level, cross-project)
 *
 * Each `.md` file defines a specialized sub-agent with YAML frontmatter.
 */
export function loadAgents(cwd: string, agentDir: string): SubagentConfig[] {
	const agents: SubagentConfig[] = [];
	const seenNames = new Set<string>();

	const projectAgentsDir = join(cwd, ".pi", "agents");
	const userAgentsDir = join(agentDir, "agents");

	loadFromDir(projectAgentsDir, "project", agents, seenNames);
	loadFromDir(userAgentsDir, "user", agents, seenNames);

	return agents;
}

function loadFromDir(dir: string, source: "project" | "user", agents: SubagentConfig[], seenNames: Set<string>): void {
	if (!existsSync(dir)) return;

	let entries: string[];
	try {
		entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return;
	}

	for (const filename of entries) {
		const filePath = join(dir, filename);
		try {
			const content = readFileSync(filePath, "utf-8");
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

			const name = frontmatter.name ?? filename.replace(/\.md$/, "");
			if (seenNames.has(name)) continue;
			seenNames.add(name);

			agents.push({
				name,
				description: frontmatter.description ?? "",
				systemPrompt: body.trim(),
				tools: frontmatter.tools,
				mcpTools: frontmatter.mcpTools,
				model: frontmatter.model,
				sourcePath: filePath,
				source,
			});
		} catch {
			// skip malformed agent files
		}
	}
}
