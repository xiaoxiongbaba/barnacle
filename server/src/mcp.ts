import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "./ai.js";
import { decrypt, encrypt } from "./crypto.js";
import type { Rule } from "./governance.js";
import type { Store, Task } from "./store.js";

/**
 * MCP servers: tools from outside the office (calendars, Notion, GitHub, files…) that agents can use.
 * You add a server in Settings (a command the office runs, or a URL) and choose who may use it; each of
 * its tools goes through the office's policy, "ask me first" by default (the CEO can decide those if you
 * delegate them). Secrets (environment variables, headers) are encrypted at rest.
 */

export interface McpConfig {
  id: number;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  /** Who may use it (occupant ids), or null for every agent. */
  members: string[] | null;
  /** Per tool: allow / ask / deny; tools not listed use `defaultRule`. */
  rules: Record<string, Rule>;
  defaultRule: Rule;
  createdAt: string;
}

/** Environment variables (stdio) or HTTP headers: names are shown, values never leave the server. */
export interface Secret {
  key: string;
  value: string;
}

export interface McpTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface McpState {
  status: "off" | "connecting" | "ready" | "error";
  error: string;
  tools: McpTool[];
}

interface Row {
  id: number;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  secrets: string;
  enabled: number;
  members: string | null;
  rules: string;
  default_rule: Rule;
  created_at: string;
}

const toConfig = (r: Row): McpConfig => ({
  id: Number(r.id),
  name: String(r.name),
  transport: r.transport,
  command: String(r.command),
  args: JSON.parse(r.args) as string[],
  url: String(r.url),
  enabled: !!r.enabled,
  members: r.members === null ? null : (JSON.parse(r.members) as string[]),
  rules: JSON.parse(r.rules) as Record<string, Rule>,
  defaultRule: r.default_rule,
  createdAt: String(r.created_at),
});

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 3 * 60_000;
const RETRY_MS = 60_000;
const MAX_RESULT = 20_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Tool names the model sees: mcp__server__tool, letters, digits, _ and - only, at most 64 characters. */
const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";

export class Mcp {
  private states = new Map<number, McpState>();
  private clients = new Map<number, Client>();
  private retry = new Map<number, NodeJS.Timeout>();
  /** Tells the pages a server's state changed (name and status only). */
  onChange: () => void = () => {};

