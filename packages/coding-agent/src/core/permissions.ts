/**
 * Permission system for controlling agent tool execution.
 *
 * Loads rules from two sources (merged, local takes priority):
 *   - ~/.pi/agent/permissions.json  (global)
 *   - <cwd>/.pi/permissions.json    (project-local)
 *
 * Rule types: "bash" | "file" | "mcp"
 * Policies:   "allow" | "ask" | "deny"
 *
 * Nested JSON format (preferred):
 * {
 *   "defaultPolicy": "ask",
 *   "bash": { "allow": ["git *", "ls *"], "deny": ["sudo *"] },
 *   "mcp":  { "allow": ["searxng_web_search"] },
 *   "file": { "ask": ["*.json"] }
 * }
 *
 * Old flat format (auto-migrated on first load):
 * { "defaultPolicy": "ask", "rules": [{ "type": "bash", "match": "git *", "policy": "allow" }] }
 *
 * Built-in critical-deny patterns (cannot be overridden):
 * rm -rf on system paths, dd on devices, mkfs, fork-bomb, pipe-to-shell, etc.
 *
 * Compound bash commands (&&, ||, ;, |) are split into sub-commands and
 * each is checked individually. The most restrictive policy wins.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.js";

// ============================================================================
// Public Types
// ============================================================================

export type PolicyType = "bash" | "file" | "mcp";
export type PolicyValue = "allow" | "ask" | "deny";

export interface PermissionRule {
	type: PolicyType;
	/** Glob/wildcard pattern for bash command text, file path, or MCP tool name */
	match: string;
	policy: PolicyValue;
}

/** Nested per-type rule section. Keys are policy values, values are pattern arrays. */
export type PermissionSection = Partial<Record<PolicyValue, string[]>>;

export interface PermissionsConfig {
	/** Default policy for actions not matched by any rule. Default: "ask" */
	defaultPolicy?: PolicyValue;
	bash?: PermissionSection;
	mcp?: PermissionSection;
	file?: PermissionSection;
}

/** Legacy flat format — detected on load and auto-migrated. */
interface LegacyPermissionsConfig {
	defaultPolicy?: PolicyValue;
	rules?: Array<{ type: PolicyType; match: string; policy: PolicyValue }>;
}

export type PermissionDecision = "allow-once" | "allow-always" | "deny-once" | "deny-always";

export type PermissionScope = "local" | "global" | "session";

export interface PermissionDecisionResult {
	decision: PermissionDecision;
	scope?: PermissionScope;
}

export interface PermissionCheckInfo {
	type: PolicyType;
	/** The command text (bash), file path (file), or tool name (mcp) */
	value: string;
}

/** Callback used to prompt the user when policy is "ask". Returns null if no UI available. */
export type PermissionAskCallback = (info: PermissionCheckInfo) => Promise<PermissionDecisionResult | null>;

// ============================================================================
// Critical deny patterns (hardcoded, cannot be overridden by user rules)
// ============================================================================

const SYSTEM_PATHS = [
	"/",
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/boot",
	"/sys",
	"/proc",
	"/dev",
	"/root",
	"/home",
	"/var",
	"/opt",
];

