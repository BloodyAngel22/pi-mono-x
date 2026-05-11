import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

interface McpServerConfig {
  type?: "local" | "remote";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

type McpServerStatus = {
  status: "connected" | "error" | "connecting" | "retrying";
  error?: string;
  attempt?: number;
  nextRetryAt?: number;
};

const SOFT_STARTUP_TIMEOUT_MS = 5000;
const INITIAL_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const mcpDir = path.join(homedir(), ".pi", "agent", "mcp");
  const configPath = path.join(homedir(), ".pi", "agent", "mcp-config.json");
  const logPath = path.join(mcpDir, "mcp.log");
  
  if (!fs.existsSync(mcpDir)) fs.mkdirSync(mcpDir, { recursive: true });

  const log = (msg: string, ...args: any[]) => {
    const timestamp = new Date().toISOString();
    const formattedMsg = `[${timestamp}] ${msg} ${args.length ? JSON.stringify(args) : ""}\n`;
    fs.appendFileSync(logPath, formattedMsg);
  };

  log("Starting MCP extension...");

  if (!fs.existsSync(configPath)) {
    log("Config not found, creating template");
    const template: McpConfig = {
      mcpServers: {
        "everything": {
          "type": "local",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-everything"]
        }
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(template, null, 2));
  }

  const config: McpConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const clients: Map<string, Client> = new Map();
  const serverStatus: Map<string, McpServerStatus> = new Map();
  let sessionGeneration = 0;

  for (const [name, cfg] of Object.entries(config.mcpServers)) {
    if (!cfg.disabled) serverStatus.set(name, { status: "connecting" });
  }

  const updateStatus = (ctx: ExtensionContext, total: number): void => {
    if (!ctx.hasUI) return;
    const statuses = [...serverStatus.values()];
    const ready = statuses.filter((s) => s.status === "connected").length;
    const active = statuses.filter((s) => s.status === "connecting" || s.status === "retrying").length;
    if (ready === total) {
      ctx.ui.setStatus("mcp", `✓ MCP: ${ready} ready`);
    } else if (active > 0) {
      ctx.ui.setStatus("mcp", `⟳ MCP ${ready}/${total} ready, ${active} loading`);
    } else {
      ctx.ui.setStatus("mcp", `⚠ MCP: ${ready}/${total} ready`);
    }
  };

  pi.on("session_start", async (event, ctx) => {
    const myGeneration = ++sessionGeneration;
    log(`Session start: initializing servers (generation ${myGeneration})`);

    // Close clients from previous session_start if any
    if (clients.size > 0) {
      void Promise.allSettled([...clients.values()].map((c) => c.close().catch(() => {})));
      clients.clear();
    }

    const serverEntries = Object.entries(config.mcpServers).filter(([, cfg]) => !cfg.disabled);
    const total = serverEntries.length;

    if (total === 0) {
      if (ctx.hasUI) ctx.ui.setStatus("mcp", "");
      return;
    }

    const initServer = async (name: string, serverConfig: McpServerConfig, attempt: number): Promise<void> => {
      log(`Initializing server: ${name} (attempt ${attempt})`);
      serverStatus.set(name, { status: "connecting", attempt });
      updateStatus(ctx, total);

      let client: Client;
      if (serverConfig.type === "remote" || serverConfig.url) {
        if (!serverConfig.url) throw new Error("URL is required for remote MCP server");

        const headers: Record<string, string> = { "Accept": "application/json, text/event-stream" };
        if (serverConfig.headers) {
          for (const [key, value] of Object.entries(serverConfig.headers)) {
            if (typeof value === "string" && value.startsWith("{env:") && value.endsWith("}")) {
              headers[key] = process.env[value.substring(5, value.length - 1)] || "";
            } else {
              headers[key] = String(value);
            }
          }
        }

        log(`Connecting to remote: ${serverConfig.url}`, { headers: Object.keys(headers) });
        let connected = false;
        let activeClient = new Client({ name: "pi-mcp-extension", version: "1.0.0" }, { capabilities: {} });

        try {
          await activeClient.connect(new StreamableHTTPClientTransport(new URL(serverConfig.url), { requestInit: { headers } }));
          connected = true;
          log(`Connected via Streamable HTTP: ${name}`);
        } catch (streamableErr: any) {
          log(`Streamable HTTP failed for ${name}, falling back to SSE`, streamableErr);
        }

        if (!connected) {
          activeClient = new Client({ name: "pi-mcp-extension", version: "1.0.0" }, { capabilities: {} });
          await activeClient.connect(new SSEClientTransport(new URL(serverConfig.url), {
            eventSourceInit: {
              fetch: (url, init) => globalThis.fetch(url as string, {
                ...(init as RequestInit),
                headers: { ...headers, ...((init?.headers as Record<string, string>) || {}) }
              })
            },
            requestInit: { headers }
          }));
          log(`Connected via SSE: ${name}`);
        }

        client = activeClient;
      } else {
        if (!serverConfig.command) throw new Error("Command is required for local MCP server");
        log(`Starting local stdio: ${serverConfig.command}`, { args: serverConfig.args });
        const localTransport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: { ...process.env, ...serverConfig.env },
          stderr: "ignore"
        });
        client = new Client({ name: "pi-mcp-extension", version: "1.0.0" }, { capabilities: {} });
        await client.connect(localTransport);
      }

      clients.set(name, client);

      const toolsResponse = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      log(`Registered ${toolsResponse.tools.length} tools from ${name}`);

      for (const tool of toolsResponse.tools) {
        const piToolName = `${name}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
        pi.registerTool({
          name: piToolName,
          label: `${name}: ${tool.name}`,
          description: tool.description || `MCP tool from ${name}`,
          parameters: tool.inputSchema as any,
          execute: async (toolCallId, params) => {
            log(`Calling tool ${name}.${tool.name}`, params);
            try {
              const result = await client.request(
                { method: "tools/call", params: { name: tool.name, arguments: params } },
                CallToolResultSchema
              );
              return {
                content: result.content.map(c => {
                  if (c.type === "text") return { type: "text", text: c.text };
                  if (c.type === "image") return { type: "image", image: c.data };
                  return { type: "text", text: JSON.stringify(c) };
                }),
                details: { server: name, originalTool: tool.name }
              };
            } catch (err: any) {
              log(`Tool call failed: ${name}.${tool.name}`, err);
              throw err;
            }
          }
        });
      }
      serverStatus.set(name, { status: "connected", attempt });
      updateStatus(ctx, total);
    };

    const startServerWithRetry = async (name: string, serverConfig: McpServerConfig): Promise<void> => {
      let attempt = 1;
      let delay = INITIAL_RETRY_DELAY_MS;
      while (myGeneration === sessionGeneration) {
        try {
          await initServer(name, serverConfig, attempt);
          return;
        } catch (error: any) {
          const message = error?.message || String(error);
          log(`Failed to start server ${name}`, error);
          const nextRetryAt = Date.now() + delay;
          serverStatus.set(name, { status: "retrying", error: message, attempt, nextRetryAt });
          updateStatus(ctx, total);
          if (attempt === 1 && ctx.hasUI) ctx.ui.notify(`MCP: ${name} unavailable, retrying in background`, "warning");
          await sleep(delay);
          attempt++;
          delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
        }
      }
    };

    for (const [name] of serverEntries) {
      serverStatus.set(name, { status: "connecting", attempt: 1 });
    }
    updateStatus(ctx, total);

    const startupTasks = serverEntries.map(([name, serverConfig]) =>
      startServerWithRetry(name, serverConfig).catch((error) => {
        log(`Unexpected MCP background task failure for ${name}`, error);
      }),
    );

    await Promise.race([Promise.allSettled(startupTasks), sleep(SOFT_STARTUP_TIMEOUT_MS)]);

    if (myGeneration !== sessionGeneration) return;
    updateStatus(ctx, total);
  });

  pi.registerCommand("mcps", {
    description: "List configured MCP servers and their status",
    handler: async (args, ctx) => {
      const theme = ctx.ui.theme;
      await ctx.ui.custom((ui, theme, keybindings, done) => {
        return {
          render: (width: number) => {
            const availWidth = Math.min(width, 60);
            const lines: string[] = [];
            const borderFg = (s: string) => theme.fg("border", s);
            const borderLine = (left: string, mid: string, right: string) => borderFg(left + mid + right);

            lines.push(borderLine("┌", "─".repeat(availWidth - 2), "┐"));
            const title = " MCP Servers Status ";
            lines.push(borderFg("│") + theme.fg("accent", title) + " ".repeat(Math.max(0, availWidth - 2 - title.length)) + borderFg("│"));
            lines.push(borderLine("├", "─".repeat(availWidth - 2), "┤"));

            for (const [name, info] of serverStatus.entries()) {
              const statusColor = info.status === "connected" ? "success" : (info.status === "error" ? "error" : "warning");
              const statusText = info.status.toUpperCase();
              const namePart = ` • ${name}: `;
              const padding = Math.max(0, availWidth - 4 - namePart.length - statusText.length);
              lines.push(borderFg("│") + " " + namePart + theme.fg(statusColor as any, statusText) + " ".repeat(padding) + " " + borderFg("│"));
              if (info.error) {
                const truncated = info.error.length > availWidth - 7 ? info.error.substring(0, availWidth - 10) + "..." : info.error;
                lines.push(borderFg("│") + "   " + theme.fg("muted", truncated) + " ".repeat(availWidth - 5 - truncated.length) + borderFg("│"));
              }
            }

            lines.push(borderLine("├", "─".repeat(availWidth - 2), "┤"));
            const help = " Press any key to close ";
            lines.push(borderFg("│") + theme.fg("muted", help) + " ".repeat(Math.max(0, availWidth - 2 - help.length)) + borderFg("│"));
            lines.push(borderLine("└", "─".repeat(availWidth - 2), "┘"));
            return lines;
          },
          handleInput: (data: string) => done(undefined)
        } as any;
      }, { overlay: true, overlayOptions: { anchor: "center", width: 60 } });
    }
  });

  pi.registerCommand("mcpauth", {
    description: "Authenticate with an MCP server — usage: /mcpauth sentry",
    handler: async (args: string, ctx: any) => {
      const serverName = args.trim().toLowerCase();

      if (!serverName) {
        ctx.ui.notify("Usage: /mcpauth <server-name>  (e.g. /mcpauth sentry)", "warning");
        return;
      }

      const serverConfig = config.mcpServers[serverName];
      if (!serverConfig) {
        ctx.ui.notify(`Unknown server: ${serverName}`, "error");
        return;
      }

      if (serverConfig.type !== "local" && !serverConfig.command) {
        ctx.ui.notify(`${serverName} is a remote server — no local auth needed`, "warning");
        return;
      }

      const command = serverConfig.command!;
      const authArgs = [...(serverConfig.args || []), "auth", "login"];

      ctx.ui.setStatus("mcp-auth", `⟳ ${serverName} auth: starting...`);
      ctx.ui.setWidget("mcp-auth", [
        `  Authenticating with ${serverName}...`,
        `  Running: ${command} ${authArgs.join(" ")}`,
      ]);

      log(`Running auth: ${command} ${authArgs.join(" ")}`);

      await new Promise<void>((resolve) => {
        const proc = spawn(command, authArgs, {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...serverConfig.env },
        });

        const widgetLines: string[] = [
          `  Authenticating with ${serverName}`,
          `  `,
        ];

        const handleOutput = (data: Buffer) => {
          const text = data.toString();
          log(`[${serverName} auth] ${text.trim()}`);

          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            widgetLines.push(`  ${trimmed}`);

            const urlMatch = trimmed.match(/https?:\/\/\S+/);
            if (urlMatch) {
              widgetLines.push(`  `);
              widgetLines.push(`  Open the URL above in your browser`);
              widgetLines.push(`  Waiting for authentication...`);
              ctx.ui.setStatus("mcp-auth", `⟳ ${serverName} auth: waiting for browser...`);
            }
          }

          ctx.ui.setWidget("mcp-auth", [...widgetLines]);
        };

        proc.stdout?.on("data", handleOutput);
        proc.stderr?.on("data", handleOutput);

        proc.on("error", (err: Error) => {
          ctx.ui.setWidget("mcp-auth", undefined);
          ctx.ui.setStatus("mcp-auth", undefined);
          ctx.ui.notify(`${serverName} auth error: ${err.message}`, "error");
          log(`Auth process error: ${err.message}`);
          resolve();
        });

        proc.on("close", async (code: number | null) => {
          ctx.ui.setWidget("mcp-auth", undefined);
          ctx.ui.setStatus("mcp-auth", undefined);

          if (code === 0) {
            ctx.ui.notify(`${serverName}: authenticated! Reconnecting...`, "info");
            log(`Auth succeeded for ${serverName}, reconnecting...`);

            try {
              const oldClient = clients.get(serverName);
              if (oldClient) {
                try { await oldClient.close(); } catch (_) {}
                clients.delete(serverName);
              }

              const transport = new StdioClientTransport({
                command: serverConfig.command!,
                args: serverConfig.args,
                env: { ...process.env, ...serverConfig.env },
                stderr: "ignore",
              });
              const newClient = new Client(
                { name: "pi-mcp-extension", version: "1.0.0" },
                { capabilities: {} }
              );
              await newClient.connect(transport);

              const toolsResponse = await newClient.request(
                { method: "tools/list" },
                ListToolsResultSchema
              );

              for (const tool of toolsResponse.tools) {
                const piToolName = `${serverName}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
                pi.registerTool({
                  name: piToolName,
                  label: `${serverName}: ${tool.name}`,
                  description: tool.description || `MCP tool from ${serverName}`,
                  parameters: tool.inputSchema as any,
                  execute: async (toolCallId: any, params: any) => {
                    const result = await newClient.request(
                      { method: "tools/call", params: { name: tool.name, arguments: params } },
                      CallToolResultSchema
                    );
                    return {
                      content: result.content.map((c: any) => {
                        if (c.type === "text") return { type: "text", text: c.text };
                        if (c.type === "image") return { type: "image", image: c.data };
                        return { type: "text", text: JSON.stringify(c) };
                      }),
                      details: { server: serverName, originalTool: tool.name }
                    };
                  }
                });
              }

              clients.set(serverName, newClient);
              serverStatus.set(serverName, { status: "connected" });
              log(`Reconnected ${serverName}: ${toolsResponse.tools.length} tools`);
              ctx.ui.notify(`${serverName}: reconnected (${toolsResponse.tools.length} tools)`, "info");
            } catch (err: any) {
              serverStatus.set(serverName, { status: "error", error: err.message });
              log(`Reconnect failed for ${serverName}`, err);
              ctx.ui.notify(`${serverName}: auth ok but reconnect failed — ${err.message}`, "error");
            }
          } else {
            ctx.ui.notify(`${serverName} auth failed (exit ${code})`, "error");
            log(`Auth failed for ${serverName}, exit code: ${code}`);
          }

          resolve();
        });
      });
    }
  });

  pi.on("session_shutdown", async () => {
    sessionGeneration++;
    log("Session shutdown: closing clients");
    await Promise.allSettled([...clients.values()].map((c) => c.close()));
    clients.clear();
  });
}
