import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Library, StoredFile } from "./library.js";
import type { Store } from "./store.js";

/** Uploading and downloading files, and the knowledge base. All need the token. */

interface Deps {
  store: Store;
  library: Library;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** Departments that can have their own documents: room id → name. */
  departments: () => { id: string; name: string }[];
}

const MAX_BYTES = 25 * 1024 * 1024;

const uploadBody = z.object({
  name: z.string().trim().min(1).max(200),
  /** The file, base64. */
  data: z.string().min(1),
  purpose: z.enum(["upload", "kb"]).default("upload"),
  scope: z.string().max(40).default("company"),
});

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
const num = (req: FastifyRequest, key: string) => Number((req.params as Record<string, string>)[key]);

export function registerFileRoutes(app: FastifyInstance, deps: Deps) {
  const { store, library } = deps;
  const auth = { preHandler: deps.requireToken };
  const scopes = () => ["company", ...deps.departments().map((d) => d.id)];

  app.post("/api/files", { ...auth, bodyLimit: Math.ceil(MAX_BYTES * 1.4) + 4096 }, async (req, reply) => {
    const body = uploadBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const data = Buffer.from(body.data.data, "base64");
    if (!data.length) return reply.code(400).send({ error: "The file is empty." });
    if (data.length > MAX_BYTES) return reply.code(413).send({ error: `Files can be up to ${MAX_BYTES / 1024 / 1024} MB.` });
    if (body.data.purpose === "kb" && !scopes().includes(body.data.scope)) return reply.code(400).send({ error: "no such department" });
    try {
      return { file: await library.add(body.data.name, data, { purpose: body.data.purpose, scope: body.data.scope }) };
    } catch (error) {
      return reply.code(400).send({ error: `${body.data.name}: ${(error as Error).message}` });
    }
  });

  /** A file's details and the start of its text (to preview). */
  app.get("/api/files/:fid", auth, async (req, reply) => {
    const file = library.file(num(req, "fid"));
    if (!file) return reply.code(404).send({ error: "no such file" });
    return { file, text: library.text(file.id).slice(0, 20_000) };
  });

  app.get("/api/files/:fid/download", auth, async (req, reply) => {
    const id = num(req, "fid");
    const file = library.file(id);
    const data = library.data(id);
    if (!file || !data) return reply.code(404).send({ error: "no such file" });
    return reply
      .header("content-type", file.mime)
      .header("content-disposition", `attachment; filename="file-${file.id}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .send(data);
  });

  /** Removes a knowledge-base document or an upload not sent yet (attachments and deliveries stay with their task). */
  app.delete("/api/files/:fid", auth, async (req, reply) => {
    const file = library.file(num(req, "fid"));
    if (!file) return reply.code(404).send({ error: "no such file" });
    if (file.purpose !== "kb" && file.purpose !== "upload") return reply.code(409).send({ error: "Files of a task stay with it." });
    library.remove(file.id);
    return { ok: true };
  });

  /** A task's attached files and the files it (and the colleagues it asked) delivered. */
  app.get("/api/tasks/:tid/files", auth, async (req, reply) => {
    const task = store.task(num(req, "tid"));
    if (!task) return reply.code(404).send({ error: "no such task" });
    const attachments = [...(task.redoOf ? library.forTask(task.redoOf, "task") : []), ...library.forTask(task.id, "task")];
    return { attachments, outputs: library.outputs(task) };
  });

  /** The files delivered in a project's turns. */
  app.get("/api/projects/:pid/files", auth, async (req) => {
    const outputs: StoredFile[] = store.projectTasks(num(req, "pid")).flatMap((t) => library.outputs(t));
    return { outputs };
  });

  // ---------------------------------------------------------------- knowledge base

  app.get("/api/knowledge", auth, async () => ({
    scopes: [{ id: "company", name: "" }, ...deps.departments()],
    documents: library.documents(),
  }));

  /** Search like the agents do (to check what they will find). */
  app.get("/api/knowledge/search", auth, async (req) => {
    const q = req.query as { q?: string; scope?: string };
    const all = scopes();
    return { hits: library.search(String(q.q ?? "").slice(0, 200), q.scope && all.includes(q.scope) ? [q.scope] : all, 10) };
  });
}
