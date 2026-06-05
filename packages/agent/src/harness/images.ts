/**
 * Image attachment helpers for harness applications.
 *
 * Provides MIME detection (by magic bytes) and file-to-ImageContent conversion
 * so harness apps do not need to hand-roll base64 + MIME handling.
 *
 * Resizing is deliberately omitted from this package — the heavy (Photon/WASM)
 * resize pipeline lives in `@earendil-works/pi-coding-agent`. Harness apps that
 * need resizing can pre-process images or pass them through coding-agent's
 * resize utility before calling `prompt()`.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { FileSystem } from "../harness/types.js";

// ---------------------------------------------------------------------------
// MIME detection (magic bytes only, no external dependencies)
// ---------------------------------------------------------------------------

const MAGIC_JPEG = [0xff, 0xd8, 0xff];
const MAGIC_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAGIC_GIF = "GIF";
const MAGIC_RIFF = "RIFF";
const MAGIC_WEBP = "WEBP";

/**
 * Detect a supported image MIME type from raw file bytes.
 * Returns `null` when the bytes do not match a known image format.
 */
export function detectImageMimeType(buffer: Uint8Array): string | null {
	if (buffer.length < 12) return null;

	// JPEG: starts with FF D8 FF
	if (startsWithBytes(buffer, MAGIC_JPEG)) {
		// F7 is SOS (Start Of Scan) — JPEG that's also a JPEG 2000 component
		if (buffer[3] === 0xf7) return null;
		return "image/jpeg";
	}

	// PNG: 8-byte magic signature
	if (startsWithBytes(buffer, MAGIC_PNG)) {
		return "image/png";
	}

	// GIF: ASCII "GIF" at offset 0
	if (startsWithAscii(buffer, 0, MAGIC_GIF)) {
		return "image/gif";
	}

	// WebP: RIFF container with WEBP at offset 8
	if (startsWithAscii(buffer, 0, MAGIC_RIFF) && startsWithAscii(buffer, 8, MAGIC_WEBP)) {
		return "image/webp";
	}

	return null;
}

function startsWithBytes(buffer: Uint8Array, magic: number[]): boolean {
	if (buffer.length < magic.length) return false;
	for (let i = 0; i < magic.length; i++) {
		if (buffer[i] !== magic[i]) return false;
	}
	return true;
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let i = 0; i < text.length; i++) {
		if (buffer[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Image attachment loading
// ---------------------------------------------------------------------------

export interface LoadImageAttachmentOptions {
	/**
	 * If true (default), the output text note includes image dimensions.
	 * Harness apps that need tight token control can disable this.
	 */
	includeMetadata?: boolean;
}

/**
 * Result of loading one image file attachment.
 */
export interface LoadedImageAttachment {
	/** The image content block suitable for `AgentHarness.prompt(text, { images })`. */
	image: ImageContent;
	/** A short text note describing the attachment (filename, dimensions). */
	note: string;
	/** The detected MIME type or null if detection failed. */
	mimeType: string | null;
}

/**
 * Read a single image file and produce an `ImageContent` block.
 *
 * Throws if the file cannot be read or its image type is not recognised.
 */
export async function loadImageAttachment(
	env: FileSystem,
	path: string,
	options?: LoadImageAttachmentOptions,
): Promise<LoadedImageAttachment> {
	const includeMetadata = options?.includeMetadata ?? true;

	const readResult = await env.readBinaryFile(path);
	if (!readResult.ok) {
		throw new Error(`Cannot read image file "${path}": ${readResult.error.code}`);
	}
	const rawData = readResult.value;

	if (!rawData || rawData.length === 0) {
		throw new Error(`Image file "${path}" is empty`);
	}

	const mimeType = detectImageMimeType(rawData);
	if (!mimeType) {
		throw new Error(`Unsupported or unrecognised image format in "${path}"`);
	}

	const base64 = Buffer.from(rawData).toString("base64");

	let note = `<image path="${path}">`;
	if (includeMetadata) {
		const infoResult = await env.fileInfo(path);
		if (infoResult.ok) {
			note = `<file name="${path}">[Image: ${infoResult.value.size}B]</file>`;
		}
	}

	return {
		image: { type: "image", data: base64, mimeType },
		note,
		mimeType,
	};
}

/**
 * Read multiple image files and produce arrays suitable for `AgentHarness.prompt()`.
 *
 * Each file that is not a recognised image type is skipped with a text
 * placeholder instead of throwing.
 */
export async function loadImageAttachments(
	env: FileSystem,
	paths: string[],
	options?: LoadImageAttachmentOptions,
): Promise<{ images: ImageContent[]; textNotes: string[] }> {
	const images: ImageContent[] = [];
	const textNotes: string[] = [];

	for (const path of paths) {
		try {
			const loaded = await loadImageAttachment(env, path, options);
			images.push(loaded.image);
			textNotes.push(loaded.note);
		} catch {
			// Skip unsupported files with a text fallback
			textNotes.push(`<file name="${path}">[Unsupported or unrecognised format — omitted]</file>`);
		}
	}

	return { images, textNotes };
}
