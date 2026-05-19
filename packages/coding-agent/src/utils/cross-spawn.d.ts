declare module "cross-spawn" {
	import type {
		ChildProcess,
		SpawnOptions,
		SpawnSyncOptions,
		SpawnSyncOptionsWithStringEncoding,
		SpawnSyncReturns,
	} from "node:child_process";

	interface CrossSpawn {
		(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
		sync(
			command: string,
			args?: readonly string[],
			options?: SpawnSyncOptionsWithStringEncoding,
		): SpawnSyncReturns<string>;
		sync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
	}

	const crossSpawn: CrossSpawn;
	export default crossSpawn;
}