  constructor(private store: Store) {
    store.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        command TEXT NOT NULL DEFAULT '',
        args TEXT NOT NULL DEFAULT '[]',
        url TEXT NOT NULL DEFAULT '',
        secrets TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        members TEXT,
        rules TEXT NOT NULL DEFAULT '{}',
        default_rule TEXT NOT NULL DEFAULT 'ask',
        created_at TEXT NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------------- settings

  list(): McpConfig[] {
    return (this.store.sql.prepare("SELECT * FROM mcp_servers ORDER BY id").all() as unknown as Row[]).map(toConfig);
  }

  get(id: number): McpConfig | undefined {
    const r = this.store.sql.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as unknown as Row | undefined;
    return r && toConfig(r);
  }

  /** The secrets' names (values stay here). */
  secretKeys(id: number): string[] {
    return this.secrets(id).map((s) => s.key);
  }

  private secrets(id: number): Secret[] {
    const r = this.store.sql.prepare("SELECT secrets FROM mcp_servers WHERE id = ?").get(id) as { secrets: string } | undefined;
    if (!r?.secrets) return [];
    try {
      return JSON.parse(decrypt(r.secrets)) as Secret[];
    } catch {
      return [];
    }
  }

  state(id: number): McpState {
    return this.states.get(id) ?? { status: "off", error: "", tools: [] };
  }

  add(c: Omit<McpConfig, "id" | "createdAt">, secrets: Secret[]): McpConfig {
    const res = this.store.sql
      .prepare("INSERT INTO mcp_servers (name, transport, command, args, url, secrets, enabled, members, rules, default_rule, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.name, c.transport, c.command, JSON.stringify(c.args), c.url, secrets.length ? encrypt(JSON.stringify(secrets)) : "", c.enabled ? 1 : 0, c.members ? JSON.stringify(c.members) : null, JSON.stringify(c.rules), c.defaultRule, new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    if (c.enabled) void this.connect(id);
    return this.get(id)!;
  }

  /**
   * Changes a server. Secrets given with an empty value keep the value they had (the page never sees
   * them); secrets left out are removed. Reconnects when how to reach it changed.
   */
  update(id: number, c: Omit<McpConfig, "id" | "createdAt">, secrets: Secret[]) {
    const before = this.get(id);
    if (!before) return undefined;
    const old = new Map(this.secrets(id).map((s) => [s.key, s.value]));
    const merged = secrets.map((s) => ({ key: s.key, value: s.value || old.get(s.key) || "" })).filter((s) => s.value);
    this.store.sql
      .prepare("UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, url = ?, secrets = ?, enabled = ?, members = ?, rules = ?, default_rule = ? WHERE id = ?")
      .run(c.name, c.transport, c.command, JSON.stringify(c.args), c.url, merged.length ? encrypt(JSON.stringify(merged)) : "", c.enabled ? 1 : 0, c.members ? JSON.stringify(c.members) : null, JSON.stringify(c.rules), c.defaultRule, id);
    const reach = (x: McpConfig) => JSON.stringify([x.transport, x.command, x.args, x.url, x.enabled]);
    const secretsChanged = JSON.stringify([...old]) !== JSON.stringify(merged.map((s) => [s.key, s.value]));
    if (reach(before) !== reach(this.get(id)!) || secretsChanged) void this.reconnect(id);
    else this.onChange();
    return this.get(id);
  }

  async remove(id: number) {
    await this.disconnect(id);
    this.states.delete(id);
    this.store.sql.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    this.onChange();
  }

  // ---------------------------------------------------------------- connections

  /** Connects every enabled server (at start). */
  start() {
    for (const c of this.list()) if (c.enabled) void this.connect(c.id);
  }

  async reconnect(id: number) {
    await this.disconnect(id);
    const c = this.get(id);
    if (c?.enabled) await this.connect(id);
    else {
      this.states.set(id, { status: "off", error: "", tools: [] });
      this.onChange();
    }
  }

  private async disconnect(id: number) {
    clearTimeout(this.retry.get(id));
    this.retry.delete(id);
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (client) await client.close().catch(() => {});
  }

  private set(id: number, s: McpState) {
    this.states.set(id, s);
    this.onChange();
  }

  async connect(id: number): Promise<void> {
    const c = this.get(id);
    if (!c || !c.enabled || this.clients.has(id)) return;
    this.set(id, { status: "connecting", error: "", tools: [] });
    const secrets = Object.fromEntries(this.secrets(id).map((s) => [s.key, s.value]));
    const client = new Client({ name: "barnacle", version: "0.1.0" });
    try {
      if (c.transport === "stdio") {
        if (!c.command.trim()) throw new Error("no command");
        await client.connect(new StdioClientTransport({ command: c.command, args: c.args, env: { ...getDefaultEnvironment(), ...secrets }, stderr: "ignore" }), { timeout: CONNECT_TIMEOUT_MS });
      } else {
        const url = new URL(c.url);
        try {
          await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: secrets } }), { timeout: CONNECT_TIMEOUT_MS });
        } catch (error) {
          // Older servers speak HTTP+SSE.
          await client.close().catch(() => {});
          await client.connect(new SSEClientTransport(url, { requestInit: { headers: secrets } }), { timeout: CONNECT_TIMEOUT_MS }).catch(() => {
            throw error;
          });
        }
      }
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
        for (const t of page.tools) tools.push({ name: t.name, description: t.description ?? t.title ?? "", schema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown> });
        cursor = page.nextCursor;
      } while (cursor && tools.length < 500);
      this.clients.set(id, client);
      client.onclose = () => {
        if (this.clients.get(id) !== client) return;
        this.clients.delete(id);
        this.set(id, { status: "error", error: "The connection closed.", tools: [] });
        this.scheduleRetry(id);
      };
      this.set(id, { status: "ready", error: "", tools });
    } catch (error) {
      await client.close().catch(() => {});
      this.set(id, { status: "error", error: clip((error as Error).message || "could not connect", 300), tools: [] });
      this.scheduleRetry(id);
    }
  }

  private scheduleRetry(id: number) {
    clearTimeout(this.retry.get(id));
    this.retry.set(
      id,
      setTimeout(() => {
        this.retry.delete(id);
        void this.connect(id);
      }, RETRY_MS),
    );
  }

  // ---------------------------------------------------------------- agents

  /** The model's name for a server's tool. */
  toolName(c: McpConfig, tool: string) {
    return `mcp__${slug(c.name).slice(0, 20)}__${slug(tool)}`.slice(0, 64);
  }

  /** Which server and tool a model-side tool name is, if it's an MCP one. */
  resolve(name: string): { server: McpConfig; tool: McpTool } | null {
    if (!name.startsWith("mcp__")) return null;
    for (const c of this.list()) {
      const tool = this.state(c.id).tools.find((t) => this.toolName(c, t.name) === name);
      if (tool) return { server: c, tool };
    }
    return null;
  }

  /** The policy for a tool call: its rule and how to describe it in the inbox. */
  rule(name: string, input: Record<string, unknown>): { rule: Rule; summary: string } | null {
    const hit = this.resolve(name);
    if (!hit) return null;
    const args = clip(JSON.stringify(input), 300);
    return { rule: hit.server.rules[hit.tool.name] ?? hit.server.defaultRule, summary: `${hit.server.name} → ${hit.tool.name} ${args}` };
  }

  /** The servers' tools an agent may use (connected servers only). */
  tools(task: Task, signal: AbortSignal): AgentTool[] {
    const out: AgentTool[] = [];
    for (const c of this.list()) {
      if (!c.enabled || (c.members && !c.members.includes(task.occupantId))) continue;
      const client = this.clients.get(c.id);
      if (!client) continue;
      for (const t of this.state(c.id).tools) {
        if ((c.rules[t.name] ?? c.defaultRule) === "deny") continue;
        out.push({
          name: this.toolName(c, t.name),
          description: clip(`[${c.name}] ${t.description}`, 1000),
          schema: t.schema.type === "object" ? t.schema : { type: "object", properties: {} },
          run: async (input) => {
            const res = await client.callTool({ name: t.name, arguments: input }, undefined, { timeout: CALL_TIMEOUT_MS, signal });
            const content = (res.content ?? []) as { type: string; text?: string; resource?: { uri?: string; text?: string }; mimeType?: string }[];
            const text = content
              .map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "resource" ? `${b.resource?.uri ?? ""}\n${b.resource?.text ?? ""}` : `[${b.type}${b.mimeType ? ` ${b.mimeType}` : ""}]`))
              .join("\n")
              .trim();
            const structured = !text && res.structuredContent ? JSON.stringify(res.structuredContent) : "";
            const out = clip(text || structured || "(no output)", MAX_RESULT);
            return res.isError ? `Error from ${c.name}: ${out}` : out;
          },
        });
      }
    }
    return out;
  }
}
