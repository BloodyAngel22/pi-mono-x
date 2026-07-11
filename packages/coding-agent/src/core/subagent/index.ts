export { agentFilePath, agentsDir, deleteAgentFile, writeAgentFile } from "./agent-writer.js";
export { loadAgents } from "./agents.js";
export type { SubagentSessionFactory } from "./manager.js";
export { getGlobalSubagentManager, SubagentManager, setGlobalSubagentManager } from "./manager.js";
export type {
	SubagentConfig,
	SubagentEvent,
	SubagentEventListener,
	SubagentResult,
	SubagentRunOptions,
	SubagentTask,
	SubagentTaskStatus,
	SubagentToolCallEntry,
} from "./types.js";
