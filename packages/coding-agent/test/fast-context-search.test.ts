import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fastContextSearch } from "../src/core/context-search.js";

function writeProjectFile(root: string, relativePath: string, content: string): string {
	const fullPath = join(root, relativePath);
	writeFileSync(fullPath, content, { encoding: "utf8" });
	return fullPath;
}

describe("fastContextSearch", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "fast-context-search-"));
		writeFileSync(join(testDir, ".gitignore"), "node_modules\ndist\n", "utf8");
		writeFileSync(join(testDir, "package.json"), "{}\n", "utf8");
		writeFileSync(join(testDir, "tsconfig.json"), "{}\n", "utf8");
		mkdirSync(join(testDir, "src", "security"), { recursive: true });
		mkdirSync(join(testDir, "src", "core"), { recursive: true });
		mkdirSync(join(testDir, "src", "misc"), { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("expands abbreviations so auth queries find authentication code", async () => {
		writeProjectFile(
			testDir,
			"src/security/session.ts",
			`export function validateAuthenticationToken(token: string): boolean {\n\treturn token.length > 0;\n}\n`,
		);
		writeProjectFile(
			testDir,
			"src/misc/logger.ts",
			`export function logEvent(message: string) {\n\treturn message;\n}\n`,
		);

		const result = await fastContextSearch(testDir, "auth handler", { maxFiles: 3, includeSnippets: false });

		expect(result.files.map((file) => file.path)).toContain("src/security/session.ts");
	});

	it("ranks symbol and path matches above noisy body-only matches", async () => {
		writeProjectFile(
			testDir,
			"src/core/fast-context-target.ts",
			`export function fastContextSearch(query: string): string {\n\treturn query;\n}\n`,
		);
		writeProjectFile(
			testDir,
			"src/misc/noisy.ts",
			Array.from({ length: 30 }, () => "// fast context search mention").join("\n"),
		);

		const result = await fastContextSearch(testDir, "fastContextSearch", { maxFiles: 2, includeSnippets: false });

		expect(result.files[0]?.path).toBe("src/core/fast-context-target.ts");
	});

	it("reindexes changed files between searches", async () => {
		const file = writeProjectFile(
			testDir,
			"src/core/feature.ts",
			`export function oldFeatureName(): string {\n\treturn "old";\n}\n`,
		);

		const first = await fastContextSearch(testDir, "oldFeatureName", { maxFiles: 2, includeSnippets: false });
		expect(first.files.map((item) => item.path)).toContain("src/core/feature.ts");

		writeFileSync(file, `export function newFeatureName(): string {\n\treturn "new";\n}\n`, "utf8");
		const future = new Date(Date.now() + 1_000);
		utimesSync(file, future, future);

		const second = await fastContextSearch(testDir, "newFeatureName", { maxFiles: 2, includeSnippets: false });
		expect(second.files.map((item) => item.path)).toContain("src/core/feature.ts");
		expect(second.files[0]?.path).toBe("src/core/feature.ts");
	});
});
