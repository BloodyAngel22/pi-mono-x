import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

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

type LogFn = (msg: string, ...args: any[]) => void;

const SOFT_STARTUP_TIMEOUT_MS = 5000;
const INITIAL_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configHash(cfg: McpServerConfig): string {
  const stable = JSON.stringify(cfg, Object.keys(cfg).sort());
  return createHash("sha1").update(stable).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Process-wide MCP client sharing.
//
// This extension module is re-executed for every session (extensions load
// through a fresh, non-caching jiti instance per session — see
// core/extensions/loader.ts), so ordinary module-scoped state does NOT
// survive across sessions/tabs. To actually share spawned MCP server
// processes across concurrently open tabs within one `pi --mode rpc`
// process, the registry lives on `globalThis` (keyed by a global symbol so
// it survives re-execution of this module), refcounted per server so a
// server process is only spawned once per distinct config and only closed
// once the last tab using it goes away.
//
// Also read directly by core's `rpc-mode.ts` (get_mcp_status) to expose
// per-server status/tools over RPC — that file duplicates (does not import)
// the `Symbol.for` keys and shapes below, so keep both files in sync.
// ---------------------------------------------------------------------------

interface SharedMcpEntry {
  name: string;
  configHash: string;
  refCount: number;
  client: Client | null;
  tools: Tool[] | null;
  status: McpServerStatus;
  /** Bumped on every (re)connect attempt/teardown; lets an in-flight retry loop notice it's been superseded or abandoned. */
  generation: number;
  statusListeners: Set<() => void>;
}

const REGISTRY_KEY = Symbol.for("pi-mono-x.mcp.sharedClients.v1");

function getRegistry(): Map<string, SharedMcpEntry> {
  const g = globalThis as unknown as Record<symbol, Map<string, SharedMcpEntry> | undefined>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY] as Map<string, SharedMcpEntry>;
}

// Configured-server list per session (including disabled servers, which never
// get a SharedMcpEntry at all). Keyed by the session's real SessionManager id
// (ctx.sessionManager.getSessionId()) so core RPC code (rpc-mode.ts) can read
// it directly via `targetSession.sessionId` — NOT the RPC-mode-local synthetic
// session id used elsewhere in the protocol. Read by rpc-mode.ts's
// `get_mcp_status` handler; keep both in sync if this shape changes.
interface SessionServerInfo {
  name: string;
  disabled: boolean;
  key: string;
}

const SESSION_SERVERS_KEY = Symbol.for("pi-mono-x.mcp.sessionServers.v1");

function getSessionServersRegistry(): Map<string, SessionServerInfo[]> {
  const g = globalThis as unknown as Record<symbol, Map<string, SessionServerInfo[]> | undefined>;
  if (!g[SESSION_SERVERS_KEY]) g[SESSION_SERVERS_KEY] = new Map();
  return g[SESSION_SERVERS_KEY] as Map<string, SessionServerInfo[]>;
}

function notifyStatus(entry: SharedMcpEntry): void {
  for (const listener of entry.statusListeners) listener();
}

async function connectServer(name: string, serverConfig: McpServerConfig, log: LogFn): Promise<{ client: Client; tools: Tool[] }> {
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

  const toolsResponse = await client.request({ method: "tools/list" }, ListToolsResultSchema);
  return { client, tools: toolsResponse.tools };
}

function startConnectLoop(key: string, entry: SharedMcpEntry, serverConfig: McpServerConfig, log: LogFn): void {
  const myGeneration = ++entry.generation;
  const attempt = async (attemptNo: number, delay: number): Promise<void> => {
    const registry = getRegistry();
    if (registry.get(key) !== entry || entry.generation !== myGeneration) return; // superseded or torn down
    entry.status = { status: attemptNo === 1 ? "connecting" : "retrying", attempt: attemptNo };
    notifyStatus(entry);
    try {
      const { client, tools } = await connectServer(entry.name, serverConfig, log);
      if (registry.get(key) !== entry || entry.generation !== myGeneration) {
        // Every subscriber left while we were connecting — don't leak the process.
        void client.close().catch(() => {});
        return;
      }
      entry.client = client;
      entry.tools = tools;
      entry.status = { status: "connected", attempt: attemptNo };
      log(`Registered ${tools.length} tools from ${entry.name} (shared)`);
      notifyStatus(entry);
    } catch (error: any) {
      const message = error?.message || String(error);
      log(`Failed to start server ${entry.name}`, error);
      if (registry.get(key) !== entry || entry.generation !== myGeneration) return;
      const nextRetryAt = Date.now() + delay;
      entry.status = { status: "retrying", error: message, attempt: attemptNo, nextRetryAt };
      notifyStatus(entry);
      await sleep(delay);
      if (registry.get(key) !== entry || entry.generation !== myGeneration) return;
      await attempt(attemptNo + 1, Math.min(delay * 2, MAX_RETRY_DELAY_MS));
    }
  };
  void attempt(1, INITIAL_RETRY_DELAY_MS);
}

