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
	path?: string;
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
	bodyText: string;
	symbols: IndexedSymbol[];
	imports: ImportEdge[];
}

interface ProjectStructureIndex {
	cwd: string;
	builtAt: number;
	files: Map<string, IndexedFile>;
	mtimes: Map<string, number>;
	symbols: IndexedSymbol[];
	imports: ImportEdge[];
	reverseImports: Map<string, string[]>;
	bm25Stats: Bm25CorpusStats;
}

interface Bm25Field {
	text: string;
	weight: number;
}

interface Bm25CorpusStats {
	documentCount: number;
	documentFrequency: Map<string, number>;
	averageFieldLength: number;
}

const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_CONTEXT_LINES = 3;
const MAX_SNIPPET_RANGES = 3;
const MAX_SNIPPET_CHARS = 1200;
const MAX_INDEXED_BODY_CHARS = 64_000;
const STRUCTURE_FILE_LIMIT = 5000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
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
	authorization: ["auth", "authentication", "login", "session"],
	authentication: ["auth", "authorization", "login"],
	auth: ["authorization", "authentication", "login", "session"],
	button: ["btn"],
	btn: ["button"],
	configuration: ["config", "settings"],
	config: ["configuration", "settings"],
	ctx: ["context", "contextUsage", "contextWindow"],
	context: ["ctx", "contextUsage", "contextWindow"],
	initialize: ["init", "setup"],
	init: ["initialize", "setup"],
	implementation: ["impl"],
	impl: ["implementation"],
	message: ["msg", "prompt"],
	msg: ["message", "prompt"],
	synchronization: ["sync"],
	sync: ["synchronization"],
	utility: ["util", "utils"],
	util: ["utility", "utils"],
	utils: ["utility", "util"],
	send: ["submit", "sendPrompt"],
	submit: ["send", "sendPrompt"],
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

function expandCamelCase(term: string): string[] {
	return term
		.replace(/[_-]+/g, " ")
		.split(/\s+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
		.map((part) => part.trim())
		.filter((part) => part.length >= 3 && part.toLowerCase() !== term.toLowerCase());
}

function addTermWithSubterms(terms: Set<string>, term: string): void {
	addTerm(terms, term);
	for (const part of expandCamelCase(term)) addTerm(terms, part);
}

const symbolSubtokenCache = new WeakMap<IndexedSymbol, Set<string>>();

// Whole camelCase/snake_case subtokens only, so a term like "auth" doesn't get credit for
// an arbitrary substring hit inside an unrelated symbol like "authorPage".
function symbolSubtokens(symbol: IndexedSymbol): Set<string> {
	const cached = symbolSubtokenCache.get(symbol);
	if (cached) return cached;
	const tokens = new Set<string>([symbol.name.toLowerCase()]);
	for (const part of expandCamelCase(symbol.name)) tokens.add(part.toLowerCase());
	symbolSubtokenCache.set(symbol, tokens);
	return tokens;
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
		addTermWithSubterms(terms, word);
	}
	for (const match of query.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
		const value = match[0];
		if (value.length >= 3) {
			addTermWithSubterms(terms, value);
			for (const part of value.split(".")) addTermWithSubterms(terms, part);
		}
	}
	return [...terms].slice(0, 36);
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

function tokenizeSearchText(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^\p{L}\p{N}_$]+/u)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2);
}

function bm25FieldsForFile(file: IndexedFile): Bm25Field[] {
	return [
		{ text: file.path, weight: 3 },
		{ text: file.symbols.map((symbol) => `${symbol.name} ${symbol.signature ?? ""}`).join("\n"), weight: 2 },
		{ text: file.imports.map((edge) => `${edge.rawSpecifier} ${edge.to ?? ""}`).join("\n"), weight: 1.5 },
		{ text: file.bodyText, weight: 1 },
	];
}

function buildBm25CorpusStats(files: Iterable<IndexedFile>): Bm25CorpusStats {
	const documentFrequency = new Map<string, number>();
	let documentCount = 0;
	let totalFieldLength = 0;
	let fieldCount = 0;
	for (const file of files) {
		documentCount++;
		const seenInDocument = new Set<string>();
		for (const field of bm25FieldsForFile(file)) {
			const tokens = tokenizeSearchText(field.text);
			totalFieldLength += tokens.length;
			fieldCount++;
			for (const token of tokens) seenInDocument.add(token);
		}
		for (const token of seenInDocument) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
	}
	return {
		documentCount,
		documentFrequency,
		averageFieldLength: fieldCount > 0 ? Math.max(1, totalFieldLength / fieldCount) : 1,
	};
}

