/**
 * Unit tests for edit-diff.ts functions:
 * - normalizeForFuzzyMatch (tab normalization, Unicode normalization)
 * - fuzzyFindText (exact + fuzzy matching)
 * - applyEditsToNormalizedContent (tab/spaces mismatch, multi-edit)
 * - buildNotFoundSnippet / getNotFoundError (improved error messages with context)
 */

import { describe, expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	buildNotFoundSnippet,
	normalizeForFuzzyMatch,
} from "../src/core/tools/edit-diff.js";

// ---------------------------------------------------------------------------
// normalizeForFuzzyMatch
// ---------------------------------------------------------------------------
describe("normalizeForFuzzyMatch", () => {
	it("normalizes tabs to 4 spaces", () => {
		const withTab = "function foo() {\n\treturn 1;\n}";
		const withSpaces = "function foo() {\n    return 1;\n}";
		expect(normalizeForFuzzyMatch(withTab)).toBe(normalizeForFuzzyMatch(withSpaces));
	});

	it("normalizes mixed indentation consistently", () => {
		const input = "\t\tif (x) {\n\t\t\tdoStuff();\n\t\t}";
		const expectedSpaces = "        if (x) {\n            doStuff();\n        }";
		expect(normalizeForFuzzyMatch(input)).toBe(normalizeForFuzzyMatch(expectedSpaces));
	});

	it("strips trailing whitespace from each line", () => {
		const input = "hello   \nworld  \n";
		const expected = "hello\nworld\n";
		expect(normalizeForFuzzyMatch(input)).toBe(normalizeForFuzzyMatch(expected));
	});

	it("normalizes smart quotes to ASCII", () => {
		const smart = "\u2018hello\u2019 \u201Cworld\u201D";
		const ascii = "'hello' \"world\"";
		expect(normalizeForFuzzyMatch(smart)).toBe(normalizeForFuzzyMatch(ascii));
	});

	it("normalizes Unicode dashes to ASCII hyphen", () => {
		const input = "a\u2013b\u2014c\u2212d";
		const expected = "a-b-c-d";
		expect(normalizeForFuzzyMatch(input)).toBe(normalizeForFuzzyMatch(expected));
	});

	it("normalizes special spaces to regular space", () => {
		const input = "a\u00A0b\u2003c\u202Fd";
		const expected = "a b c d";
		expect(normalizeForFuzzyMatch(input)).toBe(normalizeForFuzzyMatch(expected));
	});

	it("performs NFKC normalization", () => {
		const input = "\uFF2A\uFF32"; // fullwidth J and R
		const nfkc = input.normalize("NFKC");
		expect(nfkc).toBe("JR");
	});
});

// ---------------------------------------------------------------------------
// applyEditsToNormalizedContent – tab/spaces mismatch
// ---------------------------------------------------------------------------
describe("applyEditsToNormalizedContent – tab handling", () => {
	it("matches oldText with spaces against file with tabs", () => {
		const fileContent = "line1\n\tindented\nline3";
		const edits = [{ oldText: "    indented", newText: "  changed" }];
		const result = applyEditsToNormalizedContent(fileContent, edits, "test.php");
		expect(result.newContent).toContain("  changed");
		expect(result.newContent).not.toContain("\tindented");
	});

	it("matches oldText with tabs against file with spaces", () => {
		const fileContent = "line1\n    indented\nline3";
		const edits = [{ oldText: "\tindented", newText: "\tchanged" }];
		const result = applyEditsToNormalizedContent(fileContent, edits, "test.ts");
		expect(result.newContent).toContain("\tchanged");
		expect(result.newContent).not.toContain("    indented");
	});

	it("handles multi-edit with mixed tab/space indentation", () => {
		const fileContent = "\tfunction foo() {\n\t\treturn 1;\n\t}\n\n    function bar() {\n        return 2;\n    }";
		const edits = [
			{
				oldText: "    function foo() {\n        return 1;\n    }",
				newText: "    function foo() { // FOO\n        return 1;\n    }",
			},
			{
				oldText: "    function bar() {\n        return 2;\n    }",
				newText: "    function bar() { // BAR\n        return 2;\n    }",
			},
		];
		const result = applyEditsToNormalizedContent(fileContent, edits, "test.js");
		expect(result.newContent).toContain("// FOO");
		expect(result.newContent).toContain("// BAR");
	});
});

