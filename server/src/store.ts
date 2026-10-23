import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderConfig, ProviderKind } from "./ai.js";
import { decrypt, encrypt } from "./crypto.js";
import { sanitizeDetail } from "./sanitize.js";
import { WORKING_STATES, type Occupant, type OfficeEvent, type State, type StatusBody } from "./states.js";

interface OccupantRow {
  id: string;
  name: string;
  kind: "agent" | "human";
  state: State;
  detail: string;
  updated_at: string;
  last_seen_at: string;
  model: string | null;
  role: string | null;
}

interface EventRow {
  id: number;
  occupant_id: string;
  state: State;
  detail: string;
  at: string;
}

const MAX_EVENTS = 5000;

const toOccupant = (r: OccupantRow): Occupant => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  state: r.state,
  detail: r.detail,
  updatedAt: r.updated_at,
  model: r.model ?? null,
  role: r.role || null,
});

/** A provider as the settings page sees it: never the key itself, only whether one is set and its last 4 chars. */
export interface ProviderSummary {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  hasKey: boolean;
  keyHint: string | null;
}

interface ProviderRow {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  api_key: string | null;
  key_hint: string | null;
}

/** Which model an occupant thinks with, and who it is. */
export interface Brain {
  providerId: string;
  model: string;
  /** A cheaper model (same provider) for routine work, if any (see costs.ts). */
  lightModel?: string | null;
  systemPrompt: string;
  maxTokens: number;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}

const OCCUPANT_SELECT =
  "SELECT o.*, b.model AS model, s.role AS role FROM occupants o LEFT JOIN brains b ON b.occupant_id = o.id LEFT JOIN souls s ON s.occupant_id = o.id";

/** Who an agent is, in OpenClaw's terms: a job title, SOUL.md (persona, tone, boundaries) and AGENTS.md (how it works). */
export interface Soul {
  role: string;
  soul: string;
  instructions: string;
}

/** A skill in the shared library: a SKILL.md (name and description up front, instructions in the body). */
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  updatedAt: string;
  /** You wrote or changed it by hand: proposals to change it are flagged. */
  editedByYou: boolean;
}

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** One step of a task as it ran: a tool call, or the model writing. */
export interface TaskStep {
  kind: "think" | "skill" | "search" | "fetch" | "memory" | "recall" | "ask" | "delegate" | "handback" | "approval" | "note" | "file" | "mcp";
  text: string;
  at: string;
  /** A task this step points to (the colleague's sub-task, or the task it came from). */
  ref?: { occupantId: string; taskId: number };
  /** The page it read (so you can check its sources). */
  url?: string;
}

/** task: given by you or a schedule; ask / delegate: a colleague's request (a sub-task); project: a turn in a project thread. */
export type TaskKind = "task" | "ask" | "delegate" | "project";

