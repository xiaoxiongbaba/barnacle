import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { config, loadToken, tokenFromEnv, writeNewToken } from "./config.js";
import { defaultSettings, discoverPacks, findFloorArt, loadLayout, packLocation, settingsSchema, type Settings } from "./settings.js";
import { chairs, ensureDesks, moveDesk, roomAt } from "./desks.js";
import { Library } from "./library.js";
import { Costs } from "./costs.js";
import { Mcp } from "./mcp.js";
import { registerMcpRoutes } from "./routes-mcp.js";
import { registerCostRoutes } from "./routes-costs.js";
import { registerFileRoutes } from "./routes-files.js";
import { EXECUTIVE_ROOMS, defaultFloor, floorSchema, migrateFloor, withExecutiveSuite, type Floor } from "./floor.js";
import { Organization } from "./org.js";
import { Ceo } from "./ceo.js";
import { registerOrgRoutes } from "./routes-org.js";
import { registerCompanyRoutes } from "./routes-company.js";
import { TaskRunner } from "./agents.js";
import { Scheduler } from "./schedule.js";
import { registerAiRoutes } from "./routes-ai.js";
import { Projects } from "./projects.js";
import { Governance } from "./governance.js";
import { registerGovernanceRoutes } from "./routes-governance.js";
import { registerProjectRoutes } from "./routes-projects.js";
import { seedSkills } from "./skills.js";
import { STATES, occupantIdSchema, statusBodySchema, type Occupant } from "./states.js";
import { Store, type Change } from "./store.js";

const PROTOCOL_VERSION = "0.1";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
const store = new Store(config.dataDir);
const clients = new Set<WebSocket>();

let token = loadToken((msg) => app.log.warn(msg));
let settings = resolveSettings();
let layout = loadLayout(settings.pack);
let floor = resolveFloor();
const floorArtPack = findFloorArt();
if (floorArtPack) app.log.info(`Floor art pack available: ${floorArtPack.id}`);

/** Everyone who can have a desk, with their job title (for picking a room). */
const people = () => store.list().map((o) => ({ id: o.id, role: store.soul(o.id).role }));

/** The chairman and the CEO, when the organization is on (they sit in their offices). */
const executives = () => (settings.org.enabled ? { chairman: settings.org.chairman, ceo: settings.org.ceo } : {});

/** Gives everyone a desk and drops stale ones; saves when that changed anything. */
function syncDesks(): boolean {
  if (!ensureDesks(floor, people(), executives())) return false;
  store.saveSettings({ floor });
  return true;
}

/** The saved floor, or the starter office when nothing valid is saved. */
function resolveFloor(): Floor {
  const saved = floorSchema.safeParse(migrateFloor(store.settings().floor));
  return saved.success ? saved.data : defaultFloor();
}

/** Environment defaults, overridden by whatever was saved from the page (if still valid). */
function resolveSettings(): Settings {
  const merged = settingsSchema.safeParse({ ...defaultSettings(), ...store.settings() });
  const result = merged.success ? merged.data : defaultSettings();
  if (!discoverPacks().some((p) => p.id === result.pack)) result.pack = defaultSettings().pack;
  return result;
}

const office = () => ({
  name: settings.officeName,
  language: settings.language,
  pack: settings.pack,
  scene: settings.scene,
  protocol: PROTOCOL_VERSION,
  states: STATES,
  layout,
  floor,
  floorArt: settings.floorArt === "pack" ? floorArtPack : null,
  floorArtPack: floorArtPack ? { id: floorArtPack.id, name: (floorArtPack.atlas as { name?: string }).name ?? floorArtPack.id } : null,
  /** Who manages which department and who the chairman is (names only, for the office's name plates). */
  org: {
    enabled: settings.org.enabled,
    managers: settings.org.enabled ? settings.org.managers : {},
    chairman: settings.org.enabled ? settings.org.chairman : null,
    ceo: settings.org.enabled ? settings.org.ceo : null,
  },
});

/** Who is in which running project (ids and status only; titles and threads need the token). */
const projectSummaries = () =>
  store
    .projects()
    .filter((p) => p.status !== "closed")
    .map((p) => ({ id: p.id, status: p.status, members: p.members, active: projects?.active(p.id) ?? [], needsYou: p.needsYou }));
const snapshot = () => ({
  type: "snapshot",
  office: office(),
  occupants: store.list(),
  events: store.events(50),
  projects: projectSummaries(),
  inbox: governance?.count() ?? 0,
});

