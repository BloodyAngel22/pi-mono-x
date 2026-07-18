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
/** How long a tool call waits for its server's connection attempt to finish, if it hasn't already. */
const CONNECT_WAIT_TIMEOUT_MS = 30000;

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
// This extension module's factory (the `export default` below) is loaded
// through a fresh, non-caching jiti instance per *ResourceLoader* (see
// core/extensions/loader.ts) — but ResourceLoader instances are themselves
// reused across `fork`/`clone`/`switch_session`/`new_session` when they
// share a cwd (see `sameCwd` reuse in rpc-mode.ts, added to avoid re-running
// every extension's factory on every new tab). So this factory can run only
// ONCE for several concurrently open sessions/tabs, meaning ordinary
// module-scope state here is shared by all of them, not private to one —
// see the `sessionStates` map below, which is what makes per-session
// bookkeeping (acquired refs) actually per-session again.
//
// To share spawned MCP server processes across concurrently open tabs
// within one `pi --mode rpc` process, the registry lives on `globalThis`
// (keyed by a global symbol so it survives re-execution of this module),
// refcounted per server so a server process is only spawned once per
// distinct config and only closed once the last tab using it goes away.
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

// ---------------------------------------------------------------------------
// Startup connection concurrency limiter.
//
// session_start used to call acquireSharedServer() for every enabled server
// in a tight loop, and startConnectLoop() fires connectServer() immediately —
// so with dozens of configured servers, every one of them (uvx/npx package
// resolution, venv/npm startup, network handshakes) spawned at once. That's a
// CPU/IO/process-table thundering herd right at app launch. Cap how many
// connectServer() calls are actually in flight; the rest queue and start as
// slots free up, spreading the same total work out instead of bursting it.
// Lives on globalThis for the same re-execution reason as the client
// registry above (this module has no persistent module-scope state).
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_CONNECTS = 4;
// A slot is force-released after this long even if the connect attempt is
// still hanging (e.g. an unresponsive remote server) — otherwise one bad
// server could starve every other server's turn in the queue forever. The
// underlying connect attempt itself is NOT cancelled; it keeps running and
// resolves into startConnectLoop's normal retry/backoff handling.
const CONNECT_SLOT_TIMEOUT_MS = 10000;
const CONNECT_QUEUE_KEY = Symbol.for("pi-mono-x.mcp.connectQueue.v1");

interface ConnectQueueState {
  active: number;
  queue: Array<() => void>;
}

function getConnectQueue(): ConnectQueueState {
  const g = globalThis as unknown as Record<symbol, ConnectQueueState | undefined>;
  if (!g[CONNECT_QUEUE_KEY]) g[CONNECT_QUEUE_KEY] = { active: 0, queue: [] };
  return g[CONNECT_QUEUE_KEY] as ConnectQueueState;
}

async function withConnectSlot<T>(fn: () => Promise<T>): Promise<T> {
  const state = getConnectQueue();
  if (state.active >= MAX_CONCURRENT_CONNECTS) {
    await new Promise<void>((resolve) => state.queue.push(resolve));
  }
  state.active++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.active--;
    const next = state.queue.shift();
    if (next) next();
  };
  const timer = setTimeout(release, CONNECT_SLOT_TIMEOUT_MS);
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    release();
  }
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
      const { client, tools } = await withConnectSlot(() => connectServer(entry.name, serverConfig, log));
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
 * starting it (with retry/backoff) immediately if nobody else has it running
 * yet — every enabled server connects at session_start, no matter how much
 * later its tools actually get called. Returns the registry key actually
 * used — normally `name`, but if a differently-configured entry for the same
 * name is already live (e.g. the on-disk config changed between sessions), a
 * private, non-shared entry is used instead so two different configs never
 * get mixed under one client.
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

/**
 * Resolve a live client for `key`. The connect loop is already running (or
 * done) by the time this is called — started eagerly by `acquireSharedServer`
 * at session_start — so this just waits for it to finish if it's still in
 * flight. Resolves as soon as the shared entry has a client; rejects on the
 * first failed connect attempt (the background retry loop keeps going — a
 * later call may succeed) or after `CONNECT_WAIT_TIMEOUT_MS`.
 */
