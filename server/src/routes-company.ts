import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { nextRun, ruleSchema, validTimeZone } from "./schedule.js";
import type { Settings } from "./settings.js";
import { slugify } from "./skills.js";
import type { Change, Store } from "./store.js";
import { previewTeam, teamFromTemplate, TEMPLATES, type TeamDef } from "./templates.js";

/**
 * "Start a company": builds a whole team in one go — members with soul, skills and a model, each at a
 * desk in the right room, department managers, a CEO, and the scheduled work — from a built-in template
 * or from a team file. The current team can be exported as such a file to share: members, souls, skills
 * and scheduled work, never keys, providers, memory or documents.
 */

interface Deps {
  store: Store;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  settings: () => Settings;
  saveSettings: (patch: Partial<Settings>) => void;
  /** Moves someone to a free desk in a room (false if the room has none). */
  placeInRoom: (id: string, room: string) => boolean;
  hasRoom: (id: string) => boolean;
  /** The department (room id) someone's desk is in. */
  roomOf: (id: string) => string | null;
  addSuite: () => void;
  publish: (change: Change) => void;
  /** Everyone's desks again, then tell the pages. */
  refresh: () => void;
}

/** A team file, as exported (and as anyone may have edited it: everything is checked). */
const teamFile = z
  .object({
    format: z.literal("barnacle-team"),
    version: z.literal(1),
    name: z.string().trim().max(60).default(""),
    description: z.string().trim().max(500).default(""),
    members: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(40),
          name: z.string().trim().min(1).max(40),
          role: z.string().trim().max(80).default(""),
          soul: z.string().max(8000).default(""),
          instructions: z.string().max(8000).default(""),
          skills: z.array(z.string().trim().max(60)).max(30).default([]),
          room: z.string().trim().max(40).default(""),
          manager: z.boolean().default(false),
          ceo: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(30),
    skills: z
      .array(z.object({ id: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(60), description: z.string().max(500).default(""), body: z.string().max(20_000) }))
      .max(50)
      .default([]),
    schedules: z
      .array(
        z.object({
          member: z.string().trim().max(40),
          title: z.string().trim().min(1).max(80),
          prompt: z.string().trim().min(1).max(8000),
          rule: ruleSchema,
          project: z.boolean().default(false),
          projectBrief: z.string().max(2000).default(""),
        }),
      )
      .max(50)
      .default([]),
  })
  .refine((t) => new Set(t.members.map((m) => m.key)).size === t.members.length, { message: "member keys must be unique" })
  .refine((t) => t.members.filter((m) => m.ceo).length <= 1, { message: "at most one CEO" });

type TeamFile = z.infer<typeof teamFile>;