function broadcast(message: object) {
  const data = JSON.stringify(message);
  for (const socket of clients) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

function publish(change: Change) {
  broadcast({ type: "occupant", occupant: change.occupant });
  if (change.event) broadcast({ type: "event", event: change.event });
}

const publishOccupant = (occupant: Occupant) => broadcast({ type: "occupant", occupant });

function hasToken(req: FastifyRequest) {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(req.headers.authorization ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function requireToken(req: FastifyRequest, reply: FastifyReply) {
  if (!hasToken(req)) return reply.code(401).send({ error: "missing or invalid token" });
}

function parseId(raw: unknown, reply: FastifyReply): string | undefined {
  const parsed = occupantIdSchema.safeParse(raw);
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid id" });
    return undefined;
  }
  return parsed.data;
}

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

await app.register(fastifyWebsocket);

// ------------------------------------------------------------------ public reads

app.get("/api/health", async () => ({ ok: true }));
app.get("/api/office", async () => office());
app.get("/api/occupants", async () => ({ occupants: store.list() }));

app.get("/api/events", async (req) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
  return { events: store.events(limit) };
});

// ------------------------------------------------------------------ token-protected writes

app.post("/api/occupants/:id/status", { preHandler: requireToken }, async (req, reply) => {
  const id = parseId((req.params as { id: string }).id, reply);
  if (!id) return;
  const body = statusBodySchema.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: issues(body.error) });
  const isNew = !store.exists(id);
  const change = store.report(id, body.data);
  publish(change);
  // Newcomers get a desk.
  if (isNew && syncDesks()) broadcast(snapshot());
  return change.occupant;
});

/** Everything the details panel shows: the occupant and its latest events. */
app.get("/api/occupants/:id/details", async (req, reply) => {
  const id = parseId((req.params as { id: string }).id, reply);
  if (!id) return;
  const occupant = store.occupant(id);
  if (!occupant) return reply.code(404).send({ error: "no such occupant" });
  return { occupant, events: store.eventsFor(id, 60) };
});

app.delete("/api/occupants/:id", { preHandler: requireToken }, async (req, reply) => {
  const id = parseId((req.params as { id: string }).id, reply);
  if (!id) return;
  if (!store.remove(id)) return reply.code(404).send({ error: "no such occupant" });
  broadcast({ type: "removed", id });
  if (syncDesks()) broadcast(snapshot());
  return { ok: true };
});

/** Lets the settings page check a token before unlocking. */
app.get("/api/auth", { preHandler: requireToken }, async () => ({ ok: true, tokenFromEnv }));

app.get("/api/settings", { preHandler: requireToken }, async () => ({ settings, packs: discoverPacks(), floorArtPack: office().floorArtPack, tokenFromEnv }));

app.put("/api/settings", { preHandler: requireToken }, async (req, reply) => {
  const body = settingsSchema.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: issues(body.error) });
  if (!discoverPacks().some((p) => p.id === body.data.pack)) return reply.code(400).send({ error: ["pack: unknown pack"] });
  const packChanged = body.data.pack !== settings.pack;
  // The policy has its own page; a settings save without it keeps it.
  const sent = req.body as { toolPolicy?: unknown; costs?: unknown };
  const next = { ...body.data, toolPolicy: sent.toolPolicy ? body.data.toolPolicy : settings.toolPolicy, costs: sent.costs ? body.data.costs : settings.costs };
  store.saveSettings(next);
  settings = next;
  if (packChanged) layout = loadLayout(settings.pack);
  broadcast(snapshot());
  return { settings };
});

/** Replaces the whole floor plan (tiles, furniture, rooms, routing, assignments). */
app.put("/api/floor", { preHandler: requireToken }, async (req, reply) => {
  const body = floorSchema.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: issues(body.error) });
  // Drop assignments for occupants that no longer exist.
  const known = new Set(store.list().map((o) => o.id));
  body.data.assignments = Object.fromEntries(Object.entries(body.data.assignments).filter(([id]) => known.has(id)));
  ensureDesks(body.data, people(), executives());
  store.saveSettings({ floor: body.data });
  floor = body.data;
  broadcast(snapshot());
  return { floor };
});

/** Moves someone to a desk (a chair tile), or to a free desk in a room; taking someone's desk swaps. */
const deskBody = z.union([z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }), z.object({ room: z.string().min(1).max(40) })]);
app.put("/api/desks/:id", { preHandler: requireToken }, async (req, reply) => {
  const id = parseId((req.params as { id: string }).id, reply);
  if (!id) return;
  if (!store.exists(id)) return reply.code(404).send({ error: "no such occupant" });
  const body = deskBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: issues(body.error) });
  const next = structuredClone(floor);
  const error = moveDesk(next, people(), id, body.data, executives());
  if (error) return reply.code(409).send({ error });
  store.saveSettings({ floor: next });
  floor = next;
  broadcast(snapshot());
  return { desks: floor.desks };
});

