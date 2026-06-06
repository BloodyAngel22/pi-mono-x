export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export {
	createFastContextTool,
	createFastContextToolDefinition,
	type FastContextToolDetails,
	type FastContextToolInput,
} from "./fast-context.js";
export {
	createFastFetchTool,
	createFastFetchToolDefinition,
	type FastFetchToolDetails,
	type FastFetchToolInput,
	type FastFetchToolOptions,
} from "./fast-fetch.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createVirtualInteractTool,
	createVirtualInteractToolDefinition,
	type VirtualInteractToolDetails,
	type VirtualInteractToolInput,
	type VirtualInteractToolOptions,
} from "./virtual-interact.js";
export {
	createVirtualScreenshotTool,
	createVirtualScreenshotToolDefinition,
	type VirtualScreenshotToolDetails,
	type VirtualScreenshotToolInput,
	type VirtualScreenshotToolOptions,
} from "./virtual-screenshot.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.js";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.js";
import { createFastContextTool, createFastContextToolDefinition } from "./fast-context.js";
import { createFastFetchTool, createFastFetchToolDefinition, type FastFetchToolOptions } from "./fast-fetch.js";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.js";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.js";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.js";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.js";
import {
	createVirtualInteractTool,
	createVirtualInteractToolDefinition,
	type VirtualInteractToolOptions,
} from "./virtual-interact.js";
import {
	createVirtualScreenshotTool,
	createVirtualScreenshotToolDefinition,
	type VirtualScreenshotToolOptions,
} from "./virtual-screenshot.js";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "fast_context"
	| "fast_fetch"
	| "virtual_screenshot"
	| "virtual_interact";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"fast_context",
	"fast_fetch",
	"virtual_screenshot",
	"virtual_interact",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	fastFetch?: FastFetchToolOptions;
	virtualScreenshot?: VirtualScreenshotToolOptions;
	virtualInteract?: VirtualInteractToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "fast_context":
			return createFastContextToolDefinition(cwd);
		case "fast_fetch":
			return createFastFetchToolDefinition(cwd, options?.fastFetch);
		case "virtual_screenshot":
			return createVirtualScreenshotToolDefinition(cwd, options?.virtualScreenshot);
		case "virtual_interact":
			return createVirtualInteractToolDefinition(cwd, options?.virtualInteract);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "fast_context":
			return createFastContextTool(cwd);
		case "fast_fetch":
			return createFastFetchTool(cwd, options?.fastFetch);
		case "virtual_screenshot":
			return createVirtualScreenshotTool(cwd, options?.virtualScreenshot);
		case "virtual_interact":
			return createVirtualInteractTool(cwd, options?.virtualInteract);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
		createVirtualScreenshotToolDefinition(cwd, options?.virtualScreenshot),
		createVirtualInteractToolDefinition(cwd, options?.virtualInteract),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
		createFastContextToolDefinition(cwd),
		createFastFetchToolDefinition(cwd, options?.fastFetch),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		fast_context: createFastContextToolDefinition(cwd),
		fast_fetch: createFastFetchToolDefinition(cwd, options?.fastFetch),
		virtual_screenshot: createVirtualScreenshotToolDefinition(cwd, options?.virtualScreenshot),
		virtual_interact: createVirtualInteractToolDefinition(cwd, options?.virtualInteract),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
		createVirtualScreenshotTool(cwd, options?.virtualScreenshot),
		createVirtualInteractTool(cwd, options?.virtualInteract),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
		createFastContextTool(cwd),
		createFastFetchTool(cwd, options?.fastFetch),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		fast_context: createFastContextTool(cwd),
		fast_fetch: createFastFetchTool(cwd, options?.fastFetch),
		virtual_screenshot: createVirtualScreenshotTool(cwd, options?.virtualScreenshot),
		virtual_interact: createVirtualInteractTool(cwd, options?.virtualInteract),
	};
}
