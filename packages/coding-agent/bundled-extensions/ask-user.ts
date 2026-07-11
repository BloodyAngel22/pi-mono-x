import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Ask-user extension: provides the `ask_user` tool so the agent can pause and
 * ask the user a structured question with selectable options and/or free text.
 *
 * The agent calls:
 *   ask_user(question, options?, allowMultiple?)
 * and blocks until the user confirms a choice.
 */
export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user a question",
		description:
			"Pause and ask the user ONE short structured question. Provide option choices when possible. " +
			"Use when requirements are ambiguous or multiple valid approaches exist. " +
			"If you have several questions, call ask_user several times sequentially — NEVER bundle multiple questions into one call.",
		promptSnippet:
			"ask_user: Ask the user ONE short question with choices; call repeatedly for multiple questions",
		parameters: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description: "A single short question (one decision per call). Markdown is supported.",
				},
				options: {
					type: "array",
					items: { type: "string" },
					description:
						"Predefined answer options the user can choose from. Optional but recommended.",
				},
				allowMultiple: {
					type: "boolean",
					description: "Whether the user can select multiple options. Default: false.",
				},
			},
			required: ["question"],
		} as any,
		execute: async (_toolCallId: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) => {
			if (!ctx?.hasUI) {
				// Non-interactive context: return placeholder
				return {
					content: [
						{
							type: "text" as const,
							text: "(ask_user is not available in non-interactive mode. Proceed with your best judgment.)",
						},
					],
					details: {},
				};
			}

			const ui = ctx.ui;
			const question: string = params.question ?? "What would you like to do?";
			const options: string[] = Array.isArray(params.options) ? params.options : [];
			const allowMultiple: boolean = params.allowMultiple === true;

			ui.setWorkingMessage("⏸ Waiting for your input…");
			const result = await ui.askUser(question, options, allowMultiple, { signal });
			ui.setWorkingMessage();
			return {
				content: [{ type: "text" as const, text: result ?? "(cancelled by user)" }],
				details: { question, options, allowMultiple, answer: result ?? null },
			};
		},
	});
}
