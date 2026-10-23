import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BUILTIN_PRICES, type Costs } from "./costs.js";
import type { Settings } from "./settings.js";
import type { Store } from "./store.js";

/** Spending: the dashboard, a task's cost, prices and budgets. All need the token. */

interface Deps {
  store: Store;
  costs: Costs;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  settings: () => Settings;
  saveCosts: (costs: Settings["costs"]) => void;
  departments: () => { id: string; name: string }[];
}

const limits = z.object({ daily: z.number().min(0).max(1_000_000).nullable(), monthly: z.number().min(0).max(10_000_000).nullable() });
const costsBody = z.object({
  prices: z.record(z.string().trim().min(1).max(120), z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000) })).optional(),
  company: limits.optional(),
  rooms: z.record(z.string().max(40), limits).optional(),
  onExceed: z.enum(["ask", "pause"]).optional(),
  light: z.object({ scheduled: z.boolean(), ask: z.boolean(), reports: z.boolean(), project: z.boolean() }).optional(),
});

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

export function registerCostRoutes(app: FastifyInstance, deps: Deps) {
  const { store, costs } = deps;
  const auth = { preHandler: deps.requireToken };

  app.get("/api/costs", auth, async (req) => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 30, 1), 92);
    return { summary: costs.summary(days), status: costs.status(), settings: deps.settings().costs, departments: deps.departments(), builtin: BUILTIN_PRICES };
  });

  app.put("/api/costs/settings", auth, async (req, reply) => {
    const body = costsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    // Rooms without any limit aren't kept.
    const rooms = body.data.rooms && Object.fromEntries(Object.entries(body.data.rooms).filter(([, l]) => l.daily !== null || l.monthly !== null));
    const next = { ...deps.settings().costs, ...body.data, ...(rooms ? { rooms } : {}) };
    deps.saveCosts(next);
    return { settings: next, status: costs.status() };
  });

  /** What a task cost, with the colleagues it asked. */
  app.get("/api/tasks/:tid/cost", auth, async (req, reply) => {
    const task = store.task(Number((req.params as { tid: string }).tid));
    if (!task) return reply.code(404).send({ error: "no such task" });
    return { spend: costs.taskSpend(task) };
  });
}
