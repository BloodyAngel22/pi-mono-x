import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Session-scoped file checkpoint.
 *
 * Before a file is written/edited for the first time in a session, the
 * original content (or absence) is snapshotted in a temp directory.
 * Call `restore()` to revert all tracked changes.
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
	/**
	 * Content captured just before the last undo, keyed by absolute path.
	 * null = the file did not exist at undo time (was already deleted).
	 * Used to implement redo.
	 */
	private _redoContent = new Map<string, string | null>();
	private _initialized = false;

	constructor(sessionId: string) {
		this.checkpointDir = join(tmpdir(), ".pi", "checkpoints", sessionId);
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Call before `write` or `edit` runs on `filePath`.
	 * If this is the first time we've seen this path, snapshot its current state.
	 * Safe to call multiple times for the same path.
	 */
	async snapshotBeforeWrite(filePath: string): Promise<void> {
		const abs = resolve(filePath);
		if (this._snapshotted.has(abs) || this._created.has(abs)) return;

		this._ensureDir();

		if (!existsSync(abs)) {
			this._created.add(abs);
			this._persistManifest();
			return;
		}

		const dest = this._destForPath(abs);
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(abs, dest);
		this._snapshotted.add(abs);
	}

	/**
	 * Restore all tracked files to their pre-session state.
	 * Saves the current (agent) state to the redo buffer before restoring.
	 */
	async restore(): Promise<RestoreResult> {
		await this._captureRedo([...this._snapshotted], [...this._created]);

		const restored: string[] = [];
		const deleted: string[] = [];
		const errors: string[] = [];

		for (const abs of this._snapshotted) {
			try {
				const src = this._destForPath(abs);
				const original = await readFile(src, "utf-8");
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, original, "utf-8");
				restored.push(abs);
			} catch (err) {
				errors.push(`restore ${abs}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		for (const abs of this._created) {
			try {
				await rm(abs, { force: true });
				deleted.push(abs);
			} catch (err) {
				errors.push(`delete ${abs}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return { restored, deleted, errors };
	}

	/**
	 * Reapply the agent's changes that were removed by the last `restore()` call.
	 * Returns null if there is nothing to redo.
	 */
	async redo(): Promise<RestoreResult | null> {
		if (this._redoContent.size === 0) return null;
		return this._applyRedo([...this._redoContent.keys()]);
	}

	/**
	 * Restore a single tracked file to its pre-session state.
	 * Saves the current state to the redo buffer. Returns null if not tracked.
	 */
	async restoreFile(filePath: string): Promise<RestoreResult | null> {
		const abs = resolve(filePath);
		const restored: string[] = [];
		const deleted: string[] = [];
		const errors: string[] = [];

		if (this._snapshotted.has(abs)) {
			await this._captureRedo([abs], []);
			try {
				const src = this._destForPath(abs);
				const original = await readFile(src, "utf-8");
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, original, "utf-8");
				restored.push(abs);
			} catch (err) {
				errors.push(`restore ${abs}: ${err instanceof Error ? err.message : String(err)}`);
			}
		} else if (this._created.has(abs)) {
			await this._captureRedo([], [abs]);
			try {
				await rm(abs, { force: true });
				deleted.push(abs);
			} catch (err) {
				errors.push(`delete ${abs}: ${err instanceof Error ? err.message : String(err)}`);
			}
		} else {
			return null;
		}

		return { restored, deleted, errors };
	}

	/**
	 * Redo a single file that was previously undone.
	 * Returns null if there is no redo state for this file.
	 */
	async redoFile(filePath: string): Promise<RestoreResult | null> {
		const abs = resolve(filePath);
		if (!this._redoContent.has(abs)) return null;
		return this._applyRedo([abs]);
	}

	/** Status summary of what has been tracked so far. */
	getStatus(): { modified: string[]; created: string[] } {
		return {
			modified: Array.from(this._snapshotted),
			created: Array.from(this._created),
		};
	}

	/** True if any files have been tracked. */
	get hasChanges(): boolean {
		return this._snapshotted.size > 0 || this._created.size > 0;
	}

	/** True if a previous undo can be reapplied. */
	get hasRedo(): boolean {
		return this._redoContent.size > 0;
	}

	/** Paths that have redo state available. */
	get redoPaths(): string[] {
		return [...this._redoContent.keys()];
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/** Read current file states into `_redoContent` before an undo operation. */
	private async _captureRedo(modifiedPaths: string[], createdPaths: string[]): Promise<void> {
		for (const abs of [...modifiedPaths, ...createdPaths]) {
			try {
				if (existsSync(abs)) {
					this._redoContent.set(abs, await readFile(abs, "utf-8"));
				} else {
					this._redoContent.set(abs, null);
				}
			} catch {
				this._redoContent.set(abs, null);
			}
		}
	}

	/** Apply redo for the given absolute paths and clear them from the buffer. */
	private async _applyRedo(paths: string[]): Promise<RestoreResult> {
		const restored: string[] = [];
		const deleted: string[] = [];
		const errors: string[] = [];

		for (const abs of paths) {
			const content = this._redoContent.get(abs);
			this._redoContent.delete(abs);

			if (content === null || content === undefined) {
				try {
					await rm(abs, { force: true });
					deleted.push(abs);
				} catch (err) {
					errors.push(`delete ${abs}: ${err instanceof Error ? err.message : String(err)}`);
				}
			} else {
				try {
					await mkdir(dirname(abs), { recursive: true });
					await writeFile(abs, content, "utf-8");
					restored.push(abs);
				} catch (err) {
					errors.push(`redo ${abs}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		return { restored, deleted, errors };
	}

	private _ensureDir(): void {
		if (this._initialized) return;
		mkdirSync(this.checkpointDir, { recursive: true });
		writeFileSync(join(this.checkpointDir, "meta.json"), JSON.stringify({ createdAt: new Date().toISOString() }));
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

	private _persistManifest(): void {
		writeFileSync(join(this.checkpointDir, "created.json"), JSON.stringify(Array.from(this._created)));
	}

	/**
	 * Load an existing checkpoint from disk (e.g. after a reload).
	 * Used when resuming a session that already has checkpoint data on disk.
	 */
	static tryLoadFromDisk(sessionId: string): FileCheckpoint | null {
		const dir = join(tmpdir(), ".pi", "checkpoints", sessionId);
		if (!existsSync(dir)) return null;

		const checkpoint = new FileCheckpoint(sessionId);
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