function ensureConnected(key: string, serverConfig: McpServerConfig, log: LogFn): Promise<Client> {
  const registry = getRegistry();
  const entry = registry.get(key);
  if (!entry) return Promise.reject(new Error(`MCP server for ${key} is not registered`));
  if (entry.client) return Promise.resolve(entry.client);
  if (entry.generation === 0) {
    startConnectLoop(key, entry, serverConfig, log);
  }
  return new Promise<Client>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      entry.statusListeners.delete(listener);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${entry.name}: MCP server did not connect within ${CONNECT_WAIT_TIMEOUT_MS / 1000}s`));
    }, CONNECT_WAIT_TIMEOUT_MS);
    const listener = () => {
      if (entry.client) {
        cleanup();
        resolve(entry.client);
      } else if (entry.status.status === "retrying" && entry.status.error) {
        // First attempt failed — fail this tool call fast instead of sitting
        // through the backoff; the shared retry loop continues in background.
        cleanup();
        reject(new Error(`${entry.name}: ${entry.status.error}`));
      }
    };
    entry.statusListeners.add(listener);
    listener();
  });
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

  // appendFileSync on every MCP event (status change, each tool call) blocks
  // the event loop for the duration of the disk write; buffer lines and flush
  // asynchronously every 500ms / 8KB instead.
  let logBuffer = "";
  let logFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushLog = () => {
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    if (!logBuffer) return;
    const chunk = logBuffer;
    logBuffer = "";
    fs.appendFile(logPath, chunk, () => {});
  };
  const log: LogFn = (msg, ...args) => {
    const timestamp = new Date().toISOString();
    logBuffer += `[${timestamp}] ${msg} ${args.length ? JSON.stringify(args) : ""}\n`;
    if (logBuffer.length >= 8192) {
      flushLog();
      return;
    }
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(flushLog, 500);
      logFlushTimer.unref?.();
    }
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

  // Per-session bookkeeping — keyed by the real session id
  // (ctx.sessionManager.getSessionId()), NOT a bare module-scope variable.
  // Since this factory can be shared by several concurrently open sessions
  // (see the comment on the shared-client-registry section above), a plain
  // module-scope `acquiredKeys` would have one session's session_start /
  // session_shutdown release or overwrite another session's refs —
  // corrupting refcounts until some tool call resolves a `key` nobody is
  // holding anymore ("MCP server for X is not registered").
  interface PerSessionMcpState {
    /** name -> registry key this session currently holds a reference on
     *  (key may differ from name — see acquireSharedServer). */
    acquiredKeys: Map<string, string>;
    onStatusChange: () => void;
  }
  const sessionStates = new Map<string, PerSessionMcpState>();

  const releaseSessionState = (state: PerSessionMcpState): void => {
    for (const key of state.acquiredKeys.values()) releaseSharedServer(key, state.onStatusChange);
    state.acquiredKeys.clear();
  };

  const updateStatus = (ctx: ExtensionContext, total: number, acquiredKeys: Map<string, string>): void => {
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

  pi.on("session_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    log(`Session start (${sessionId}): attaching to shared MCP servers`);

    // A repeated session_start for a session we've already seen (e.g.
    // ctx.reload()) — release whatever THIS session held before
    // re-acquiring. Other sessions' state lives under their own id and is
    // untouched.
    const previous = sessionStates.get(sessionId);
    if (previous) releaseSessionState(previous);

    const acquiredKeys = new Map<string, string>();
    const state: PerSessionMcpState = { acquiredKeys, onStatusChange: () => {} };
    sessionStates.set(sessionId, state);

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
            // /mcpauth reconnect elsewhere is picked up automatically. The
            // connect loop already started at session_start; this just waits
            // for it if it's still in flight.
            const serverConfig = config.mcpServers[name];
            const client =
              getRegistry().get(key)?.client ??
              (serverConfig ? await ensureConnected(key, serverConfig, log) : null);
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
      state.onStatusChange = () => {
        updateStatus(ctx, total, acquiredKeys);
        for (const [name, key] of acquiredKeys) registerToolsFor(name, key);
        checkDone();
      };
      for (const [name, serverConfig] of serverEntries) {
        const key = acquireSharedServer(name, serverConfig, log, state.onStatusChange);
        acquiredKeys.set(name, key);
      }
      publishSessionServers();
      // Servers already running for another tab are ready immediately.
      for (const [name, key] of acquiredKeys) registerToolsFor(name, key);
      updateStatus(ctx, total, acquiredKeys);
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
      const acquiredKeys = sessionStates.get(ctx.sessionManager.getSessionId())?.acquiredKeys ?? new Map<string, string>();
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
              const key = sessionStates.get(ctx.sessionManager.getSessionId())?.acquiredKeys.get(serverName) ?? serverName;
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
                    const client = getRegistry().get(key)?.client ?? (await ensureConnected(key, serverConfig, log));
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
    const sessionId = ctx.sessionManager.getSessionId();
    log(`Session shutdown (${sessionId}): releasing shared MCP servers`);
    const state = sessionStates.get(sessionId);
    if (state) {
      releaseSessionState(state);
      sessionStates.delete(sessionId);
    }
    getSessionServersRegistry().delete(sessionId);
    flushLog();
  });
}
