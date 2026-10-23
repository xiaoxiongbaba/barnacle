import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { systemPrompt, type TaskRunner } from "./agents.js";
import { chat, listModels, ProviderError, type ChatMessage } from "./ai.js";
import { ENTRY_MAX, fits, MEMORY_LIMITS, usage } from "./memory.js";
import { nextRun, ruleSchema, validTimeZone, type Scheduler } from "./schedule.js";
import { parseSkillMd, slugify, toSkillMd } from "./skills.js";
import type { Store, Change } from "./store.js";
import type { Occupant } from "./states.js";

interface Deps {
  store: Store;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  parseId: (raw: unknown, reply: FastifyReply) => string | undefined;
  publish: (change: Change) => void;
  publishOccupant: (occupant: Occupant) => void;
  officeName: () => string;
  tasks: TaskRunner;
  scheduler: Scheduler;
  /** Attaches uploaded files to a task. */
  attach: (taskId: number, fileIds: number[]) => void;
}

const HISTORY_LIMIT = 20;
const CHAT_TIMEOUT_MS = 5 * 60_000;

const providerBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["anthropic", "openai"]),
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .transform((v) => v || null)
    .pipe(z.url({ protocol: /^https?$/ }).nullable()),
  /** Omit to keep the stored key; empty string removes it. */
  apiKey: z.string().trim().max(1000).optional(),
});

const brainBody = z.object({
  providerId: z.string().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  lightModel: z.string().trim().max(200).nullable().default(null),
  systemPrompt: z.string().max(4000).default(""),
  maxTokens: z.number().int().min(256).max(128_000).default(4096),
});

const chatBody = z.object({ message: z.string().trim().min(1).max(8000) });

const soulBody = z.object({
  role: z.string().trim().max(60).default(""),
  soul: z.string().max(20_000).default(""),
  instructions: z.string().max(20_000).default(""),
  skills: z.array(z.string().max(60)).max(100).default([]),
});

/** A skill as fields, or as a whole SKILL.md (`markdown`). */
const skillBody = z.union([
  z.object({ markdown: z.string().min(1).max(60_000) }),
  z.object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(500).default(""),
    body: z.string().max(60_000).default(""),
  }),
]);

const taskBody = z.object({
  prompt: z.string().trim().min(1).max(8000),
  title: z.string().trim().max(80).optional(),
  fileIds: z.array(z.number().int().positive()).max(10).default([]),
});

const memoryBody = z.object({
  target: z.enum(["memory", "user"]).default("memory"),
  text: z.string().trim().min(1).max(ENTRY_MAX),
});

const memoryEditBody = z.object({ text: z.string().trim().min(1).max(ENTRY_MAX) });

const scheduleBody = z.object({
  title: z.string().trim().max(80).default(""),
  prompt: z.string().trim().min(1).max(8000),
  rule: ruleSchema,
  timeZone: z.string().max(64).refine(validTimeZone, "unknown time zone"),
  enabled: z.boolean().default(true),
  /** Set: each run starts a new project with this name instead of a task. */
  projectTitle: z.string().trim().max(60).nullable().default(null),
  projectBrief: z.string().max(8000).default(""),
});

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

/** Anthropic requires alternating roles; a failed reply can leave two user turns in a row, so merge them. */
function alternate(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ ...m });
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

