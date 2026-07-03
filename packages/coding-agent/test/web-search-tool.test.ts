import { describe, expect, it, vi } from "vitest";
import { createAllToolDefinitions } from "../src/core/tools/index.js";
import { createWebSearchToolDefinition } from "../src/core/tools/web-search.js";

function createResponse(
	body: string,
	init?: { status?: number; statusText?: string; contentType?: string; headers?: Record<string, string> },
): Response {
	return new Response(body, {
		status: init?.status ?? 200,
		statusText: init?.statusText ?? "OK",
		headers: { ...(init?.contentType ? { "content-type": init.contentType } : {}), ...(init?.headers ?? {}) },
	});
}

describe("web_search tool", () => {
	it("is registered with all built-in tool definitions", () => {
		const defs = createAllToolDefinitions(process.cwd());
		expect(defs.web_search.name).toBe("web_search");
	});

	it("searches with configured endpoint, query parameter, and default browser-like headers", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => createResponse("result body"));
		const tool = createWebSearchToolDefinition(process.cwd(), {
			settings: {
				searchUrl: "https://search.example.test/find",
				queryParam: "query",
			},
			fetch: fetchMock,
		});

		const result = await tool.execute("call", { query: "pi agent" }, undefined, undefined, undefined as never);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(String(url)).toBe("https://search.example.test/find?query=pi+agent");
		const headers = init?.headers as Record<string, string>;
		expect(headers["User-Agent"]).toContain("Chrome");
		expect(headers.Accept).toContain("text/html");
		const firstContent = result.content[0];
		expect(firstContent?.type).toBe("text");
		if (firstContent?.type !== "text") throw new Error("Expected text content");
		expect(firstContent.text).toContain("result body");
		expect(result.details?.mode).toBe("search");
	});

	it("merges user-configured headers on top of the defaults, letting user values win", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => createResponse("result body"));
		const tool = createWebSearchToolDefinition(process.cwd(), {
			settings: { headers: { Accept: "text/plain", "X-Custom": "1" } },
			fetch: fetchMock,
		});

		await tool.execute("call", { query: "https://example.test/page" }, undefined, undefined, undefined as never);

		const [, init] = fetchMock.mock.calls[0]!;
		const headers = init?.headers as Record<string, string>;
		expect(headers.Accept).toBe("text/plain");
		expect(headers["X-Custom"]).toBe("1");
		expect(headers["User-Agent"]).toContain("Chrome");
	});

	it("fetches direct URLs without adding search parameters", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => createResponse("page body"));
		const tool = createWebSearchToolDefinition(process.cwd(), { fetch: fetchMock });

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

	describe("retry behavior", () => {
		it("retries on a transient 503 and eventually succeeds", async () => {
			let call = 0;
			const fetchMock = vi.fn<typeof fetch>(async () => {
				call++;
				if (call < 3)
					return createResponse("temporarily unavailable", { status: 503, statusText: "Service Unavailable" });
				return createResponse("ok body");
			});
			const tool = createWebSearchToolDefinition(process.cwd(), {
				settings: { maxRetries: 2 },
				fetch: fetchMock,
			});

			const result = await tool.execute(
				"call",
				{ query: "https://example.test/flaky" },
				undefined,
				undefined,
				undefined as never,
			);

			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(result.details?.retries).toBe(2);
			const firstContent = result.content[0];
			if (firstContent?.type !== "text") throw new Error("Expected text content");
			expect(firstContent.text).toContain("ok body");
		}, 10_000);

		it("surfaces a clear error after exhausting retries on a persistent network failure", async () => {
			const fetchMock = vi.fn<typeof fetch>(async () => {
				throw new Error("connect ECONNREFUSED");
			});
			const tool = createWebSearchToolDefinition(process.cwd(), {
				settings: { maxRetries: 1 },
				fetch: fetchMock,
			});

			await expect(
				tool.execute("call", { query: "https://example.test/down" }, undefined, undefined, undefined as never),
			).rejects.toThrow("ECONNREFUSED");
			expect(fetchMock).toHaveBeenCalledTimes(2);
		}, 10_000);
	});

	describe("bot-challenge detection", () => {
		it("reports a clear blocked message instead of raw challenge HTML on a Cloudflare-style 403", async () => {
			const fetchMock = vi.fn<typeof fetch>(async () =>
				createResponse("<html><body>Just a moment... Checking your browser before accessing</body></html>", {
					status: 403,
					statusText: "Forbidden",
				}),
			);
			const tool = createWebSearchToolDefinition(process.cwd(), { fetch: fetchMock });

			const result = await tool.execute(
				"call",
				{ query: "https://example.test/protected" },
				undefined,
				undefined,
				undefined as never,
			);

			expect(result.details?.blocked).toBe(true);
			expect(result.details?.challengeType).toBe("cloudflare");
			const firstContent = result.content[0];
			if (firstContent?.type !== "text") throw new Error("Expected text content");
			expect(firstContent.text).toContain("blocked by cloudflare");
			expect(firstContent.text).not.toContain("Checking your browser");
		});

		it("does not attempt to load playwright when headlessFallback is disabled (default)", async () => {
			const fetchMock = vi.fn<typeof fetch>(async () =>
				createResponse("Just a moment... please wait", { status: 403 }),
			);
			const tool = createWebSearchToolDefinition(process.cwd(), { fetch: fetchMock });

			const result = await tool.execute(
				"call",
				{ query: "https://example.test/protected" },
				undefined,
				undefined,
				undefined as never,
			);

			expect(result.details?.blocked).toBe(true);
			expect(result.details?.headlessAttempted).toBeFalsy();
			const firstContent = result.content[0];
			if (firstContent?.type !== "text") throw new Error("Expected text content");
			expect(firstContent.text).toContain("headlessFallback");
		});
	});
});
