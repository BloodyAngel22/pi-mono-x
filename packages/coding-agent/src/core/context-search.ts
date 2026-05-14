import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { ensureTool } from "../utils/tools-manager.js";

export interface FastContextRange {
	start: number;
	end: number;
	snippet?: string;
}

export interface FastContextFile {
	path: string;
	ranges?: string[];
	snippets?: FastContextRange[];
	score?: number;
	reason?: string;
}

export interface FastContextResult {
	query: string;
	files: FastContextFile[];
	fallback?: "lexical";
	elapsedMs?: number;
}

export interface FastContextOptions {
	maxFiles?: number;
	maxMatches?: number;
	contextLines?: number;
	includeSnippets?: boolean;
}

interface IndexedSymbol {
	name: string;
	kind:
		| "function"
		| "class"
		| "method"
		| "interface"
		| "type"
		| "enum"
		| "const"
		| "component"
		| "command"
		| "tool"
		| "struct"
		| "trait"
		| "module";
	path: string;
	startLine: number;
	endLine: number;
	exported?: boolean;
	parent?: string;
	signature?: string;
}

interface ImportEdge {
	from: string;
	to?: string;
	rawSpecifier: string;
	kind: "import" | "require" | "dynamic" | "export" | "mod" | "use";
	confidence: number;
}

interface IndexedFile {
	path: string;
	abs: string;
	mtimeMs: number;
	size: number;
	language: string;
	symbols: IndexedSymbol[];
	imports: ImportEdge[];
}

interface ProjectStructureIndex {
	cwd: string;
	builtAt: number;
	files: Map<string, IndexedFile>;
	symbols: IndexedSymbol[];
	imports: ImportEdge[];
	reverseImports: Map<string, string[]>;
}

const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_CONTEXT_LINES = 3;
const MAX_SNIPPET_RANGES = 3;
const MAX_SNIPPET_CHARS = 1200;
const STRUCTURE_INDEX_TTL_MS = 60_000;
const STRUCTURE_FILE_LIMIT = 5000;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py"]);
const TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".md",
	".mdx",
	".rs",
	".go",
	".py",
	".java",
	".kt",
	".swift",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".cs",
	".php",
	".rb",
	".dart",
	".vue",
	".svelte",
	".html",
	".css",
	".scss",
	".yaml",
	".yml",
	".toml",
	".xml",
]);

const QUERY_EXPANSIONS: Record<string, string[]> = {
	кнопка: ["button", "btn"],
	кнопку: ["button", "btn"],
	отправка: ["send", "submit"],
	отправить: ["send", "submit"],
	сообщение: ["message", "prompt"],
	сообщения: ["messages", "prompt"],
	контекст: ["context", "contextUsage", "contextWindow"],
	контекста: ["context", "contextUsage", "contextWindow"],
	сессия: ["session", "sessionState"],
	сессии: ["session", "sessionState"],
	агент: ["agent", "AgentSession"],
	агента: ["agent", "AgentSession"],
	субагент: ["subagent", "task"],
	субагенты: ["subagent", "task"],
	инструмент: ["tool", "ToolDefinition"],
	инструменты: ["tools", "ToolDefinition"],
	поиск: ["search", "find", "grep"],
	найти: ["search", "find", "grep"],
	ошибка: ["error", "Error"],
	настройки: ["settings", "config"],
	команда: ["command", "slash"],
	команды: ["commands", "slash"],
	чат: ["chat", "message"],
	модель: ["model", "provider"],
	модели: ["models", "provider"],
	authorization: ["auth", "login", "session"],
	auth: ["authorization", "login", "session"],
	button: ["btn"],
	send: ["submit", "sendPrompt"],
	submit: ["send", "sendPrompt"],
	context: ["contextUsage", "contextWindow"],
	session: ["sessionState", "sessionStats"],
};

const structureIndexCache = new Map<string, ProjectStructureIndex>();

function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ");
}

function addTerm(terms: Set<string>, term: string): void {
	const normalized = term.trim();
	if (!normalized || normalized.length < 3) return;
	terms.add(normalized);
	const expansions = QUERY_EXPANSIONS[normalized.toLowerCase()];
	if (expansions) for (const expansion of expansions) terms.add(expansion);
}

