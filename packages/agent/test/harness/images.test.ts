import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.js";
import { detectImageMimeType, loadImageAttachment, loadImageAttachments } from "../../src/harness/images.js";

// Tiny 1x1 red PNG (base64)
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

// Tiny JPEG (2x2 blue)
const TINY_JPEG_HEX =
	"ffd8ffe000104a46494600010101004800480000ffdb00430003020203020203030303040603040506050505070608060707080708080809090a090908080a0b0f0f0a0c0a0e0a0a0a0d0e0d0d0a0d0e0d0e0d0d0a0d0effc0000b080001000101011100ffc4000d000000070101010000000000000000000000010203040506070809ffc4003010000104020103030204050500000000000100020304051112132131061441512242152332336116243471a1c1d1f0ffda0008010100003f00f96e82082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082082ffd9";

describe("detectImageMimeType", () => {
	it("returns null for empty buffer", () => {
		expect(detectImageMimeType(new Uint8Array(0))).toBeNull();
	});

	it("returns null for too-short buffer", () => {
		expect(detectImageMimeType(new Uint8Array([0x89, 0x50]))).toBeNull();
	});

	it("returns null for unknown data", () => {
		const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);
		expect(detectImageMimeType(buf)).toBeNull();
	});

	it("detects PNG", () => {
		const buf = Buffer.from(TINY_PNG_BASE64, "base64");
		expect(detectImageMimeType(buf)).toBe("image/png");
	});

	it("detects JPEG", () => {
		const buf = Buffer.from(TINY_JPEG_HEX, "hex");
		expect(detectImageMimeType(buf)).toBe("image/jpeg");
	});

	it("returns null for JPEG with SOS marker (0xf7 at byte 3)", () => {
		// JPEG 2000 components that are not regular JPEG
		const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xf7, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
		expect(detectImageMimeType(buf)).toBeNull();
	});

	it("detects GIF from ASCII header", () => {
		const buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
		expect(detectImageMimeType(buf)).toBe("image/gif");
	});

	it("detects WebP", () => {
		const webpHeader = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
		expect(detectImageMimeType(webpHeader)).toBe("image/webp");
	});
});

describe("loadImageAttachment", () => {
	let testDir: string;
	let env: NodeExecutionEnv;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-image-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		env = new NodeExecutionEnv({ cwd: testDir });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("loads a PNG file and returns ImageContent", async () => {
		const filePath = join(testDir, "test.png");
		writeFileSync(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await loadImageAttachment(env, filePath);

		expect(result.mimeType).toBe("image/png");
		expect(result.image.type).toBe("image");
		expect(result.image.mimeType).toBe("image/png");
		expect(result.image.data).toBeTruthy();
		// Base64 data should decode to valid PNG
		const decoded = Buffer.from(result.image.data, "base64");
		expect(decoded[0]).toBe(0x89);
		expect(decoded[1]).toBe(0x50); // P
		expect(result.note).toContain("test.png");
	});

	it("loads a JPEG file and returns ImageContent", async () => {
		const filePath = join(testDir, "test.jpg");
		writeFileSync(filePath, Buffer.from(TINY_JPEG_HEX, "hex"));

		const result = await loadImageAttachment(env, filePath);

		expect(result.mimeType).toBe("image/jpeg");
		expect(result.image.type).toBe("image");
		expect(result.image.mimeType).toBe("image/jpeg");
	});

	it("throws on unsupported file format", async () => {
		const filePath = join(testDir, "test.txt");
		writeFileSync(filePath, "hello world");

		await expect(loadImageAttachment(env, filePath)).rejects.toThrow(/unsupported/i);
	});

	it("throws on nonexistent file", async () => {
		const filePath = join(testDir, "nonexistent.png");
		await expect(loadImageAttachment(env, filePath)).rejects.toThrow();
	});
});

describe("loadImageAttachments", () => {
	let testDir: string;
	let env: NodeExecutionEnv;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-image-batch-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		env = new NodeExecutionEnv({ cwd: testDir });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("loads multiple image files", async () => {
		const pngPath = join(testDir, "a.png");
		writeFileSync(pngPath, Buffer.from(TINY_PNG_BASE64, "base64"));
		const jpgPath = join(testDir, "b.jpg");
		writeFileSync(jpgPath, Buffer.from(TINY_JPEG_HEX, "hex"));

		const result = await loadImageAttachments(env, [pngPath, jpgPath]);

		expect(result.images).toHaveLength(2);
		expect(result.textNotes).toHaveLength(2);
		expect(result.images[0].mimeType).toBe("image/png");
		expect(result.images[1].mimeType).toBe("image/jpeg");
	});

	it("skips unsupported files and includes a text fallback", async () => {
		const pngPath = join(testDir, "a.png");
		writeFileSync(pngPath, Buffer.from(TINY_PNG_BASE64, "base64"));
		const txtPath = join(testDir, "b.txt");
		writeFileSync(txtPath, "hello");

		const result = await loadImageAttachments(env, [pngPath, txtPath]);

		// PNG should be included, txt skipped
		expect(result.images).toHaveLength(1);
		expect(result.textNotes).toHaveLength(2);
		expect(result.textNotes[0]).toContain("a.png");
		expect(result.textNotes[1]).toContain("Unsupported");
	});
});
