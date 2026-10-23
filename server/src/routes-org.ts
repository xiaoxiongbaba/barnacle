import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CATEGORIES, type Ceo } from "./ceo.js";
import type { Organization } from "./org.js";
import { startOfDay, validTimeZone } from "./schedule.js";
import type { Settings } from "./settings.js";
import type { Store } from "./store.js";

interface Deps {
  store: Store;
  org: Organization;
  ceo: Ceo;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  settings: () => Settings;
  saveOrg: (patch: Partial<Settings["org"]>) => void;
  /** After the chairman or the floor changed: desks again. */
  syncDesks: () => void;
  /** Adds the CEO and chairman offices to the floor (if missing). */
  addSuite: () => boolean;
  hasSuite: () => boolean;
  inboxCount: () => number;
}

const orgBody = z.object({
  enabled: z.boolean().optional(),
  chairman: z.string().max(40).nullable().optional(),
  managers: z.record(z.string().max(40), z.string().max(40)).optional(),
  reportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  reportDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  timeZone: z.string().max(64).refine(validTimeZone, "unknown time zone").optional(),
  language: z.enum(["en", "ja", "zh-Hant"]).optional(),
  ceo: z.string().max(40).nullable().optional(),
  delegation: z.record(z.string().max(60), z.object({ enabled: z.boolean(), dailyLimit: z.number().int().min(1).max(200).default(10) })).optional(),
  highRisk: z.array(z.string().max(60)).optional(),
  managerReview: z.record(z.string().max(40), z.boolean()).optional(),
});

const overruleBody = z.object({ note: z.string().trim().max(1000).default("") });

const taskBody = z.object({ prompt: z.string().trim().min(1).max(8000) });

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

/** The company: settings, reports, the chairman's dashboard and work for departments. All need the token. */
export function registerOrgRoutes(app: FastifyInstance, deps: Deps) {
  const { store, org } = deps;
  const auth = { preHandler: deps.requireToken };

  app.get("/api/org", auth, async () => ({
    org: deps.settings().org,
    hasSuite: deps.hasSuite(),
    departments: org.departments().map((d) => ({ id: d.room.id, name: d.room.name, hue: d.room.hue, manager: d.manager, members: d.members })),
  }));

  app.put("/api/org", auth, async (req, reply) => {
    const body = orgBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const patch = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined)) as Partial<Settings["org"]>;
    if (patch.chairman && !store.exists(patch.chairman)) return reply.code(400).send({ error: "no such occupant" });
    if (patch.ceo && !store.exists(patch.ceo)) return reply.code(400).send({ error: "no such occupant" });
    if (patch.delegation) patch.delegation = Object.fromEntries(Object.entries(patch.delegation).filter(([k]) => CATEGORIES.includes(k)));
    // Turning it on starts the clock: the first reports cover the time from now.
    if (patch.enabled && !deps.settings().org.enabled) patch.lastReportAt = new Date().toISOString();
    deps.saveOrg(patch);
    deps.syncDesks();
    return { org: deps.settings().org };
  });

  app.post("/api/org/suite", auth, async () => ({ added: deps.addSuite() }));

  /** Makes reports now: one department's, or all. */
  app.post("/api/org/reports", auth, async (req, reply) => {
    const room = (req.body as { room?: string } | undefined)?.room;
    if (room) {
      const r = await org.runOne(room);
      if (!r) return reply.code(404).send({ error: "no such department" });
      return { reports: [r] };
    }
    return { reports: await org.runAll() };
  });

  app.get("/api/org/reports", auth, async (req) => {
    const q = req.query as { room?: string; limit?: string };
    return { reports: store.reports({ roomId: q.room || undefined, limit: Math.min(200, Number(q.limit) || 50) }) };
  });

  /** The chairman's dashboard: every department at a glance, and what waits for you. */
  app.get("/api/org/dashboard", auth, async () => {
    const settings = deps.settings();
    const today = startOfDay(settings.org.timeZone).toISOString();
    const now = new Date().toISOString();
    const pending = store.deliveries({ status: "pending", limit: 1000 });
    const departments = org.departments().map((d) => {
      const { facts } = org.facts(d, today, now);
      const people = d.members.map((id) => store.occupant(id)).filter((o) => o !== undefined);
      return {
        id: d.room.id,
        name: d.room.name,
        hue: d.room.hue,
        purpose: d.room.purpose,
        manager: d.manager,
        members: d.members,
        stats: {
          total: people.length,
          working: people.filter((o) => !["idle", "offline"].includes(o.state)).length,
          doneToday: facts.done.length,
          failedToday: facts.failed.length,
          open: facts.open.length,
          unchecked: pending.filter((t) => d.members.includes(t.occupantId)).length,
          approvals: facts.approvals.length,
        },
        latest: store.reports({ roomId: d.room.id, limit: 1 })[0] ?? null,
      };
    });
    return {
      org: settings.org,
      hasSuite: deps.hasSuite(),
      company: store.reports({ roomId: "company", limit: 1 })[0] ?? null,
      decisions: store.decisions({ by: "ceo", limit: 20 }),
      departments,
      inbox: deps.inboxCount(),
      unchecked: pending.length,
    };
  });

  /** The CEO: what you delegated (and your record per category), and its recent decisions. */
  app.get("/api/org/ceo", auth, async () => ({
    categories: deps.ceo.categories(),
    decisions: store.decisions({ by: "ceo", limit: 60 }),
  }));

  app.post("/api/org/ceo/decisions/:id/overrule", auth, async (req, reply) => {
    const body = overruleBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const result = deps.ceo.overrule(Number((req.params as { id: string }).id), body.data.note);
    if (!result.ok) return reply.code(409).send({ error: result.message });
    return result;
  });

  app.post("/api/departments/:room/tasks", auth, async (req, reply) => {
    const body = taskBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const result = org.dispatch((req.params as { room: string }).room, body.data.prompt);
    if (typeof result === "string") return reply.code(409).send({ error: result });
    return { task: result };
  });
}