// ---------------------------------------------------------------------------
// applyEditsToNormalizedContent – edge cases
// ---------------------------------------------------------------------------
describe("applyEditsToNormalizedContent – edge cases", () => {
	it("preserves exact match behavior when tabs are not involved", () => {
		const fileContent = "hello world";
		const result = applyEditsToNormalizedContent(fileContent, [{ oldText: "world", newText: "there" }], "test.txt");
		expect(result.newContent).toBe("hello there");
	});

	it("rejects empty oldText", () => {
		expect(() => applyEditsToNormalizedContent("content", [{ oldText: "", newText: "x" }], "test.txt")).toThrow(
			"oldText must not be empty",
		);
	});

	it("rejects duplicate oldText", () => {
		expect(() =>
			applyEditsToNormalizedContent("foo foo foo", [{ oldText: "foo", newText: "bar" }], "test.txt"),
		).toThrow("Found 3 occurrences");
	});

	it("rejects overlapping edits", () => {
		expect(() =>
			applyEditsToNormalizedContent(
				"one\ntwo\nthree\n",
				[
					{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
					{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
				],
				"test.txt",
			),
		).toThrow("overlap");
	});

	it("applies edits in reverse order to preserve offsets", () => {
		const fileContent = "a\nb\nc\n";
		const result = applyEditsToNormalizedContent(
			fileContent,
			[
				{ oldText: "a\n", newText: "A\n" },
				{ oldText: "c\n", newText: "C\n" },
			],
			"test.txt",
		);
		expect(result.newContent).toBe("A\nb\nC\n");
	});
});

// ---------------------------------------------------------------------------
// buildNotFoundSnippet – error message context
// ---------------------------------------------------------------------------
describe("buildNotFoundSnippet", () => {
	it("finds closest match by word overlap and shows context", () => {
		const content = "line1\nignore-me\nfunction doStuff() {\n    return 42;\n}\nline5";
		const oldText = "function do_stuff() {";
		const snippet = buildNotFoundSnippet(content, oldText);
		expect(snippet).toContain("function doStuff()");
		expect(snippet).toMatch(/(at line 3|near line 3)/);
	});

	it("falls back to 'File starts with' when no word overlap exists", () => {
		const content = "abc\n123\nxyz\n";
		const oldText = "function main() {";
		const snippet = buildNotFoundSnippet(content, oldText);
		expect(snippet).toContain("File starts with");
		expect(snippet).toContain("abc");
	});

	it("shows surrounding lines (+/- 2) around the closest match", () => {
		const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const oldText = "line 9\nline 10\nline 11";
		const snippet = buildNotFoundSnippet(content.join("\n"), oldText);
		expect(snippet).toContain("line 7");
		expect(snippet).toContain("line 11");
		expect(snippet).not.toContain("line 5");
	});

	it("handles completely empty oldText anchor", () => {
		const content = "first line\nsecond line\n";
		const snippet = buildNotFoundSnippet(content, "  \n  \n");
		expect(snippet).toContain("File starts with");
	});

	it("handles oldText that is an exact substring of a content line", () => {
		const content = "export const FOO = 'bar';\nexport const BAZ = 'qux';\n";
		const oldText = "FOO = 'bar'";
		const snippet = buildNotFoundSnippet(content, oldText);
		expect(snippet).toContain("FOO = 'bar'");
		expect(snippet).toMatch(/(at line 1|near line 1)/);
	});
});

// ---------------------------------------------------------------------------
// getNotFoundError behavior — verify via applyEditsToNormalizedContent
// ---------------------------------------------------------------------------
describe("getNotFoundError – error message format", () => {
	it("includes 'Looking for' in error when text is not found", () => {
		try {
			applyEditsToNormalizedContent(
				"line1\nline2\nline3\n",
				[{ oldText: "nonexistent", newText: "replacement" }],
				"test.txt",
			);
		} catch (e: unknown) {
			const msg = (e as Error).message;
			expect(msg).toContain("Looking for");
			expect(msg).toContain("nonexistent");
		}
	});

	it("includes file context in error when text is not found", () => {
		try {
			applyEditsToNormalizedContent("abc\ndef\nghi\n", [{ oldText: "xyz", newText: "replacement" }], "test.txt");
		} catch (e: unknown) {
			const msg = (e as Error).message;
			expect(msg).toMatch(/(File starts with|closest match|near line)/);
			expect(msg).toContain("abc");
		}
	});

	it("shows edit index in multi-edit error", () => {
		try {
			applyEditsToNormalizedContent(
				"alpha\nbeta\ngamma\n",
				[
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "missing\n", newText: "MISSING\n" },
				],
				"test.txt",
			);
		} catch (e: unknown) {
			const msg = (e as Error).message;
			expect(msg).toContain("edits[1]");
			expect(msg).toContain("Looking for");
		}
	});

	it("shows single-edit format when totalEdits is 1", () => {
		try {
			applyEditsToNormalizedContent(
				"some content",
				[{ oldText: "missing text", newText: "replacement" }],
				"test.txt",
			);
		} catch (e: unknown) {
			const msg = (e as Error).message;
			expect(msg).toContain("Could not find the exact text");
			expect(msg).not.toContain("edits[0]");
		}
	});
});