const setupBody = z.object({
  /** A built-in template, or a team from a file. */
  template: z.string().max(40).optional(),
  team: z.unknown().optional(),
  language: z.enum(["en", "ja", "zh-Hant"]).default("en"),
  providerId: z.string().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  officeName: z.string().trim().max(60).optional(),
  timeZone: z.string().max(64).refine(validTimeZone, "unknown time zone").default("UTC"),
  options: z
    .object({ org: z.boolean().default(true), ceo: z.boolean().default(false), schedules: z.boolean().default(true) })
    .default({ org: true, ceo: false, schedules: true }),
});

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`);

export function registerCompanyRoutes(app: FastifyInstance, deps: Deps) {
  const { store } = deps;
  const auth = { preHandler: deps.requireToken };

  /** A team file checked against this office: the team, and what won't fit as it is. */
  /** What won't come over as it is (the page words it): skills that are missing, rooms the office lacks, schedules for nobody. */
  type Warning = { kind: "skills" | "room" | "schedule"; who: string; what: string };
  const readTeam = (raw: unknown): { team?: TeamDef; warnings: Warning[]; error?: string[] } => {
    const parsed = teamFile.safeParse(raw);
    if (!parsed.success) return { warnings: [], error: issues(parsed.error) };
    const file: TeamFile = parsed.data;
    const warnings: Warning[] = [];
    const keys = new Set(file.members.map((m) => m.key));
    const brought = new Set(file.skills.map((s) => s.id));
    const library = new Set(store.skills().map((s) => s.id));
    const members = file.members.map((m) => {
      const missing = m.skills.filter((s) => !brought.has(s) && !library.has(s));
      if (missing.length) warnings.push({ kind: "skills", who: m.name, what: missing.join(", ") });
      if (m.room && !deps.hasRoom(m.room)) warnings.push({ kind: "room", who: m.name, what: m.room });
      return { ...m, skills: m.skills.filter((s) => brought.has(s) || library.has(s)), room: m.room };
    });
    const schedules = file.schedules.filter((s) => {
      if (keys.has(s.member)) return true;
      warnings.push({ kind: "schedule", who: s.title, what: s.member });
      return false;
    });
    return { team: { name: file.name, description: file.description, members, skills: file.skills, schedules }, warnings };
  };

  app.get("/api/company/templates", auth, async (req) => {
    const lang = (req.query as { lang?: string }).lang;
    const l = lang === "zh-Hant" || lang === "ja" ? lang : "en";
    return { templates: TEMPLATES.map((t) => previewTeam(t.id, teamFromTemplate(t, l))) };
  });

  /** Reads a team file for the wizard: its preview and warnings (nothing is created). */
  app.post("/api/company/team-preview", { ...auth, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const { team, warnings, error } = readTeam((req.body as { team?: unknown } | undefined)?.team);
    if (!team) return reply.code(400).send({ error });
    return { preview: previewTeam("file", team), warnings };
  });

  /** The current team as a file: members (agents), souls, skills, scheduled work. No keys, models, memory or documents. */
  app.get("/api/company/export", auth, async () => {
    const s = deps.settings();
    const org = s.org;
    const agents = store.list().filter((o) => {
      if (o.kind !== "agent") return false;
      const soul = store.soul(o.id);
      return !!store.brain(o.id) || !!soul.role || !!soul.soul;
    });
    const members = agents.map((o) => {
      const soul = store.soul(o.id);
      const room = deps.roomOf(o.id) ?? "";
      return {
        key: o.id,
        name: o.name,
        role: soul.role,
        soul: soul.soul,
        instructions: soul.instructions,
        skills: store.agentSkills(o.id),
        room,
        manager: !!room && org.managers[room] === o.id,
        ceo: org.ceo === o.id,
      };
    });
    const used = new Set(members.flatMap((m) => m.skills));
    const skills = store
      .skills()
      .filter((sk) => used.has(sk.id))
      .map((sk) => ({ id: sk.id, name: sk.name, description: sk.description, body: sk.body }));
    const schedules = agents.flatMap((o) =>
      store.schedules(o.id).map((sc) => ({ member: o.id, title: sc.title, prompt: sc.prompt, rule: sc.rule, project: sc.projectTitle !== null, projectBrief: sc.projectBrief })),
    );
    return {
      format: "barnacle-team",
      version: 1,
      name: s.officeName,
      description: "",
      exportedAt: new Date().toISOString(),
      members,
      skills,
      schedules,
    };
  });

  app.post("/api/company/setup", { ...auth, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const body = setupBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: issues(body.error) });
    const { language: lang, providerId, model, options, timeZone } = body.data;
    let def: TeamDef;
    if (body.data.team !== undefined) {
      const read = readTeam(body.data.team);
      if (!read.team) return reply.code(400).send({ error: read.error });
      def = read.team;
    } else {
      const template = TEMPLATES.find((t) => t.id === body.data.template);
      if (!template) return reply.code(400).send({ error: "no such template" });
      def = teamFromTemplate(template, lang);
    }
    if (!store.providerConfig(providerId)) return reply.code(400).send({ error: "no such provider" });

    // Skills the team brings: new ones are added; one that clashes with a different skill of yours
    // comes in under a new id, so nothing you have is overwritten.
    const skillId = new Map<string, string>();
    for (const sk of def.skills) {
      const mine = store.skill(sk.id);
      if (mine && mine.body === sk.body && mine.name === sk.name) {
        skillId.set(sk.id, sk.id);
        continue;
      }
      let id = mine ? `${slugify(sk.id)}-imported` : slugify(sk.id);
      for (let n = 2; mine && store.skill(id); n++) id = `${slugify(sk.id)}-imported-${n}`;
      store.saveSkill({ id, name: sk.name, description: sk.description, body: sk.body });
      skillId.set(sk.id, id);
    }
    const known = new Set(store.skills().map((s) => s.id));

    // Members: new ids and names when taken (and @mentions follow the new names).
    const members = def.members.filter((m) => !m.ceo || options.ceo);
    const names = new Set(store.list().map((o) => o.name.toLowerCase()));
    const created: { key: string; id: string; name: string; original: string; room: string; manager: boolean; ceo: boolean }[] = [];
    for (const m of members) {
      // An id from the name (Ava → ava), else from the file's key; names in other scripts give "agent".
      const idOf = (x: string) => x.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "").slice(0, 30);
      const base = idOf(m.name) || idOf(m.key) || "agent";
      let id = base;
      for (let n = 2; store.exists(id); n++) id = `${base}-${n}`;
      let name = m.name;
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${m.name} ${n}`;
      names.add(name.toLowerCase());
      deps.publish(store.report(id, { state: "idle", name, kind: "agent" }));
      store.saveSoul(id, { role: m.role, soul: m.soul, instructions: m.instructions });
      store.setAgentSkills(id, m.skills.map((s) => skillId.get(s) ?? s).filter((s) => known.has(s)));
      store.saveBrain(id, { providerId, model, systemPrompt: "", maxTokens: 4096 });
      created.push({ key: m.key, id, name, original: m.name, room: m.room, manager: m.manager, ceo: m.ceo });
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
    // Desks in the rooms the team means (the CEO's is placed by the organization).
    for (const c of created) if (!c.ceo && c.room && deps.hasRoom(c.room)) deps.placeInRoom(c.id, c.room);

    // Scheduled work.
    let schedules = 0;
    if (options.schedules) {
      const rename = (text: string) => created.reduce((s, c) => (c.original === c.name ? s : s.replaceAll(`@${c.original}`, `@${c.name}`)), text);
      for (const s of def.schedules) {
        const owner = created.find((c) => c.key === s.member);
        if (!owner) continue;
        const next = nextRun(s.rule, timeZone, new Date());
        if (!next) continue;
        store.addSchedule({
          occupantId: owner.id,
          title: s.title,
          prompt: rename(s.prompt),
          rule: s.rule,
          timeZone,
          enabled: true,
          nextRunAt: next.toISOString(),
          projectTitle: s.project ? s.title : null,
          projectBrief: s.projectBrief,
        });
        schedules++;
      }
    }

    if (body.data.officeName) deps.saveSettings({ officeName: body.data.officeName });
    deps.refresh();
    return { members: created.map((c) => ({ id: c.id, name: c.name })), schedules };
  });
}