function bm25fScore(file: IndexedFile, queryTerms: string[], stats: Bm25CorpusStats): number {
	if (stats.documentCount <= 0 || queryTerms.length === 0) return 0;
	const normalizedTerms = [...new Set(queryTerms.flatMap((term) => tokenizeSearchText(term)))];
	if (!normalizedTerms.length) return 0;
	let score = 0;
	for (const field of bm25FieldsForFile(file)) {
		const tokens = tokenizeSearchText(field.text);
		if (!tokens.length) continue;
		const counts = new Map<string, number>();
		for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
		const lengthNorm = 1 - BM25_B + BM25_B * (tokens.length / stats.averageFieldLength);
		for (const term of normalizedTerms) {
			const tf = counts.get(term) ?? 0;
			if (tf <= 0) continue;
			const df = stats.documentFrequency.get(term) ?? 0;
			const idf = Math.max(0.01, Math.log(1 + (stats.documentCount - df + 0.5) / (df + 0.5)));
			score += field.weight * idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm));
		}
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
				if (line && TEXT_EXTENSIONS.has(path.extname(line).toLowerCase())) out.push(line);
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
			if (!killed && buf.trim() && TEXT_EXTENSIONS.has(path.extname(buf.trim()).toLowerCase())) out.push(buf.trim());
			resolve(out.slice(0, STRUCTURE_FILE_LIMIT));
		});
		child.on("error", () => resolve(out));
	});
}

function rebuildDerivedIndex(index: ProjectStructureIndex): void {
	index.symbols = [];
	index.imports = [];
	index.reverseImports = new Map<string, string[]>();
	for (const file of index.files.values()) {
		index.symbols.push(...file.symbols);
		index.imports.push(...file.imports);
	}
	for (const edge of index.imports) {
		if (!edge.to || !index.files.has(edge.to)) continue;
		const arr = index.reverseImports.get(edge.to) ?? [];
		arr.push(edge.from);
		index.reverseImports.set(edge.to, arr);
	}
	index.bm25Stats = buildBm25CorpusStats(index.files.values());
}

function indexSourceFile(cwd: string, abs: string, fileSet: Set<string>): IndexedFile | undefined {
	try {
		const st = statSync(abs);
		if (!st.isFile() || st.size > 512_000) return undefined;
		const rel = relativeToCwd(cwd, abs);
		const language = languageForPath(rel);
		const content = readFileSync(abs, "utf8");
		return {
			path: rel,
			abs,
			mtimeMs: st.mtimeMs,
			size: st.size,
			language,
			bodyText: content.slice(0, MAX_INDEXED_BODY_CHARS),
			symbols: extractSymbols(rel, content, language),
			imports: extractImports(rel, content, language, fileSet),
		};
	} catch {
		return undefined;
	}
}

