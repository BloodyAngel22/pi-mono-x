import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type PermissionAsk = (info: { type: "bash" | "file" | "mcp"; value: string }) => Promise<unknown>;

describe("InteractiveMode permission prompts", () => {
	test("treats cancelled permission prompts as deny once", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const fakeThis: {
			session: { permissionAsk?: PermissionAsk };
			showExtensionSelectorAsync: ReturnType<typeof vi.fn>;
			showWarning: ReturnType<typeof vi.fn>;
		} = {
			session: {},
			showExtensionSelectorAsync: vi.fn().mockResolvedValue(undefined),
			showWarning: vi.fn(),
		};

		try {
			(
				InteractiveMode.prototype as unknown as {
					setupPermissionAsk: (this: typeof fakeThis) => void;
				}
			).setupPermissionAsk.call(fakeThis);

			const result = await fakeThis.session.permissionAsk?.({ type: "file", value: "src/example.ts" });

			expect(result).toEqual({ decision: "deny-once" });
		} finally {
			write.mockRestore();
		}
	});
});
