import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCheckpoint } from "../src/core/file-checkpoint.js";

const tempDirs: string[] = [];
const legacySessionIds: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-file-checkpoint-test-"));
	tempDirs.push(dir);
	return dir;
}

function createSessionId(): string {
	return `file-checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createLegacySessionId(): string {
	const sessionId = createSessionId();
	legacySessionIds.push(sessionId);
	return sessionId;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
	await Promise.all(
		legacySessionIds
			.splice(0, legacySessionIds.length)
			.map((sessionId) => rm(join(tmpdir(), ".pi", "checkpoints", sessionId), { recursive: true, force: true })),
	);
});

describe("FileCheckpoint", () => {
	it("restores modified files to the selected turn state", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "notes.ts");
		const checkpointRoot = await createTempDir();
		const checkpoint = new FileCheckpoint(createSessionId(), checkpointRoot);

		await writeFile(filePath, "original", "utf-8");
		await checkpoint.snapshotBeforeWrite(filePath, 0);
		await writeFile(filePath, "after turn 0", "utf-8");
		await checkpoint.captureTurnEnd(0);
		await checkpoint.snapshotBeforeWrite(filePath, 1);
		await writeFile(filePath, "after turn 1", "utf-8");
		await checkpoint.captureTurnEnd(1);

		const result = await checkpoint.restoreToTurn(1);

		expect(result?.restored).toEqual([filePath]);
		expect(await readFile(filePath, "utf-8")).toBe("after turn 0");
	});

	it("loads turn restore metadata from disk", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "notes.ts");
		const sessionId = createSessionId();
		const checkpointRoot = await createTempDir();
		const checkpoint = new FileCheckpoint(sessionId, checkpointRoot);

		await writeFile(filePath, "original", "utf-8");
		await checkpoint.snapshotBeforeWrite(filePath, 0);
		await writeFile(filePath, "after turn 0", "utf-8");
		await checkpoint.captureTurnEnd(0);
		await checkpoint.snapshotBeforeWrite(filePath, 1);
		await writeFile(filePath, "after turn 1", "utf-8");
		await checkpoint.captureTurnEnd(1);

		const reloaded = FileCheckpoint.tryLoadFromDisk(sessionId, checkpointRoot);
		const result = await reloaded?.restoreToTurn(1);

		expect(result?.restored).toEqual([filePath]);
		expect(await readFile(filePath, "utf-8")).toBe("after turn 0");
	});

	it("restores backward and forward to selected turn states", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "print_numbers.sh");
		const checkpointRoot = await createTempDir();
		const checkpoint = new FileCheckpoint(createSessionId(), checkpointRoot);

		await writeFile(filePath, '#!/bin/bash\nfor i in {0..10}; do\n    echo "$i"\ndone\n', "utf-8");
		await checkpoint.snapshotBeforeWrite(filePath, 0);
		await writeFile(filePath, '#!/bin/bash\nfor i in {-10..10}; do\n    echo "$i"\ndone\n', "utf-8");
		await checkpoint.captureTurnEnd(0);

		await checkpoint.restoreToTurn(0);
		expect(await readFile(filePath, "utf-8")).toBe('#!/bin/bash\nfor i in {0..10}; do\n    echo "$i"\ndone\n');

		await checkpoint.restoreToTurn(1);
		expect(await readFile(filePath, "utf-8")).toBe('#!/bin/bash\nfor i in {-10..10}; do\n    echo "$i"\ndone\n');
	});

	it("restores backward and forward after loading checkpoint from disk", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "print_numbers.sh");
		const sessionId = createSessionId();
		const checkpointRoot = await createTempDir();
		const checkpoint = new FileCheckpoint(sessionId, checkpointRoot);

		await writeFile(filePath, '#!/bin/bash\nfor i in {0..10}; do\n    echo "$i"\ndone\n', "utf-8");
		await checkpoint.snapshotBeforeWrite(filePath, 0);
		await writeFile(filePath, '#!/bin/bash\nfor i in {-10..10}; do\n    echo "$i"\ndone\n', "utf-8");
		await checkpoint.captureTurnEnd(0);

		const reloaded = FileCheckpoint.tryLoadFromDisk(sessionId, checkpointRoot);
		await reloaded?.restoreToTurn(0);
		expect(await readFile(filePath, "utf-8")).toBe('#!/bin/bash\nfor i in {0..10}; do\n    echo "$i"\ndone\n');

		await reloaded?.restoreToTurn(1);
		expect(await readFile(filePath, "utf-8")).toBe('#!/bin/bash\nfor i in {-10..10}; do\n    echo "$i"\ndone\n');
	});

	it("migrates legacy temp checkpoints to persistent checkpoint storage", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "notes.ts");
		const sessionId = createLegacySessionId();
		const checkpointRoot = await createTempDir();
		const legacyCheckpoint = new FileCheckpoint(sessionId, join(tmpdir(), ".pi", "checkpoints"));

		await writeFile(filePath, "original", "utf-8");
		await legacyCheckpoint.snapshotBeforeWrite(filePath, 0);
		await writeFile(filePath, "changed", "utf-8");
		await legacyCheckpoint.captureTurnEnd(0);

		const reloaded = FileCheckpoint.tryLoadFromDisk(sessionId, checkpointRoot);
		expect(existsSync(join(checkpointRoot, sessionId, "turn-ends", "0"))).toBe(true);

		await reloaded?.restoreToTurn(0);
		expect(await readFile(filePath, "utf-8")).toBe("original");
		await reloaded?.restoreToTurn(1);
		expect(await readFile(filePath, "utf-8")).toBe("changed");
	});
});
