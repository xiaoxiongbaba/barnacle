import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ACTIONS, type Governance, type Rule } from "./governance.js";
import type { Store, Task } from "./store.js";

interface Deps {
  store: Store;
  governance: Governance;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  policy: () => Record<string, Rule>;
  setPolicy: (policy: Record<string, Rule>) => void;
}

const decisionBody = z.object({ approve: z.boolean(), note: z.string().trim().max(1000).default("") });
const reviewBody = z.object({ verdict: z.enum(["accepted", "rejected"]), note: z.string().trim().max(2000).default("") });
const experienceBody = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(8000),
  applicability: z.string().trim().min(1).max(1000),
  tags: z.array(z.string().trim().max(30)).max(5).default([]),
});
const proposalBody = z.object({ approve: z.boolean(), assign: z.boolean().default(true) });
const policyBody = z.object({ policy: z.record(z.string().max(40), z.enum(["allow", "ask", "deny"])) });

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
const num = (req: FastifyRequest, key: string) => Number((req.params as Record<string, string>)[key]);

/** The inbox, approvals, reviews, the experience library, skill proposals and the policy. All need the token. */
export function registerGovernanceRoutes(app: FastifyInstance, deps: Deps) {
  const { store, governance } = deps;
  const auth = { preHandler: deps.requireToken };

  /** Everything that waits for you. */
  app.get("/api/inbox", auth, async () => {
    const skills = new Map(store.skills().map((s) => [s.id, s]));
    return {
      approvals: store.approvals("pending"),
      projects: store
        .projects()
        .filter((p) => p.needsYou && p.status !== "closed")
        .map((p) => ({ id: p.id, title: p.title, members: p.members, updatedAt: p.updatedAt })),
      experiences: store.experiences("draft"),
      skills: store.skillProposals("pending").map((p) => {
        const current = p.skillId ? skills.get(p.skillId) : undefined;
        return { ...p, current: current ? { body: current.body, description: current.description, editedByYou: current.editedByYou } : null };
      }),
      count: governance.count(),
      // Why the CEO handed these to you: "approval:12" → its note.
      ceoNotes: Object.fromEntries(
        store
          .decisions({ by: "ceo", limit: 200 })
          .filter((d) => d.decision === "escalate")
          .reverse()
          .map((d) => [`${d.refType}:${d.refId}`, d.reason]),
      ),
    };
  });

  app.post("/api/approvals/:id", auth, async (req, reply) => {
    const body = decisionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const a = governance.decide(num(req, "id"), body.data.approve, body.data.note);
    if (!a) return reply.code(404).send({ error: "no such approval" });
    return { approval: a };
  });

  app.post("/api/tasks/:tid/review", auth, async (req, reply) => {
    const body = reviewBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const result = governance.review(num(req, "tid"), body.data.verdict, body.data.note);
    if (result.error) return reply.code(409).send({ error: result.error });
    return result;
  });

  // ---------------------------------------------------------------- experience library

  app.get("/api/experiences", auth, async () => ({ experiences: store.experiences() }));

  /** One you write yourself goes straight into the library. */
  app.post("/api/experiences", auth, async (req, reply) => {
    const body = experienceBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    return { experience: store.addExperience({ ...body.data, status: "approved", proposedBy: null, taskId: null }) };
  });

  /** Edit, and approve or reject a draft (status). */
  app.put("/api/experiences/:id", auth, async (req, reply) => {
    const body = experienceBody.partial().extend({ status: z.enum(["draft", "approved", "rejected"]).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const { status, ...fields } = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined)) as typeof body.data;
    const id = num(req, "id");
    if (!store.experience(id)) return reply.code(404).send({ error: "no such entry" });
    if (Object.keys(fields).length) store.updateExperience(id, fields);
    // Keeping or dropping a draft is a decision (a precedent for the CEO).
    if (status === "approved" || status === "rejected") governance.decideExperience(id, status === "approved");
    else if (status) store.updateExperience(id, { status });
    governance.changed();
    return { experience: store.experience(id) };
  });

  app.delete("/api/experiences/:id", auth, async (req, reply) => {
    if (!store.removeExperience(num(req, "id"))) return reply.code(404).send({ error: "no such entry" });
    governance.changed();
    return { ok: true };
  });

  // ---------------------------------------------------------------- skill proposals

  /** Approving saves the skill (and, for a new one, gives it to the agent that proposed it). */
  app.post("/api/skill-proposals/:id", auth, async (req, reply) => {
    const body = proposalBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    if (!governance.decideSkill(num(req, "id"), body.data.approve, body.data.assign)) return reply.code(404).send({ error: "no such proposal" });
    return { ok: true };
  });

  // ---------------------------------------------------------------- policy

  app.get("/api/policy", auth, async () => ({ defaults: ACTIONS, policy: deps.policy() }));

  app.put("/api/policy", auth, async (req, reply) => {
    const body = policyBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    deps.setPolicy(Object.fromEntries(Object.entries(body.data.policy).filter(([k]) => k in ACTIONS)));
    return { defaults: ACTIONS, policy: deps.policy() };
  });

  // ---------------------------------------------------------------- deliveries (finished work to check)

  const snippet = (text: string) => text.replace(/[#>*_`|-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  const listItem = (t: Task) => ({
    type: "task" as const,
    id: t.id,
    occupantId: t.occupantId,
    title: t.title,
    snippet: snippet(t.status === "failed" ? t.error : t.result),
    status: t.status,
    review: t.review,
    scheduled: t.scheduleId !== null,
    redoOf: t.redoOf,
    at: t.finishedAt ?? t.createdAt,
  });

  /** The pages a task (and the colleagues it asked) read, for checking its sources. */
  const sources = (task: Task, depth = 0): { url: string; by: string }[] => {
    const own = task.steps.filter((s) => s.url).map((s) => ({ url: s.url!, by: task.occupantId }));
    if (depth >= 3) return own;
    return [...own, ...store.childTasks(task.id).flatMap((c) => sources(c, depth + 1))];
  };

  app.get("/api/deliveries", auth, async (req) => {
    const q = req.query as { status?: string; occupant?: string; q?: string };
    const status = (["pending", "accepted", "rejected", "failed", "all", "projects"] as const).find((s) => s === q.status) ?? "pending";
    const occupantId = q.occupant || undefined;
    const words = (q.q ?? "").trim().toLowerCase();
    const matches = (...texts: string[]) => !words || texts.some((x) => x.toLowerCase().includes(words));
    const counts = {
      pending: store.deliveries({ status: "pending", occupantId, limit: 1000 }).length,
      accepted: store.deliveries({ status: "accepted", occupantId, limit: 1000 }).length,
      rejected: store.deliveries({ status: "rejected", occupantId, limit: 1000 }).length,
      failed: store.deliveries({ status: "failed", occupantId, limit: 1000 }).length,
      projects: store.projects().filter((p) => p.summary && (!occupantId || p.members.includes(occupantId))).length,
    };
    const projects =
      status === "projects" || status === "all"
        ? store
            .projects()
            .filter((p) => p.summary && (!occupantId || p.members.includes(occupantId)) && matches(p.title, p.summary))
            .map((p) => ({ type: "project" as const, id: p.id, title: p.title, snippet: snippet(p.summary), members: p.members, status: p.status, at: p.updatedAt }))
        : [];
    const tasks = status === "projects" ? [] : store.deliveries({ status, occupantId }).filter((t) => matches(t.title, t.prompt, t.result));
    const items = [...tasks.map(listItem), ...projects].sort((a, b) => b.at.localeCompare(a.at));
    return { items, counts };
  });

  /** One delivery in full: what was asked, the result, how it got there, and what it read. */
  app.get("/api/deliveries/task/:tid", auth, async (req, reply) => {
    const task = store.task(num(req, "tid"));
    if (!task) return reply.code(404).send({ error: "no such task" });
    const seen = new Set<string>();
    const unique = sources(task).filter((s) => !seen.has(s.url) && seen.add(s.url));
    const redoneBy = store.deliveries({ status: "all", occupantId: task.occupantId, limit: 1000 }).find((t) => t.redoOf === task.id)?.id ?? null;
    const helpers = store.childTasks(task.id).map((c) => ({ id: c.id, occupantId: c.occupantId, kind: c.kind, title: c.title, status: c.status }));
    // Earlier versions and who sent them back (the manager, or you), oldest first.
    const rounds: { id: number; by: "manager" | "you"; note: string; managerId: string | null }[] = [];
    for (let t = task.redoOf === null ? undefined : store.task(task.redoOf); t && rounds.length < 10; t = t.redoOf === null ? undefined : store.task(t.redoOf)) {
      if (t.managerReview === "failed") rounds.unshift({ id: t.id, by: "manager", note: t.managerNote, managerId: t.managerId });
      else if (t.review === "rejected") rounds.unshift({ id: t.id, by: "you", note: t.reviewNote, managerId: null });
    }
    return { task, sources: unique, redoneBy, helpers, rounds };
  });

  /** For the badge and the "finished" toast: how many wait for checking, and the newest. */
  app.get("/api/deliveries/summary", auth, async () => {
    const pending = store.deliveries({ status: "pending", limit: 1000 });
    const latest = store.deliveries({ status: "all", limit: 1 })[0];
    return { pending: pending.length, latest: latest ? { id: latest.id, occupantId: latest.occupantId, title: latest.title, status: latest.status } : null };
  });
}
