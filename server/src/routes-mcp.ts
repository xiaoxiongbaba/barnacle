import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Mcp } from "./mcp.js";

/** MCP servers in Settings: add, change, reconnect, remove, and the rule for each tool. All need the token. */

interface Deps {
  mcp: Mcp;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const rule = z.enum(["allow", "ask", "deny"]);
const serverBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    transport: z.enum(["stdio", "http"]),
    command: z.string().trim().max(500).default(""),
    args: z.array(z.string().max(1000)).max(50).default([]),
    url: z.string().trim().max(1000).default(""),
    /** Environment variables (stdio) or headers (http). An empty value keeps the saved one. */
    secrets: z.array(z.object({ key: z.string().trim().min(1).max(100), value: z.string().max(8000).default("") })).max(30).default([]),
    enabled: z.boolean().default(true),
    members: z.array(z.string().max(40)).max(200).nullable().default(null),
    rules: z.record(z.string().max(200), rule).default({}),
    defaultRule: rule.default("ask"),
  })
  .refine((b) => (b.transport === "stdio" ? !!b.command : /^https?:\/\//.test(b.url)), { message: "a command (stdio) or an http(s) URL is needed" });

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
const num = (req: FastifyRequest) => Number((req.params as { id: string }).id);

export function registerMcpRoutes(app: FastifyInstance, deps: Deps) {
  const { mcp } = deps;
  const auth = { preHandler: deps.requireToken };
  const view = (id: number) => {
    const c = mcp.get(id)!;
    return { ...c, secretKeys: mcp.secretKeys(id), state: mcp.state(id), toolNames: Object.fromEntries(mcp.state(id).tools.map((t) => [t.name, mcp.toolName(c, t.name)])) };
  };

  app.get("/api/mcp", auth, async () => ({ servers: mcp.list().map((c) => view(c.id)) }));

  app.post("/api/mcp", auth, async (req, reply) => {
    const body = serverBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const { secrets, ...config } = body.data;
    const c = mcp.add(config, secrets);
    return { server: view(c.id) };
  });

  app.put("/api/mcp/:id", auth, async (req, reply) => {
    const body = serverBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const { secrets, ...config } = body.data;
    if (!mcp.update(num(req), config, secrets)) return reply.code(404).send({ error: "no such server" });
    return { server: view(num(req)) };
  });

  app.post("/api/mcp/:id/reconnect", auth, async (req, reply) => {
    if (!mcp.get(num(req))) return reply.code(404).send({ error: "no such server" });
    await mcp.reconnect(num(req));
    return { server: view(num(req)) };
  });

  app.delete("/api/mcp/:id", auth, async (req, reply) => {
    if (!mcp.get(num(req))) return reply.code(404).send({ error: "no such server" });
    await mcp.remove(num(req));
    return { ok: true };
  });
}
