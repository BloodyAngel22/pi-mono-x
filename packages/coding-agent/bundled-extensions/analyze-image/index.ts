/**
 * analyze-image — bundled extension for pi coding agent.
 *
 * Provides the `analyze_image` tool that lets text-only LLMs "see" images by
 * extracting text (OCR), reading metadata, and optionally generating a caption.
 *
 * Architecture:
 *   - OCR:          tesseract.js  (pure JS WASM, auto-downloads language data)
 *   - Metadata:     probe-image-size (pure JS, reads image headers)
 *   - Captioning:   @huggingface/transformers (optional, ONNX in Node.js)
 *   - Fallback:     rule-based heuristics (color stats, text density)
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { execSync, exec } from "node:child_process";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnalyzeImageParams {
	image_path: string;
	lang?: string;
	analyze?: ("ocr" | "caption" | "classify")[];
}

interface TextBlock {
	text: string;
	bbox: [number, number, number, number];
	confidence: number;
	line_num: number;
}

interface ImageMetadata {
	width: number;
	height: number;
	format: string;
	size_bytes: number;
	has_transparency: boolean;
}

interface AnalyzeResult {
	text: string;
	confidence: number;
	blocks: TextBlock[];
	caption: string;
	image_type: string;
	colors: DominantColor[];
	metadata: ImageMetadata;
	latency_hint: string;
	error?: string;
}

interface Config {
	ocr_enabled: boolean;
	ocr_lang: string;
	ocr_engine: "tesseract.js" | "native-cli";
	captioning_enabled: boolean;
	captioning_backend: "tiny" | "vit-gpt2" | "ollama" | "disabled";
	captioning_model: string;
	ollama_host: string;
	ollama_model: string;
	max_image_size_mb: number;
	rule_based_classification: boolean;
}

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Config = {
	ocr_enabled: true,
	ocr_lang: "eng+rus",
	ocr_engine: "tesseract.js",
	captioning_enabled: false,
	captioning_backend: "tiny",
	captioning_model: "Xenova/vit-gpt2-image-captioning",
	ollama_host: "http://localhost:11434",
	ollama_model: "llava",
	max_image_size_mb: 10,
	rule_based_classification: true,
};

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "analyze-image", "config.json");

// ─── Config loading ───────────────────────────────────────────────────────────

function loadConfig(): Config {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
			return { ...DEFAULT_CONFIG, ...raw };
		}
	} catch {
		// ignore, use defaults
	}
	return { ...DEFAULT_CONFIG };
}

// ─── Metadata (probe-image-size) ──────────────────────────────────────────────

function readImageMetadata(filePath: string): ImageMetadata {
	const fd = fs.openSync(filePath, "r");
	try {
		// Read first 64KB — should cover all metadata segments
		const buf = Buffer.alloc(65536);
		const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
		const header = buf.subarray(0, bytesRead);
		const stat = fs.statSync(filePath);
		const meta: ImageMetadata = {
			width: 0,
			height: 0,
			format: path.extname(filePath).toLowerCase().replace(".", "") || "unknown",
			size_bytes: stat.size,
			has_transparency: false,
		};

		// Detect PNG
		if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
			meta.format = "png";
			meta.width = header.readUInt32BE(16);
			meta.height = header.readUInt32BE(20);
			// Color type: 0=grayscale, 2=RGB, 3=palette, 4=grayscale+alpha, 6=RGBA
			const colorType = header[25];
			meta.has_transparency = colorType === 4 || colorType === 6;
			// For palette PNGs (colorType 3), check for tRNS chunk
			if (colorType === 3) {
				// Scan for "tRNS" chunk in first 64KB
				for (let i = 33; i < bytesRead - 4; i++) {
					if (header[i] === 0x74 && header[i+1] === 0x52 && header[i+2] === 0x4e && header[i+3] === 0x53) {
						meta.has_transparency = true;
						break;
					}
				}
			}
		}
		// Detect JPEG — parse segments properly
		else if (header[0] === 0xff && header[1] === 0xd8) {
			meta.format = "jpeg";
			// Walk through JPEG segments: FF marker, then 2-byte length (excl. marker itself)
			let pos = 2;
			while (pos < bytesRead - 1) {
				if (header[pos] !== 0xff) break;
				const marker = header[pos + 1];
				// SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2) — contain image dimensions
				if (marker >= 0xc0 && marker <= 0xc2) {
					if (pos + 11 < bytesRead) {
						meta.height = header.readUInt16BE(pos + 5);
						meta.width = header.readUInt16BE(pos + 7);
					}
					break;
				}
				// SOS (0xDA) — start of scan, no more metadata after this
				if (marker === 0xda) break;
				// Skip segment: marker (2 bytes) + length (2 bytes, includes length field itself)
				if (pos + 3 >= bytesRead) break;
				const segLen = header.readUInt16BE(pos + 2);
				if (segLen < 2) break;
				pos += 2 + segLen;
			}
		}
		// Detect GIF
		else if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) {
			meta.format = "gif";
			meta.width = header.readUInt16LE(6);
			meta.height = header.readUInt16LE(8);
			meta.has_transparency = true; // common for GIFs
		}
		// Detect WebP
		else if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
			meta.format = "webp";
			const webpMagic = header.subarray(8, 12).toString();
			if (webpMagic === "WEBP") {
				const vp8xStart = header.subarray(12, 16).toString();
				if (vp8xStart === "VP8X") {
					const alphaBit = (header[20] >> 4) & 1;
					meta.has_transparency = alphaBit === 1;
				}
				if (header.length >= 30) {
					const w = ((header[26] & 0x3f) << 8) | header[27];
					const h = ((header[28] & 0x3f) << 8) | header[29];
					if (w > 0 && h > 0) {
						meta.width = w + 1;
						meta.height = h + 1;
					}
				}
			}
		}

		return meta;
	} finally {
		fs.closeSync(fd);
	}
}

// ─── Rule-based Image Classification ─────────────────────────────────────────

function classifyImage(filePath: string, metadata: ImageMetadata): string {
	// PNG with aspect ratio > 1.5 or width >= 400 → screenshot/UI
	if (metadata.format === "png" && metadata.width > 0) {
		if (metadata.width >= 400 || metadata.width > metadata.height * 1.5) {
			return "screenshot";
		}
	}
	// Photos are usually .jpg with varying aspect ratios
	if (metadata.format === "jpeg") {
		return "photo";
	}
	// Icons and logos are typically small
	if (metadata.width <= 256 && metadata.height <= 256) {
		return "icon";
	}
	// WebP is common for web content
	if (metadata.format === "webp") {
		return "web_image";
	}
	// GIFs are often animations
	if (metadata.format === "gif") {
		return "animation";
	}
	return "unknown";
}

// ─── Color extraction (pure JS, no deps) ─────────────────────────────────────

interface DominantColor {
	r: number;
	g: number;
	b: number;
	name: string;
	pct: number;
}

// Simple color name mapping
const COLOR_NAMES: [number, number, number, string][] = [
	[255, 255, 255, "white"],
	[0, 0, 0, "black"],
	[255, 0, 0, "red"],
	[0, 255, 0, "green"],
	[0, 0, 255, "blue"],
	[255, 255, 0, "yellow"],
	[255, 165, 0, "orange"],
	[255, 192, 203, "pink"],
	[128, 0, 128, "purple"],
	[165, 42, 42, "brown"],
	[128, 128, 128, "gray"],
	[0, 128, 128, "teal"],
	[0, 0, 128, "navy"],
	[128, 128, 0, "olive"],
	[255, 20, 147, "deep_pink"],
	[0, 255, 255, "cyan"],
	[255, 99, 71, "tomato"],
	[144, 238, 144, "light_green"],
	[173, 216, 230, "light_blue"],
	[255, 228, 181, "peach"],
	[255, 182, 193, "light_pink"],
	[240, 230, 140, "khaki"],
	[135, 206, 235, "sky_blue"],
	[255, 218, 185, "peach_puff"],
	[245, 245, 220, "beige"],
];

function closestColorName(r: number, g: number, b: number): string {
	let minDist = Infinity;
	let name = "unknown";
	for (const [cr, cg, cb, cn] of COLOR_NAMES) {
		const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
		if (d < minDist) {
			minDist = d;
			name = cn;
		}
	}
	return name;
}

function extractColors(filePath: string, metadata: ImageMetadata): DominantColor[] {
	// For JPEG/GIF/WebP, raw byte sampling gives garbage (compressed).
	// For PNG, try to skip the IHDR+IDAT headers and sample from pixel data region.
	// Most reliable approach: skip first 100 bytes (headers) and sample from there,
	// accepting that compressed PNG gives approximate results.
	if (metadata.format === "jpeg" || metadata.format === "gif" || metadata.format === "webp") {
		return [];
	}

	const fd = fs.openSync(filePath, "r");
	try {
		const size = Math.min(metadata.size_bytes, 512 * 1024);
		const buf = Buffer.alloc(size);
		const bytesRead = fs.readSync(fd, buf, 0, size, 0);

		// Track both count and accumulated RGB per color name
		const buckets = new Map<string, { count: number; rSum: number; gSum: number; bSum: number }>();
		let totalSamples = 0;

		// For PNG, skip alpha bytes (every 4th byte in RGBA).
		// Raw compressed data won't give accurate pixels, but we can still estimate.
		const step = metadata.format === "png" ? 4 : 3;
		for (let i = 200; i < bytesRead - step; i += step) {
			const r = buf[i] ?? 0;
			const g = buf[i + 1] ?? 0;
			const b = buf[i + 2] ?? 0;
			if (r < 3 && g < 3 && b < 3) continue;
			const name = closestColorName(r, g, b);
			const bucket = buckets.get(name) ?? { count: 0, rSum: 0, gSum: 0, bSum: 0 };
			bucket.count++;
			bucket.rSum += r;
			bucket.gSum += g;
			bucket.bSum += b;
			buckets.set(name, bucket);
			totalSamples++;
		}

		if (totalSamples < 5) return [];

		return [...buckets.entries()]
			.sort((a, b) => b[1].count - a[1].count)
			.slice(0, 4)
			.map(([name, b]) => ({
				r: Math.round(b.rSum / b.count),
				g: Math.round(b.gSum / b.count),
				b: Math.round(b.bSum / b.count),
				name,
				pct: Math.round((b.count / totalSamples) * 100),
			}));
	} finally {
		fs.closeSync(fd);
	}
}

// ─── OCR: try native Tesseract CLI first, fallback to Tesseract.js ────────────

let nativeTesseractAvailable: boolean | null = null;

async function hasNativeTesseract(): Promise<boolean> {
	if (nativeTesseractAvailable !== null) return nativeTesseractAvailable;
	try {
		await new Promise<void>((resolve, reject) => {
			exec("tesseract --version 2>/dev/null", { timeout: 2000 }, (error) => {
				if (error) reject(error); else resolve();
			});
		});
		nativeTesseractAvailable = true;
	} catch {
		nativeTesseractAvailable = false;
	}
	return nativeTesseractAvailable;
}

let tesseractWorker: any = null;

async function getTesseractWorker(lang: string): Promise<any> {
	if (tesseractWorker) return tesseractWorker;
	const require = createRequire(import.meta.url);
	try {
		const Tesseract = require("tesseract.js");
		const worker = await Tesseract.createWorker(lang, 1, {
			logger: () => {},
		});
		tesseractWorker = worker;
		return worker;
	} catch (err) {
		throw new Error(
			`tesseract.js is not installed. Run: npm install tesseract.js\n${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function runOcrNative(filePath: string, lang: string, signal?: AbortSignal): Promise<{ text: string; confidence: number; blocks: TextBlock[] }> {
	const langArg = lang.replace("+", "+");
	// Use TSV format for bounding boxes and per-word confidence
	const cmd = `tesseract "${filePath}" stdout -l ${langArg} --psm 6 tsv 2>/dev/null`;
	const tsvRaw = await new Promise<string>((resolve, reject) => {
		const child = exec(cmd, { timeout: 10000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error); else resolve(stdout);
		});
		// Allow user cancellation via AbortSignal
		if (signal) {
			signal.addEventListener("abort", () => {
				child.kill();
				reject(new DOMException("Cancelled", "AbortError"));
			}, { once: true });
		}
	});
	const lines = tsvRaw.split(/[\r\n]+/).filter((l: string) => l.trim().length > 0);

	// Parse TSV: header line defines columns, data lines follow
	// Format: level page_num block_num par_num line_num word_num left top width height conf text
	const blocks: TextBlock[] = [];
	const textLines: string[] = [];
	let totalConf = 0;
	let wordCount = 0;

	if (lines.length >= 2) {
		const header = lines[0].split("\t");
		const colIdx: Record<string, number> = {};
		header.forEach((col: string, i: number) => { colIdx[col.trim()] = i; });

		const levelCol = colIdx["level"];
		const leftCol = colIdx["left"];
		const topCol = colIdx["top"];
		const widthCol = colIdx["width"];
		const heightCol = colIdx["height"];
		const confCol = colIdx["conf"];
		const textCol = colIdx["text"];

		for (let i = 1; i < lines.length; i++) {
			const cols = lines[i].split("\t");
			const level = levelCol !== undefined ? parseInt(cols[levelCol] ?? "", 10) : NaN;
			if (isNaN(level)) continue;

			// Word level (level=5) or line level (level=4)
			const word = (textCol !== undefined ? cols[textCol] ?? "" : "").trim();
			if (!word) continue;

			if (level === 5) {
				// Word level: extract bbox and confidence
				const left = leftCol !== undefined ? parseInt(cols[leftCol] ?? "0", 10) : 0;
				const top = topCol !== undefined ? parseInt(cols[topCol] ?? "0", 10) : 0;
				const w = widthCol !== undefined ? parseInt(cols[widthCol] ?? "0", 10) : 0;
				const h = heightCol !== undefined ? parseInt(cols[heightCol] ?? "0", 10) : 0;
				const conf = confCol !== undefined ? parseInt(cols[confCol] ?? "-1", 10) : -1;

				blocks.push({
					text: word,
					bbox: [left, top, left + w, top + h] as [number, number, number, number],
					confidence: conf >= 0 ? conf / 100 : 0.5,
					line_num: cols[colIdx["line_num"]] ? parseInt(cols[colIdx["line_num"]], 10) : 0,
				});

				if (conf >= 0) {
					totalConf += conf;
					wordCount++;
				}
			}

			// Line level (level=4): collect text for the full output
			if (level === 4) {
				textLines.push(word);
			}
		}
	}

	const text = textLines.join("\n");
	const confidence = wordCount > 0 ? (totalConf / wordCount) / 100 : (text ? 0.5 : 0);
	return { text, confidence, blocks };
}

async function runOcrJs(filePath: string, lang: string): Promise<{ text: string; confidence: number; blocks: TextBlock[] }> {
	const worker = await getTesseractWorker(lang);
	const imageBuffer = fs.readFileSync(filePath);
	const { data } = await worker.recognize(imageBuffer);

	const blocks: TextBlock[] = [];
	if (data.words) {
		for (const word of data.words) {
			if (word.text?.trim()) {
				// Fallback to 0 for undefined bbox properties (varies by tesseract.js version)
				const x0 = typeof word.bbox?.x0 === "number" ? word.bbox.x0 : 0;
				const y0 = typeof word.bbox?.y0 === "number" ? word.bbox.y0 : 0;
				const x1 = typeof word.bbox?.x1 === "number" ? word.bbox.x1 : 0;
				const y1 = typeof word.bbox?.y1 === "number" ? word.bbox.y1 : 0;
				blocks.push({
					text: word.text.trim(),
					bbox: [x0, y0, x1, y1] as [number, number, number, number],
					confidence: typeof word.confidence === "number" ? word.confidence : 0,
					line_num: typeof word.line_num === "number" ? word.line_num : 0,
				});
			}
		}
	}

	const text = data.text ?? "";
	const confidence = data.words?.length
		? data.words.reduce((sum: number, w: any) => sum + (w.confidence ?? 0), 0) / data.words.length
		: 0;

	return { text, confidence, blocks };
}

async function runOcr(filePath: string, lang: string, signal?: AbortSignal): Promise<{ text: string; confidence: number; blocks: TextBlock[] }> {
	// Try native Tesseract CLI first (2-5x faster)
	if (await hasNativeTesseract()) {
		try {
			return await runOcrNative(filePath, lang, signal);
		} catch {
			// fall through to JS version
		}
	}
	return runOcrJs(filePath, lang);
}

// ─── Captioning (optional, via transformers.js) ───────────────────────────────

const CAPTION_TIMEOUT_MS = 30_000; // 30 seconds max for captioning inference
let captionerPipeline: any = null; // Cache the pipeline across calls (saves ~10-20s)

async function getCaptioner(): Promise<any> {
	if (captionerPipeline) return captionerPipeline;
	const require = createRequire(import.meta.url);
	const { pipeline } = require("@huggingface/transformers") as any;
	captionerPipeline = await Promise.race([
		pipeline("image-to-text", "Xenova/vit-gpt2-image-captioning", {
			dtype: "q8",
			device: "cpu",
		}),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Model loading timed out (60s)")), 60_000)
		),
	]);
	return captionerPipeline;
}

async function runCaptioning(filePath: string, _backend: string, onProgress?: (msg: string) => void): Promise<string> {
	const require = createRequire(import.meta.url);

	// First check if the package is installed
	try {
		require.resolve("@huggingface/transformers");
	} catch {
		throw new Error(
			`@huggingface/transformers not installed. To enable captioning:\n` +
			`  cd /home/maximz/programming/pi-mono-x && npm install @huggingface/transformers\n` +
			`First run also downloads ~300MB model (Xenova/vit-gpt2-image-captioning) from HuggingFace Hub.`
		);
	}

	try {
		const { RawImage } = require("@huggingface/transformers") as any;

		// Load image using RawImage (handles file paths, URLs, buffers)
		let image: any;
		try {
			image = await Promise.race([
				RawImage.read(filePath),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Loading image timed out")), 10000)
				),
			]);
		} catch {
			throw new Error("Failed to load image (timed out or corrupted)");
		}

		if (onProgress) onProgress("🧠 Loading captioning model (cached)…");

		// Load quantized q8 model — cached in memory after first load (~245MB)
		let captioner: any;
		try {
			captioner = await getCaptioner();
			if (onProgress) onProgress("✅ Captioning model loaded");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to load captioning model: ${msg}`);
		}

		if (onProgress) onProgress("🧠 Generating caption…");

		// Run with timeout and limited tokens
		const result = await Promise.race([
			captioner(image, {
				max_new_tokens: 30,
				num_beams: 1,
				do_sample: false,
			}),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Captioning timed out after 30s")), CAPTION_TIMEOUT_MS)
			),
		]);

		const caption = Array.isArray(result)
			? (result[0]?.generated_text ?? "")
			: String(result ?? "");
		return caption || "(no description generated)";
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Captioning failed: ${message}`);
	}
}

// ─── Main analyze function ────────────────────────────────────────────────────

/// Return partial results when analysis is cancelled mid-way
function partialResult(
	stage: string,
	metadata: ImageMetadata,
	image_type: string,
	colors: DominantColor[],
): AnalyzeResult {
	return {
		text: "",
		confidence: 0,
		blocks: [],
		caption: "",
		image_type,
		colors,
		metadata,
		latency_hint: "cancelled",
		error: `Analysis cancelled during: ${stage}`,
	};
}

async function analyzeImage(
	filePath: string,
	params: AnalyzeImageParams,
	config: Config,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
): Promise<AnalyzeResult> {
	// 1. Resolve path
	const resolvedPath = path.resolve(filePath);
	if (!fs.existsSync(resolvedPath)) {
		return {
			text: "",
			confidence: 0,
			blocks: [],
			caption: "",
			image_type: "unknown",
			colors: [],
			metadata: { width: 0, height: 0, format: "unknown", size_bytes: 0, has_transparency: false },
			latency_hint: "N/A",
			error: `File not found: ${filePath}`,
		};
	}

	// Check file size limit
	const stat = fs.statSync(resolvedPath);
	if (stat.size > config.max_image_size_mb * 1024 * 1024) {
		return {
			text: "",
			confidence: 0,
			blocks: [],
			caption: "",
			image_type: "unknown",
			colors: [],
			metadata: { width: 0, height: 0, format: "unknown", size_bytes: stat.size, has_transparency: false },
			latency_hint: "N/A",
			error: `Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: ${config.max_image_size_mb}MB`,
		};
	}

	// 2. Metadata (always, fast)
	const metadata = readImageMetadata(resolvedPath);

	if (signal?.aborted) return partialResult("metadata", metadata, "unknown", []);

	// 3. Classification
	let image_type = "unknown";
	if (config.rule_based_classification) {
		image_type = classifyImage(resolvedPath, metadata);
	}

	if (signal?.aborted) return partialResult("classification", metadata, image_type, []);

	// 3b. Color extraction (always, fast)
	let colors: DominantColor[] = [];
	try {
		colors = extractColors(resolvedPath, metadata);
	} catch {}

	// Determine what analyzers to run
	const requested = params.analyze ?? ["ocr"];
	const shouldRunOcr = config.ocr_enabled && (requested.includes("ocr") || requested.includes("all"));
	// If the agent explicitly asks for captioning via analyze param, enable it
	// even if config has it disabled (config disable is only for auto-analysis)
	const captionRequested = requested.includes("caption") || requested.includes("all");
	const shouldRunCaption = (config.captioning_enabled || captionRequested) && captionRequested;

	// 4. OCR
	let text = "";
	let confidence = 0;
	let blocks: TextBlock[] = [];

	if (shouldRunOcr) {
		try {
			if (onProgress) onProgress("Running OCR…");
			const lang = params.lang ?? config.ocr_lang;
			const result = await runOcr(resolvedPath, lang, signal);
			// Filter out low-confidence words (< 10%)
			// Filter out low-confidence garbage words (< 30%)
			const filteredBlocks = result.blocks.filter((b: TextBlock) => b.confidence >= 0.3);
			const filteredText = filteredBlocks.map((b: TextBlock) => b.text).join(" ");
			blocks = filteredBlocks;
			text = result.blocks.length > 0
				? filteredBlocks.length > 0
					? filteredText
					: `(low confidence: ${result.blocks.map((b: TextBlock) => b.text).join(" ")})`
				: "";
			confidence = filteredBlocks.length > 0
				? filteredBlocks.reduce((sum: number, b: TextBlock) => sum + b.confidence, 0) / filteredBlocks.length
				: result.confidence;
		} catch (err) {
			return {
				text: "",
				confidence: 0,
				blocks: [],
				caption: "",
				image_type,
				colors,
				metadata,
				latency_hint: "OCR failed",
				error: `OCR failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	// 5. Captioning (optional)
	let caption = "";
	if (shouldRunCaption) {
		try {
			const backend = config.captioning_backend;
			if (backend !== "disabled") {
				if (signal?.aborted) return partialResult("captioning", metadata, imageType, colors);
				if (onProgress) onProgress("🧠 Running captioning (may take 10-30s on CPU)…");
				caption = await runCaptioning(resolvedPath, backend, onProgress);
			}
		} catch (err) {
			caption = `(captioning unavailable: ${err instanceof Error ? err.message : String(err)})`;
		}
	}

	// Build latency hint
	const parts: string[] = [];
	if (shouldRunOcr) parts.push("OCR");
	if (shouldRunCaption) parts.push("captioning");
	if (!shouldRunOcr && !shouldRunCaption && config.rule_based_classification) parts.push("classification");
	if (parts.length === 0) parts.push("metadata only");
	const latencyHint = parts.join("+");

	return {
		text,
		confidence,
		blocks,
		caption,
		image_type,
		colors,
		metadata,
		latency_hint: latencyHint,
	};
}

// ─── TUI Renderers ────────────────────────────────────────────────────────────

function renderCall(args: any, theme: any, _context: any): any {
	const { Container, Text } = requireTui();
	const filePath = args?.image_path ?? "?";
	const analyze = Array.isArray(args?.analyze) ? args.analyze.join(", ") : "ocr";
	const lang = args?.lang ?? "default";

	const container = new Container();
	container.addChild(new Text(`📷 Analyze image`, theme.fg("accent", {})));
	container.addChild(new Text(`   file: ${filePath}`, theme.fg("dim", {})));
	container.addChild(new Text(`   analyze: [${analyze}]  lang: ${lang}`, theme.fg("dim", {})));
	container.addChild(new Text(``));
	return container;
}

function renderResult(result: any, _options: any, theme: any, _context: any): any {
	const { Container, Text } = requireTui();
	const container = new Container();

	const data = result?.content?.[0]?.text ?? "";
	let parsed: AnalyzeResult;
	try {
		parsed = JSON.parse(data);
	} catch {
		container.addChild(new Text(data, {}));
		container.addChild(new Text(``));
		return container;
	}

	// Debug info in header
	const debugParts: string[] = [];
	if (parsed.latency_hint && parsed.latency_hint !== "N/A") debugParts.push(`latency: ${parsed.latency_hint}`);
	if (parsed.error) debugParts.push(`error: ${parsed.error}`);
	if (debugParts.length > 0) {
		container.addChild(new Text(`🔧 ${debugParts.join(" · ")}`, theme.fg("dim", {})));
	}

	// Image type
	if (parsed.image_type && parsed.image_type !== "unknown") {
		container.addChild(new Text(`📂 type: ${parsed.image_type}`, theme.fg("accent", {})));
	}

	// Metadata
	const m = parsed.metadata;
	if (m && m.width > 0) {
		container.addChild(
			new Text(
				`   ${m.width}×${m.height}  ${m.format.toUpperCase()}  ${(m.size_bytes / 1024).toFixed(1)}KB` +
					(m.has_transparency ? "  α" : ""),
				theme.fg("dim", {}),
			),
		);
	} else if (m && m.format) {
		container.addChild(new Text(`   (metadata: ${m.format})`, theme.fg("dim", {})));
	}

	// Caption
	if (parsed.caption) {
		container.addChild(new Text(`   🎯 ${parsed.caption}`, theme.fg("accent", {})));
	}

	// OCR text
	if (parsed.text) {
		const conf = parsed.confidence;
		const confColor = conf > 0.9 ? "success" : conf > 0.6 ? "warning" : "error";
		const lines = parsed.text.split("\n").slice(0, 20);
		container.addChild(new Text(`   📝 confidence: ${(conf * 100).toFixed(0)}%`, theme.fg(confColor, {})));
		container.addChild(new Text(``));
		for (const line of lines) {
			container.addChild(new Text(`   ${line}`, {}));
		}
		if (lines.length < parsed.text.split("\n").length) {
			container.addChild(new Text(`   … (truncated)`, theme.fg("dim", {})));
		}
	}

	// Colors summary
	if (parsed.colors && parsed.colors.length > 0) {
		const colorNames = parsed.colors.map((c: DominantColor) => `${c.name} ${c.pct}%`).join("  ");
		container.addChild(new Text(`   🎨 ${colorNames}`, theme.fg("dim", {})));
	}

	// Error
	if (parsed.error) {
		container.addChild(new Text(`   ❌ ${parsed.error}`, theme.fg("error", {})));
	}

	container.addChild(new Text(``));
	return container;
}

function requireTui(): any {
	const require = createRequire(import.meta.url);
	return require("@earendil-works/pi-tui");
}

// ─── Save base64 image to temp file ──────────────────────────────────────────

function saveBase64Image(data: string, mimeType: string): string {
	const ext = mimeType === "image/png" ? "png"
		: mimeType === "image/jpeg" ? "jpg"
		: mimeType === "image/gif" ? "gif"
		: mimeType === "image/webp" ? "webp"
		: "png";
	const tmpDir = path.join(os.tmpdir(), "pi-analyze-image");
	fs.mkdirSync(tmpDir, { recursive: true });
	const tmpFile = path.join(tmpDir, `pasted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
	fs.writeFileSync(tmpFile, Buffer.from(data, "base64"));
	return tmpFile;
}

// ─── Handle pasted images before agent starts ─────────────────────────────────

async function handlePastedImages(event: any, config: Config): Promise<{ text: string; tmpFiles: string[] }> {
	const images = event.images as Array<{ type: string; data: string; mimeType: string }> | undefined;
	if (!images || images.length === 0) return { text: "", tmpFiles: [] };

	const parts: string[] = [];
	const tmpFiles: string[] = [];

	for (let i = 0; i < images.length; i++) {
		const img = images[i];
		try {
			const tmpPath = saveBase64Image(img.data, img.mimeType);
			tmpFiles.push(tmpPath);
			const analyze: ("ocr" | "caption" | "classify")[] = ["ocr", "classify"];
			if (config.captioning_enabled) {
				analyze.push("caption");
			}
			const result = await analyzeImage(tmpPath, { image_path: tmpPath, analyze }, config);

			const lines: string[] = [];
			lines.push(`--- Image ${i + 1} ---`);
			if (result.image_type && result.image_type !== "unknown") {
				lines.push(`Type: ${result.image_type}`);
			}
			if (result.metadata.width > 0) {
				lines.push(`Dimensions: ${result.metadata.width}x${result.metadata.height}`);
			}
			if (result.text) {
				lines.push(`Text extracted (confidence: ${(result.confidence * 100).toFixed(0)}%):`);
				lines.push(result.text);
			}
			if (result.error) {
				lines.push(`Error: ${result.error}`);
			}
			parts.push(lines.join("\n"));
		} catch (err) {
			parts.push(`--- Image ${i + 1} ---\nFailed to analyze: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return { text: parts.join("\n\n"), tmpFiles };
}

function cleanupTempFiles(files: string[]): void {
	for (const f of files) {
		try { fs.unlinkSync(f); } catch {}
	}
}

// ─── Read clipboard file paths via shell ───────────────────────────────────────

function readClipboardUriList(): string[] {
	// 1) Wayland: wl-paste
	try {
		const out = execSync("wl-paste -t text/uri-list 2>/dev/null", { timeout: 2000, encoding: "utf-8" });
		if (out) {
			const paths = out.split(/[\r\n]+/)
				.map(l => l.trim())
				.filter(l => l.startsWith("file://"))
				.map(l => decodeURIComponent(l.replace(/^file:\/\//, "")));
			if (paths.length > 0) return paths;
		}
	} catch {}

	// 2) X11: xclip
	try {
		const out = execSync("xclip -o -selection clipboard -t text/uri-list 2>/dev/null", { timeout: 2000, encoding: "utf-8" });
		if (out) {
			const paths = out.split(/[\r\n]+/)
				.map(l => l.trim())
				.filter(l => l.startsWith("file://"))
				.map(l => decodeURIComponent(l.replace(/^file:\/\//, "")));
			if (paths.length > 0) return paths;
		}
	} catch {}

	return [];
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	const config = loadConfig();

	// Intercept pasted images via the `input` event.
	// When the user pastes an image, we replace it with OCR text so the
	// text-only LLM can "see" it. This avoids duplicate messages and
	// prevents the agent from constructing fake file paths.
	pi.on("input", async (event: any, _ctx: any) => {
		// If the current model supports vision natively, let images pass through
		const modelSupportsVision = _ctx?.model?.input?.includes?.("image");
		if (modelSupportsVision) {
			return { action: "continue" };
		}

		if (!event.images || event.images.length === 0) {
			return { action: "continue" };
		}

		const { text, tmpFiles } = await handlePastedImages(event, loadConfig());

		// Don't clean up temp files — let the agent reuse them
		// (e.g. to call analyze_image with caption on the same image)

		// Also try to get the original file path from clipboard (if user copied from file manager)
		let clipboardPaths: string[] = [];
		try {
			clipboardPaths = readClipboardUriList();
		} catch {}

		if (!text && clipboardPaths.length === 0) {
			return { action: "continue" };
		}

		// Build analysis text with path info
		const imgCount = event.images.length;
		const lines: string[] = [
			`[The user pasted ${imgCount > 1 ? `${imgCount} images` : "an image"}. `,
			`Since your model doesn't support vision directly, here is the extracted content. `,
			`This image has already been fully analyzed — do NOT call analyze_image on it.]`,
		];

		// Only mention clipboard path if user explicitly needs it
		if (clipboardPaths.length > 0) {
			lines.push(`Original file path (reference): ${clipboardPaths[0]}`);
			lines.push("");
		}

		if (text) {
			lines.push(text);
		}

		const analysisNote = lines.join("\n");
		const modifiedText = event.text
			? `${event.text}\n\n${analysisNote}`
			: analysisNote;

		return {
			action: "transform",
			text: modifiedText,
			images: [], // remove raw image data from prompt
		};
	});

	// Clean up old temp files on startup (older than 1 hour)
	try {
		const tmpDir = path.join(os.tmpdir(), "pi-analyze-image");
		if (fs.existsSync(tmpDir)) {
			const now = Date.now();
			const files = fs.readdirSync(tmpDir);
			for (const f of files) {
				const fp = path.join(tmpDir, f);
				try {
					const stat = fs.statSync(fp);
					if (now - stat.mtimeMs > 3_600_000) { // older than 1 hour
						fs.unlinkSync(fp);
					}
				} catch {}
			}
		}
	} catch {}

	// /clipboard debug command — shows clipboard contents
	pi.registerCommand("clipboard", {
		description: "Show clipboard contents (file paths and image info) for debugging",
		handler: async (_args: string, ctx: any) => {
			const lines: string[] = ["📋 Clipboard debug:"];

			// File paths from clipboard
			try {
				const paths = readClipboardUriList();
				if (paths.length > 0) {
					lines.push("  File paths:");
					for (const p of paths) {
						const exists = fs.existsSync(p) ? "exists" : "NOT FOUND";
						lines.push(`    ${p} (${exists})`);
					}
					// Also try to show image metadata for each path
					for (const p of paths) {
						if (fs.existsSync(p)) {
							try {
								const meta = readImageMetadata(p);
								if (meta.width > 0) {
									lines.push(`    → ${meta.width}\u00d7${meta.height} ${meta.format.toUpperCase()}`);
								}
							} catch {}
						}
					}
				} else {
					lines.push("  File paths: none — screenshot/raw paste");
					lines.push("  (The image was pasted as raw data (e.g., screenshot from Spectacle/Flameshot).");
					lines.push("   Our auto-analysis in the input handler already extracted text from it.");
					lines.push("   If you need further analysis, the temp file path is in the analysis output.)");
				}
			} catch (err) {
				lines.push(`  Error reading clipboard: ${err}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerTool({
		name: "analyze_image",
		label: "Analyze Image",
		description:
			"Extract text (OCR) and metadata from an image file, and optionally generate a caption. " +
			"Lets text-only LLMs 'see' images without vision capability. " +
			"Works with screenshots, error dialogs, documents, photos, and UI layouts.",
		promptGuidelines: [
			"Use analyze_image ONLY when the user explicitly asks you to analyze an image file by path",
			"Do NOT call analyze_image automatically — only use it after the user asks",
			"If the user pastes an image in chat, it was already analyzed. Do NOT analyze it again.",
			"Pass image_path as an absolute path. Do NOT pass relative paths or URLs.",
			"By default OCR + metadata only. Add analyze: ['caption'] for visual description (slower).",
		],
		parameters: {
			type: "object",
			properties: {
				image_path: {
					type: "string",
					description: "Absolute path to the image file (PNG, JPEG, GIF, WebP). Required.",
				},
				lang: {
					type: "string",
					description:
						"OCR language(s). Default: 'eng+rus'. Examples: 'eng', 'rus', 'deu', 'fra', 'eng+rus'.",
				},
				analyze: {
					type: "array",
					items: { type: "string", enum: ["ocr", "caption", "classify"] },
					description:
						"What analysis to perform. Default: ['ocr']. " +
						"Options: 'ocr' (text extraction), 'caption' (visual description, slower, requires model download), " +
						"'classify' (classify image type).",
				},
			},
			required: ["image_path"],
		} as any,
		execute: async (toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) => {
			// Report progress after each stage
			const update = (msg: string) => {
				if (onUpdate) onUpdate({ content: [{ type: "text" as const, text: msg }] });
			};

			if (signal?.aborted) {
				return { content: [{ type: "text" as const, text: "Analysis cancelled" }], details: {} };
			}

			update("📷 Reading metadata...");
			const result = await analyzeImage(params.image_path, params as AnalyzeImageParams, loadConfig(), signal, update);

			if (signal?.aborted) {
				return { content: [{ type: "text" as const, text: "Analysis cancelled" }], details: {} };
			}

			// Build result content
			const content: any[] = [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];

			// Also return the image as a content block so clients (pi-pine) can display it
			const resolvedPath = path.resolve(params.image_path);
			if (resolvedPath && fs.existsSync(resolvedPath)) {
				try {
					const imgBuffer = fs.readFileSync(resolvedPath);
					const mimeType = result.metadata?.format === "png" ? "image/png"
						: result.metadata?.format === "jpeg" || result.metadata?.format === "jpg" ? "image/jpeg"
						: result.metadata?.format === "gif" ? "image/gif"
						: result.metadata?.format === "webp" ? "image/webp"
						: "image/png";
					content.push({ type: "image", data: imgBuffer.toString("base64"), mimeType });
				} catch {
					// ignore — image is optional in response
				}
			}

			update("✅ Analyzing complete");
			return {
				content,
				details: result,
			};
		},
		renderCall,
		renderResult,
	});
}