async function getStructureIndex(cwd: string, signal?: AbortSignal): Promise<ProjectStructureIndex> {
	const cached = structureIndexCache.get(cwd);
	const absFiles = await listSourceFiles(cwd, signal).catch(() => []);
	const relFiles = absFiles.map((f) => relativeToCwd(cwd, f));
	const fileSet = new Set(relFiles);
	const currentRelSet = new Set(relFiles);
	const mustReindexAll =
		!cached || relFiles.length !== cached.files.size || relFiles.some((rel) => !cached.files.has(rel));
	const index: ProjectStructureIndex = cached ?? {
		cwd,
		builtAt: 0,
		files: new Map<string, IndexedFile>(),
		mtimes: new Map<string, number>(),
		symbols: [],
		imports: [],
		reverseImports: new Map<string, string[]>(),
		bm25Stats: buildBm25CorpusStats([]),
	};

	let changed = !cached;
	for (const rel of [...index.files.keys()]) {
		if (!currentRelSet.has(rel)) {
			index.files.delete(rel);
			index.mtimes.delete(rel);
			changed = true;
		}
	}

	for (const abs of absFiles) {
		const rel = relativeToCwd(cwd, abs);
		let mtimeMs: number | undefined;
		try {
			const st = statSync(abs);
			if (!st.isFile()) continue;
			mtimeMs = st.mtimeMs;
		} catch {
			continue;
		}
		const cachedMtime = index.mtimes.get(rel);
		if (!mustReindexAll && cachedMtime === mtimeMs && index.files.has(rel)) continue;
		const indexed = indexSourceFile(cwd, abs, fileSet);
		if (indexed) {
			index.files.set(rel, indexed);
			index.mtimes.set(rel, indexed.mtimeMs);
		} else {
			index.files.delete(rel);
			index.mtimes.delete(rel);
		}
		changed = true;
	}

	if (changed) rebuildDerivedIndex(index);
	index.builtAt = Date.now();
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
	const scopeRoot = options.path ? path.resolve(cwd, options.path) : cwd;
	const safeScopeRoot = scopeRoot === cwd || scopeRoot.startsWith(cwd + path.sep) ? scopeRoot : cwd;
	const scopePrefix = safeScopeRoot === cwd ? "" : `${relativeToCwd(cwd, safeScopeRoot)}/`;
	const [matches, pathHits, structure] = await Promise.all([
		runRg(safeScopeRoot, terms.length ? terms : [normalized], maxMatches, signal).catch(() => []),
		runFd(safeScopeRoot, terms, maxFiles * 4, signal).catch(() => []),
		getStructureIndex(cwd, signal).catch(() => undefined),
	]);
	const bm25Stats = structure?.bm25Stats;

	const files = new Map<
		string,
		{
			abs: string;
			score: number;
			terms: Set<string>;
			queryTermsMatched: Set<string>;
			ranges: Array<{ start: number; end: number }>;
		}
	>();
	const ensure = (abs: string) => {
		let item = files.get(abs);
		if (!item) {
			item = { abs, score: 0, terms: new Set(), queryTermsMatched: new Set(), ranges: [] };
			files.set(abs, item);
		}
		return item;
	};
	const addFileScore = (
		rel: string,
		score: number,
		reason: string,
		range?: { start: number; end: number },
		matchedTerms?: string[],
	) => {
		const abs = path.resolve(cwd, rel);
		const item = ensure(abs);
		item.score += score + pathScore(rel) + fileNameBoost(rel, terms);
		item.terms.add(reason);
		if (matchedTerms) for (const term of matchedTerms) item.queryTermsMatched.add(term.toLowerCase());
		if (range) item.ranges = mergeRange(item.ranges, range);
		scoreCache.delete(abs);
	};
	const scoreCache = new Map<string, number>();
	const scoreItem = (item: { abs: string; score: number; queryTermsMatched: Set<string> }): number => {
		const cachedScore = scoreCache.get(item.abs);
		if (cachedScore !== undefined) return cachedScore;
		const rel = relativeToCwd(cwd, item.abs);
		const inScope = !scopePrefix || rel.startsWith(scopePrefix);
		const indexed = inScope ? structure?.files.get(rel) : undefined;
		const bm25Score = indexed && bm25Stats ? bm25fScore(indexed, terms.length ? terms : [normalized], bm25Stats) : 0;
		// Reward files that match several distinct query terms over files that repeat a single term,
		// capped well below the exact-symbol-match boost (+70) so it nudges rather than dominates ranking.
		const coverage = item.queryTermsMatched.size;
		const coverageBonus =
			coverage >= 2 ? Math.min(40, (coverage - 1) * 8 * (coverage / Math.max(1, terms.length))) : 0;
		const score = item.score + bm25Score * 10 + pathScore(rel) + fileNameBoost(rel, terms) + coverageBonus;
		scoreCache.set(item.abs, score);
		return score;
	};

	const rgMatchCounts = new Map<string, number>();
	for (const match of matches) {
		const item = ensure(match.file);
		const previousMatches = rgMatchCounts.get(match.file) ?? 0;
		rgMatchCounts.set(match.file, previousMatches + 1);
		// Repeated lexical matches in one file are useful, but should not let noisy comments/logs outrank
		// exact path/symbol hits. Give the first hit a strong signal, then quickly saturate.
		item.score += previousMatches === 0 ? 10 : previousMatches < 4 ? 2 : 0;
		item.terms.add(match.term);
		item.queryTermsMatched.add(match.term.toLowerCase());
		item.ranges = mergeRange(item.ranges, {
			start: Math.max(1, match.line - contextLines),
			end: match.line + contextLines,
		});
		if (previousMatches === 0 && TEXT_EXTENSIONS.has(path.extname(match.file).toLowerCase())) item.score += 1;
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
		for (const term of terms)
			if (rel.toLowerCase().includes(term.toLowerCase())) {
				item.terms.add(term);
				item.queryTermsMatched.add(term.toLowerCase());
			}
	}

	if (structure) {
		const loweredTerms = terms.map((t) => t.toLowerCase());
		for (const symbol of structure.symbols) {
			if (scopePrefix && !symbol.path.startsWith(scopePrefix)) continue;
			const symbolName = symbol.name.toLowerCase();
			const subtokens = symbolSubtokens(symbol);
			let boost = 0;
			const matchedTerms: string[] = [];
			for (const term of loweredTerms) {
				if (symbolName === term) {
					boost += 70;
					matchedTerms.push(term);
				} else if (subtokens.has(term)) {
					boost += 30;
					matchedTerms.push(term);
				}
			}
			if (boost <= 0) continue;
			if (symbol.exported) boost += 8;
			if (symbol.kind === "tool" || symbol.kind === "command") boost += 10;
			addFileScore(
				symbol.path,
				boost,
				`symbol:${symbol.name}`,
				{
					start: Math.max(1, symbol.startLine - 1),
					end: symbol.endLine,
				},
				matchedTerms,
			);
		}

		const seeded = [...files.values()]
			.sort((a, b) => scoreItem(b) - scoreItem(a))
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
			return scoreItem(b) - scoreItem(a) || aRel.localeCompare(bRel);
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
				score: Math.round(scoreItem(item)),
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