function targetsSysPath(cmd: string): boolean {
	return SYSTEM_PATHS.some((p) => {
		const escaped = p.replace(/\//g, "\\/");
		return new RegExp(`(?:^|\\s)${escaped}(?:[\\s/*$]|$)`).test(cmd);
	});
}

function hasRmRf(cmd: string): boolean {
	if (!/\brm\b/.test(cmd)) return false;
	const hasRecursive = /\s-[a-zA-Z]*[rR]|--(recursive)/.test(cmd);
	const hasForce = /\s-[a-zA-Z]*f|--force/.test(cmd);
	return hasRecursive && hasForce;
}

interface CriticalRule {
	name: string;
	description: string;
	test: (cmd: string) => boolean;
}

const CRITICAL_DENY_RULES: CriticalRule[] = [
	{
		name: "rm-rf-system",
		description: "Recursive forced removal of system/important directories",
		test: (cmd) => hasRmRf(cmd) && (targetsSysPath(cmd) || /\s\/[*]/.test(cmd)),
	},
	{
		name: "dd-device",
		description: "Direct write to block device (dd of=/dev/...)",
		test: (cmd) => /\bdd\b/.test(cmd) && /\bof=\/dev\/(sd|hd|nvme|xvd|vd)[a-z0-9]/.test(cmd),
	},
	{
		name: "device-overwrite",
		description: "Direct overwrite of block device",
		test: (cmd) => />\s*\/dev\/(sd|hd|nvme|xvd|vd)[a-z0-9]/.test(cmd),
	},
	{
		name: "mkfs",
		description: "Filesystem format (mkfs)",
		test: (cmd) => /\bmkfs\b/.test(cmd),
	},
	{
		name: "fork-bomb",
		description: "Fork bomb — total system hang",
		test: (cmd) => /:\s*\(\s*\)\s*\{/.test(cmd) || /\(\s*\)\s*\{[^}]*:\|:/.test(cmd),
	},
	{
		name: "pipe-to-shell",
		description: "Pipe network output directly to shell (curl|bash etc.)",
		test: (cmd) =>
			/\b(curl|wget|fetch|http)\b.*\|\s*(sudo\s+)?(ba)?sh\b/.test(cmd) || /\|\s*sudo\s+(ba)?sh\b/.test(cmd),
	},
	{
		name: "no-preserve-root",
		description: "Flag --no-preserve-root — bypasses root protection",
		test: (cmd) => /--no-preserve-root/.test(cmd),
	},
	{
		name: "wipefs",
		description: "wipefs — erases filesystem signatures from device",
		test: (cmd) => /\bwipefs\b/.test(cmd),
	},
	{
		name: "shred-device",
		description: "shred on block device — irreversible data destruction",
		test: (cmd) => /\bshred\b/.test(cmd) && /\/dev\/(sd|hd|nvme|xvd|vd)[a-z0-9]/.test(cmd),
	},
	{
		name: "parted-destructive",
		description: "parted/fdisk with destructive operations",
		test: (cmd) => /\b(parted|fdisk|sfdisk|cfdisk)\b/.test(cmd) && /\b(mklabel|rm\s+\d|mkpart|--script)\b/.test(cmd),
	},
	{
		name: "mv-dev-null",
		description: "mv files into /dev/null — irreversible data loss",
		test: (cmd) => /\bmv\b/.test(cmd) && /\/dev\/null/.test(cmd),
	},
];

// ============================================================================
// Glob/wildcard matching (supports * and ? wildcards)
// ============================================================================

function matchesGlob(pattern: string, value: string): boolean {
	const expandedPattern = pattern.startsWith("~/") ? homedir() + pattern.slice(1) : pattern;
	const expandedValue = value.startsWith("~/") ? homedir() + value.slice(1) : value;

	// Escape regex special chars except * and ?
	const regexStr = expandedPattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	try {
		return new RegExp(`^${regexStr}$`).test(expandedValue);
	} catch {
		return expandedPattern === expandedValue;
	}
}

// ============================================================================
// Compound-command splitting
// ============================================================================

/**
 * Split a bash command string into individual sub-commands by shell operators.
 * Handles &&, ||, ;, and |. Does not attempt full shell parsing (no quotes etc.)
 * Returns trimmed, non-empty sub-command strings.
 */
function splitCompoundCommand(cmd: string): string[] {
	// Split on &&, ||, ;, | (in that priority order via regex alternation)
	const parts = cmd.split(/&&|\|\||;|\|/);
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ============================================================================
// PermissionsManager
// ============================================================================

export class PermissionsManager {
	private _global: PermissionsConfig = {};
	private _local: PermissionsConfig = {};
	private _session: PermissionsConfig = {};
	private readonly _globalPath: string;
	private _localPath: string;

	constructor(cwd: string) {
		this._globalPath = join(getAgentDir(), "permissions.json");
		this._localPath = this._localPathFor(cwd);
		this._load();
	}

	private _localPathFor(cwd: string): string {
		return join(cwd, ".pi", "permissions.json");
	}

	/** Reload rules from disk and optionally update local path (when cwd changes). */
	reload(newCwd?: string): void {
		if (newCwd) {
			this._localPath = this._localPathFor(newCwd);
		}
		this._load();
	}

	private _load(): void {
		this._global = this._loadFile(this._globalPath);
		this._local = this._loadFile(this._localPath);
	}

	private _loadFile(filePath: string): PermissionsConfig {
		if (!existsSync(filePath)) return {};
		try {
			const raw = readFileSync(filePath, "utf-8");
			// Strip trailing commas before ] and } (common JSONC mistake)
			const sanitized = raw.replace(/,\s*([\]}])/g, "$1");
			const parsed = JSON.parse(sanitized) as Record<string, unknown>;

			// Auto-migrate legacy flat format (has a "rules" array)
			if (Array.isArray(parsed.rules)) {
				const legacy = parsed as unknown as LegacyPermissionsConfig;
				const migrated = this._migrateFromLegacy(legacy);
				// Overwrite file with new format
				try {
					writeFileSync(filePath, `${JSON.stringify(migrated, null, 2)}\n`, "utf-8");
				} catch {
					// Best-effort — ignore write errors
				}
				return migrated;
			}

			return parsed as PermissionsConfig;
		} catch {
			return {};
		}
	}

	/** Convert old flat { rules: [...] } format to new nested format. */
	private _migrateFromLegacy(legacy: LegacyPermissionsConfig): PermissionsConfig {
		const config: PermissionsConfig = {};
		if (legacy.defaultPolicy) config.defaultPolicy = legacy.defaultPolicy;
		for (const rule of legacy.rules ?? []) {
			if (!config[rule.type]) config[rule.type] = {};
			const section = config[rule.type] as PermissionSection;
			if (!section[rule.policy]) section[rule.policy] = [];
			const list = section[rule.policy] as string[];
			if (!list.includes(rule.match)) list.push(rule.match);
		}
		return config;
	}

	/** Returns the matching critical-deny rule for a bash command, or null if safe. */
	getCriticalDeny(cmd: string): CriticalRule | null {
		for (const rule of CRITICAL_DENY_RULES) {
			if (rule.test(cmd)) return rule;
		}
		return null;
	}

	/** Get all critical deny rules (for display in /permissions). */
	getCriticalDenyRules(): ReadonlyArray<CriticalRule> {
		return CRITICAL_DENY_RULES;
	}

	/**
	 * Check policy for a given action.
	 * Local rules take priority over global rules.
	 * For bash, compound commands (&&, ||, ;, |) are split and each sub-command
	 * is checked. The most restrictive result wins (deny > ask > allow).
	 * Returns "ask" if no rule matches and no default is set.
	 */
	checkPolicy(type: PolicyType, value: string): PolicyValue {
		if (type === "bash") {
			return this._checkBashPolicy(value);
		}
		return this._checkSinglePolicy(type, value);
	}

	private _checkBashPolicy(cmd: string): PolicyValue {
		const subCmds = splitCompoundCommand(cmd);
		if (subCmds.length <= 1) {
			return this._checkSinglePolicy("bash", cmd);
		}

		// Evaluate each sub-command. Most restrictive wins: deny > ask > allow.
		const PRIORITY: Record<PolicyValue, number> = { allow: 0, ask: 1, deny: 2 };
		let result: PolicyValue = "allow";
		for (const sub of subCmds) {
			const policy = this._checkSinglePolicy("bash", sub);
			if (PRIORITY[policy] > PRIORITY[result]) {
				result = policy;
			}
			if (result === "deny") break; // can't get worse
		}
		return result;
	}

	private _checkSinglePolicy(type: PolicyType, value: string): PolicyValue {
		// Session rules take highest priority, then local, then global
		const sessionResult = this._checkSection(this._session[type], value);
		if (sessionResult !== null) return sessionResult;
		const localResult = this._checkSection(this._local[type], value);
		if (localResult !== null) return localResult;
		const globalResult = this._checkSection(this._global[type], value);
		if (globalResult !== null) return globalResult;
		return this._local.defaultPolicy ?? this._global.defaultPolicy ?? "ask";
	}

	/**
	 * Check a single PermissionSection. Checks deny first (most restrictive),
	 * then allow, then ask. Returns null if no pattern matches.
	 */
	private _checkSection(section: PermissionSection | undefined, value: string): PolicyValue | null {
		if (!section) return null;
		// Priority: deny > allow > ask
		for (const policy of ["deny", "allow", "ask"] as PolicyValue[]) {
			const patterns = section[policy] ?? [];
			for (const pattern of patterns) {
				if (matchesGlob(pattern, value)) return policy;
			}
		}
		return null;
	}

	/**
	 * Add a rule and persist to disk (or store in-memory for session scope).
	 * @param scope "global" saves to ~/.pi/agent/permissions.json; "local" saves to <cwd>/.pi/permissions.json; "session" keeps in memory only
	 */
	addRule(rule: PermissionRule, scope: PermissionScope): void {
		const config = scope === "global" ? this._global : scope === "local" ? this._local : this._session;

		// Remove any existing entry for same type+match across all policies
		if (!config[rule.type]) config[rule.type] = {};
		const section = config[rule.type] as PermissionSection;
		for (const policy of ["allow", "ask", "deny"] as PolicyValue[]) {
			if (section[policy]) {
				section[policy] = section[policy].filter((p) => p !== rule.match);
			}
		}
		// Add to the appropriate policy list
		if (!section[rule.policy]) section[rule.policy] = [];
		(section[rule.policy] as string[]).push(rule.match);

		if (scope !== "session") {
			const filePath = scope === "global" ? this._globalPath : this._localPath;
			this._saveFile(filePath, config);
		}
	}

	/** Remove a rule from local, global, or session config. */
	removeRule(type: PolicyType, match: string, scope: PermissionScope): void {
		const config = scope === "global" ? this._global : scope === "local" ? this._local : this._session;
		const section = config[type];
		if (!section) return;
		for (const policy of ["allow", "ask", "deny"] as PolicyValue[]) {
			if (section[policy]) {
				section[policy] = section[policy].filter((p) => p !== match);
			}
		}
		if (scope !== "session") {
			const filePath = scope === "global" ? this._globalPath : this._localPath;
			this._saveFile(filePath, config);
		}
	}

	/** Get all merged rules (session + local + global) as a flat list. Session rules listed first. */
	getAllRules(): Array<PermissionRule & { scope: PermissionScope }> {
		const result: Array<PermissionRule & { scope: PermissionScope }> = [];
		for (const [scopeLabel, config] of [
			["session", this._session],
			["local", this._local],
			["global", this._global],
		] as const) {
			for (const type of ["bash", "file", "mcp"] as PolicyType[]) {
				const section = config[type];
				if (!section) continue;
				for (const policy of ["allow", "ask", "deny"] as PolicyValue[]) {
					for (const match of section[policy] ?? []) {
						result.push({ type, match, policy, scope: scopeLabel });
					}
				}
			}
		}
		return result;
	}

	getDefaultPolicy(): PolicyValue {
		return this._local.defaultPolicy ?? this._global.defaultPolicy ?? "ask";
	}

	getLocalPath(): string {
		return this._localPath;
	}

	getGlobalPath(): string {
		return this._globalPath;
	}

	private _saveFile(filePath: string, config: PermissionsConfig): void {
		try {
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		} catch {
			// Silently ignore save errors
		}
	}
}