app.post("/api/token/rotate", { preHandler: requireToken }, async (_req, reply) => {
  if (tokenFromEnv) return reply.code(409).send({ error: "The token is set by BARNACLE_TOKEN; change it there." });
  token = writeNewToken();
  app.log.warn("The office token was rotated from the settings page.");
  return { token };
});

seedSkills(store);
const tasks = new TaskRunner({
  store,
  publish,
  // Only which task changed and how; pages fetch the content with the token.
  notify: (task) => broadcast({ type: "task", task: { id: task.id, occupantId: task.occupantId, status: task.status } }),
  // Who walks over to whom; what they asked stays behind the token.
  handoff: (h) => broadcast({ type: "handoff", ...h }),
  officeName: () => settings.officeName,
  language: () => settings.language,
});
const scheduler = new Scheduler(store, tasks);
/** Made below; projects may report changes while starting up, before it exists. */
let governance: Governance | null = null;
const projects: Projects = new Projects({
  store,
  tasks,
  notify: (p, active) => {
    broadcast({ type: "project", project: { id: p.id, status: p.status, members: p.members, active, needsYou: p.needsYou } });
    governance?.changed();
  },
  handoff: (h) => broadcast({ type: "handoff", ...h }),
  log: (message) => app.log.warn(message),
  language: () => settings.language,
});
scheduler.projects = projects;
governance = new Governance({
  store,
  tasks,
  policy: () => settings.toolPolicy,
  publish,
  inbox: (count) => broadcast({ type: "inbox", count }),
});
const library = new Library(store);
const mcp = new Mcp(store);
mcp.onChange = () => broadcast({ type: "mcp" });
governance.extraRule = (tool, input) => mcp.rule(tool, input);
/** Departments: the work rooms with desks (each can have its own documents). */
const departments = () =>
  floor.rooms.filter((r) => !EXECUTIVE_ROOMS.includes(r.id) && chairs(floor).some((c) => roomAt(floor, c)?.id === r.id)).map((r) => ({ id: r.id, name: r.name }));
/** The knowledge someone may search: the company's and their department's (the chairman and the CEO: all of it). */
function knowledgeScopes(occupantId: string) {
  const org = settings.org;
  if (org.enabled && (org.chairman === occupantId || org.ceo === occupantId)) return ["company", ...departments().map((d) => d.id)];
  const desk = floor.desks[occupantId];
  const room = desk && roomAt(floor, desk);
  return room ? ["company", room.id] : ["company"];
}
{
  const governed = tasks.hooks.extraTools;
  tasks.hooks.extraTools = (task, step, signal) => [
    ...(governed?.(task, step, signal) ?? []),
    ...library.tools(task, knowledgeScopes(task.occupantId), step),
    ...mcp.tools(task, signal),
  ];
  tasks.hooks.prepare = (task) => library.prepare(task);
}
const organization = new Organization({
  store,
  tasks,
  floor: () => floor,
  org: () => settings.org,
  saveOrg: (patch) => {
    settings = { ...settings, org: { ...settings.org, ...patch } };
    store.saveSettings(settings);
  },
  publish,
  handoff: (h) => broadcast({ type: "handoff", ...h }),
  notify: (r) => broadcast({ type: "report", report: { id: r.id, roomId: r.roomId } }),
  log: (message) => app.log.warn(message),
});
const ceo = new Ceo({
  store,
  governance: governance!,
  org: () => settings.org,
  publish,
  handoff: (h) => broadcast({ type: "handoff", ...h }),
  notifyReport: (r) => broadcast({ type: "report", report: { id: r.id, roomId: r.roomId } }),
  notifyDecision: (d) => broadcast({ type: "decision", decision: { id: d.id, category: d.category } }),
  roomName: (id) => (id === "company" ? "Company" : (floor.rooms.find((r) => r.id === id)?.name ?? id)),
  log: (message) => app.log.warn(message),
});
organization.ceo = ceo;

