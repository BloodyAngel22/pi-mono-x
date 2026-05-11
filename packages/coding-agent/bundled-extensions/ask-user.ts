import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, getKeybindings, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

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
			"Pause and ask the user a structured question. Provide option choices when possible. " +
			"Use when requirements are ambiguous or multiple valid approaches exist.",
		promptSnippet:
			"ask_user: Pause and ask the user a structured question with choices before proceeding",
		parameters: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description: "The question to ask the user. Markdown is supported.",
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

			// Inform the user the agent is waiting for input
			ui.setWorkingMessage("\u23f8 Waiting for your input\u2026");

			return new Promise<{ content: Array<{ type: "text"; text: string }>; details: {} }>((resolve) => {
				// State
				let cursor = 0;
				let cursorInInput = false;
				const selected = new Set<number>();
				let customText = "";
				let resolved = false;
				let removeInput: (() => void) | undefined;

				const buildResult = (): string => {
					const parts: string[] = [];
					for (const i of selected) {
						const opt = options[i];
						if (opt) parts.push(opt);
					}
					if (customText.trim()) parts.push(customText.trim());
					if (parts.length === 0 && options.length > 0 && !cursorInInput) {
						const opt = options[cursor];
						if (opt) parts.push(opt);
					}
					return parts.join(", ") || "(no selection)";
				};

				const finish = (result: string) => {
					if (resolved) return;
					resolved = true;
					ui.setWidget("ask_user", undefined);
					ui.setWorkingMessage();
					removeInput?.();
					resolve({ content: [{ type: "text" as const, text: result }], details: {} });
				};

				const kb = getKeybindings();

				// Input handler (assigned before widget so close-over reference is safe)
				removeInput = ui.onTerminalInput((data: string) => {
					if (resolved) return undefined;

					// Up: move cursor up (or leave custom text field back to options)
					if (kb.matches(data, "tui.select.up")) {
						if (cursorInInput) {
							cursorInInput = false;
							cursor = options.length > 0 ? options.length - 1 : 0;
						} else if (cursor > 0) {
							cursor--;
						}
						ui.requestRender();
						return { consume: true };
					}

					// Down: move cursor down (or into custom text field)
					if (kb.matches(data, "tui.select.down")) {
						if (!cursorInInput && cursor < options.length - 1) {
							cursor++;
						} else if (!cursorInInput && cursor >= options.length - 1) {
							cursorInInput = true;
						}
						ui.requestRender();
						return { consume: true };
					}

					// Space: toggle selection on current option (not in free-text field)
					if (matchesKey(data, "space") && !cursorInInput) {
						if (allowMultiple) {
							if (selected.has(cursor)) selected.delete(cursor);
							else selected.add(cursor);
						} else {
							selected.clear();
							selected.add(cursor);
						}
						ui.requestRender();
						return { consume: true };
					}

					// Enter: confirm selection
					if (kb.matches(data, "tui.select.confirm")) {
						finish(buildResult());
						return { consume: true };
					}

					// Escape / Ctrl+C: cancel
					if (kb.matches(data, "tui.select.cancel")) {
						finish("(cancelled by user)");
						return { consume: true };
					}

					// Free-text typing when cursor is on the custom input row
					if (cursorInInput) {
						if (matchesKey(data, "backspace")) {
							customText = customText.slice(0, -1);
							ui.requestRender();
							return { consume: true };
						}
						// Accept any single printable character
						if (data.length === 1 && data >= " ") {
							customText += data;
							ui.requestRender();
							return { consume: true };
						}
					}

					return undefined;
				});

				// Abort signal support
				if (signal) {
					signal.addEventListener("abort", () => finish("(cancelled: agent aborted)"), { once: true });
				}

				// Widget factory: render the question UI
				ui.setWidget(
					"ask_user",
					(tui: any, thm: any) => {
						const root = new Container();

						const render = (width: number): string[] => {
							const fit = (line: string) => truncateToWidth(line, Math.max(0, width), "", true);
							const lines: string[] = [""];
							// Question (rendered as plain text for simplicity)
							const qLine = `  ${question}`;
							lines.push(fit(thm.bold(qLine)));
							lines.push("");

							// Options
							for (let i = 0; i < options.length; i++) {
								const isSel = selected.has(i);
								const isCur = !cursorInInput && cursor === i;
								const cb = allowMultiple ? (isSel ? "[x]" : "[ ]") : isSel ? "(•)" : "( )";
								const cbStyled = isSel ? thm.fg("success", cb) : thm.fg("muted", cb);
								const pointer = isCur ? thm.fg("accent", ">") : " ";
								const optText = isCur
									? thm.bold(options[i])
									: thm.fg("dim", options[i] ?? "");
								const line = ` ${pointer} ${cbStyled} ${optText}`;
								lines.push(fit(line));
							}

							// Free-text input row
							const inputPointer = cursorInInput ? thm.fg("accent", ">") : " ";
							const inputLabel = thm.fg("dim", "Custom: ");
							const inputVal =
								customText ||
								(cursorInInput ? thm.fg("dim", "type here…") : "");
							const inputLine = ` ${inputPointer} ${inputLabel}${inputVal}`;
							lines.push(fit(inputLine));

							// Hint
							lines.push("");
							const hint = thm.fg(
								"dim",
								"  ↑↓ navigate  Space select  Enter confirm  Esc cancel",
							);
							lines.push(fit(hint));

							return lines;
						};

						// Patch root render
						(root as any).render = render;
						(root as any).invalidate = () => {};

						return root as any;
					},
					{ placement: "aboveEditor" },
				);
			});
		},
	});
}