export function registerAiRoutes(app: FastifyInstance, deps: Deps) {
  const { store, requireToken, parseId } = deps;
  const auth = { preHandler: requireToken };
  const busy = new Set<string>();

  // ---------------------------------------------------------------- providers

  app.get("/api/providers", auth, async () => ({ providers: store.providers() }));

  app.post("/api/providers", auth, async (req, reply) => {
    const body = providerBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const id = randomUUID();
    store.saveProvider(id, { ...body.data, apiKey: body.data.apiKey || null });
    return { provider: store.providers().find((p) => p.id === id) };
  });

  app.put("/api/providers/:pid", auth, async (req, reply) => {
    const { pid } = req.params as { pid: string };
    if (!store.providerConfig(pid)) return reply.code(404).send({ error: "no such provider" });
    const body = providerBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const apiKey = body.data.apiKey === undefined ? undefined : body.data.apiKey || null;
    store.saveProvider(pid, { ...body.data, apiKey });
    return { provider: store.providers().find((p) => p.id === pid) };
  });

  app.delete("/api/providers/:pid", auth, async (req, reply) => {
    const { pid } = req.params as { pid: string };
    if (!store.providerConfig(pid)) return reply.code(404).send({ error: "no such provider" });
    for (const occupantId of store.removeProvider(pid)) {
      const occupant = store.occupant(occupantId);
      if (occupant) deps.publishOccupant(occupant);
    }
    return { ok: true };
  });

  app.get("/api/providers/:pid/models", auth, async (req, reply) => {
    const provider = store.providerConfig((req.params as { pid: string }).pid);
    if (!provider) return reply.code(404).send({ error: "no such provider" });
    try {
      return { models: await listModels(provider) };
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message });
    }
  });

  // ---------------------------------------------------------------- brains

  app.get("/api/occupants/:id/brain", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    return { brain: store.brain(id) ?? null };
  });

  app.put("/api/occupants/:id/brain", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    if (!store.exists(id)) return reply.code(404).send({ error: "no such occupant" });
    const body = brainBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    if (!store.providerConfig(body.data.providerId)) return reply.code(400).send({ error: ["providerId: no such provider"] });
    store.saveBrain(id, body.data);
    deps.publishOccupant(store.occupant(id)!);
    return { brain: store.brain(id) };
  });

  app.delete("/api/occupants/:id/brain", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    store.removeBrain(id);
    const occupant = store.occupant(id);
    if (occupant) deps.publishOccupant(occupant);
    return { ok: true };
  });

  // ---------------------------------------------------------------- chat

  app.get("/api/occupants/:id/messages", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    return { messages: store.messages(id, 100) };
  });

  app.delete("/api/occupants/:id/messages", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    store.clearMessages(id);
    return { ok: true };
  });

  /**
   * Streams a reply as server-sent events: {type:"text",text} … then {type:"done"} or {type:"error",message}.
   * The occupant walks to the library while thinking, the desks while replying, and back to the lounge.
   * Chat content is never put in the public state detail.
   */
  app.post("/api/occupants/:id/chat", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    const body = chatBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const occupant = store.occupant(id);
    const brain = store.brain(id);
    if (!occupant || !brain) return reply.code(409).send({ error: "This occupant has no model assigned." });
    const provider = store.providerConfig(brain.providerId);
    if (!provider) return reply.code(409).send({ error: "The assigned provider no longer exists." });
    if (busy.has(id)) return reply.code(409).send({ error: "Still answering the previous message." });

    busy.add(id);
    const history = store.messages(id, HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content }));
    store.addMessage(id, "user", body.data.message);
    deps.publish(store.report(id, { state: "researching" }));

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (event: object) => raw.write(`data: ${JSON.stringify(event)}\n\n`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    let finished = false;
    raw.on("close", () => {
      if (!finished) controller.abort();
    });

    const profile = deps.tasks.profile(id);
    const system = profile ? systemPrompt(profile, deps.officeName(), "chat") : "";

    let replying = false;
    try {
      const text = await chat(provider, {
        model: brain.model,
        tag: { occupantId: id, kind: "chat" },
        system,
        maxTokens: brain.maxTokens,
        messages: alternate([...history, { role: "user", content: body.data.message }]),
        signal: controller.signal,
        onText: (chunk) => {
          if (!replying) {
            replying = true;
            deps.publish(store.report(id, { state: "writing" }));
          }
          send({ type: "text", text: chunk });
        },
      });
      if (text) store.addMessage(id, "assistant", text);
      deps.publish(store.report(id, { state: "idle" }));
      send({ type: "done" });
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : "Unexpected error while calling the model.";
      if (!(error instanceof ProviderError)) app.log.error(error);
      deps.publish(store.report(id, { state: "error", detail: message.slice(0, 80) }));
      send({ type: "error", message });
    } finally {
      finished = true;
      clearTimeout(timer);
      busy.delete(id);
      raw.end();
    }
  });

  // ---------------------------------------------------------------- souls and skills

  app.get("/api/occupants/:id/soul", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    return { soul: store.soul(id), skills: store.agentSkills(id) };
  });

  app.put("/api/occupants/:id/soul", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    if (!store.exists(id)) return reply.code(404).send({ error: "no such occupant" });
    const body = soulBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const known = new Set(store.skills().map((s) => s.id));
    store.saveSoul(id, { role: body.data.role, soul: body.data.soul, instructions: body.data.instructions });
    store.setAgentSkills(id, body.data.skills.filter((s) => known.has(s)));
    deps.publishOccupant(store.occupant(id)!);
    return { soul: store.soul(id), skills: store.agentSkills(id) };
  });

  app.get("/api/skills", auth, async () => ({ skills: store.skills() }));

  const saveSkill = (id: string | null, raw: unknown) => {
    const body = skillBody.safeParse(raw);
    if (!body.success) return { error: issues(body.error) };
    const fields = "markdown" in body.data ? parseSkillMd(body.data.markdown) : body.data;
    if (!fields) return { error: ["markdown: needs a front matter with name (and description), or a # heading"] };
    const name = fields.name.slice(0, 60);
    const skillId = id ?? slugify(name);
    if (!id && store.skill(skillId)) return { error: [`name: a skill called "${name}" already exists`] };
    store.saveSkill({ id: skillId, name, description: fields.description.slice(0, 500), body: fields.body, editedByYou: true });
    return { skill: store.skill(skillId) };
  };

  app.post("/api/skills", auth, async (req, reply) => {
    const result = saveSkill(null, req.body);
    return "error" in result ? reply.code(400).send(result) : result;
  });

  app.put("/api/skills/:sid", auth, async (req, reply) => {
    const { sid } = req.params as { sid: string };
    if (!store.skill(sid)) return reply.code(404).send({ error: "no such skill" });
    const result = saveSkill(sid, req.body);
    return "error" in result ? reply.code(400).send(result) : result;
  });

  app.delete("/api/skills/:sid", auth, async (req, reply) => {
    const { sid } = req.params as { sid: string };
    if (!store.removeSkill(sid)) return reply.code(404).send({ error: "no such skill" });
    return { ok: true };
  });

  /** The skill as a SKILL.md file. */
  app.get("/api/skills/:sid/export", auth, async (req, reply) => {
    const skill = store.skill((req.params as { sid: string }).sid);
    if (!skill) return reply.code(404).send({ error: "no such skill" });
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="${skill.id}-SKILL.md"`)
      .send(toSkillMd(skill));
  });

  // ---------------------------------------------------------------- tasks

  app.get("/api/occupants/:id/tasks", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    return { tasks: store.tasks(id, 30) };
  });

  app.post("/api/occupants/:id/tasks", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    if (!store.exists(id)) return reply.code(404).send({ error: "no such occupant" });
    if (!store.brain(id)) return reply.code(409).send({ error: "This agent has no model yet. Give it one in Settings → Members." });
    const body = taskBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const title = body.data.title || body.data.prompt.split("\n")[0].slice(0, 60);
    if (!body.data.fileIds.length) return { task: deps.tasks.add(id, title, body.data.prompt) };
    // Attach the files before the task can start.
    const task = store.addTask(id, title, body.data.prompt);
    deps.attach(task.id, body.data.fileIds);
    deps.tasks.wake(task);
    return { task };
  });

  app.post("/api/tasks/:tid/cancel", auth, async (req, reply) => {
    const task = deps.tasks.cancel(Number((req.params as { tid: string }).tid));
    if (!task) return reply.code(404).send({ error: "no such task" });
    return { task };
  });

  // ---------------------------------------------------------------- memory

  const memoryView = (id: string) => {
    const entries = store.memories(id);
    return { entries, limits: MEMORY_LIMITS, usage: usage(entries) };
  };

  app.get("/api/occupants/:id/memory", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    return memoryView(id);
  });

  /** Entries you add are yours: the agent reads them but can't change them. */
  app.post("/api/occupants/:id/memory", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    if (!store.exists(id)) return reply.code(404).send({ error: "no such occupant" });
    const body = memoryBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const text = body.data.text.replace(/\s+/g, " ");
    if (!fits(store.memories(id), body.data.target, text)) return reply.code(409).send({ error: "memory is full" });
    store.addMemory(id, body.data.target, text, "you");
    return memoryView(id);
  });

  app.put("/api/occupants/:id/memory/:mid", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    const entry = store.memoryEntry(Number((req.params as { mid: string }).mid), id);
    if (!entry) return reply.code(404).send({ error: "no such entry" });
    const body = memoryEditBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const text = body.data.text.replace(/\s+/g, " ");
    if (!fits(store.memories(id), entry.target, text, entry.id)) return reply.code(409).send({ error: "memory is full" });
    store.updateMemory(entry.id, text, "you");
    return memoryView(id);
  });

  app.delete("/api/occupants/:id/memory/:mid", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    const entry = store.memoryEntry(Number((req.params as { mid: string }).mid), id);
    if (!entry) return reply.code(404).send({ error: "no such entry" });
    store.removeMemory(entry.id);
    return memoryView(id);
  });

  /** Searches an agent's past tasks and chats, the same way its recall tool does. */
  app.get("/api/occupants/:id/recall", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    const q = String((req.query as { q?: string }).q ?? "").slice(0, 200);
    return { hits: store.recall(id, q, 10) };
  });

  // ---------------------------------------------------------------- schedules

  const scheduleId = (req: FastifyRequest) => Number((req.params as { sid: string }).sid);

  app.get("/api/occupants/:id/schedules", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    return { schedules: store.schedules(id) };
  });

  app.post("/api/occupants/:id/schedules", auth, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id, reply);
    if (!id) return;
    if (!store.exists(id)) return reply.code(404).send({ error: "no such occupant" });
    const body = scheduleBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const { prompt, rule, timeZone, enabled, projectBrief } = body.data;
    const projectTitle = body.data.projectTitle || null;
    const next = nextRun(rule, timeZone, new Date());
    if (!next) return reply.code(400).send({ error: "That time has already passed." });
    const title = body.data.title || prompt.split("\n")[0].slice(0, 60);
    return { schedule: store.addSchedule({ occupantId: id, title: projectTitle ?? title, prompt, rule, timeZone, enabled, nextRunAt: next.toISOString(), projectTitle, projectBrief }) };
  });

  app.put("/api/schedules/:sid", auth, async (req, reply) => {
    const current = store.schedule(scheduleId(req));
    if (!current) return reply.code(404).send({ error: "no such schedule" });
    const body = scheduleBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const merged = { ...current, ...Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined)) };
    // Changing when it runs, or switching it back on, starts the clock again from now.
    const retime = body.data.rule !== undefined || body.data.timeZone !== undefined || (body.data.enabled && !current.enabled);
    const next = retime ? nextRun(merged.rule, merged.timeZone, new Date()) : current.nextRunAt ? new Date(current.nextRunAt) : null;
    if (merged.enabled && !next) return reply.code(400).send({ error: "That time has already passed." });
    const projectTitle = body.data.projectTitle !== undefined ? body.data.projectTitle || null : current.projectTitle;
    return {
      schedule: store.updateSchedule(current.id, {
        title: projectTitle ?? (merged.title || merged.prompt.split("\n")[0].slice(0, 60)),
        projectTitle,
        projectBrief: merged.projectBrief,
        prompt: merged.prompt,
        rule: merged.rule,
        timeZone: merged.timeZone,
        enabled: merged.enabled,
        nextRunAt: next?.toISOString() ?? null,
      }),
    };
  });

  app.delete("/api/schedules/:sid", auth, async (req, reply) => {
    if (!store.removeSchedule(scheduleId(req))) return reply.code(404).send({ error: "no such schedule" });
    return { ok: true };
  });

  /** Runs it once now; the regular times stay as they are. */
  app.post("/api/schedules/:sid/run", auth, async (req, reply) => {
    const s = store.schedule(scheduleId(req));
    if (!s) return reply.code(404).send({ error: "no such schedule" });
    if (!store.brain(s.occupantId)) return reply.code(409).send({ error: "This agent has no model yet. Give it one in Settings → Members." });
    const started = await deps.scheduler.fire(s, new Date(), true);
    if (!started) return reply.code(409).send({ error: "The last run is still going." });
    return { ...started, schedule: store.schedule(s.id) };
  });
}