/**
 * Acquire a reference to the shared MCP client for `name`/`serverConfig`,
 * starting it (with retry/backoff) if nobody else has it running yet.
 * Returns the registry key actually used — normally `name`, but if a
 * differently-configured entry for the same name is already live (e.g. the
 * on-disk config changed between sessions), a private, non-shared entry is
 * used instead so two different configs never get mixed under one client.
 */
function acquireSharedServer(name: string, serverConfig: McpServerConfig, log: LogFn, onStatusChange: () => void): string {
  const registry = getRegistry();
  const hash = configHash(serverConfig);
  let key = name;
  let entry = registry.get(key);
  if (entry && entry.configHash !== hash) {
    key = `${name}::${hash}`;
    entry = registry.get(key);
  }
  if (!entry) {
    entry = {
      name,
      configHash: hash,
      refCount: 0,
      client: null,
      tools: null,
      status: { status: "connecting" },
      generation: 0,
      statusListeners: new Set(),
    };
    registry.set(key, entry);
  }
  entry.refCount++;
  entry.statusListeners.add(onStatusChange);
  if (!entry.client && entry.generation === 0) {
    startConnectLoop(key, entry, serverConfig, log);
  }
  return key;
}

function releaseSharedServer(key: string, onStatusChange: () => void): void {
  const registry = getRegistry();
  const entry = registry.get(key);
  if (!entry) return;
  entry.statusListeners.delete(onStatusChange);
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.generation++; // abandon any in-flight connect/retry loop
    registry.delete(key);
    if (entry.client) void entry.client.close().catch(() => {});
  }
}

