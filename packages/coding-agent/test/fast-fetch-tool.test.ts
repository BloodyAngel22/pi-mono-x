import { describe, expect, it, vi } from "vitest";
import { createFastFetchToolDefinition } from "../src/core/tools/fast-fetch.js";
import { createAllToolDefinitions } from "../src/core/tools/index.js";

function createResponse(body: string, init?: { status?: number; statusText?: string; contentType?: string }): Response {
	return new Response(body, {
		status: init?.status ?? 200,
		statusText: init?.statusText ?? "OK",
		headers: init?.contentType ? { "content-type": init.contentType } : undefined,
	});
}

describe("fast_fetch tool", () => {
	it("is registered with all built-in tool definitions", () => {
		const defs = createAllToolDefinitions(process.cwd());
		expect(defs.fast_fetch.name).toBe("fast_fetch");
	});

	it("searches with configured endpoint, query parameter, and headers", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => createResponse("result body"));
		const tool = createFastFetchToolDefinition(process.cwd(), {
			settings: {
				searchUrl: "https://search.example.test/find",
				queryParam: "query",
				headers: { Accept: "text/plain" },
			},
			fetch: fetchMock,
		});

		const result = await tool.execute("call", { query: "pi agent" }, undefined, undefined, undefined as never);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(String(url)).toBe("https://search.example.test/find?query=pi+agent");
		expect(init?.headers).toEqual({ Accept: "text/plain" });
		const firstContent = result.content[0];
		expect(firstContent?.type).toBe("text");
		if (firstContent?.type !== "text") throw new Error("Expected text content");
		expect(firstContent.text).toContain("result body");
		expect(result.details?.mode).toBe("search");
	});

	it("fetches direct URLs without adding search parameters", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => createResponse("page body"));
		const tool = createFastFetchToolDefinition(process.cwd(), { fetch: fetchMock });

		const result = await tool.execute(
			"call",
			{ query: "https://example.test/page" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.test/page");
		expect(result.details?.mode).toBe("url");
		const firstContent = result.content[0];
		expect(firstContent?.type).toBe("text");
		if (firstContent?.type !== "text") throw new Error("Expected text content");
		expect(firstContent.text).toContain("page body");
	});
});
