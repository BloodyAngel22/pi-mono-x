import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const NUDGE_THRESHOLD = 75;
const AUTO_COMPACT_THRESHOLD = 90;
const NUDGE_EVERY_N_REQUESTS = 5;


let currentCtx: any = null;
let requestsSinceNudge = 0;

function compactWithPromise(ctx: any, instructions?: string): Promise<string> {
  return new Promise((resolve) => {
    ctx.compact({
      customInstructions: instructions,
      onComplete: () => resolve("Context compacted successfully. Continue from here."),
      onError: (err: Error) => resolve(`Compact failed: ${err.message}`),
    });
  });
}

export default function (pi: ExtensionAPI): void {

  pi.registerTool({
    name: "compress",
    label: "Compress context",
    description: [
      "Summarize and compress older parts of the conversation to free up context window space.",
      "Call this when the conversation is getting long or you need more room to work.",
      "Optionally specify a focus to guide what to preserve in the summary.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "What to emphasize or preserve in the summary (e.g. 'keep file edits and test results')",
        },
      },
      required: [],
    } as any,
    execute: async (_toolCallId: string, params: any) => {
      if (!currentCtx) {
        return { content: [{ type: "text" as const, text: "No active session context available." }] };
      }
      const msg = await compactWithPromise(currentCtx, params?.focus);
      return { content: [{ type: "text" as const, text: msg }] };
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    currentCtx = ctx;
    requestsSinceNudge = 0;
  });

  pi.on("before_agent_start", async (event: any, ctx: any): Promise<any> => {
    currentCtx = ctx;
    requestsSinceNudge++;

    const piUsage = ctx.getContextUsage?.();
    const pct = (piUsage?.percent != null) ? Math.round(piUsage.percent) : 0;
    const source = "pi";

    if (pct === 0) return;

    if (pct >= AUTO_COMPACT_THRESHOLD) {
      if (ctx.hasUI) ctx.ui.notify(`Context at ${pct}% [${source}] — auto-compacting…`, "info");
      await compactWithPromise(ctx);
      if (ctx.hasUI) ctx.ui.notify("Context auto-compacted", "info");
      requestsSinceNudge = 0;
      return;
    }

    if (pct >= NUDGE_THRESHOLD && requestsSinceNudge >= NUDGE_EVERY_N_REQUESTS) {
      requestsSinceNudge = 0;
      return {
        systemPrompt: event.systemPrompt +
          `\n\n[Context window is at ${pct}% [${source}]. Consider calling the compress tool to summarize older conversation parts before the context fills up completely.]`,
      };
    }
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    currentCtx = ctx;
  });
}