async function forceReconnectSharedServer(name: string, key: string, serverConfig: McpServerConfig, log: LogFn): Promise<{ client: Client; tools: Tool[] }> {
  const registry = getRegistry();
  const existing = registry.get(key);
  if (existing?.client) {
    const old = existing.client;
    existing.client = null;
    void old.close().catch(() => {});
  }
  const { client, tools } = await connectServer(name, serverConfig, log);
  const entry = registry.get(key);
  if (entry) {
    entry.client = client;
    entry.tools = tools;
    entry.status = { status: "connected" };
    notifyStatus(entry);
  }
  return { client, tools };
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const mcpDir = path.join(homedir(), ".pi", "agent", "mcp");
  const configPath = path.join(homedir(), ".pi", "agent", "mcp-config.json");
  const logPath = path.join(mcpDir, "mcp.log");

  if (!fs.existsSync(mcpDir)) fs.mkdirSync(mcpDir, { recursive: true });

  const log: LogFn = (msg, ...args) => {
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

  // Registry keys this session instance currently holds a reference on
  // (name -> registry key, which may differ from name — see acquireSharedServer).
  let acquiredKeys: Map<string, string> = new Map();
  let onStatusChangeRef: () => void = () => {};

  const updateStatus = (ctx: ExtensionContext, total: number): void => {
    if (!ctx.hasUI) return;
    const registry = getRegistry();
    const statuses = [...acquiredKeys.values()]
      .map((key) => registry.get(key)?.status)
      .filter((s): s is McpServerStatus => Boolean(s));
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

  const releaseAll = () => {
    for (const key of acquiredKeys.values()) releaseSharedServer(key, onStatusChangeRef);
    acquiredKeys = new Map();
  };

  pi.on("session_start", async (event, ctx) => {
    log("Session start: attaching to shared MCP servers");

    // A repeated session_start on the same instance (e.g. ctx.reload())
    // — release whatever we held before re-acquiring.
    releaseAll();

    const sessionId = ctx.sessionManager.getSessionId();
    const allEntries = Object.entries(config.mcpServers);
    const serverEntries = allEntries.filter(([, cfg]) => !cfg.disabled);
    const total = serverEntries.length;

    const publishSessionServers = () => {
      getSessionServersRegistry().set(
        sessionId,
        allEntries.map(([name, cfg]) => ({
          name,
          disabled: Boolean(cfg.disabled),
          key: acquiredKeys.get(name) ?? name,
        })),
      );
    };

    if (total === 0) {
      if (ctx.hasUI) ctx.ui.setStatus("mcp", "");
      publishSessionServers();
      return;
    }

    const registeredServers = new Set<string>();
    const registerToolsFor = (name: string, key: string) => {
      if (registeredServers.has(name)) return;
      const entry = getRegistry().get(key);
      if (!entry?.tools) return;
      registeredServers.add(name);
      for (const tool of entry.tools) {
        const piToolName = `${name}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
        pi.registerTool({
          name: piToolName,
          label: `${name}: ${tool.name}`,
          description: tool.description || `MCP tool from ${name}`,
          parameters: tool.inputSchema as any,
          execute: async (toolCallId, params) => {
            // Resolved at call time (not captured at registration) so a
            // /mcpauth reconnect elsewhere is picked up automatically.
            const client = getRegistry().get(key)?.client;
            if (!client) throw new Error(`${name} is not connected`);
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
    };

    const allReady = new Promise<void>((resolve) => {
      const checkDone = () => {
        if ([...acquiredKeys.keys()].every((n) => registeredServers.has(n))) resolve();
      };
      onStatusChangeRef = () => {
        updateStatus(ctx, total);
        for (const [name, key] of acquiredKeys) registerToolsFor(name, key);
        checkDone();
      };
      for (const [name, serverConfig] of serverEntries) {
        const key = acquireSharedServer(name, serverConfig, log, onStatusChangeRef);
        acquiredKeys.set(name, key);
      }
      publishSessionServers();
      // Servers already running for another tab are ready immediately.
      for (const [name, key] of acquiredKeys) registerToolsFor(name, key);
      updateStatus(ctx, total);
      checkDone();
    });

    // Soft timeout — don't block session start on a slow/retrying server,
    // same as before; it'll finish attaching in the background.
    await Promise.race([allReady, sleep(SOFT_STARTUP_TIMEOUT_MS)]);
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
            const registry = getRegistry();
            const statusEntries: Array<[string, McpServerStatus]> = [...acquiredKeys.entries()].map(
              ([name, key]) => [name, registry.get(key)?.status ?? { status: "connecting" as const }],
            );

            lines.push(borderLine("┌", "─".repeat(availWidth - 2), "┐"));
            const title = " MCP Servers Status ";
            lines.push(borderFg("│") + theme.fg("accent", title) + " ".repeat(Math.max(0, availWidth - 2 - title.length)) + borderFg("│"));
            lines.push(borderLine("├", "─".repeat(availWidth - 2), "┤"));

            for (const [name, info] of statusEntries) {
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
              // Reconnect the SHARED entry — every tab currently using this
              // server picks up the freshly authenticated client on its
              // next tool call (see registerToolsFor's execute lookup).
              const key = acquiredKeys.get(serverName) ?? serverName;
              const { tools } = await forceReconnectSharedServer(serverName, key, serverConfig, log);

              // Re-register tools for THIS session in case names/schemas changed.
              for (const tool of tools) {
                const piToolName = `${serverName}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
                pi.registerTool({
                  name: piToolName,
                  label: `${serverName}: ${tool.name}`,
                  description: tool.description || `MCP tool from ${serverName}`,
                  parameters: tool.inputSchema as any,
                  execute: async (toolCallId: any, params: any) => {
                    const client = getRegistry().get(key)?.client;
                    if (!client) throw new Error(`${serverName} is not connected`);
                    const result = await client.request(
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

              log(`Reconnected ${serverName}: ${tools.length} tools`);
              ctx.ui.notify(`${serverName}: reconnected (${tools.length} tools)`, "info");
            } catch (err: any) {
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

  pi.on("session_shutdown", async (_event, ctx) => {
    log("Session shutdown: releasing shared MCP servers");
    releaseAll();
    getSessionServersRegistry().delete(ctx.sessionManager.getSessionId());
  });
}
