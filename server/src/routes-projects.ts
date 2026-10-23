import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Projects } from "./projects.js";
import type { Store } from "./store.js";

interface Deps {
  store: Store;
  projects: Projects;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const createBody = z.object({
  title: z.string().trim().min(1).max(80),
  brief: z.string().max(8000).default(""),
  message: z.string().trim().min(1).max(8000),
});

const messageBody = z.object({ text: z.string().trim().min(1).max(8000) });

const editBody = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  brief: z.string().max(8000).optional(),
  closed: z.boolean().optional(),
});

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

/** Project threads: everything needs the office token (threads hold your work). */
export function registerProjectRoutes(app: FastifyInstance, deps: Deps) {
  const { store, projects } = deps;
  const auth = { preHandler: deps.requireToken };
  const pid = (req: FastifyRequest) => Number((req.params as { pid: string }).pid);

  app.get("/api/projects", auth, async () => ({
    projects: store.projects().map((p) => ({ ...p, active: projects.active(p.id) })),
  }));

  app.post("/api/projects", auth, async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const project = await projects.create(body.data.title, body.data.brief, body.data.message);
    return { project };
  });

  app.get("/api/projects/:pid", auth, async (req, reply) => {
    const project = store.project(pid(req));
    if (!project) return reply.code(404).send({ error: "no such project" });
    const turns = store.projectTasks(project.id).map((t) => ({ id: t.id, occupantId: t.occupantId, status: t.status, title: t.title, steps: t.steps, error: t.error, createdAt: t.createdAt }));
    return { project: { ...project, active: projects.active(project.id) }, messages: store.projectMessages(project.id), notes: store.projectNotes(project.id), turns };
  });

  app.post("/api/projects/:pid/messages", auth, async (req, reply) => {
    if (!store.project(pid(req))) return reply.code(404).send({ error: "no such project" });
    const body = messageBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    return { message: await projects.post(pid(req), body.data.text) };
  });

  app.put("/api/projects/:pid", auth, async (req, reply) => {
    const project = store.project(pid(req));
    if (!project) return reply.code(404).send({ error: "no such project" });
    const body = editBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    if (body.data.closed) {
      projects.stop(project.id);
      void projects.summarize(project.id);
    }
    store.updateProject(project.id, {
      ...(body.data.title !== undefined ? { title: body.data.title } : {}),
      ...(body.data.brief !== undefined ? { brief: body.data.brief } : {}),
      ...(body.data.closed !== undefined ? { status: body.data.closed ? "closed" : "idle", needsYou: false } : {}),
    });
    projects.refresh(project.id);
    return { project: store.project(project.id) };
  });

  app.post("/api/projects/:pid/stop", auth, async (req, reply) => {
    if (!store.project(pid(req))) return reply.code(404).send({ error: "no such project" });
    projects.stop(pid(req));
    return { project: store.project(pid(req)) };
  });

  app.delete("/api/projects/:pid", auth, async (req, reply) => {
    const id = pid(req);
    if (!store.project(id)) return reply.code(404).send({ error: "no such project" });
    projects.stop(id);
    store.removeProject(id);
    return { ok: true };
  });
}
