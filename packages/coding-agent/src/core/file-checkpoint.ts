import { cpSync, type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "../config.js";

/**
 * Session-scoped file checkpoint.
 *
 * Before a file is written/edited, pi records the file state before and after
 * each turn so tree navigation can restore code to a selected session point.
 *
 * Storage layout (all under `checkpointDir`):
 *   files/<absolute-path-without-leading-slash>  — original file content
 *   created.json                                  — JSON array of absolute paths
 *                                                   of files that did not exist
 *                                                   before the agent created them
 *   meta.json                                     — { sessionId, createdAt }
 */
export class FileCheckpoint {
	private readonly checkpointDir: string;
	/** Absolute paths of files whose originals are stored. */
	private readonly _snapshotted = new Set<string>();
	/** Absolute paths of new files created by the agent. */
	private readonly _created = new Set<string>();
	private readonly _turnChanges = new Map<number, { modified: Set<string>; created: Set<string> }>();
	private readonly _turnSnapshotFiles = new Map<number, Set<string>>();
	private readonly _turnEndSnapshotFiles = new Map<number, Set<string>>();
	private _currentRestoreContent = new Map<string, string | null>();
	private _initialized = false;

	constructor(
		private readonly sessionId: string,
		checkpointRoot = getCheckpointRoot(),
	) {
		this.checkpointDir = join(checkpointRoot, sessionId);
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Call before `write` or `edit` runs on `filePath`.
	 * If this is the first time we've seen this path, snapshot its current state.
	 * Safe to call multiple times for the same path.
	 */
	async snapshotBeforeWrite(filePath: string, turnIndex?: number): Promise<void> {
		const abs = resolve(filePath);
		const existedBefore = existsSync(abs);
		await this._recordTurnChange(abs, existedBefore, turnIndex);
		if (this._snapshotted.has(abs) || this._created.has(abs)) return;

		this._ensureDir();

		if (!existedBefore) {
			this._created.add(abs);
			this._persistManifest();
			return;
		}

		const dest = this._destForPath(abs);
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(abs, dest);
		this._snapshotted.add(abs);
	}

	/** Status summary of what has been tracked so far. */
	getStatus(): { modified: string[]; created: string[] } {
		return {
			modified: Array.from(this._snapshotted),
			created: Array.from(this._created),
		};
	}

	getTurnStatus(turnIndex: number): { modified: string[]; created: string[] } | null {
		const status = this._turnChanges.get(turnIndex);
		if (!status || (status.modified.size === 0 && status.created.size === 0)) return null;
		return {
			modified: Array.from(status.modified),
			created: Array.from(status.created),
		};
	}

	async captureTurnEnd(turnIndex: number): Promise<void> {
		const status = this._turnChanges.get(turnIndex);
		if (!status) return;
		this._ensureDir();
		let files = this._turnEndSnapshotFiles.get(turnIndex);
		if (!files) {
			files = new Set<string>();
			this._turnEndSnapshotFiles.set(turnIndex, files);
		}
		for (const abs of [...status.modified, ...status.created]) {
			if (files.has(abs) || !existsSync(abs)) continue;
			const dest = this._turnEndDestForPath(abs, turnIndex);
			await mkdir(dirname(dest), { recursive: true });
			await copyFile(abs, dest);
			files.add(abs);
		}
	}

	async restoreToTurn(turnIndex: number): Promise<RestoreResult | null> {
		const paths = new Set<string>([...this._snapshotted, ...this._created]);
		for (const status of this._turnChanges.values()) {
			for (const abs of status.modified) paths.add(abs);
			for (const abs of status.created) paths.add(abs);
		}
		if (paths.size === 0) return null;
		return this._restoreToTurnPaths(paths, turnIndex);
	}

	/** True if any files have been tracked. */
	get hasChanges(): boolean {
		return this._snapshotted.size > 0 || this._created.size > 0;
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	private async _captureCurrentRestoreContent(modifiedPaths: string[], createdPaths: string[]): Promise<void> {
		for (const abs of [...modifiedPaths, ...createdPaths]) {
			try {
				if (existsSync(abs)) {
					this._currentRestoreContent.set(abs, await readFile(abs, "utf-8"));
				} else {
					this._currentRestoreContent.set(abs, null);
				}
			} catch {
				this._currentRestoreContent.set(abs, null);
			}
		}
	}

	private _ensureDir(): void {
		if (this._initialized) return;
		mkdirSync(this.checkpointDir, { recursive: true });
		writeFileSync(
			join(this.checkpointDir, "meta.json"),
			JSON.stringify({ sessionId: this.sessionId, createdAt: new Date().toISOString() }),
		);
		this._initialized = true;
	}

	/** Map an absolute path to its mirror path inside the checkpoint dir. */
	private _destForPath(abs: string): string {
		// On POSIX: /home/user/foo.ts → checkpointDir/files/home/user/foo.ts
		// On Windows: C:\foo\bar.ts → checkpointDir/files/C/foo/bar.ts
		const relative = abs.startsWith(sep)
			? abs.slice(sep.length)
			: abs.replace(/^[A-Za-z]:[\\/]/, (m) => m.slice(0, 1) + sep);
		return join(this.checkpointDir, "files", relative);
	}

	private _turnDestForPath(abs: string, turnIndex: number): string {
		const relative = abs.startsWith(sep)
			? abs.slice(sep.length)
			: abs.replace(/^[A-Za-z]:[\\/]/, (m) => m.slice(0, 1) + sep);
		return join(this.checkpointDir, "turns", String(turnIndex), relative);
	}

	private _turnEndDestForPath(abs: string, turnIndex: number): string {
		const relative = abs.startsWith(sep)
			? abs.slice(sep.length)
			: abs.replace(/^[A-Za-z]:[\\/]/, (m) => m.slice(0, 1) + sep);
		return join(this.checkpointDir, "turn-ends", String(turnIndex), relative);
	}

	private async _recordTurnChange(abs: string, existedBefore: boolean, turnIndex?: number): Promise<void> {
		if (turnIndex === undefined) return;
		this._ensureDir();
		let status = this._turnChanges.get(turnIndex);
		if (!status) {
			status = { modified: new Set<string>(), created: new Set<string>() };
			this._turnChanges.set(turnIndex, status);
		}
		if (existedBefore) {
			status.modified.add(abs);
			await this._snapshotTurnFile(abs, turnIndex);
		} else {
			status.created.add(abs);
		}
		this._persistTurnChanges();
	}

	private async _snapshotTurnFile(abs: string, turnIndex: number): Promise<void> {
		let files = this._turnSnapshotFiles.get(turnIndex);
		if (!files) {
			files = new Set<string>();
			this._turnSnapshotFiles.set(turnIndex, files);
		}
		if (files.has(abs)) return;
		const dest = this._turnDestForPath(abs, turnIndex);
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(abs, dest);
		files.add(abs);
	}

	private async _restoreToTurnPaths(paths: Set<string>, turnIndex: number): Promise<RestoreResult> {
		const restored: string[] = [];
		const deleted: string[] = [];
		const errors: string[] = [];
		await this._captureCurrentRestoreContent([...paths], []);

		for (const abs of paths) {
			const latestChange = this._findLatestChangeBeforeTurn(abs, turnIndex);
			const wasCreatedBeforeTarget =
				latestChange !== undefined && this._turnChanges.get(latestChange)?.created.has(abs);

			if (latestChange !== undefined) {
				const src = this._turnEndDestForPath(abs, latestChange);
				try {
					if (existsSync(src)) {
						const content = await readFile(src, "utf-8");
						await mkdir(dirname(abs), { recursive: true });
						await writeFile(abs, content, "utf-8");
						restored.push(abs);
						continue;
					}
					const currentRestoreContent = this._currentRestoreContent.get(abs);
					if (currentRestoreContent !== undefined) {
						if (currentRestoreContent === null) {
							await rm(abs, { force: true });
							deleted.push(abs);
						} else {
							await mkdir(dirname(abs), { recursive: true });
							await writeFile(abs, currentRestoreContent, "utf-8");
							restored.push(abs);
						}
						continue;
					}
				} catch (err) {
					errors.push(`restore ${abs}: ${err instanceof Error ? err.message : String(err)}`);
					continue;
				}
			}

			if (wasCreatedBeforeTarget || this._created.has(abs)) {
				try {
					await rm(abs, { force: true });
					deleted.push(abs);
				} catch (err) {
					errors.push(`delete ${abs}: ${err instanceof Error ? err.message : String(err)}`);
				}
				continue;
			}

			if (!this._snapshotted.has(abs)) continue;
			try {
				const original = await readFile(this._destForPath(abs), "utf-8");
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, original, "utf-8");
				restored.push(abs);
			} catch (err) {
				errors.push(`restore ${abs}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return { restored, deleted, errors };
	}

	private _findLatestChangeBeforeTurn(abs: string, turnIndex: number): number | undefined {
		let latest: number | undefined;
		for (const [idx, status] of this._turnChanges.entries()) {
			if (idx >= turnIndex) continue;
			if (!status.modified.has(abs) && !status.created.has(abs)) continue;
			if (latest === undefined || idx > latest) latest = idx;
		}
		return latest;
	}

	private _persistManifest(): void {
		writeFileSync(join(this.checkpointDir, "created.json"), JSON.stringify(Array.from(this._created)));
	}

	private _persistTurnChanges(): void {
		const turns = Array.from(this._turnChanges, ([turnIndex, status]) => ({
			turnIndex,
			modified: Array.from(status.modified),
			created: Array.from(status.created),
		}));
		writeFileSync(join(this.checkpointDir, "turn-changes.json"), JSON.stringify(turns));
	}

	/**
	 * Load an existing checkpoint from disk (e.g. after a reload).
	 * Used when resuming a session that already has checkpoint data on disk.
	 */
	static tryLoadFromDisk(sessionId: string, checkpointRoot = getCheckpointRoot()): FileCheckpoint | null {
		const dir = findCheckpointDir(sessionId, checkpointRoot);
		if (dir === null || !existsSync(dir)) return null;

		const persistentDir = join(checkpointRoot, sessionId);
		if (dir !== persistentDir) {
			mkdirSync(dirname(persistentDir), { recursive: true });
			cpSync(dir, persistentDir, { recursive: true });
		}

		const checkpoint = new FileCheckpoint(sessionId, checkpointRoot);
		checkpoint._initialized = true;

		// Restore created.json
		const createdPath = join(dir, "created.json");
		if (existsSync(createdPath)) {
			try {
				const list = JSON.parse(readFileSync(createdPath, "utf-8")) as string[];
				for (const p of list) checkpoint._created.add(p);
			} catch {
				// ignore malformed file
			}
		}

		const turnChangesPath = join(dir, "turn-changes.json");
		if (existsSync(turnChangesPath)) {
			try {
				const turns = JSON.parse(readFileSync(turnChangesPath, "utf-8")) as Array<{
					turnIndex: number;
					modified: string[];
					created: string[];
				}>;
				for (const turn of turns) {
					checkpoint._turnChanges.set(turn.turnIndex, {
						modified: new Set(turn.modified),
						created: new Set(turn.created),
					});
					checkpoint._turnSnapshotFiles.set(turn.turnIndex, new Set(turn.modified));
				}
			} catch {}
		}

		// Enumerate snapshotted files from the files/ directory
		const filesRoot = join(dir, "files");
		if (existsSync(filesRoot)) {
			for (const abs of walkFiles(filesRoot)) {
				// Reconstruct the original absolute path
				const rel = abs.slice(filesRoot.length + 1); // relative to files/
				const original = sep + rel; // re-add leading /
				checkpoint._snapshotted.add(original);
			}
		}

		return checkpoint;
	}
}

export function getCheckpointRoot(): string {
	return join(getAgentDir(), "checkpoints");
}

function findCheckpointDir(sessionId: string, checkpointRoot: string): string | null {
	const persistentDir = join(checkpointRoot, sessionId);
	if (existsSync(persistentDir)) return persistentDir;
	const legacyTempDir = join(tmpdir(), ".pi", "checkpoints", sessionId);
	if (existsSync(legacyTempDir)) return legacyTempDir;
	return null;
}

export interface RestoreResult {
	restored: string[];
	deleted: string[];
	errors: string[];
}

function* walkFiles(dir: string): Generator<string> {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkFiles(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}
