export type State = "idle" | "writing" | "researching" | "executing" | "syncing" | "waiting" | "error" | "offline";

export interface Occupant {
  id: string;
  name: string;
  kind: "agent" | "human";
  state: State;
  detail: string;
  updatedAt: string;
  model: string | null;
  /** Job title from the agent's soul. */
  role: string | null;
}

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** A piece of work given to an agent, and how it went. */
export interface Task {
  id: number;
  occupantId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  result: string;
  error: string;
  scheduleId: number | null;
  /** task: given by you or a schedule; ask / delegate: a colleague's request. */
  kind: "task" | "ask" | "delegate" | "project";
  projectId: number | null;
  /** Your verdict on the delivery, and why. */
  review: "accepted" | "rejected" | null;
  reviewNote: string;
  /** The task this one redoes. */
  redoOf: number | null;
  /** The department manager's check before it reaches you. */
  managerReview: "pending" | "passed" | "failed" | null;
  managerNote: string;
  managerId: string | null;
  parentTaskId: number | null;
  requestedBy: string | null;
  depth: number;
  steps: TaskStep[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface OfficeEvent {
  id: number;
  occupantId: string;
  state: State;
  detail: string;
  at: string;
}

export interface Area {
  label: string;
  theme: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A condition on who is in the office, used by props (see docs/mod-pack-spec.md, "bindings"). */
export interface When {
  anyOccupantIn: State[];
}

/** A character skin: a sprite sheet whose frames loop while the character stands still. */
export interface Skin {
  id: string;
  image: string;
  frameWidth: number;
  frameHeight: number;
  frames: number[];
  fps: number;
  scale?: number;
}

/** A static or animated object placed in the room. */
export interface Prop {
  id: string;
  image: string;
  x: number;
  y: number;
  frameWidth?: number;
  frameHeight?: number;
  /** Frames to animate; omit for all frames in the sheet. */
  frames?: number[];
  fps?: number;
  /** Frame shown when not animating. */
  frame?: number;
  origin?: [number, number];
  scale?: number;
  depth?: number;
  /**
   * "play": animate only while the condition holds; "show": visible (and animating) only while it holds;
   * "always": animate always; "static": never animate, just show `frame`.
   */
  behaviour?: "play" | "show" | "always" | "static";
  when?: When;
}

export interface Layout {
  tile: number;
  width: number;
  height: number;
  areas: Record<string, Area>;
  stateAreas: Record<State, string>;
  /** Set by the server: where this pack's files are served. */
  assetBase?: string;
  /** A full-room image; when present, the procedural room and area rugs are not drawn. */
  background?: string;
  skins?: Skin[];
  props?: Prop[];
}

export interface Office {
  name: string;
  language: string;
  pack: string;
  scene: "floor" | "pack";
  floor: import("./floor/model").Floor;
  /** A sprite-sheet art pack for the floor scene, or null for the built-in drawings. */
  floorArt: { id: string; base: string; atlas: import("./floor/art-atlas").Atlas } | null;
  /** An installed art pack that can be chosen instead of the built-in art. */
  floorArtPack: { id: string; name: string } | null;
  protocol: string;
  states: State[];
  layout: Layout;
  /** Who manages which department (room id → occupant) and who the chairman is. */
  org?: OrgRoles;
}

export interface OrgRoles {
  enabled: boolean;
  managers: Record<string, string>;
  chairman: string | null;
  ceo?: string | null;
}

export interface OrgSettings extends OrgRoles {
  reportTime: string;
  reportDays: number[];
  timeZone: string;
  language: "en" | "ja" | "zh-Hant";
  lastReportAt: string | null;
  ceo: string | null;
  delegation: Record<string, { enabled: boolean; dailyLimit: number }>;
  highRisk: string[];
  managerReview: Record<string, boolean>;
}

/** A decision on something that waited for you: by you, or by the CEO for you. */
export interface Decision {
  id: number;
  category: string;
  refType: "approval" | "experience" | "skill" | "task";
  refId: string;
  summary: string;
  decision: "approve" | "deny" | "escalate";
  reason: string;
  by: "chairman" | "ceo";
  precedents: number[];
  overruledBy: number | null;
  overrules: number | null;
  createdAt: string;
}

/** A category the CEO may be given: what you delegated, and how you decided it so far. */
export interface DelegationCategory {
  key: string;
  delegated: boolean;
  dailyLimit: number;
  highRisk: boolean;
  decided: number;
  approved: number;
  streak: number;
  usedToday: number;
}

/** A department's report: by its manager, or counted by the office (author null). */
export interface Report {
  id: number;
  roomId: string;
  author: string | null;
  periodStart: string;
  periodEnd: string;
  content: string;
  createdAt: string;
}

export interface DepartmentView {
  id: string;
  name: string;
  hue: number;
  purpose: string;
  manager: string | null;
  members: string[];
  stats: { total: number; working: number; doneToday: number; failedToday: number; open: number; unchecked: number; approvals: number };
  latest: Report | null;
}

export interface Dashboard {
  org: OrgSettings;
  hasSuite: boolean;
  company: Report | null;
  decisions: Decision[];
  departments: DepartmentView[];
  inbox: number;
  unchecked: number;
}

/** What the details panel loads for one occupant. */
export interface OccupantDetails {
  occupant: Occupant;
  events: OfficeEvent[];
}

export interface TaskStep {
  kind: "think" | "skill" | "search" | "fetch" | "memory" | "recall" | "ask" | "delegate" | "handback" | "approval" | "note" | "file" | "mcp";
  text: string;
  at: string;
  /** The colleague's sub-task, or the task a request came from. */
  ref?: { occupantId: string; taskId: number };
}

/** Someone walks over to a colleague (names only). */
export interface Handoff {
  from: string;
  to: string;
  kind: "ask" | "delegate" | "return" | "pass";
}

export type ProjectStatus = "planning" | "active" | "idle" | "closed";

/** What every page may know about a project: who is in it and whether it runs (no titles or text). */
export interface ProjectSummary {
  id: number;
  status: ProjectStatus;
  members: string[];
  /** Members with a turn queued or running. */
  active: string[];
  needsYou: boolean;
}

export interface Project extends ProjectSummary {
  title: string;
  brief: string;
  plan: { mode: "advisory" | "enforced"; goal: string; plan: string; entries: { agentId: string; instruction: string }[] } | null;
  /** The latest summary of what the project delivered. */
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMessage {
  id: number;
  author: string;
  kind: "message" | "plan" | "summary" | "system";
  text: string;
  taskId: number | null;
  at: string;
}

export interface ProjectDetails {
  project: Project;
  messages: ProjectMessage[];
  notes: Record<string, string>;
  turns: { id: number; occupantId: string; status: TaskStatus; title: string; error: string; createdAt: string }[];
}

export type ServerMessage =
  | { type: "snapshot"; office: Office; occupants: Occupant[]; events: OfficeEvent[]; projects?: ProjectSummary[]; inbox?: number }
  /** How many things wait for you (a count only). */
  | { type: "inbox"; count: number }
  /** A department report was made (ids only). */
  | { type: "report"; report: { id: number; roomId: string } }
  | { type: "costs" }
  | { type: "mcp" }
  /** The CEO decided something (ids only). */
  | { type: "decision"; decision: { id: number; category: string } }
  | { type: "project"; project: ProjectSummary }
  | { type: "occupant"; occupant: Occupant }
  | { type: "removed"; id: string }
  | { type: "event"; event: OfficeEvent }
  /** A task changed (only ids and status; the content needs the token). */
  | { type: "task"; task: { id: number; occupantId: string; status: TaskStatus } }
  | ({ type: "handoff" } & Handoff);

/** A stable colour per occupant, so the same agent always looks the same. */
export function hueFor(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Long-term memory: the agent's own notes and the shared profile of you ("user"). */
export interface MemoryEntry {
  id: number;
  target: "memory" | "user";
  text: string;
  source: "agent" | "you";
  updatedAt: string;
}

export interface MemoryView {
  entries: MemoryEntry[];
  limits: { memory: number; user: number };
  usage: { memory: number; user: number };
}

export interface RecallHit {
  kind: "task" | "chat";
  ref: number;
  at: string;
  snippet: string;
}

export type ScheduleRule = { type: "weekly"; time: string; days: number[] } | { type: "interval"; hours: number } | { type: "once"; at: string };

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
  /** Set: each run starts a new project with this name. */
  projectTitle: string | null;
  projectBrief: string;
  lastProjectId: number | null;
}

export interface Approval {
  id: number;
  taskId: number;
  occupantId: string;
  action: string;
  summary: string;
  createdAt: string;
}

export interface Experience {
  id: number;
  title: string;
  body: string;
  applicability: string;
  tags: string[];
  status: "draft" | "approved" | "rejected";
  proposedBy: string | null;
  updatedAt: string;
}

export interface SkillProposal {
  id: number;
  skillId: string | null;
  name: string;
  description: string;
  body: string;
  reason: string;
  proposedBy: string;
  current: { body: string; description: string; editedByYou: boolean } | null;
}

/** Everything that waits for you. */
export interface Inbox {
  approvals: Approval[];
  projects: { id: number; title: string; members: string[]; updatedAt: string }[];
  experiences: Experience[];
  skills: SkillProposal[];
  count: number;
  /** Why the CEO handed these to you: "approval:12" → its note. */
  ceoNotes?: Record<string, string>;
}
