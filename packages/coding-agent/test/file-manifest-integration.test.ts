/**
 * Integration tests for the transient file manifest wired through AgentSession/Agent.
 *
 * Verifies that buildFileManifestMessage (test/manifest.test.ts covers it in isolation)
 * is actually injected into the transient LLM-bound context via transformContext,
 * recomputed fresh (never accumulating) on every turn, and never persisted.
 */

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	buildFileManifestMessage,
	pruneStaleReadOnlyToolResults,
	pruneStaleToolResults,
} from "../src/core/compaction/index.js";
import { createHarness, type Harness } from "./test-harness.js";

function createFakeReadTool(): AgentTool {
	return {
		name: "read",
		label: "Read",
		description: "Read a file",
		parameters: Type.Object({ path: Type.String() }),
		execute: async (_id, params) => {
			const { path } = params as { path: string };
			return { content: [{ type: "text", text: `contents of ${path}` }], details: {} };
		},
	};
}

function createFakeWriteTool(): AgentTool {
	return {
		name: "write",
		label: "Write",
		description: "Write a file",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		execute: async () => {
			return { content: [{ type: "text", text: "written successfully" }], details: {} };
		},
	};
}

/** Mirrors the transformContext wiring in core/sdk.ts, for a harness-backed session. */
function makeTransformContext(sessionRef: { current?: AgentSession }) {
	return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
		let working = messages;
		if (sessionRef.current?.contextPruningEnabled) {
			const pruned = pruneStaleToolResults(working);
			if (pruned.prunedToolCallIds.length > 0) {
				working = pruned.messages;
			}
			const prunedReadOnly = pruneStaleReadOnlyToolResults(working);
			if (prunedReadOnly.prunedToolCallIds.length > 0) {
				working = prunedReadOnly.messages;
			}
		}
		if (sessionRef.current?.fileManifestEnabled) {
			const manifestMessage = buildFileManifestMessage(working, new Date().toISOString());
			if (manifestMessage) {
				working = [...working, manifestMessage];
			}
		}
		return working;
	};
}

/** Find messages in a captured LLM Context that look like our injected file manifest note. */
function findManifestMessages(messages: Message[]): Message[] {
	return messages.filter((m) => {
		if (m.role !== "user" || typeof m.content === "string") return false;
		return m.content.some((c) => c.type === "text" && c.text.startsWith("Modified this session:"));
	});
}

describe("file manifest integration", () => {
	let harness: Harness;

	afterEach(() => {
		harness?.cleanup();
	});

	it("injects a manifest reflecting a modified file whose original read was pruned", async () => {
		const readTool = createFakeReadTool();
		const writeTool = createFakeWriteTool();
		const sessionRef: { current?: AgentSession } = {};
		harness = createHarness({
			responses: [
				{ toolCalls: [{ id: "call-1", name: "read", args: { path: "foo.ts" } }] },
				{ toolCalls: [{ id: "call-2", name: "write", args: { path: "foo.ts", content: "new" } }] },
				"done",
				"done again",
			],
			tools: [readTool, writeTool],
			baseToolsOverride: { read: readTool, write: writeTool },
			transformContext: makeTransformContext(sessionRef),
		});
		sessionRef.current = harness.session;

		await harness.session.prompt("read foo.ts then write it");

		expect(harness.faux.callCount).toBe(3);
		const thirdCallContext = harness.faux.contexts[2];
		const manifestMessages = findManifestMessages(thirdCallContext.messages);
		expect(manifestMessages).toHaveLength(1);

		const text = (manifestMessages[0].content as { type: "text"; text: string }[])[0].text;
		expect(text).toContain("Modified this session: foo.ts");
		expect(text).toContain("content pruned from context");
		expect(text).toContain("foo.ts");

		// A further turn must still show exactly one manifest message, not two.
		await harness.session.prompt("continue");
		expect(harness.faux.callCount).toBe(4);
		const fourthCallContext = harness.faux.contexts[3];
		expect(findManifestMessages(fourthCallContext.messages)).toHaveLength(1);

		// Never persisted to agent state or the session log.
		expect(harness.session.messages.some((m) => m.role === "custom")).toBe(false);
		const entries = harness.sessionManager.getEntries();
		expect(entries.some((e) => e.type === "message" && e.message.role === "custom")).toBe(false);
	});

	it("does not inject a manifest when fileManifestEnabled is false", async () => {
		const readTool = createFakeReadTool();
		const writeTool = createFakeWriteTool();
		const sessionRef: { current?: AgentSession } = {};
		harness = createHarness({
			responses: [
				{ toolCalls: [{ id: "call-1", name: "read", args: { path: "foo.ts" } }] },
				{ toolCalls: [{ id: "call-2", name: "write", args: { path: "foo.ts", content: "new" } }] },
				"done",
			],
			tools: [readTool, writeTool],
			baseToolsOverride: { read: readTool, write: writeTool },
			transformContext: makeTransformContext(sessionRef),
		});
		sessionRef.current = harness.session;
		harness.session.setFileManifestEnabled(false);

		await harness.session.prompt("read foo.ts then write it");

		for (const context of harness.faux.contexts) {
			expect(findManifestMessages(context.messages)).toHaveLength(0);
		}
	});

	it("does not inject an empty manifest when no files were touched", async () => {
		const sessionRef: { current?: AgentSession } = {};
		harness = createHarness({
			responses: ["hello, nothing to do here"],
			transformContext: makeTransformContext(sessionRef),
		});
		sessionRef.current = harness.session;

		await harness.session.prompt("just say hi");

		expect(harness.faux.callCount).toBe(1);
		expect(findManifestMessages(harness.faux.contexts[0].messages)).toHaveLength(0);
	});
});