const roomName = (id: string) => (id === "company" ? "Company" : (floor.rooms.find((r) => r.id === id)?.name ?? id));
let costsTimer: NodeJS.Timeout | null = null;
const costs = new Costs({
  store,
  settings: () => settings,
  roomOf: (id) => {
    const desk = floor.desks[id];
    return (desk && roomAt(floor, desk)?.id) || null;
  },
  roomName,
  ask: (task, action, summary, detail, ctx) => governance!.ask(task, action, summary, detail, ctx),
  // At most every few seconds: pages refetch the numbers.
  changed: () => {
    costsTimer ??= setTimeout(() => {
      costsTimer = null;
      broadcast({ type: "costs" });
    }, 3000);
  },
});
tasks.hooks.budget = (task, ctx, starting) => costs.check(task, ctx, starting);
tasks.hooks.model = (task, brain) => (brain.lightModel && costs.light(task) ? brain.lightModel : brain.model);
organization.spendLine = (scope, since, until) => costs.spendLine(scope, since, until);
ceo.spendLine = (scope, since, until) => costs.spendLine(scope, since, until);
registerCostRoutes(app, {
  store,
  costs,
  requireToken,
  settings: () => settings,
  saveCosts: (next) => {
    settings = { ...settings, costs: next };
    store.saveSettings(settings);
  },
  departments,
});
registerOrgRoutes(app, {
  ceo,
  store,
  org: organization,
  requireToken,
  settings: () => settings,
  saveOrg: (patch) => {
    settings = { ...settings, org: { ...settings.org, ...patch } };
    store.saveSettings(settings);
    broadcast(snapshot());
  },
  syncDesks: () => {
    if (syncDesks()) broadcast(snapshot());
  },
  addSuite: () => {
    if (floor.rooms.some((r) => r.id === "chairman")) return false;
    floor = withExecutiveSuite(floor);
    syncDesks();
    store.saveSettings({ floor });
    broadcast(snapshot());
    return true;
  },
  hasSuite: () => floor.rooms.some((r) => r.id === "chairman"),
  inboxCount: () => governance?.count() ?? 0,
});
registerCompanyRoutes(app, {
  store,
  requireToken,
  settings: () => settings,
  saveSettings: (patch) => {
    settings = { ...settings, ...patch };
    store.saveSettings(settings);
  },
  placeInRoom: (id, room) => {
    const next = structuredClone(floor);
    if (moveDesk(next, people(), id, { room }, executives())) return false;
    floor = next;
    store.saveSettings({ floor });
    return true;
  },
  hasRoom: (id) => floor.rooms.some((r) => r.id === id),
  addSuite: () => {
    if (floor.rooms.some((r) => r.id === "chairman")) return;
    floor = withExecutiveSuite(floor);
    store.saveSettings({ floor });
  },
  publish,
  refresh: () => {
    syncDesks();
    broadcast(snapshot());
  },
});
registerGovernanceRoutes(app, {
  store,
  governance,
  requireToken,
  policy: () => settings.toolPolicy,
  setPolicy: (toolPolicy) => {
    settings = { ...settings, toolPolicy };
    store.saveSettings(settings);
  },
});
registerProjectRoutes(app, { store, projects, requireToken });
registerMcpRoutes(app, { mcp, requireToken });
registerFileRoutes(app, { store, library, requireToken, departments });
registerAiRoutes(app, { store, requireToken, parseId, publish, publishOccupant, officeName: () => settings.officeName, tasks, scheduler, attach: (taskId, ids) => library.attach(taskId, ids) });
tasks.resume();
syncDesks();
scheduler.start();
mcp.start();
organization.start();

// ------------------------------------------------------------------ live updates and static files

app.get("/ws", { websocket: true }, (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify(snapshot()));
  socket.on("close", () => clients.delete(socket));
});

await app.register(fastifyStatic, { root: config.packsRoot, prefix: "/packs/", decorateReply: false });
if (discoverPacks().some((p) => p.id === "custom")) {
  await app.register(fastifyStatic, { root: packLocation("custom").dir, prefix: "/pack-custom/", decorateReply: false });
}
// Integration scripts contain no secrets; serving them lets the settings page offer a one-line download.
await app.register(fastifyStatic, { root: config.integrationsDir, prefix: "/integrations/", decorateReply: false });

if (existsSync(config.webDir)) {
  await app.register(fastifyStatic, { root: config.webDir });
} else {
  app.log.warn(`No web build at ${config.webDir}; run "npm run build -w web" (the API still works).`);
}

const sweeper = setInterval(() => {
  for (const change of store.sweep(settings.stateTtlSeconds, settings.offlineAfterSeconds)) publish(change);
}, 15_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(sweeper);
    scheduler.stop();
    organization.stop();
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
app.log.info(`${settings.officeName} is open at http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port} (pack: ${settings.pack})`);
