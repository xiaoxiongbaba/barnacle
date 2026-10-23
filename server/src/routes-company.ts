import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { nextRun, validTimeZone } from "./schedule.js";
import type { Settings } from "./settings.js";
import type { Change, Store } from "./store.js";
import { archetype, pick, preview, TEMPLATE_SKILLS, TEMPLATES } from "./templates.js";

/**
 * "Start a company": builds a whole team from a template in one go — members with soul, skills and a
 * model, each at a desk in the right room, department managers, a CEO, and the scheduled work.
 */

interface Deps {
  store: Store;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  settings: () => Settings;
  saveSettings: (patch: Partial<Settings>) => void;
  /** Moves someone to a free desk in a room (false if the room has none). */
  placeInRoom: (id: string, room: string) => boolean;
  hasRoom: (id: string) => boolean;
  addSuite: () => void;
  publish: (change: Change) => void;
  /** Everyone's desks again, then tell the pages. */
  refresh: () => void;
}

const setupBody = z.object({
  template: z.string().max(40),
  language: z.enum(["en", "ja", "zh-Hant"]).default("en"),
  providerId: z.string().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  officeName: z.string().trim().max(60).optional(),
  timeZone: z.string().max(64).refine(validTimeZone, "unknown time zone").default("UTC"),
  options: z
    .object({ org: z.boolean().default(true), ceo: z.boolean().default(false), schedules: z.boolean().default(true) })
    .default({ org: true, ceo: false, schedules: true }),
});

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

export function registerCompanyRoutes(app: FastifyInstance, deps: Deps) {
  const { store } = deps;
  const auth = { preHandler: deps.requireToken };

  app.get("/api/company/templates", auth, async (req) => {
    const lang = (req.query as { lang?: string }).lang;
    const l = lang === "zh-Hant" || lang === "ja" ? lang : "en";
    return { templates: TEMPLATES.map((t) => preview(t, l)) };
  });

  app.post("/api/company/setup", auth, async (req, reply) => {
    const body = setupBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const { language: lang, providerId, model, options, timeZone } = body.data;
    const template = TEMPLATES.find((t) => t.id === body.data.template);
    if (!template) return reply.code(400).send({ error: "no such template" });
    if (!store.providerConfig(providerId)) return reply.code(400).send({ error: "no such provider" });

    // Skills the template needs.
    for (const s of TEMPLATE_SKILLS) if (!store.skill(s.id)) store.saveSkill(s);
    const known = new Set(store.skills().map((s) => s.id));

    // Members: new ids and names when taken (and @mentions follow the new names).
    const members = template.members.filter((m) => !m.ceo || options.ceo);
    const names = new Set(store.list().map((o) => o.name.toLowerCase()));
    const created: { key: string; id: string; name: string; room: string; manager: boolean; ceo: boolean }[] = [];
    for (const m of members) {
      let id = m.name.toLowerCase();
      for (let n = 2; store.exists(id); n++) id = `${m.name.toLowerCase()}-${n}`;
      let name = m.name;
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${m.name} ${n}`;
      names.add(name.toLowerCase());
      const a = archetype(m.archetype);
      deps.publish(store.report(id, { state: "idle", name, kind: "agent" }));
      store.saveSoul(id, { role: pick(a.role, lang), soul: pick(a.soul, lang), instructions: pick(a.instructions, lang) });
      store.setAgentSkills(id, a.skills.filter((s) => known.has(s)));
      store.saveBrain(id, { providerId, model, systemPrompt: "", maxTokens: 4096 });
      created.push({ key: m.key, id, name, room: m.room, manager: !!m.manager, ceo: !!m.ceo });
    }

    // The organization: managers, the CEO, you as chairman (and the executive offices).
    if (options.org) {
      deps.addSuite();
      const org = deps.settings().org;
      const managers = { ...org.managers };
      for (const c of created) if (c.manager && deps.hasRoom(c.room)) managers[c.room] = c.id;
      const chairman = org.chairman ?? store.list().find((o) => o.kind === "human")?.id ?? null;
      const ceo = created.find((c) => c.ceo)?.id ?? org.ceo;
      deps.saveSettings({ org: { ...org, enabled: true, managers, chairman, ceo, timeZone, language: lang, lastReportAt: org.lastReportAt ?? new Date().toISOString() } });
    }
    // Desks in the rooms the template means (the CEO's is placed by the organization).
    for (const c of created) if (!c.ceo && deps.hasRoom(c.room)) deps.placeInRoom(c.id, c.room);

    // Scheduled work.
    let schedules = 0;
    if (options.schedules) {
      const rename = (text: string) => created.reduce((s, c) => s.replaceAll(`@${template.members.find((m) => m.key === c.key)!.name}`, `@${c.name}`), text);
      for (const s of template.schedules) {
        const owner = created.find((c) => c.key === s.member);
        if (!owner) continue;
        const next = nextRun(s.rule, timeZone, new Date());
        if (!next) continue;
        const title = pick(s.title, lang);
        store.addSchedule({
          occupantId: owner.id,
          title,
          prompt: rename(pick(s.prompt, lang)),
          rule: s.rule,
          timeZone,
          enabled: true,
          nextRunAt: next.toISOString(),
          projectTitle: s.project ? title : null,
          projectBrief: "",
        });
        schedules++;
      }
    }

    if (body.data.officeName) deps.saveSettings({ officeName: body.data.officeName });
    deps.refresh();
    return { members: created.map((c) => ({ id: c.id, name: c.name })), schedules };
  });
}