function extractTerms(query: string): string[] {
	const terms = new Set<string>();
	const cleaned = query
		.replace(/[`'"“”‘’()[\]{}<>.,:;!?/\\|]/g, " ")
		.split(/\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
	for (const word of cleaned) {
		if (word.length < 3) continue;
		if (/^(the|and|for|with|from|this|that|как|где|что|это|для|или|при|над|под|надо|нужно|можно)$/i.test(word))
			continue;
		addTerm(terms, word);
	}
	for (const match of query.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
		const value = match[0];
		if (value.length >= 3) addTerm(terms, value);
	}
	return [...terms].slice(0, 24);
}

function pathScore(relativePath: string): number {
	const p = relativePath.toLowerCase();
	let score = 0;
	if (/(^|\/)src\//.test(p)) score += 12;
	if (/(^|\/)packages\/[^/]+\/src\//.test(p)) score += 12;
	if (/(^|\/)(app|apps|lib|core|components|features|server|client)\//.test(p)) score += 6;
	if (/\.(test|spec)\.[tj]sx?$/.test(p)) score -= 4;
	if (/(^|\/)(__tests__|test|tests)\//.test(p)) score -= 2;
	if (/(^|\/)(docs|examples|assets|fixtures|vendor)\//.test(p)) score -= 8;
	if (/(^|\/)(dist|build|coverage|target|node_modules|\.git)\//.test(p)) score -= 30;
	if (/(^|\/)(changelog|license|package-lock|tsconfig\.tsbuildinfo)/.test(p)) score -= 14;
	if (/\.(md|mdx)$/.test(p)) score -= 4;
	if (/\.(ts|tsx|rs|go|py|java|kt|swift|dart|vue|svelte)$/.test(p)) score += 4;
	return score;
}

function fileNameBoost(relativePath: string, terms: string[]): number {
	const base = path.basename(relativePath).toLowerCase();
	let score = 0;
	for (const term of terms) {
		const t = term.toLowerCase();
		if (base === t || base === `${t}.ts` || base === `${t}.tsx`) score += 20;
		else if (base.includes(t)) score += 8;
	}
	return score;
}

function relativeToCwd(cwd: string, file: string): string {
	const rel = path.relative(cwd, file);
	return (rel && !rel.startsWith("..") ? rel : file).replace(/\\/g, "/");
}

function mergeRange(
	ranges: Array<{ start: number; end: number }>,
	next: { start: number; end: number },
): Array<{ start: number; end: number }> {
	const result = [...ranges, next].sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of result) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end + 2) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged.slice(0, 4);
}

function trimSnippet(snippet: string): string {
	return snippet.length > MAX_SNIPPET_CHARS ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}\n...` : snippet;
}

function readSnippet(absPath: string, start: number, end: number): string | undefined {
	try {
		const lines = readFileSync(absPath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		return trimSnippet(
			lines
				.slice(Math.max(0, start - 1), Math.min(lines.length, end))
				.map((line, idx) => `${start + idx}: ${line}`)
				.join("\n"),
		);
	} catch {
		return undefined;
	}
}

function languageForPath(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".ts":
		case ".tsx":
			return "typescript";
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return "javascript";
		case ".rs":
			return "rust";
		case ".py":
			return "python";
		default:
			return "text";
	}
}

function lineForOffset(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

function symbolEndLine(lines: string[], startLine: number): number {
	let end = startLine;
	for (let i = startLine; i < Math.min(lines.length, startLine + 80); i++) {
		const line = lines[i - 1] ?? "";
		if (
			i > startLine &&
			/^\s*(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|def|class|fn|struct|enum|trait)\b/.test(
				line,
			)
		)
			break;
		end = i;
		if (i > startLine + 2 && /^\S/.test(line) && line.trim().endsWith("}")) break;
	}
	return end;
}

function addSymbol(
	symbols: IndexedSymbol[],
	text: string,
	lines: string[],
	match: RegExpExecArray,
	nameIndex: number,
	kind: IndexedSymbol["kind"],
	relPath: string,
	exported = false,
): void {
	const name = match[nameIndex];
	if (!name) return;
	const startLine = lineForOffset(text, match.index);
	symbols.push({
		name,
		kind,
		path: relPath,
		startLine,
		endLine: symbolEndLine(lines, startLine),
		exported,
		signature: match[0].trim().slice(0, 180),
	});
}

function extractSymbols(relPath: string, content: string, language: string): IndexedSymbol[] {
	const symbols: IndexedSymbol[] = [];
	const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const specs: Array<[RegExp, number, IndexedSymbol["kind"], boolean?]> = [];
	if (language === "typescript" || language === "javascript") {
		specs.push([/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, 1, "function", true]);
		specs.push([/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, 1, "function"]);
		specs.push([/\bexport\s+class\s+([A-Za-z_$][\w$]*)\b/g, 1, "class", true]);
		specs.push([/\bclass\s+([A-Za-z_$][\w$]*)\b/g, 1, "class"]);
		specs.push([/\bexport\s+interface\s+([A-Za-z_$][\w$]*)\b/g, 1, "interface", true]);
		specs.push([/\binterface\s+([A-Za-z_$][\w$]*)\b/g, 1, "interface"]);
		specs.push([/\bexport\s+type\s+([A-Za-z_$][\w$]*)\b/g, 1, "type", true]);
		specs.push([/\btype\s+([A-Za-z_$][\w$]*)\b/g, 1, "type"]);
		specs.push([/\bexport\s+enum\s+([A-Za-z_$][\w$]*)\b/g, 1, "enum", true]);
		specs.push([
			/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
			1,
			"function",
			true,
		]);
		specs.push([/\bconst\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, 1, "component"]);
		specs.push([
			/\b(?:public|private|protected|static|async|readonly|override|\s)+\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[{;]/g,
			1,
			"method",
		]);
		specs.push([/\bpi\.registerTool\s*\(\s*{[\s\S]{0,400}?name:\s*["']([^"']+)["']/g, 1, "tool", true]);
		specs.push([/\bcase\s+["']([^"']+)["']\s*:/g, 1, "command"]);
	} else if (language === "rust") {
		specs.push([/\b(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/g, 1, "function"]);
		specs.push([/\b(?:pub\s+)?struct\s+([A-Za-z_][\w]*)\b/g, 1, "struct"]);
		specs.push([/\b(?:pub\s+)?enum\s+([A-Za-z_][\w]*)\b/g, 1, "enum"]);
		specs.push([/\b(?:pub\s+)?trait\s+([A-Za-z_][\w]*)\b/g, 1, "trait"]);
		specs.push([/\bmod\s+([A-Za-z_][\w]*)\s*;/g, 1, "module"]);
	} else if (language === "python") {
		specs.push([/^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm, 1, "function"]);
		specs.push([/^\s*async\s+def\s+([A-Za-z_][\w]*)\s*\(/gm, 1, "function"]);
		specs.push([/^\s*class\s+([A-Za-z_][\w]*)\b/gm, 1, "class"]);
	}
	for (const [regex, nameIndex, kind, exported] of specs) {
		let match = regex.exec(content);
		while (match !== null) {
			addSymbol(
				symbols,
				content,
				lines,
				match,
				nameIndex,
				kind,
				relPath,
				Boolean(exported || /\bexport\b|\bpub\b/.test(match[0])),
			);
			match = regex.exec(content);
		}
	}
	const seen = new Set<string>();
	return symbols
		.filter((s) => {
			const key = `${s.kind}:${s.name}:${s.startLine}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, 250);
}

function resolveTsImport(fromRel: string, specifier: string, fileSet: Set<string>): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		`${base}.mjs`,
		`${base}.cjs`,
		path.posix.join(base, "index.ts"),
		path.posix.join(base, "index.tsx"),
		path.posix.join(base, "index.js"),
		path.posix.join(base, "index.jsx"),
	];
	return candidates.find((candidate) => fileSet.has(candidate));
}

function extractImports(relPath: string, content: string, language: string, fileSet: Set<string>): ImportEdge[] {
	const imports: ImportEdge[] = [];
	const push = (rawSpecifier: string, kind: ImportEdge["kind"], confidence = 0.8) => {
		const to =
			language === "typescript" || language === "javascript"
				? resolveTsImport(relPath, rawSpecifier, fileSet)
				: undefined;
		imports.push({ from: relPath, to, rawSpecifier, kind, confidence: to ? confidence : Math.min(confidence, 0.35) });
	};
	if (language === "typescript" || language === "javascript") {
		for (const regex of [
			/\bimport\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
			/\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g,
			/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
			/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		]) {
			let match = regex.exec(content);
			while (match !== null) {
				push(
					match[1],
					regex.source.includes("export")
						? "export"
						: regex.source.includes("require")
							? "require"
							: regex.source.includes("import\\s\\*")
								? "dynamic"
								: "import",
				);
				match = regex.exec(content);
			}
		}
	} else if (language === "rust") {
		let match = /\bmod\s+([A-Za-z_][\w]*)\s*;/g.exec(content);
		while (match !== null) {
			imports.push({ from: relPath, rawSpecifier: match[1], kind: "mod", confidence: 0.3 });
			match = /\bmod\s+([A-Za-z_][\w]*)\s*;/g.exec(content);
		}
		for (const m of content.matchAll(/\buse\s+([^;]+);/g))
			imports.push({ from: relPath, rawSpecifier: m[1].trim(), kind: "use", confidence: 0.25 });
	} else if (language === "python") {
		for (const m of content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm))
			imports.push({ from: relPath, rawSpecifier: m[1] || m[2], kind: "import", confidence: 0.25 });
	}
	return imports.slice(0, 200);
}

async function listSourceFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const fdPath = await ensureTool("fd", true);
	if (!fdPath) return [];
	return new Promise((resolve) => {
		const args = [
			"--type",
			"f",
			"--hidden",
			"--exclude",
			".git",
			"--exclude",
			"node_modules",
			"--exclude",
			"dist",
			"--exclude",
			"build",
			"--exclude",
			"coverage",
			"--exclude",
			"target",
			cwd,
		];
		const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "ignore"] });
		const out: string[] = [];
		let buf = "";
		let killed = false;
		const onAbort = () => {
			killed = true;
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => {
			buf += chunk.toString();
			let idx = buf.indexOf("\n");
			while (idx >= 0) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (line && SOURCE_EXTENSIONS.has(path.extname(line).toLowerCase())) out.push(line);
				if (out.length >= STRUCTURE_FILE_LIMIT) {
					killed = true;
					child.kill();
					break;
				}
				idx = buf.indexOf("\n");
			}
		});
		child.on("close", () => {
			signal?.removeEventListener("abort", onAbort);
			if (!killed && buf.trim() && SOURCE_EXTENSIONS.has(path.extname(buf.trim()).toLowerCase()))
				out.push(buf.trim());
			resolve(out.slice(0, STRUCTURE_FILE_LIMIT));
		});
		child.on("error", () => resolve(out));
	});
}

async function getStructureIndex(cwd: string, signal?: AbortSignal): Promise<ProjectStructureIndex> {
	const cached = structureIndexCache.get(cwd);
	if (cached && Date.now() - cached.builtAt < STRUCTURE_INDEX_TTL_MS) return cached;
	const absFiles = await listSourceFiles(cwd, signal).catch(() => []);
	const relFiles = absFiles.map((f) => relativeToCwd(cwd, f));
	const fileSet = new Set(relFiles);
	const files = new Map<string, IndexedFile>();
	const allSymbols: IndexedSymbol[] = [];
	const allImports: ImportEdge[] = [];
	for (const abs of absFiles) {
		try {
			const st = statSync(abs);
			if (!st.isFile() || st.size > 512_000) continue;
			const rel = relativeToCwd(cwd, abs);
			const language = languageForPath(rel);
			const content = readFileSync(abs, "utf8");
			const symbols = extractSymbols(rel, content, language);
			const imports = extractImports(rel, content, language, fileSet);
			const indexed: IndexedFile = {
				path: rel,
				abs,
				mtimeMs: st.mtimeMs,
				size: st.size,
				language,
				symbols,
				imports,
			};
			files.set(rel, indexed);
			allSymbols.push(...symbols);
			allImports.push(...imports);
		} catch {
			// ignore unreadable files
		}
	}
	const reverseImports = new Map<string, string[]>();
	for (const edge of allImports) {
		if (!edge.to) continue;
		const arr = reverseImports.get(edge.to) ?? [];
		arr.push(edge.from);
		reverseImports.set(edge.to, arr);
	}
	const index = { cwd, builtAt: Date.now(), files, symbols: allSymbols, imports: allImports, reverseImports };
	structureIndexCache.set(cwd, index);
	return index;
}

async function runRg(
	cwd: string,
	terms: string[],
	maxMatches: number,
	signal?: AbortSignal,
): Promise<Array<{ file: string; line: number; text: string; term: string }>> {
	const rgPath = await ensureTool("rg", true);
	if (!rgPath || terms.length === 0) return [];
	const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	return new Promise((resolve, reject) => {
		const args = [
			"--json",
			"--line-number",
			"--color=never",
			"--hidden",
			"--ignore-case",
			"--glob",
			"!node_modules/**",
			"--glob",
			"!.git/**",
			"--glob",
			"!dist/**",
			"--glob",
			"!target/**",
			"-e",
			pattern,
			cwd,
		];
		const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		const matches: Array<{ file: string; line: number; text: string; term: string }> = [];
		let stderr = "";
		let killed = false;
		const cleanup = () => {
			rl.close();
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			killed = true;
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		rl.on("line", (line) => {
			if (matches.length >= maxMatches) {
				killed = true;
				child.kill();
				return;
			}
			try {
				const event = JSON.parse(line);
				if (event.type !== "match") return;
				const file = event.data?.path?.text;
				const lineNumber = event.data?.line_number;
				const text = String(event.data?.lines?.text ?? "").replace(/\n$/, "");
				if (!file || typeof lineNumber !== "number") return;
				const lower = text.toLowerCase();
				const term = terms.find((t) => lower.includes(t.toLowerCase())) ?? terms[0];
				matches.push({ file, line: lineNumber, text, term });
			} catch {}
		});
		child.on("error", (err) => {
			cleanup();
			reject(err);
		});
		child.on("close", (code) => {
			cleanup();
			if (!killed && code !== 0 && code !== 1)
				reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
			else resolve(matches);
		});
	});
}

async function runFd(cwd: string, terms: string[], limit: number, signal?: AbortSignal): Promise<string[]> {
	const fdPath = await ensureTool("fd", true);
	if (!fdPath || terms.length === 0) return [];
	const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	return new Promise((resolve) => {
		const args = [
			"--type",
			"f",
			"--hidden",
			"--exclude",
			".git",
			"--exclude",
			"node_modules",
			"--exclude",
			"dist",
			"--exclude",
			"target",
			"--ignore-case",
			pattern,
			cwd,
		];
		const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "ignore"] });
		const out: string[] = [];
		let buf = "";
		let killed = false;
		const onAbort = () => {
			killed = true;
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => {
			buf += chunk.toString();
			let idx = buf.indexOf("\n");
			while (idx >= 0) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (line) out.push(line);
				if (out.length >= limit) {
					killed = true;
					child.kill();
					break;
				}
				idx = buf.indexOf("\n");
			}
		});
		child.on("close", () => {
			signal?.removeEventListener("abort", onAbort);
			if (!killed && buf.trim()) out.push(buf.trim());
			resolve(out.slice(0, limit));
		});
		child.on("error", () => resolve(out));
	});
}

function testPairCandidates(relPath: string, fileSet: Set<string>): string[] {
	const ext = path.posix.extname(relPath);
	const withoutExt = relPath.slice(0, -ext.length);
	const base = path.posix.basename(withoutExt);
	const dir = path.posix.dirname(relPath);
	const candidates = [
		`${withoutExt}.test${ext}`,
		`${withoutExt}.spec${ext}`,
		path.posix.join(dir, "__tests__", `${base}.test${ext}`),
		path.posix.join("tests", `${base}.test${ext}`),
		path.posix.join("test", `${base}.test${ext}`),
	];
	return candidates.filter((candidate) => fileSet.has(candidate));
}

export async function fastContextSearch(
	cwd: string,
	query: string,
	options: FastContextOptions = {},
	signal?: AbortSignal,
): Promise<FastContextResult> {
	const started = Date.now();
	const normalized = normalizeQuery(query);
	if (!normalized) return { query, files: [], fallback: "lexical", elapsedMs: 0 };
	const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
	const maxMatches = Math.max(maxFiles, options.maxMatches ?? DEFAULT_MAX_MATCHES);
	const contextLines = Math.max(0, options.contextLines ?? DEFAULT_CONTEXT_LINES);
	const terms = extractTerms(normalized);
	const [matches, pathHits, structure] = await Promise.all([
		runRg(cwd, terms.length ? terms : [normalized], maxMatches, signal).catch(() => []),
		runFd(cwd, terms, maxFiles * 4, signal).catch(() => []),
		getStructureIndex(cwd, signal).catch(() => undefined),
	]);

	const files = new Map<
		string,
		{ abs: string; score: number; terms: Set<string>; ranges: Array<{ start: number; end: number }> }
	>();
	const ensure = (abs: string) => {
		let item = files.get(abs);
		if (!item) {
			item = { abs, score: 0, terms: new Set(), ranges: [] };
			files.set(abs, item);
		}
		return item;
	};
	const addFileScore = (rel: string, score: number, reason: string, range?: { start: number; end: number }) => {
		const abs = path.resolve(cwd, rel);
		const item = ensure(abs);
		item.score += score + pathScore(rel) + fileNameBoost(rel, terms);
		item.terms.add(reason);
		if (range) item.ranges = mergeRange(item.ranges, range);
	};

	for (const match of matches) {
		const item = ensure(match.file);
		item.score += 10;
		item.terms.add(match.term);
		item.ranges = mergeRange(item.ranges, {
			start: Math.max(1, match.line - contextLines),
			end: match.line + contextLines,
		});
		if (TEXT_EXTENSIONS.has(path.extname(match.file).toLowerCase())) item.score += 1;
	}

	for (const hit of pathHits) {
		const abs = path.isAbsolute(hit) ? hit : path.resolve(cwd, hit);
		if (!existsSync(abs)) continue;
		try {
			if (!statSync(abs).isFile()) continue;
		} catch {
			continue;
		}
		const rel = relativeToCwd(cwd, abs);
		const item = ensure(abs);
		item.score += 6 + pathScore(rel) + fileNameBoost(rel, terms);
		for (const term of terms) if (rel.toLowerCase().includes(term.toLowerCase())) item.terms.add(term);
	}

	if (structure) {
		const loweredTerms = terms.map((t) => t.toLowerCase());
		for (const symbol of structure.symbols) {
			const symbolName = symbol.name.toLowerCase();
			let boost = 0;
			for (const term of loweredTerms) {
				if (symbolName === term) boost += 70;
				else if (symbolName.includes(term) || term.includes(symbolName)) boost += 30;
			}
			if (boost <= 0) continue;
			if (symbol.exported) boost += 8;
			if (symbol.kind === "tool" || symbol.kind === "command") boost += 10;
			addFileScore(symbol.path, boost, `symbol:${symbol.name}`, {
				start: Math.max(1, symbol.startLine - 1),
				end: symbol.endLine,
			});
		}

		const seeded = [...files.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, Math.min(maxFiles, 8))
			.map((item) => relativeToCwd(cwd, item.abs));
		for (const rel of seeded) {
			const indexed = structure.files.get(rel);
			for (const edge of indexed?.imports ?? [])
				if (edge.to) addFileScore(edge.to, 8 * edge.confidence, `imported-by:${path.posix.basename(rel)}`);
			for (const importer of structure.reverseImports.get(rel) ?? [])
				addFileScore(importer, 7, `imports:${path.posix.basename(rel)}`);
			for (const test of testPairCandidates(rel, new Set(structure.files.keys())))
				addFileScore(test, 14, `test:${path.posix.basename(rel)}`);
		}
	}

	const resultFiles: FastContextFile[] = [...files.values()]
		.sort((a, b) => {
			const aRel = relativeToCwd(cwd, a.abs);
			const bRel = relativeToCwd(cwd, b.abs);
			const aScore = a.score + pathScore(aRel) + fileNameBoost(aRel, terms);
			const bScore = b.score + pathScore(bRel) + fileNameBoost(bRel, terms);
			return bScore - aScore || aRel.localeCompare(bRel);
		})
		.slice(0, maxFiles)
		.map((item) => {
			const ranges = item.ranges.map((r) => `${r.start}-${r.end}`);
			const snippetRanges = item.ranges.slice(0, MAX_SNIPPET_RANGES);
			return {
				path: relativeToCwd(cwd, item.abs),
				ranges: ranges.length ? ranges : undefined,
				snippets: options.includeSnippets
					? snippetRanges.map((r) => ({ ...r, snippet: readSnippet(item.abs, r.start, r.end) }))
					: undefined,
				score: Math.round(
					item.score +
						pathScore(relativeToCwd(cwd, item.abs)) +
						fileNameBoost(relativeToCwd(cwd, item.abs), terms),
				),
				reason: item.terms.size ? `matched: ${[...item.terms].slice(0, 5).join(", ")}` : "path match",
			};
		});

	return { query: normalized, files: resultFiles, fallback: "lexical", elapsedMs: Date.now() - started };
}

export function formatFastContextResult(result: FastContextResult): string {
	if (!result.files.length) return `No fast context results for: ${result.query}`;
	const lines: string[] = [`Fast context results for: ${result.query}`];
	for (const file of result.files) {
		lines.push(
			`- ${file.path}${file.ranges?.length ? ` (${file.ranges.join(", ")})` : ""}${file.reason ? ` — ${file.reason}` : ""}`,
		);
		for (const snippet of file.snippets ?? []) {
			if (!snippet.snippet) continue;
			lines.push("  ```");
			lines.push(
				snippet.snippet
					.split("\n")
					.map((line) => `  ${line}`)
					.join("\n"),
			);
			lines.push("  ```");
		}
	}
	return lines.join("\n");
}