export interface Task {
  id: number;
  occupantId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  result: string;
  error: string;
  steps: TaskStep[];
  /** The schedule that started it, if any. */
  scheduleId: number | null;
  kind: TaskKind;
  /** For a colleague's request: the task it is part of, and who asked. */
  parentTaskId: number | null;
  requestedBy: string | null;
  /** 0 for your tasks, 1 for a colleague's request, 2 for a request made inside that one… */
  depth: number;
  /** For a project turn: the project. */
  projectId: number | null;
  /** Your verdict on a delivery, and why (for a redo). */
  review: "accepted" | "rejected" | null;
  reviewNote: string;
  /** The task this one redoes. */
  redoOf: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface TaskRow {
  id: number;
  occupant_id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  result: string;
  error: string;
  steps: string;
  schedule_id: number | null;
  kind: TaskKind | null;
  parent_task_id: number | null;
  requested_by: string | null;
  depth: number | null;
  project_id: number | null;
  review: "accepted" | "rejected" | null;
  review_note: string | null;
  redo_of: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  occupantId: r.occupant_id,
  title: r.title,
  prompt: r.prompt,
  status: r.status,
  result: r.result,
  error: r.error,
  steps: JSON.parse(r.steps) as TaskStep[],
  scheduleId: r.schedule_id ?? null,
  kind: r.kind ?? "task",
  parentTaskId: r.parent_task_id ?? null,
  requestedBy: r.requested_by ?? null,
  depth: r.depth ?? 0,
  projectId: r.project_id ?? null,
  review: r.review ?? null,
  reviewNote: r.review_note ?? "",
  redoOf: r.redo_of ?? null,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const toEvent = (r: EventRow): OfficeEvent => ({
  id: r.id,
  occupantId: r.occupant_id,
  state: r.state,
  detail: r.detail,
  at: r.at,
});

/** Long-term memory: an agent's own notes, or the office-wide profile of the people it works for. */
export type MemoryTarget = "memory" | "user";

export interface MemoryEntry {
  id: number;
  target: MemoryTarget;
  text: string;
  /** Who wrote it last: the agent, or you (yours are locked for the agent). */
  source: "agent" | "you";
  updatedAt: string;
}

interface MemoryRow {
  id: number;
  occupant_id: string;
  target: MemoryTarget;
  text: string;
  source: "agent" | "you";
  updated_at: string;
}

const toMemory = (r: MemoryRow): MemoryEntry => ({ id: r.id, target: r.target, text: r.text, source: r.source, updatedAt: r.updated_at });

/** When a schedule fires, in the time zone it was set up in. Days: 0 = Sunday … 6 = Saturday. */
export type ScheduleRule =
  | { type: "weekly"; time: string; days: number[] }
  | { type: "interval"; hours: number }
  | { type: "once"; at: string };

/** A task an agent does by itself, on a schedule. */
export interface Schedule {
  id: number;
  occupantId: string;
  title: string;
  prompt: string;
  rule: ScheduleRule;
  timeZone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: number | null;
  /** Set: each run starts a new project with this name (and the date); the prompt's @mentions assign the work. */
  projectTitle: string | null;
  projectBrief: string;
  lastProjectId: number | null;
  createdAt: string;
}

interface ScheduleRow {
  id: number;
  occupant_id: string;
  title: string;
  prompt: string;
  rule: string;
  time_zone: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: number | null;
  project_title: string | null;
  project_brief: string | null;
  last_project_id: number | null;
  created_at: string;
}

const toSchedule = (r: ScheduleRow): Schedule => ({
  id: r.id,
  occupantId: r.occupant_id,
  title: r.title,
  prompt: r.prompt,
  rule: JSON.parse(r.rule) as ScheduleRule,
  timeZone: r.time_zone,
  enabled: r.enabled === 1,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastTaskId: r.last_task_id,
  projectTitle: r.project_title ?? null,
  projectBrief: r.project_brief ?? "",
  lastProjectId: r.last_project_id ?? null,
  createdAt: r.created_at,
});

export type ProjectStatus = "planning" | "active" | "idle" | "closed";

/** How the planner arranged a project: shared by everyone in it. */
export interface ProjectPlan {
  mode: "advisory" | "enforced";
  goal: string;
  plan: string;
  entries: { agentId: string; instruction: string }[];
}

/** A project: a goal several agents work on together, in a thread you can follow. */
export interface Project {
  id: number;
  title: string;
  /** What you wrote about the project; every member reads it. */
  brief: string;
  status: ProjectStatus;
  plan: ProjectPlan | null;
  members: string[];
  /** Someone asked you something (an @you in the thread) and nothing is running. */
  needsYou: boolean;
  /** The latest summary of what the project delivered. */
  summary: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: number;
  title: string;
  brief: string;
  status: ProjectStatus;
  plan: string | null;
  members: string;
  needs_you: number;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  title: r.title,
  brief: r.brief,
  status: r.status,
  plan: r.plan ? (JSON.parse(r.plan) as ProjectPlan) : null,
  members: JSON.parse(r.members) as string[],
  needsYou: r.needs_you === 1,
  summary: r.summary ?? "",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** A line in a project thread: from you, a member, the planner, or the office (system). */
export interface ProjectMessage {
  id: number;
  projectId: number;
  author: string;
  kind: "message" | "plan" | "summary" | "system";
  text: string;
  taskId: number | null;
  at: string;
}

/** An action an agent wants to take that you asked to approve first. */
export interface Approval {
  id: number;
  taskId: number;
  occupantId: string;
  action: string;
  /** What exactly it wants to do, in words. */
  summary: string;
  status: "pending" | "approved" | "denied" | "expired";
  note: string;
  createdAt: string;
  decidedAt: string | null;
}

/** A team lesson: proposed by an agent as a draft, in the library once you approve it. */
export interface Experience {
  id: number;
  title: string;
  body: string;
  /** When it holds, and the signs that it no longer does. */
  applicability: string;
  tags: string[];
  status: "draft" | "approved" | "rejected";
  proposedBy: string | null;
  taskId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A new skill, or a change to one, that an agent proposes and you approve. */
export interface SkillProposal {
  id: number;
  /** The skill it changes, or null for a new one. */
  skillId: string | null;
  name: string;
  description: string;
  body: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  proposedBy: string;
  taskId: number | null;
  createdAt: string;
}

/** A department's report for a period: written by its manager, or counted automatically (author null). */
export interface Report {
  id: number;
  roomId: string;
  author: string | null;
  periodStart: string;
  periodEnd: string;
  content: string;
  /** What it was based on: task ids, project ids… (so every line can be traced). */
  facts: Record<string, unknown>;
  createdAt: string;
}

const toReport = (r: Record<string, unknown>): Report => ({
  id: Number(r.id),
  roomId: String(r.room_id),
  author: (r.author as string | null) ?? null,
  periodStart: String(r.period_start),
  periodEnd: String(r.period_end),
  content: String(r.content),
  facts: JSON.parse(String(r.facts ?? "{}")) as Record<string, unknown>,
  createdAt: String(r.created_at),
});

/**
 * A decision on something that waited for you: by you (the chairman) or by the CEO on your behalf.
 * Yours are the precedents the CEO follows; the CEO's can be overruled.
 */
export interface Decision {
  id: number;
  /** "approval:web_fetch", "experience", "skill", "delivery"… */
  category: string;
  refType: "approval" | "experience" | "skill" | "task";
  refId: string;
  summary: string;
  decision: "approve" | "deny" | "escalate";
  reason: string;
  by: "chairman" | "ceo";
  /** Ids of the earlier decisions it followed. */
  precedents: number[];
  /** What overruling it would restore (e.g. a skill's previous text). */
  undo: Record<string, unknown> | null;
  overruledBy: number | null;
  overrules: number | null;
  createdAt: string;
}

const toDecision = (r: Record<string, unknown>): Decision => ({
  id: Number(r.id),
  category: String(r.category),
  refType: r.ref_type as Decision["refType"],
  refId: String(r.ref_id),
  summary: String(r.summary),
  decision: r.decision as Decision["decision"],
  reason: String(r.reason ?? ""),
  by: r.by as Decision["by"],
  precedents: JSON.parse(String(r.precedents ?? "[]")) as number[],
  undo: r.undo ? (JSON.parse(String(r.undo)) as Record<string, unknown>) : null,
  overruledBy: r.overruled_by === null || r.overruled_by === undefined ? null : Number(r.overruled_by),
  overrules: r.overrules === null || r.overrules === undefined ? null : Number(r.overrules),
  createdAt: String(r.created_at),
});

/** A past task or chat message found by a search. */
export interface RecallHit {
  kind: "task" | "chat";
  ref: number;
  at: string;
  snippet: string;
}

export interface Change {
  occupant: Occupant;
  event: OfficeEvent | null;
}

const toApproval = (r: Record<string, unknown>): Approval => ({
  id: Number(r.id),
  taskId: Number(r.task_id),
  occupantId: String(r.occupant_id),
  action: String(r.action),
  summary: String(r.summary),
  status: r.status as Approval["status"],
  note: String(r.note ?? ""),
  createdAt: String(r.created_at),
  decidedAt: (r.decided_at as string | null) ?? null,
});

const toExperience = (r: Record<string, unknown>): Experience => ({
  id: Number(r.id),
  title: String(r.title),
  body: String(r.body),
  applicability: String(r.applicability),
  tags: JSON.parse(String(r.tags ?? "[]")) as string[],
  status: r.status as Experience["status"],
  proposedBy: (r.proposed_by as string | null) ?? null,
  taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toSkillProposal = (r: Record<string, unknown>): SkillProposal => ({
  id: Number(r.id),
  skillId: (r.skill_id as string | null) ?? null,
  name: String(r.name),
  description: String(r.description),
  body: String(r.body),
  reason: String(r.reason),
  status: r.status as SkillProposal["status"],
  proposedBy: String(r.proposed_by),
  taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
  createdAt: String(r.created_at),
});

/** What a finished task contributes to the search index. */
export const taskText = (t: Task) => `Task: ${t.title}\n${t.prompt}\n\nResult:\n${t.result}`;

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "barnacle.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS occupants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occupant_id TEXT NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_occupant ON events (occupant_id, id);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT,
        api_key TEXT,
        key_hint TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS brains (
        occupant_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        max_tokens INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occupant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_by_occupant ON messages (occupant_id, id);
      CREATE TABLE IF NOT EXISTS souls (
        occupant_id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT '',
        soul TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_skills (
        occupant_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        PRIMARY KEY (occupant_id, skill_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occupant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        steps TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_by_occupant ON tasks (occupant_id, id);
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occupant_id TEXT NOT NULL,
        target TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_by_occupant ON memories (occupant_id, target, id);
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occupant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        rule TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        last_task_id INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        brief TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        plan TEXT,
        members TEXT NOT NULL DEFAULT '[]',
        needs_you INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        author TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        task_id INTEGER,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_messages_by_project ON project_messages (project_id, id);
      CREATE TABLE IF NOT EXISTS project_notes (
        project_id INTEGER NOT NULL,
        occupant_id TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, occupant_id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        occupant_id TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS experiences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        applicability TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        proposed_by TEXT,
        task_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        body TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        proposed_by TEXT NOT NULL,
        task_id INTEGER,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        author TEXT,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        content TEXT NOT NULL,
        facts TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reports_by_room ON reports (room_id, id);
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        ref_type TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        by TEXT NOT NULL,
        precedents TEXT NOT NULL DEFAULT '[]',
        undo TEXT,
        overruled_by INTEGER,
        overrules INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decisions_by_category ON decisions (category, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS recall USING fts5(text, kind UNINDEXED, ref UNINDEXED, occupant_id UNINDEXED, at UNINDEXED, tokenize = 'trigram');
    `);
    // Columns added after the first release.
    const taskColumns = (this.db.prepare("PRAGMA table_info(tasks)").all() as unknown as { name: string }[]).map((c) => c.name);
    if (!taskColumns.includes("schedule_id")) this.db.exec("ALTER TABLE tasks ADD COLUMN schedule_id INTEGER");
    if (!taskColumns.includes("kind")) {
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
        ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER;
        ALTER TABLE tasks ADD COLUMN requested_by TEXT;
        ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
      `);
    }
    if (!taskColumns.includes("project_id")) this.db.exec("ALTER TABLE tasks ADD COLUMN project_id INTEGER");
    const columns = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
    if (!columns("projects").includes("summary")) this.db.exec("ALTER TABLE projects ADD COLUMN summary TEXT");
    if (!columns("tasks").includes("review")) {
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN review TEXT;
        ALTER TABLE tasks ADD COLUMN review_note TEXT;
        ALTER TABLE tasks ADD COLUMN redo_of INTEGER;
      `);
    }
    if (!columns("brains").includes("light_model")) this.db.exec("ALTER TABLE brains ADD COLUMN light_model TEXT");
    if (!columns("skills").includes("edited_by_you")) this.db.exec("ALTER TABLE skills ADD COLUMN edited_by_you INTEGER NOT NULL DEFAULT 0");
    if (!columns("schedules").includes("project_title")) {
      this.db.exec(`
        ALTER TABLE schedules ADD COLUMN project_title TEXT;
        ALTER TABLE schedules ADD COLUMN project_brief TEXT;
        ALTER TABLE schedules ADD COLUMN last_project_id INTEGER;
      `);
    }
    this.backfillRecall();
  }

  /** The database, for modules that keep their own tables (files and the knowledge base). */
  get sql(): DatabaseSync {
    return this.db;
  }

  /** Saved settings as a plain object (values are JSON); validate before use. */
  settings(): Record<string, unknown> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as unknown as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  }

  saveSettings(values: Record<string, unknown>) {
    const upsert = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const [key, value] of Object.entries(values)) upsert.run(key, JSON.stringify(value));
  }

  list(): Occupant[] {
    const rows = this.db.prepare(`${OCCUPANT_SELECT} ORDER BY o.kind DESC, o.name`).all() as unknown as OccupantRow[];
    return rows.map(toOccupant);
  }

  private row(id: string): OccupantRow | undefined {
    return this.db.prepare(`${OCCUPANT_SELECT} WHERE o.id = ?`).get(id) as unknown as OccupantRow | undefined;
  }

  events(limit: number): OfficeEvent[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** One occupant's latest events, newest first. */
  eventsFor(id: string, limit: number): OfficeEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE occupant_id = ? ORDER BY id DESC LIMIT ?").all(id, limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** Records a report. Logs an event only when the state or detail actually changed. */
  report(id: string, body: StatusBody, now = new Date()): Change {
    const at = now.toISOString();
    const detail = sanitizeDetail(body.detail);
    const existing = this.row(id);
    const name = body.name ?? existing?.name ?? id;
    const kind = body.kind ?? existing?.kind ?? "agent";

    this.db
      .prepare(
        `INSERT INTO occupants (id, name, kind, state, detail, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, state = excluded.state,
           detail = excluded.detail, updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at`,
      )
      .run(id, name, kind, body.state, detail, at, at);

    const changed = !existing || existing.state !== body.state || existing.detail !== detail;
    const event = changed ? this.logEvent(id, body.state, detail, at) : null;
    return { occupant: toOccupant(this.row(id)!), event };
  }

  exists(id: string): boolean {
    return this.row(id) !== undefined;
  }

  remove(id: string): boolean {
    this.db.prepare("DELETE FROM events WHERE occupant_id = ?").run(id);
    this.db.prepare("DELETE FROM brains WHERE occupant_id = ?").run(id);
    this.db.prepare("DELETE FROM messages WHERE occupant_id = ?").run(id);
    this.db.prepare("DELETE FROM souls WHERE occupant_id = ?").run(id);
    this.db.prepare("DELETE FROM agent_skills WHERE occupant_id = ?").run(id);
    this.db.prepare("DELETE FROM tasks WHERE occupant_id = ?").run(id);
    this.db.prepare("DELETE FROM memories WHERE occupant_id = ?").run(id);
    this.db.prepare("DELETE FROM schedules WHERE occupant_id = ?").run(id);
    this.db.prepare("DELETE FROM recall WHERE occupant_id = ?").run(id);
    return this.db.prepare("DELETE FROM occupants WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Working states with no report for `ttlSeconds` fall back to idle;
   * anyone unseen for `offlineSeconds` goes offline.
   */
  sweep(ttlSeconds: number, offlineSeconds: number, now = new Date()): Change[] {
    const changes: Change[] = [];
    const at = now.toISOString();
    for (const r of this.db.prepare(OCCUPANT_SELECT).all() as unknown as OccupantRow[]) {
      const sinceReport = (now.getTime() - Date.parse(r.updated_at)) / 1000;
      const sinceSeen = (now.getTime() - Date.parse(r.last_seen_at)) / 1000;
      let next: { state: State; detail: string } | null = null;
      if (r.state !== "offline" && sinceSeen > offlineSeconds) {
        next = { state: "offline", detail: "" };
      } else if (WORKING_STATES.has(r.state) && sinceReport > ttlSeconds) {
        next = { state: "idle", detail: "" }; // empty: clients show the translated state name
      }
      if (!next) continue;
      this.db.prepare("UPDATE occupants SET state = ?, detail = ?, updated_at = ? WHERE id = ?").run(next.state, next.detail, at, r.id);
      const event = this.logEvent(r.id, next.state, next.detail, at);
      changes.push({ occupant: toOccupant(this.row(r.id)!), event });
    }
    return changes;
  }

  // ---------------------------------------------------------------- providers

  providers(): ProviderSummary[] {
    const rows = this.db.prepare("SELECT * FROM providers ORDER BY created_at").all() as unknown as ProviderRow[];
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, baseUrl: r.base_url, hasKey: !!r.api_key, keyHint: r.key_hint }));
  }

  /** The provider with its decrypted key, for server-side calls only. */
  providerConfig(id: string): (ProviderConfig & { name: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as unknown as ProviderRow | undefined;
    if (!r) return undefined;
    return { name: r.name, kind: r.kind, baseUrl: r.base_url, apiKey: r.api_key ? decrypt(r.api_key) : null };
  }

  /** Creates or updates a provider. `apiKey: undefined` keeps the stored key; `null` removes it. */
  saveProvider(id: string, p: { name: string; kind: ProviderKind; baseUrl: string | null; apiKey?: string | null }) {
    const existing = this.db.prepare("SELECT api_key, key_hint FROM providers WHERE id = ?").get(id) as unknown as
      | { api_key: string | null; key_hint: string | null }
      | undefined;
    let sealed = existing?.api_key ?? null;
    let hint = existing?.key_hint ?? null;
    if (p.apiKey !== undefined) {
      sealed = p.apiKey ? encrypt(p.apiKey) : null;
      hint = p.apiKey ? p.apiKey.slice(-4) : null;
    }
    this.db
      .prepare(
        `INSERT INTO providers (id, name, kind, base_url, api_key, key_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, base_url = excluded.base_url,
           api_key = excluded.api_key, key_hint = excluded.key_hint`,
      )
      .run(id, p.name, p.kind, p.baseUrl, sealed, hint, new Date().toISOString());
  }

  /** Deletes a provider and unassigns it from every occupant. Returns the affected occupant ids. */
  removeProvider(id: string): string[] {
    const affected = (this.db.prepare("SELECT occupant_id FROM brains WHERE provider_id = ?").all(id) as unknown as { occupant_id: string }[]).map(
      (r) => r.occupant_id,
    );
    this.db.prepare("DELETE FROM brains WHERE provider_id = ?").run(id);
    this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    return affected;
  }

  // ---------------------------------------------------------------- brains and chat history

  brain(occupantId: string): Brain | undefined {
    const r = this.db.prepare("SELECT * FROM brains WHERE occupant_id = ?").get(occupantId) as unknown as
      | { provider_id: string; model: string; light_model: string | null; system_prompt: string; max_tokens: number }
      | undefined;
    return r && { providerId: r.provider_id, model: r.model, lightModel: r.light_model ?? null, systemPrompt: r.system_prompt, maxTokens: r.max_tokens };
  }

  saveBrain(occupantId: string, b: Brain) {
    this.db
      .prepare(
        `INSERT INTO brains (occupant_id, provider_id, model, light_model, system_prompt, max_tokens) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(occupant_id) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model,
           light_model = excluded.light_model, system_prompt = excluded.system_prompt, max_tokens = excluded.max_tokens`,
      )
      .run(occupantId, b.providerId, b.model, b.lightModel || null, b.systemPrompt, b.maxTokens);
  }

  removeBrain(occupantId: string) {
    this.db.prepare("DELETE FROM brains WHERE occupant_id = ?").run(occupantId);
  }

  /** The most recent `limit` messages, oldest first. */
  messages(occupantId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT role, content, at FROM messages WHERE occupant_id = ? ORDER BY id DESC LIMIT ?")
      .all(occupantId, limit) as unknown as StoredMessage[];
    return rows.reverse();
  }

  addMessage(occupantId: string, role: "user" | "assistant", content: string) {
    const at = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO messages (occupant_id, role, content, at) VALUES (?, ?, ?, ?)").run(occupantId, role, content, at);
    this.index(occupantId, "chat", Number(result.lastInsertRowid), `${role === "user" ? "You" : "Me"}: ${content}`, at);
  }

  clearMessages(occupantId: string) {
    this.db.prepare("DELETE FROM messages WHERE occupant_id = ?").run(occupantId);
    this.db.prepare("DELETE FROM recall WHERE occupant_id = ? AND kind = 'chat'").run(occupantId);
  }

  occupant(id: string): Occupant | undefined {
    const r = this.row(id);
    return r && toOccupant(r);
  }

  // ---------------------------------------------------------------- souls and skills

  soul(occupantId: string): Soul {
    const r = this.db.prepare("SELECT role, soul, instructions FROM souls WHERE occupant_id = ?").get(occupantId) as unknown as Soul | undefined;
    return r ?? { role: "", soul: "", instructions: "" };
  }

  saveSoul(occupantId: string, s: Soul) {
    this.db
      .prepare(
        `INSERT INTO souls (occupant_id, role, soul, instructions) VALUES (?, ?, ?, ?)
         ON CONFLICT(occupant_id) DO UPDATE SET role = excluded.role, soul = excluded.soul, instructions = excluded.instructions`,
      )
      .run(occupantId, s.role, s.soul, s.instructions);
  }

  skills(): Skill[] {
    const rows = this.db.prepare("SELECT id, name, description, body, updated_at, edited_by_you FROM skills ORDER BY name").all() as unknown as {
      id: string;
      name: string;
      description: string;
      body: string;
      updated_at: string;
      edited_by_you: number;
    }[];
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, body: r.body, updatedAt: r.updated_at, editedByYou: r.edited_by_you === 1 }));
  }

  skill(id: string): Skill | undefined {
    return this.skills().find((s) => s.id === id);
  }

  saveSkill(s: Omit<Skill, "updatedAt" | "editedByYou"> & { editedByYou?: boolean }) {
    this.db
      .prepare(
        `INSERT INTO skills (id, name, description, body, updated_at, edited_by_you) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, body = excluded.body, updated_at = excluded.updated_at,
           edited_by_you = MAX(edited_by_you, excluded.edited_by_you)`,
      )
      .run(s.id, s.name, s.description, s.body, new Date().toISOString(), s.editedByYou ? 1 : 0);
  }

  removeSkill(id: string) {
    this.db.prepare("DELETE FROM agent_skills WHERE skill_id = ?").run(id);
    return this.db.prepare("DELETE FROM skills WHERE id = ?").run(id).changes > 0;
  }

  /** The skills an agent has (ids). */
  agentSkills(occupantId: string): string[] {
    const rows = this.db.prepare("SELECT skill_id FROM agent_skills WHERE occupant_id = ?").all(occupantId) as unknown as { skill_id: string }[];
    return rows.map((r) => r.skill_id);
  }

  setAgentSkills(occupantId: string, skillIds: string[]) {
    this.db.prepare("DELETE FROM agent_skills WHERE occupant_id = ?").run(occupantId);
    const insert = this.db.prepare("INSERT OR IGNORE INTO agent_skills (occupant_id, skill_id) VALUES (?, ?)");
    for (const id of skillIds) insert.run(occupantId, id);
  }

  // ---------------------------------------------------------------- tasks

  addTask(
    occupantId: string,
    title: string,
    prompt: string,
    origin: { scheduleId?: number | null; kind?: TaskKind; parentTaskId?: number | null; requestedBy?: string | null; depth?: number; projectId?: number | null; redoOf?: number | null } = {},
  ): Task {
    const result = this.db
      .prepare(
        "INSERT INTO tasks (occupant_id, title, prompt, status, schedule_id, kind, parent_task_id, requested_by, depth, project_id, redo_of, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        occupantId,
        title,
        prompt,
        origin.scheduleId ?? null,
        origin.kind ?? "task",
        origin.parentTaskId ?? null,
        origin.requestedBy ?? null,
        origin.depth ?? 0,
        origin.projectId ?? null,
        origin.redoOf ?? null,
        new Date().toISOString(),
      );
    return this.task(Number(result.lastInsertRowid))!;
  }

  task(id: number): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
    return r && toTask(r);
  }

  /** An agent's latest tasks, newest first. */
  tasks(occupantId: string, limit: number): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE occupant_id = ? ORDER BY id DESC LIMIT ?").all(occupantId, limit) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  /** Back to "to check". */
  clearReview(id: number) {
    this.db.prepare("UPDATE tasks SET review = NULL, review_note = NULL WHERE id = ?").run(id);
  }

  reviewTask(id: number, review: "accepted" | "rejected", note: string) {
    this.db.prepare("UPDATE tasks SET review = ?, review_note = ? WHERE id = ?").run(review, note, id);
    return this.task(id);
  }

  /**
   * Finished work to check: your tasks and scheduled ones (not colleagues' sub-tasks or project turns),
   * newest first. "pending": done and not yet accepted or sent back.
   */
  deliveries(filter: { status?: "pending" | "accepted" | "rejected" | "failed" | "all"; occupantId?: string; limit?: number } = {}): Task[] {
    const where = ["kind = 'task'"];
    const args: (string | number)[] = [];
    switch (filter.status ?? "all") {
      case "pending":
        where.push("status = 'done' AND review IS NULL");
        break;
      case "accepted":
        where.push("review = 'accepted'");
        break;
      case "rejected":
        where.push("review = 'rejected'");
        break;
      case "failed":
        where.push("status = 'failed'");
        break;
      default:
        where.push("status IN ('done', 'failed')");
    }
    if (filter.occupantId) {
      where.push("occupant_id = ?");
      args.push(filter.occupantId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ?`)
      .all(...args, filter.limit ?? 200) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  /** A task's colleague requests (sub-tasks), oldest first. */
  childTasks(parentTaskId: number): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY id").all(parentTaskId) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  /** Queued tasks, oldest first (for picking up after a restart too). */
  queuedTasks(): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY id").all() as unknown as TaskRow[];
    return rows.map(toTask);
  }

  updateTask(id: number, patch: Partial<Pick<Task, "status" | "result" | "error" | "steps" | "startedAt" | "finishedAt">>) {
    const t = this.task(id);
    if (!t) return undefined;
    const next = { ...t, ...patch };
    this.db
      .prepare("UPDATE tasks SET status = ?, result = ?, error = ?, steps = ?, started_at = ?, finished_at = ? WHERE id = ?")
      .run(next.status, next.result, next.error, JSON.stringify(next.steps), next.startedAt, next.finishedAt, id);
    return next;
  }

  /** Tasks left running when the server stopped can't resume; mark them failed. */
  failInterrupted(message: string) {
    this.db.prepare("UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'").run(message, new Date().toISOString());
  }

  // ---------------------------------------------------------------- schedules

  schedules(occupantId: string): Schedule[] {
    const rows = this.db.prepare("SELECT * FROM schedules WHERE occupant_id = ? ORDER BY id").all(occupantId) as unknown as ScheduleRow[];
    return rows.map(toSchedule);
  }

  schedule(id: number): Schedule | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as unknown as ScheduleRow | undefined;
    return r && toSchedule(r);
  }

  /** Enabled schedules whose time has come. */
  dueSchedules(now: string): Schedule[] {
    const rows = this.db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at").all(now) as unknown as ScheduleRow[];
    return rows.map(toSchedule);
  }

  addSchedule(s: Pick<Schedule, "occupantId" | "title" | "prompt" | "rule" | "timeZone" | "enabled" | "nextRunAt" | "projectTitle" | "projectBrief">): Schedule {
    const result = this.db
      .prepare("INSERT INTO schedules (occupant_id, title, prompt, rule, time_zone, enabled, next_run_at, project_title, project_brief, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.occupantId, s.title, s.prompt, JSON.stringify(s.rule), s.timeZone, s.enabled ? 1 : 0, s.nextRunAt, s.projectTitle, s.projectBrief, new Date().toISOString());
    return this.schedule(Number(result.lastInsertRowid))!;
  }

  updateSchedule(
    id: number,
    patch: Partial<Pick<Schedule, "title" | "prompt" | "rule" | "timeZone" | "enabled" | "nextRunAt" | "lastRunAt" | "lastTaskId" | "projectTitle" | "projectBrief" | "lastProjectId">>,
  ) {
    const cur = this.schedule(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        "UPDATE schedules SET title = ?, prompt = ?, rule = ?, time_zone = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_task_id = ?, project_title = ?, project_brief = ?, last_project_id = ? WHERE id = ?",
      )
      .run(next.title, next.prompt, JSON.stringify(next.rule), next.timeZone, next.enabled ? 1 : 0, next.nextRunAt, next.lastRunAt, next.lastTaskId, next.projectTitle, next.projectBrief, next.lastProjectId, id);
    return next;
  }

  removeSchedule(id: number) {
    return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
  }

  // ---------------------------------------------------------------- projects

  projects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY status = 'closed', updated_at DESC").all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  project(id: number): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
    return r && toProject(r);
  }

  addProject(title: string, brief: string): Project {
    const at = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO projects (title, brief, status, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?)").run(title, brief, at, at);
    return this.project(Number(result.lastInsertRowid))!;
  }

  updateProject(id: number, patch: Partial<Pick<Project, "title" | "brief" | "status" | "plan" | "members" | "needsYou" | "summary">>) {
    const cur = this.project(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE projects SET title = ?, brief = ?, status = ?, plan = ?, members = ?, needs_you = ?, summary = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.brief, next.status, next.plan ? JSON.stringify(next.plan) : null, JSON.stringify(next.members), next.needsYou ? 1 : 0, next.summary, next.updatedAt, id);
    return next;
  }

  removeProject(id: number) {
    this.db.prepare("DELETE FROM project_messages WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM project_notes WHERE project_id = ?").run(id);
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  projectMessages(projectId: number, limit = 500): ProjectMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM project_messages WHERE project_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(projectId, limit) as unknown as { id: number; project_id: number; author: string; kind: ProjectMessage["kind"]; text: string; task_id: number | null; at: string }[];
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, author: r.author, kind: r.kind, text: r.text, taskId: r.task_id, at: r.at }));
  }

  addProjectMessage(projectId: number, author: string, kind: ProjectMessage["kind"], text: string, taskId: number | null = null): ProjectMessage {
    const at = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO project_messages (project_id, author, kind, text, task_id, at) VALUES (?, ?, ?, ?, ?, ?)").run(projectId, author, kind, text, taskId, at);
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(at, projectId);
    return { id: Number(result.lastInsertRowid), projectId, author, kind, text, taskId, at };
  }

  /** Each member's own notes for a project (occupant id → text). */
  projectNotes(projectId: number): Record<string, string> {
    const rows = this.db.prepare("SELECT occupant_id, text FROM project_notes WHERE project_id = ?").all(projectId) as unknown as { occupant_id: string; text: string }[];
    return Object.fromEntries(rows.map((r) => [r.occupant_id, r.text]));
  }

  saveProjectNote(projectId: number, occupantId: string, text: string) {
    this.db
      .prepare(
        `INSERT INTO project_notes (project_id, occupant_id, text, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, occupant_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
      )
      .run(projectId, occupantId, text, new Date().toISOString());
  }

  /** A project's turns (tasks), oldest first. */
  projectTasks(projectId: number): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY id").all(projectId) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  // ---------------------------------------------------------------- approvals, experience, skill proposals

  addApproval(a: Pick<Approval, "taskId" | "occupantId" | "action" | "summary">): Approval {
    const at = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO approvals (task_id, occupant_id, action, summary, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(a.taskId, a.occupantId, a.action, a.summary, at);
    return this.approval(Number(result.lastInsertRowid))!;
  }

  approval(id: number): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r && toApproval(r);
  }

  approvals(status?: Approval["status"]): Approval[] {
    const rows = (status ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY id").all(status) : this.db.prepare("SELECT * FROM approvals ORDER BY id DESC LIMIT 100").all()) as Record<string, unknown>[];
    return rows.map(toApproval);
  }

  decideApproval(id: number, status: Exclude<Approval["status"], "pending">, note = "") {
    this.db.prepare("UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, note, new Date().toISOString(), id);
    return this.approval(id);
  }

  /** Pending approvals left from before a restart can't resume; they expire. */
  expireApprovals() {
    this.db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'").run(new Date().toISOString());
  }

  addExperience(e: Pick<Experience, "title" | "body" | "applicability" | "tags" | "status" | "proposedBy" | "taskId">): Experience {
    const at = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO experiences (title, body, applicability, tags, status, proposed_by, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.title, e.body, e.applicability, JSON.stringify(e.tags), e.status, e.proposedBy, e.taskId, at, at);
    return this.experience(Number(result.lastInsertRowid))!;
  }

  experience(id: number): Experience | undefined {
    const r = this.db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r && toExperience(r);
  }

  experiences(status?: Experience["status"]): Experience[] {
    const rows = (status ? this.db.prepare("SELECT * FROM experiences WHERE status = ? ORDER BY updated_at DESC").all(status) : this.db.prepare("SELECT * FROM experiences ORDER BY updated_at DESC").all()) as Record<string, unknown>[];
    return rows.map(toExperience);
  }

  updateExperience(id: number, patch: Partial<Pick<Experience, "title" | "body" | "applicability" | "tags" | "status">>) {
    const cur = this.experience(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE experiences SET title = ?, body = ?, applicability = ?, tags = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.body, next.applicability, JSON.stringify(next.tags), next.status, next.updatedAt, id);
    return next;
  }

  removeExperience(id: number) {
    return this.db.prepare("DELETE FROM experiences WHERE id = ?").run(id).changes > 0;
  }

  /** Approved lessons whose words match (any of the keywords, in any field). */
  searchExperiences(keyword: string, limit = 8): Experience[] {
    const words = keyword.split(/[\s,，。、;；]+/).filter(Boolean).slice(0, 8);
    if (!words.length) return this.experiences("approved").slice(0, limit);
    const like = words.map(() => "(title LIKE ? OR body LIKE ? OR applicability LIKE ? OR tags LIKE ?)").join(" OR ");
    const rows = this.db
      .prepare(`SELECT * FROM experiences WHERE status = 'approved' AND (${like}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...words.flatMap((w) => Array(4).fill(`%${w}%`)), limit) as Record<string, unknown>[];
    return rows.map(toExperience);
  }

  addSkillProposal(p: Pick<SkillProposal, "skillId" | "name" | "description" | "body" | "reason" | "proposedBy" | "taskId">): SkillProposal {
    const result = this.db
      .prepare("INSERT INTO skill_proposals (skill_id, name, description, body, reason, status, proposed_by, task_id, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
      .run(p.skillId, p.name, p.description, p.body, p.reason, p.proposedBy, p.taskId, new Date().toISOString());
    return this.skillProposal(Number(result.lastInsertRowid))!;
  }

  skillProposal(id: number): SkillProposal | undefined {
    const r = this.db.prepare("SELECT * FROM skill_proposals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r && toSkillProposal(r);
  }

  skillProposals(status: SkillProposal["status"] = "pending"): SkillProposal[] {
    return (this.db.prepare("SELECT * FROM skill_proposals WHERE status = ? ORDER BY id").all(status) as Record<string, unknown>[]).map(toSkillProposal);
  }

  /** Puts a decided proposal back in the inbox. */
  reopenSkillProposal(id: number) {
    this.db.prepare("UPDATE skill_proposals SET status = 'pending', decided_at = NULL WHERE id = ?").run(id);
  }

  decideSkillProposal(id: number, status: "approved" | "rejected") {
    this.db.prepare("UPDATE skill_proposals SET status = ?, decided_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  }

  // ---------------------------------------------------------------- decisions (yours and the CEO's)

  addDecision(d: Omit<Decision, "id" | "createdAt" | "overruledBy">): Decision {
    const result = this.db
      .prepare(
        "INSERT INTO decisions (category, ref_type, ref_id, summary, decision, reason, by, precedents, undo, overrules, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(d.category, d.refType, d.refId, d.summary, d.decision, d.reason, d.by, JSON.stringify(d.precedents), d.undo ? JSON.stringify(d.undo) : null, d.overrules, new Date().toISOString());
    const id = Number(result.lastInsertRowid);
    if (d.overrules) this.db.prepare("UPDATE decisions SET overruled_by = ? WHERE id = ?").run(id, d.overrules);
    return this.decision(id)!;
  }

  decision(id: number): Decision | undefined {
    const r = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r && toDecision(r);
  }

  decisions(filter: { category?: string; by?: Decision["by"]; since?: string; limit?: number } = {}): Decision[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.category) {
      where.push("category = ?");
      args.push(filter.category);
    }
    if (filter.by) {
      where.push("by = ?");
      args.push(filter.by);
    }
    if (filter.since) {
      where.push("created_at >= ?");
      args.push(filter.since);
    }
    const rows = this.db
      .prepare(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, filter.limit ?? 100) as Record<string, unknown>[];
    return rows.map(toDecision);
  }

  // ---------------------------------------------------------------- reports

  addReport(r: Omit<Report, "id" | "createdAt">): Report {
    const at = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO reports (room_id, author, period_start, period_end, content, facts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.roomId, r.author, r.periodStart, r.periodEnd, r.content, JSON.stringify(r.facts), at);
    return this.report_(Number(result.lastInsertRowid))!;
  }

  report_(id: number): Report | undefined {
    const r = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r && toReport(r);
  }

  reports(filter: { roomId?: string; limit?: number } = {}): Report[] {
    const rows = (
      filter.roomId
        ? this.db.prepare("SELECT * FROM reports WHERE room_id = ? ORDER BY id DESC LIMIT ?").all(filter.roomId, filter.limit ?? 50)
        : this.db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT ?").all(filter.limit ?? 100)
    ) as Record<string, unknown>[];
    return rows.map(toReport);
  }

  /** Tasks of some people that finished, or were still open, in a period (for reports). */
  tasksBetween(occupantIds: string[], since: string, until: string): Task[] {
    if (!occupantIds.length) return [];
    const marks = occupantIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE occupant_id IN (${marks})
         AND ((finished_at >= ? AND finished_at <= ?) OR status IN ('queued', 'running'))
         ORDER BY id`,
      )
      .all(...occupantIds, since, until) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  // ---------------------------------------------------------------- memory

  /** An agent's notes and the shared profile ("user" entries belong to no one agent). */
  memories(occupantId: string): MemoryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE (occupant_id = ? AND target = 'memory') OR (occupant_id = '' AND target = 'user') ORDER BY id")
      .all(occupantId) as unknown as MemoryRow[];
    return rows.map(toMemory);
  }

  /** The entry, if it is one this agent can see. */
  memoryEntry(id: number, occupantId: string): MemoryEntry | undefined {
    return this.memories(occupantId).find((m) => m.id === id);
  }

  addMemory(occupantId: string, target: MemoryTarget, text: string, source: MemoryEntry["source"]): MemoryEntry {
    const at = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO memories (occupant_id, target, text, source, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(target === "user" ? "" : occupantId, target, text, source, at);
    return { id: Number(result.lastInsertRowid), target, text, source, updatedAt: at };
  }

  updateMemory(id: number, text: string, source: MemoryEntry["source"]) {
    this.db.prepare("UPDATE memories SET text = ?, source = ?, updated_at = ? WHERE id = ?").run(text, source, new Date().toISOString(), id);
  }

  removeMemory(id: number) {
    return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  // ---------------------------------------------------------------- recall (full-text search over past work)

  /** Adds a finished task or a chat message to the search index. */
  index(occupantId: string, kind: RecallHit["kind"], ref: number, text: string, at: string) {
    this.db.prepare("INSERT INTO recall (text, kind, ref, occupant_id, at) VALUES (?, ?, ?, ?, ?)").run(text, kind, ref, occupantId, at);
  }

  private backfillRecall() {
    const { n } = this.db.prepare("SELECT count(*) AS n FROM recall").get() as { n: number };
    if (n > 0) return;
    for (const r of this.db.prepare("SELECT * FROM tasks WHERE status = 'done'").all() as unknown as TaskRow[]) {
      this.index(r.occupant_id, "task", r.id, taskText(toTask(r)), r.finished_at ?? r.created_at);
    }
    for (const r of this.db.prepare("SELECT id, occupant_id, role, content, at FROM messages").all() as unknown as { id: number; occupant_id: string; role: string; content: string; at: string }[]) {
      this.index(r.occupant_id, "chat", r.id, `${r.role === "user" ? "You" : "Me"}: ${r.content}`, r.at);
    }
  }

  /**
   * Searches an agent's past tasks and chats. Words of 3+ characters use the trigram index (which also
   * finds Chinese and Japanese text); shorter ones fall back to a plain substring match.
   */
  recall(occupantId: string, query: string, limit = 6): RecallHit[] {
    const terms = query
      .split(/[\s,，。、;；:：!?！？"'“”「」()（）]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!terms.length) return [];
    const long = terms.filter((t) => [...t].length >= 3);
    type Row = { kind: RecallHit["kind"]; ref: number; at: string; snippet: string };
    let rows: Row[];
    if (long.length) {
      const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
      rows = this.db
        .prepare(
          `SELECT kind, ref, at, snippet(recall, 0, '«', '»', '…', 64) AS snippet FROM recall
           WHERE recall MATCH ? AND occupant_id = ? ORDER BY rank LIMIT ?`,
        )
        .all(match, occupantId, limit) as unknown as Row[];
    } else {
      const like = terms.map(() => "text LIKE ?").join(" OR ");
      rows = (
        this.db
          .prepare(`SELECT kind, ref, at, text FROM recall WHERE occupant_id = ? AND (${like}) ORDER BY at DESC LIMIT ?`)
          .all(occupantId, ...terms.map((t) => `%${t}%`), limit) as unknown as (Row & { text: string })[]
      ).map((r) => {
        const i = Math.max(0, r.text.indexOf(terms.find((t) => r.text.includes(t)) ?? ""));
        return { kind: r.kind, ref: r.ref, at: r.at, snippet: `${i > 40 ? "…" : ""}${r.text.slice(Math.max(0, i - 40), i + 80)}…` };
      });
    }
    return rows.map((r) => ({ kind: r.kind, ref: Number(r.ref), at: r.at, snippet: r.snippet.replace(/\s+/g, " ") }));
  }

  private logEvent(occupantId: string, state: State, detail: string, at: string): OfficeEvent {
    const result = this.db
      .prepare("INSERT INTO events (occupant_id, state, detail, at) VALUES (?, ?, ?, ?)")
      .run(occupantId, state, detail, at);
    this.db.prepare("DELETE FROM events WHERE id <= ?").run(Number(result.lastInsertRowid) - MAX_EVENTS);
    return { id: Number(result.lastInsertRowid), occupantId, state, detail, at };
  }
}
