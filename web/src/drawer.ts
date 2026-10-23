import { taskCost } from "./costs-ui";
import { soulEditor, type Skill } from "./agent-editor";
import { api, tokenStore, Unauthorized } from "./auth";
import { AttachPicker, taskFiles } from "./files-ui";
import { characterSeed } from "./floor/art-habblaud";
import { language, t } from "./i18n";
import { renderMarkdown } from "./markdown";
import { LOOK } from "./panel";
import { InboxView } from "./governance-ui";
import { mentionChips, ProjectView } from "./projects";
import type { Inbox, MemoryEntry, MemoryView, Occupant, OccupantDetails, ProjectDetails, RecallHit, Schedule, ScheduleRule, State, Task } from "./types";
import { avatarCanvas } from "./vendor/habblaud/art/index";
import { ICONS } from "./vendor/habblaud/ui/icons";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "3 minutes ago" in the page's language. */
export function relativeTime(at: number, now = Date.now()) {
  const s = Math.round((at - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language(), { numeric: "auto" });
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

function section(title: string, extra?: string) {
  const sec = el("section", "ui-sec");
  const head = el("div", "ui-sec__head");
  head.append(el("h3", "ui-sec__title", title));
  if (extra) head.append(el("span", "ui-sec__extra", extra));
  sec.append(head);
  return sec;
}

/** "claude-opus-5-5" → "Opus 5.5"; other ids are shown as they are. */
export function prettyModel(id: string) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ""}`;
}

type Repeat = "daily" | "weekdays" | "weekly" | "interval" | "once";

/** The schedule form, as typed. */
interface ScheduleDraft {
  prompt: string;
  repeat: Repeat;
  time: string;
  days: number[];
  hours: number;
  /** datetime-local value, in the browser's time zone. */
  at: string;
  /** Start a project each time instead of a task. */
  asProject: boolean;
  projectTitle: string;
  projectBrief: string;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const sameDays = (a: number[], b: number[]) => a.length === b.length && b.every((d) => a.includes(d));

/** "Mon" / "週一" / "月" for 0 = Sunday … 6 = Saturday (25 Oct 2026 was a Sunday). */
const dayName = (d: number) => new Intl.DateTimeFormat(language(), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 25 + d)));

const shortDateTime = (iso: string) => new Intl.DateTimeFormat(language(), { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** "Weekdays at 09:00", "Every 4 h", … */
function describeRule(rule: ScheduleRule) {
  if (rule.type === "interval") return t("sched.everyHours", { n: String(rule.hours) });
  if (rule.type === "once") return t("sched.onceAt", { when: shortDateTime(rule.at) });
  if (sameDays(rule.days, ALL_DAYS)) return t("sched.everyDay", { time: rule.time });
  if (sameDays(rule.days, WEEKDAYS)) return t("sched.everyWeekday", { time: rule.time });
  if (sameDays(rule.days, [0, 6])) return t("sched.everyWeekend", { time: rule.time });
  const days = [...rule.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(dayName).join(t("sched.daySep"));
  return t("sched.everyWeek", { days, time: rule.time });
}

/** A local datetime-local value an hour from now, on the hour. */
function inAnHour() {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

function draftOf(s?: Pick<Schedule, "prompt" | "rule"> & Partial<Pick<Schedule, "projectTitle" | "projectBrief">>): ScheduleDraft {
  const base: ScheduleDraft = {
    prompt: s?.prompt ?? "",
    repeat: "weekdays",
    time: "09:00",
    days: [1],
    hours: 4,
    at: inAnHour(),
    asProject: !!s?.projectTitle,
    projectTitle: s?.projectTitle ?? "",
    projectBrief: s?.projectBrief ?? "",
  };
  const rule = s?.rule;
  if (!rule) return base;
  if (rule.type === "interval") return { ...base, repeat: "interval", hours: rule.hours };
  if (rule.type === "once") {
    const d = new Date(rule.at);
    const pad = (n: number) => String(n).padStart(2, "0");
    return { ...base, repeat: "once", at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  const repeat: Repeat = sameDays(rule.days, ALL_DAYS) ? "daily" : sameDays(rule.days, WEEKDAYS) ? "weekdays" : "weekly";
  return { ...base, repeat, time: rule.time, days: [...rule.days] };
}

function ruleOf(d: ScheduleDraft): ScheduleRule | string {
  if (d.repeat === "interval") return { type: "interval", hours: Math.max(1, Math.min(168, Math.round(d.hours) || 1)) };
  if (d.repeat === "once") return { type: "once", at: new Date(d.at).toISOString() };
  const days = d.repeat === "daily" ? ALL_DAYS : d.repeat === "weekdays" ? WEEKDAYS : d.days;
  if (!days.length) return t("sched.needDays");
  return { type: "weekly", time: d.time || "09:00", days };
}

const STEP_ICON: Record<Task["steps"][number]["kind"], string> = { think: "✏️", skill: "🧩", search: "🔎", fetch: "🌐", memory: "🧠", recall: "🗂️", ask: "🙋", delegate: "🤝", handback: "📦", approval: "✋", note: "📝", file: "📎", mcp: "🔌" };
const TASK_ICON: Record<Task["status"], string> = { queued: "⏳", running: "⚙️", done: "✅", failed: "⚠️", cancelled: "⏹️" };

/**
 * The details drawer on the right (Habblaud's layout): who it is, where, what it's doing now, giving it
 * work and reading what it delivered, its timeline and profile. It reloads while open.
 */
export class Drawer {
  private id: string | null = null;
  private data: OccupantDetails | null = null;
  /** null: not loaded; "locked": the page isn't unlocked, so tasks can't be read. */
  private tasks: Task[] | "locked" | null = null;
  private openTask: number | null = null;
  private draft = "";
  private sending = false;
  /** Files picked for the next task. */
  private attach = new AttachPicker(() => this.render());
  private sendError = "";
  private timer: number | null = null;
  /** Memory: null until loaded, "locked" without the token. */
  private memory: MemoryView | "locked" | null = null;
  private memDraft = { memory: "", user: "" };
  private memEdit: { id: number; text: string } | null = null;
  private memError = "";
  private recallQuery = "";
  private recallHits: RecallHit[] | null = null;
  private composing = false;
  /** Project mode: the drawer shows a project ("new": the form for one) instead of an occupant. */
  private projectId: number | "new" | null = null;
  private project: ProjectDetails | null = null;
  private projectView = new ProjectView({
    agents: () => this.opts.agents(),
    nameOf: (id) => this.opts.nameOf(id),
    openAgent: (id) => {
      this.open(id);
      this.opts.onFocus(id);
    },
    openProject: (id) => this.openProject(id),
    scheduleProject: (project, message) => {
      const owner = project.members[0];
      if (!owner) return;
      this.open(owner);
      this.opts.onFocus(owner);
      this.schedForm = {
        id: null,
        draft: { ...draftOf({ prompt: message, rule: { type: "weekly", time: "09:00", days: WEEKDAYS } }), asProject: true, projectTitle: project.title, projectBrief: project.brief },
      };
      this.scrollToForm = true;
    },
    close: () => this.close(),
    reload: () => void this.load(),
  });
  /** Schedules: null until loaded, "locked" without the token. */
  private schedules: Schedule[] | "locked" | null = null;
  /** The open schedule form: a new one (id null) or editing one. */
  private schedForm: { id: number | null; draft: ScheduleDraft } | null = null;
  private schedError = "";
  /** Inbox mode: everything that waits for you. */
  private inboxOpen = false;
  private inbox: Inbox | null = null;
  private inboxView = new InboxView({
    nameOf: (id) => this.opts.nameOf(id),
    waiting: () => this.opts.waiting(),
    openAgent: (id) => {
      this.open(id);
      this.opts.onFocus(id);
    },
    openProject: (id) => this.openProject(id),
    reload: () => void this.load(),
  });
  /** A delivery being sent back: task id and the reason being typed. */
  private rejecting: { id: number; note: string } | null = null;
  /** Workstation mode: the agent's setup (desk, model, job title, soul, skills) instead of its work. */
  private bench = false;
  /** The soul and skills editor, kept across redraws so what you change isn't lost. */
  private benchEditor: { id: string; node: HTMLElement } | null = null;
  /** After the next redraw, bring the schedule form into view. */
  private scrollToForm = false;
  private root = $("drawer");
  private body = $("drawer-body");

  constructor(
    private opts: {
      nameOf: (id: string) => string;
      /** Agents with a model (who can be @mentioned in projects). */
      agents: () => Occupant[];
      /** Everyone in the "waiting" state (for the inbox). */
      waiting: () => Occupant[];
      /** "Manager of Research", "Chairman", or null. */
      orgTitle: (id: string) => string | null;
      /** Whether someone is the chairman (their drawer opens the chairman's desk). */
      isChairman: (id: string) => boolean;
      openHeadquarters: () => void;
      /** "Research · desk 3", or null without a desk. */
      deskLabel: (id: string) => string | null;
      /** Lets you click a new desk for someone in the office. */
      pickDesk: (id: string) => void;
      /** Opens Settings at someone's model. */
      onBrain: (id: string) => void;
      roomOf: (o: Occupant) => string | null;
      onFocus: (id: string) => void;
      onChat: (id: string) => void;
      onToggle: (open: boolean) => void;
      unlock: () => Promise<void>;
      onSoul: (id: string) => void;
    },
  ) {
    const close = $("drawer-close");
    close.innerHTML = ICONS.close;
    close.addEventListener("click", () => this.close());
    this.body.addEventListener("compositionstart", () => (this.composing = true));
    this.body.addEventListener("compositionend", () => (this.composing = false));
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.id && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) this.close();
    });
  }

  get openId() {
    return this.id;
  }

  open(id: string) {
    const changed = this.id !== id || this.projectId !== null;
    this.id = id;
    this.projectId = null;
    this.project = null;
    this.inboxOpen = false;
    this.bench = false;
    if (changed) {
      this.data = null;
      this.tasks = null;
      this.openTask = null;
      this.draft = "";
      this.attach.clear();
      this.sendError = "";
      this.memory = null;
      this.memDraft = { memory: "", user: "" };
      this.memEdit = null;
      this.memError = "";
      this.recallQuery = "";
      this.recallHits = null;
      this.schedules = null;
      this.schedForm = null;
      this.schedError = "";
      this.body.replaceChildren(el("p", "ui-faint", t("drawer.loading")));
      this.body.scrollTop = 0;
    }
    this.root.classList.add("is-open");
    this.root.removeAttribute("inert");
    this.root.setAttribute("aria-hidden", "false");
    this.opts.onToggle(true);
    void this.load();
    if (this.timer === null) this.timer = window.setInterval(() => void this.load(), 5000);
  }

  /** Shows a project (or the form for a new one). */
  openProject(id: number | "new") {
    if (this.projectId !== id) {
      this.projectView.reset();
      this.project = null;
      this.body.replaceChildren(el("p", "ui-faint", t("drawer.loading")));
      this.body.scrollTop = 0;
    }
    this.id = null;
    this.data = null;
    this.inboxOpen = false;
    this.projectId = id;
    this.root.classList.add("is-open");
    this.root.removeAttribute("inert");
    this.root.setAttribute("aria-hidden", "false");
    this.opts.onToggle(true);
    void this.load();
    if (this.timer === null) this.timer = window.setInterval(() => void this.load(), 5000);
  }

  /** Shows someone's workstation: what they are set up with (clicking their computer opens this). */
  openWorkbench(id: string) {
    this.open(id);
    this.bench = true;
    if (this.benchEditor?.id !== id) this.benchEditor = null;
    this.render();
  }

  /** Shows the inbox. */
  openInbox() {
    if (!this.inboxOpen) {
      this.body.replaceChildren(el("p", "ui-faint", t("drawer.loading")));
      this.body.scrollTop = 0;
    }
    this.id = null;
    this.data = null;
    this.projectId = null;
    this.project = null;
    this.inboxOpen = true;
    this.root.classList.add("is-open");
    this.root.removeAttribute("inert");
    this.root.setAttribute("aria-hidden", "false");
    this.opts.onToggle(true);
    void this.load();
    if (this.timer === null) this.timer = window.setInterval(() => void this.load(), 5000);
  }

  /** Something in the inbox changed: reload it if it's shown. */
  inboxChanged() {
    if (this.inboxOpen) void this.load();
  }

  /** A project changed: reload it if it's the one shown. */
  projectChanged(id: number) {
    if (this.projectId === id) void this.load();
  }

  close() {
    if (!this.id && this.projectId === null && !this.inboxOpen) return;
    this.inboxOpen = false;
    this.id = null;
    this.projectId = null;
    this.project = null;
    this.root.classList.remove("is-open");
    this.root.setAttribute("inert", "");
    this.root.setAttribute("aria-hidden", "true");
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.opts.onToggle(false);
  }

  /** Opens someone's drawer at one of their tasks (a colleague's sub-task, or where a request came from). */
  jump(ref: { occupantId: string; taskId: number }) {
    this.open(ref.occupantId);
    this.openTask = ref.taskId;
    this.opts.onFocus(ref.occupantId);
  }

  /** Someone changed: redraw if it's who the drawer shows. */
  refresh(occupant?: Occupant) {
    if (!this.id || !this.data) return;
    if (occupant && occupant.id !== this.id) return;
    if (occupant) this.data.occupant = occupant;
    this.render();
  }

  /** A task of someone changed: reload if it's who the drawer shows. */
  taskChanged(occupantId: string) {
    if (occupantId === this.id) void this.loadTasks().then(() => this.render());
  }

  private async load() {
    if (this.inboxOpen) return this.loadInbox();
    if (this.projectId !== null) return this.loadProject();
    const id = this.id;
    if (!id) return;
    try {
      const res = await fetch(`/api/occupants/${encodeURIComponent(id)}/details`);
      if (this.id !== id) return;
      if (res.status === 404) return this.render(true);
      if (!res.ok) return;
      this.data = (await res.json()) as OccupantDetails;
      await Promise.all([this.loadTasks(), this.data.occupant.kind === "agent" ? this.loadMemory() : undefined, this.data.occupant.kind === "agent" ? this.loadSchedules() : undefined]);
      this.render();
    } catch {
      // Offline for a moment; the next tick tries again.
    }
  }

  private async loadInbox() {
    try {
      const res = await api<Inbox>("GET", "/api/inbox");
      if (!this.inboxOpen) return;
      this.inbox = res;
    } catch (err) {
      if (err instanceof Unauthorized) {
        await this.opts.unlock().catch(() => {});
        if (!tokenStore.get()) return this.close();
      }
      return;
    }
    this.render();
  }

  private async loadProject() {
    const pid = this.projectId;
    if (pid === null) return;
    if (pid !== "new") {
      try {
        const res = await api<ProjectDetails>("GET", `/api/projects/${pid}`);
        if (this.projectId !== pid) return;
        this.project = res;
      } catch (err) {
        if (err instanceof Unauthorized) {
          await this.opts.unlock().catch(() => {});
          if (!tokenStore.get()) return this.close();
        } else if (/404|no such/.test((err as Error).message)) return this.close();
        return;
      }
    }
    this.render();
  }

  private async loadTasks() {
    const id = this.id;
    if (!id) return;
    if (!tokenStore.get()) {
      this.tasks = "locked";
      return;
    }
    try {
      const res = await api<{ tasks: Task[] }>("GET", `/api/occupants/${encodeURIComponent(id)}/tasks`);
      if (this.id === id) this.tasks = res.tasks;
    } catch (err) {
      if (err instanceof Unauthorized) this.tasks = "locked";
    }
  }

  private async loadSchedules() {
    const id = this.id;
    if (!id) return;
    if (!tokenStore.get()) {
      this.schedules = "locked";
      return;
    }
    try {
      const res = await api<{ schedules: Schedule[] }>("GET", `/api/occupants/${encodeURIComponent(id)}/schedules`);
      if (this.id === id) this.schedules = res.schedules;
    } catch (err) {
      if (err instanceof Unauthorized) this.schedules = "locked";
    }
  }

  /** Any change to a schedule, then a fresh list (and tasks, since "Run now" adds one). */
  private async changeSchedule(fn: () => Promise<unknown>) {
    try {
      await fn();
      this.schedError = "";
      await Promise.all([this.loadSchedules(), this.loadTasks()]);
    } catch (err) {
      this.schedError = err instanceof Unauthorized ? t("drawer.unlockToGive") : (err as Error).message;
    }
    this.render();
  }

  private saveSchedule() {
    const form = this.schedForm;
    const id = this.id;
    if (!form || !id || !form.draft.prompt.trim()) return;
    const rule = ruleOf(form.draft);
    if (typeof rule === "string") {
      this.schedError = rule;
      return this.render();
    }
    const d = form.draft;
    const body = {
      prompt: d.prompt.trim(),
      rule,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      projectTitle: d.asProject ? d.projectTitle.trim() || d.prompt.trim().split("\n")[0].slice(0, 60) : null,
      projectBrief: d.asProject ? d.projectBrief : "",
    };
    void this.changeSchedule(async () => {
      if (form.id === null) await api("POST", `/api/occupants/${encodeURIComponent(id)}/schedules`, body);
      else await api("PUT", `/api/schedules/${form.id}`, body);
      this.schedForm = null;
    });
  }

  private async loadMemory() {
    const id = this.id;
    if (!id) return;
    if (!tokenStore.get()) {
      this.memory = "locked";
      return;
    }
    try {
      const res = await api<MemoryView>("GET", `/api/occupants/${encodeURIComponent(id)}/memory`);
      if (this.id === id) this.memory = res;
    } catch (err) {
      if (err instanceof Unauthorized) this.memory = "locked";
    }
  }

  /** Adds, edits or deletes an entry, then shows the result (or why it failed). */
  private async changeMemory(method: "POST" | "PUT" | "DELETE", path: string, body?: object) {
    const id = this.id;
    if (!id) return;
    try {
      const res = await api<MemoryView>(method, `/api/occupants/${encodeURIComponent(id)}/memory${path}`, body);
      if (this.id !== id) return;
      this.memory = res;
      this.memError = "";
      this.memEdit = null;
      if (method === "POST") this.memDraft[(body as { target: "memory" | "user" }).target] = "";
    } catch (err) {
      this.memError = err instanceof Unauthorized ? t("mem.unlock") : /full/.test((err as Error).message) ? t("mem.full") : (err as Error).message;
    }
    this.render();
  }

  private async searchPast(q: string) {
    const id = this.id;
    this.recallQuery = q;
    if (!id || !q.trim()) {
      this.recallHits = null;
      return this.render();
    }
    try {
      const res = await api<{ hits: RecallHit[] }>("GET", `/api/occupants/${encodeURIComponent(id)}/recall?q=${encodeURIComponent(q)}`);
      if (this.id === id && this.recallQuery === q) this.recallHits = res.hits;
    } catch {
      this.recallHits = [];
    }
    this.render();
  }

  private async send(prompt: string) {
    const id = this.id;
    if (!id || this.sending) return;
    this.sending = true;
    this.sendError = "";
    try {
      const res = await api<{ task: Task }>("POST", `/api/occupants/${encodeURIComponent(id)}/tasks`, { prompt, fileIds: this.attach.ids });
      this.draft = "";
      this.attach.clear();
      this.openTask = res.task.id;
      await this.loadTasks();
    } catch (err) {
      this.sendError = err instanceof Unauthorized ? t("drawer.unlockToGive") : (err as Error).message;
    } finally {
      this.sending = false;
      this.render();
    }
  }

  private render(gone = false) {
    // Fields keep their value in this.* as it changes, and say which they are (data-field), so a redraw
    // can put the cursor back where it was.
    const active = document.activeElement;
    const typing = (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || active instanceof HTMLSelectElement) && this.body.contains(active) ? active : null;
    const focus = typing && !(typing instanceof HTMLSelectElement) && typing.dataset.field ? { field: typing.dataset.field, start: typing.selectionStart, end: typing.selectionEnd } : null;
    // Only the search box redraws under the cursor (for live results), and never mid-IME composition.
    if (typing && (focus?.field !== "recall" || this.composing)) return;
    if (this.inboxOpen) {
      $("drawer-kind").textContent = t("inbox.title");
      const scroll = this.body.scrollTop;
      if (this.inbox) this.body.replaceChildren(this.inboxView.render(this.inbox));
      this.body.scrollTop = scroll;
      return;
    }
    if (this.projectId !== null) {
      $("drawer-kind").textContent = t("proj.kind");
      const scroll = this.body.scrollTop;
      const view = this.projectId === "new" ? this.projectView.renderNew() : this.project && this.projectView.render(this.project, (at) => relativeTime(at));
      if (view) this.body.replaceChildren(view);
      this.body.scrollTop = scroll;
      return;
    }
    const d = this.data;
    if (!d) return;
    const o = d.occupant;
    const look = LOOK[o.state];
    const view = el("div", `ui-drawer__view${gone ? " is-gone" : ""}`);
    $("drawer-kind").textContent = o.kind === "human" ? t("ui.human") : t("ui.agent");

    // Hero: avatar, name, job title, model, room.
    const hero = el("div", "ui-hero");
    const avatar = el("span", "ui-avatar ui-avatar--lg");
    const img = document.createElement("img");
    img.src = avatarCanvas(characterSeed(o.id), { scale: 3 }).toDataURL();
    img.alt = "";
    img.width = 60;
    img.height = 60;
    avatar.append(img);
    const text = el("div", "ui-hero__text");
    const line = el("div", "ui-hero__line");
    line.append(el("h2", "ui-hero__name", o.name));
    if (o.role) line.append(el("span", "ui-role ui-role--title", o.role));
    const title = this.opts.orgTitle(o.id);
    if (title) line.append(el("span", "ui-role ui-role--org", `★ ${title}`));
    text.append(line);
    if (o.model) {
      const model = el("div", "ui-hero__acc");
      model.append(el("span", "ui-faint", t("drawer.model")), el("span", "ui-hero__acc-name", prettyModel(o.model)));
      text.append(model);
    }
    const desk = this.opts.deskLabel(o.id);
    const deskRow = el("div", "ui-hero__where");
    const move = el("button", "ui-room-link", desk ?? t("desk.none"));
    move.type = "button";
    move.title = t("desk.move");
    move.addEventListener("click", () => this.opts.pickDesk(o.id));
    deskRow.append(el("span", "ui-faint", t("desk.title")), move);
    text.append(deskRow);
    const room = this.opts.roomOf(o);
    if (room) {
      const where = el("div", "ui-hero__where");
      const link = el("button", "ui-room-link", room);
      link.type = "button";
      link.addEventListener("click", () => this.opts.onFocus(o.id));
      where.append(el("span", "ui-faint", t("drawer.room")), link);
      text.append(where);
    }
    hero.append(avatar, text);
    view.append(hero);
    if (gone) view.append(el("p", "ui-gone", t("drawer.gone")));

    // Status and actions.
    const status = el("div", "ui-status");
    const label = el("span", "ui-status__label");
    label.append(el("span", `ui-status-dot ${look.dot}`), el("span", "ui-status__text", t(`state.${o.state}`)), el("span", "ui-status__since", relativeTime(Date.parse(o.updatedAt))));
    const actions = el("span", "ui-status__actions");
    const button = (text: string, fn: () => void) => {
      const b = el("button", "ui-btn", text);
      b.type = "button";
      b.addEventListener("click", fn);
      actions.append(b);
    };
    button(t("drawer.centre"), () => this.opts.onFocus(o.id));
    if (this.opts.isChairman(o.id)) button(`🏛 ${t("hq.title")}`, () => this.opts.openHeadquarters());
    if (o.model) button(t("chat.open"), () => this.opts.onChat(o.id));
    if (o.kind === "agent") button(this.bench ? t("bench.more") : t("desk.bench"), () => {
      this.bench = !this.bench;
      this.render();
    });
    status.append(label, actions);
    view.append(status);

    // Now.
    const now = section(t("drawer.now"));
    const box = el("div", "ui-now");
    const body = el("div", "ui-now__body");
    body.append(el("span", `ui-now__text${o.state === "error" ? " is-error" : ""}`, o.detail || t(`state.${o.state}`)), el("span", "ui-now__time", relativeTime(Date.parse(o.updatedAt))));
    box.append(el("span", "ui-now__icon", look.icon), body);
    now.append(box);
    view.append(now);

    if (o.kind === "agent" && this.bench) view.append(this.benchSection(o));
    else if (o.kind === "agent") view.append(this.workSection(o), this.scheduleSection(o), this.memorySection(o));

    // Timeline from the office's events.
    if (d.events.length) {
      const tl = section(t("drawer.timeline"), String(d.events.length));
      const list = el("ol", "ui-timeline");
      for (const e of d.events.slice(0, 30)) {
        const li = el("li", `ui-tl${e.state === "error" ? " is-error" : ""}`);
        const time = el("time", "ui-tl__time", relativeTime(Date.parse(e.at)));
        time.dateTime = e.at;
        li.append(el("span", "ui-tl__icon", LOOK[e.state as State].icon), el("span", "ui-tl__text", e.detail || t(`state.${e.state}`)), time);
        list.append(li);
      }
      tl.append(list);
      view.append(tl);
    }

    this.body.replaceChildren(view);
    if (this.scrollToForm && this.schedForm) {
      this.scrollToForm = false;
      this.body.querySelector(".ui-sched__form")?.scrollIntoView({ block: "center" });
    }
    if (focus) {
      const next = this.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${focus.field}"]`);
      next?.focus({ preventScroll: true });
      if (next && focus.start !== null) next.setSelectionRange(focus.start, focus.end);
    }
  }

  /**
   * The workstation: desk, model, and the job title, soul and skills editor. Skills belong to the person,
   * not the computer, so moving desks keeps them.
   */
  private benchSection(o: Occupant) {
    const sec = section(t("bench.title"));
    sec.append(el("p", "ui-faint ui-small", t("bench.intro")));
    const rows = el("div", "ui-bench__rows");
    const row = (label: string, value: string, action: string, fn: () => void) => {
      const r = el("div", "ui-bench__row");
      const b = el("button", "ui-btn ui-btn--sm", action);
      b.type = "button";
      b.addEventListener("click", fn);
      r.append(el("span", "ui-faint", label), el("span", "ui-bench__value", value), b);
      rows.append(r);
    };
    row(t("desk.title"), this.opts.deskLabel(o.id) ?? t("desk.none"), t("desk.move"), () => this.opts.pickDesk(o.id));
    row(t("bench.model"), o.model ? prettyModel(o.model) : t("bench.noModel"), t("bench.changeModel"), () => this.opts.onBrain(o.id));
    sec.append(rows);
    if (!tokenStore.get()) {
      const unlock = el("button", "ui-btn", t("drawer.unlock"));
      unlock.type = "button";
      unlock.addEventListener("click", () => void this.opts.unlock().then(() => this.render()));
      sec.append(unlock);
      return sec;
    }
    if (this.benchEditor?.id !== o.id) {
      const guard = async <T,>(status: Element | null, fn: () => Promise<T>) => {
        try {
          return await fn();
        } catch (err) {
          if (status) {
            status.textContent = (err as Error).message;
            status.className = "status status--error";
          }
          return undefined;
        }
      };
      const node = soulEditor(o, guard, () => api<{ skills: Skill[] }>("GET", "/api/skills").then((r) => r.skills));
      node.classList.add("ui-bench__editor");
      this.benchEditor = { id: o.id, node };
    }
    sec.append(this.benchEditor.node);
    return sec;
  }

  /** Giving work and what it delivered. */
  private workSection(o: Occupant) {
    const tasks = this.tasks;
    const list = Array.isArray(tasks) ? tasks : [];
    const done = list.filter((x) => x.status === "done").length;
    const sec = section(t("drawer.tasks"), list.length ? `${done}/${list.length}` : undefined);

    if (tasks === "locked") {
      const unlock = el("button", "ui-btn", t("drawer.unlock"));
      unlock.type = "button";
      unlock.addEventListener("click", () => void this.opts.unlock().then(() => this.load()));
      sec.append(el("p", "ui-faint ui-small", t("drawer.unlockToGive")), unlock);
      return sec;
    }

    // Composer.
    if (!o.model) sec.append(el("p", "ui-faint ui-small", t("drawer.needModel")));
    else {
      const form = el("form", "ui-composer");
      const input = el("textarea", "ui-composer__input");
      input.rows = 3;
      input.maxLength = 8000;
      input.placeholder = t("drawer.taskPlaceholder", { name: o.name });
      input.value = this.draft;
      input.dataset.field = "task";
      input.addEventListener("input", () => (this.draft = input.value));
      const send = el("button", "ui-btn ui-btn--primary", this.sending ? t("drawer.sending") : t("drawer.give"));
      send.type = "submit";
      send.disabled = this.sending || this.attach.busy > 0;
      const buttons = el("div", "ui-composer__buttons");
      buttons.append(this.attach.button(), send);
      form.append(input, buttons);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const prompt = input.value.trim();
        if (prompt) {
          input.blur();
          void this.send(prompt);
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
      });
      sec.append(form);
      if (this.attach.files.length || this.attach.error) sec.append(this.attach.chips());
      if (this.sendError) sec.append(el("p", "ui-error ui-small", this.sendError));
    }

    // Tasks, newest first; the open one shows its steps and its delivery.
    const ul = el("ul", "ui-taskcards");
    for (const task of list) ul.append(this.taskCard(task));
    if (list.length) sec.append(ul);
    else if (o.model) sec.append(el("p", "ui-faint ui-small", t("drawer.noTasks")));
    return sec;
  }

  /** Tasks it does by itself on a schedule, and the form to add or change one. */
  private scheduleSection(o: Occupant) {
    const list = this.schedules;
    const sec = section(t("sched.title"), Array.isArray(list) && list.length ? String(list.filter((x) => x.enabled).length) : undefined);
    if (list === "locked") {
      sec.append(el("p", "ui-faint ui-small", t("drawer.unlockToGive")));
      return sec;
    }
    if (!list) return sec;
    if (list.length) {
      const ul = el("ul", "ui-sched__list");
      for (const s of list) ul.append(this.scheduleItem(s));
      sec.append(ul);
    } else if (!this.schedForm) sec.append(el("p", "ui-faint ui-small", t("sched.empty")));
    if (this.schedForm) sec.append(this.scheduleForm(o, this.schedForm));
    else if (o.model) {
      const add = el("button", "ui-btn", `＋ ${t("sched.new")}`);
      add.type = "button";
      add.addEventListener("click", () => {
        this.schedForm = { id: null, draft: draftOf() };
        this.render();
      });
      sec.append(add);
    } else sec.append(el("p", "ui-faint ui-small", t("drawer.needModel")));
    if (this.schedError) sec.append(el("p", "ui-error ui-small", this.schedError));
    return sec;
  }

  private scheduleItem(s: Schedule) {
    const li = el("li", `ui-sched${s.enabled ? "" : " is-paused"}`);
    const head = el("div", "ui-sched__head");
    head.append(el("span", "ui-sched__icon", s.enabled ? (s.projectTitle ? "📋" : "⏰") : "⏸️"), el("span", "ui-sched__title", s.title));
    const when = el("div", "ui-sched__when");
    const status =
      s.enabled && s.nextRunAt
        ? t("sched.next", { when: `${relativeTime(Date.parse(s.nextRunAt))} · ${shortDateTime(s.nextRunAt)}` })
        : s.rule.type === "once" && s.lastRunAt
          ? t("sched.finished")
          : t("sched.paused");
    when.append(el("span", "ui-sched__rule", describeRule(s.rule)), el("span", "", status));
    if (s.lastRunAt) when.append(el("span", "ui-faint", t("sched.lastRun", { when: relativeTime(Date.parse(s.lastRunAt)) })));
    const actions = el("div", "ui-sched__actions");
    const button = (text: string, fn: () => void, primary = false) => {
      const b = el("button", `ui-btn ui-btn--sm${primary ? " ui-btn--primary" : ""}`, text);
      b.type = "button";
      b.addEventListener("click", fn);
      actions.append(b);
    };
    button(t("sched.runNow"), () => void this.changeSchedule(() => api("POST", `/api/schedules/${s.id}/run`)));
    if (s.enabled) button(t("sched.pause"), () => void this.changeSchedule(() => api("PUT", `/api/schedules/${s.id}`, { enabled: false })));
    else if (s.rule.type !== "once" || !s.lastRunAt) button(t("sched.resume"), () => void this.changeSchedule(() => api("PUT", `/api/schedules/${s.id}`, { enabled: true })));
    button(t("sched.edit"), () => {
      this.schedForm = { id: s.id, draft: draftOf(s) };
      this.render();
    });
    button(t("sched.delete"), () => void this.changeSchedule(() => api("DELETE", `/api/schedules/${s.id}`)));
    li.append(head, when, actions);
    return li;
  }

  private scheduleForm(o: Occupant, form: { id: number | null; draft: ScheduleDraft }) {
    const d = form.draft;
    const box = el("form", "ui-sched__form");
    const prompt = el("textarea", "ui-composer__input");
    prompt.rows = 3;
    prompt.maxLength = 8000;
    prompt.placeholder = t("sched.prompt", { name: o.name });
    prompt.value = d.prompt;
    prompt.dataset.field = "sched-prompt";
    prompt.addEventListener("input", () => (d.prompt = prompt.value));
    box.append(prompt);

    // Start a project each time: a name, and @mentions in the message assign the members.
    const asProject = el("label", "ui-sched__check");
    const check = el("input");
    check.type = "checkbox";
    check.checked = d.asProject;
    check.addEventListener("change", () => {
      d.asProject = check.checked;
      check.blur();
      this.render();
    });
    asProject.append(check, el("span", "", t("sched.asProject")));
    box.prepend(asProject);
    if (d.asProject) {
      prompt.placeholder = t("sched.projectPrompt");
      const name = el("input", "ui-mem__input");
      name.maxLength = 60;
      name.placeholder = t("sched.projectName");
      name.value = d.projectTitle;
      name.addEventListener("input", () => (d.projectTitle = name.value));
      prompt.before(name);
      prompt.after(mentionChips(this.opts.agents(), prompt, (v) => (d.prompt = v)));
    }

    const row = el("div", "ui-sched__row");
    const repeat = el("select", "ui-sched__select");
    for (const r of ["daily", "weekdays", "weekly", "interval", "once"] as const) repeat.append(new Option(t(`sched.${r}`), r, false, d.repeat === r));
    repeat.addEventListener("change", () => {
      d.repeat = repeat.value as Repeat;
      repeat.blur();
      this.render();
    });
    row.append(repeat);
    if (d.repeat === "interval") {
      const hours = el("input", "ui-mem__input ui-sched__num");
      hours.type = "number";
      hours.min = "1";
      hours.max = "168";
      hours.value = String(d.hours);
      hours.addEventListener("input", () => (d.hours = Number(hours.value)));
      row.append(hours, el("span", "ui-faint ui-small", t("sched.hours")));
    } else if (d.repeat === "once") {
      const at = el("input", "ui-mem__input");
      at.type = "datetime-local";
      at.value = d.at;
      at.addEventListener("input", () => (d.at = at.value));
      row.append(at);
    } else {
      const time = el("input", "ui-mem__input ui-sched__time");
      time.type = "time";
      time.value = d.time;
      time.addEventListener("input", () => (d.time = time.value));
      row.append(time);
    }
    box.append(row);

    if (d.repeat === "weekly") {
      const days = el("div", "ui-sched__days");
      for (const day of [1, 2, 3, 4, 5, 6, 0]) {
        const chip = el("button", `ui-sched__day${d.days.includes(day) ? " is-on" : ""}`, dayName(day));
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(d.days.includes(day)));
        chip.addEventListener("click", () => {
          d.days = d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day];
          this.render();
        });
        days.append(chip);
      }
      box.append(days);
    }

    const actions = el("div", "ui-sched__actions is-shown");
    const save = el("button", "ui-btn ui-btn--sm ui-btn--primary", t("sched.save"));
    save.type = "submit";
    const cancel = el("button", "ui-btn ui-btn--sm", t("sched.cancel"));
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      this.schedForm = null;
      this.schedError = "";
      this.render();
    });
    actions.append(save, cancel, el("span", "ui-faint ui-small", t("sched.tz", { tz: Intl.DateTimeFormat().resolvedOptions().timeZone })));
    box.append(actions);
    box.addEventListener("submit", (e) => {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      this.saveSchedule();
    });
    return box;
  }

  /**
   * The layered memory: what the agent keeps in mind (its notes, and the profile of you everyone shares),
   * with how full each is; searching its past work; and a line on where skills fit in.
   */
  private memorySection(o: Occupant) {
    const mem = this.memory;
    const sec = section(t("mem.title"), mem && mem !== "locked" ? String(mem.entries.length) : undefined);
    if (mem === "locked") {
      sec.append(el("p", "ui-faint ui-small", t("mem.unlock")));
      return sec;
    }
    if (!mem) return sec;
    sec.append(el("p", "ui-faint ui-small ui-mem__intro", t("mem.layers")));
    for (const target of ["memory", "user"] as const) sec.append(this.memoryBlock(o, mem, target));
    if (this.memError) sec.append(el("p", "ui-error ui-small", this.memError));

    // Looking back through past tasks and chats.
    const past = el("div", "ui-mem__block");
    past.append(el("div", "ui-mem__head", t("mem.recall")));
    const form = el("form", "ui-mem__add");
    const input = el("input", "ui-mem__input");
    input.type = "search";
    input.placeholder = t("mem.recallPlaceholder");
    input.value = this.recallQuery;
    input.dataset.field = "recall";
    let debounce = 0;
    input.addEventListener("input", () => {
      this.recallQuery = input.value;
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void this.searchPast(input.value), 350);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      input.blur();
      void this.searchPast(input.value);
    });
    form.append(input);
    past.append(form);
    if (this.recallHits) {
      if (!this.recallHits.length) past.append(el("p", "ui-faint ui-small", t("mem.noHits")));
      const ul = el("ul", "ui-mem__hits");
      for (const h of this.recallHits) {
        const li = el("li", "ui-mem__hit");
        const meta = el("div", "ui-mem__meta");
        meta.append(el("span", "", `${h.kind === "task" ? "✅" : "💬"} ${t(h.kind === "task" ? "mem.task" : "mem.chat")}`), el("span", "", relativeTime(Date.parse(h.at))));
        const text = el("p", "ui-mem__snippet");
        // «…» marks the matched words.
        for (const [i, part] of h.snippet.split(/[«»]/).entries()) text.append(i % 2 ? el("mark", "", part) : document.createTextNode(part));
        li.append(meta, text);
        if (h.kind === "task" && Array.isArray(this.tasks) && this.tasks.some((x) => x.id === h.ref)) {
          li.classList.add("is-link");
          li.addEventListener("click", () => {
            this.openTask = h.ref;
            this.render();
            this.body.querySelector(".ui-taskcard.is-open")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          });
        }
        ul.append(li);
      }
      past.append(ul);
    }
    sec.append(past);
    return sec;
  }

  private memoryBlock(o: Occupant, mem: MemoryView, target: MemoryEntry["target"]) {
    const block = el("div", "ui-mem__block");
    const head = el("div", "ui-mem__head");
    const used = mem.usage[target];
    const limit = mem.limits[target];
    const bar = el("span", `ui-progress ui-mem__bar${used / limit > 0.85 ? " is-full" : ""}`);
    bar.style.setProperty("--p", `${Math.min(100, (used / limit) * 100)}%`);
    bar.append(el("span", "ui-progress__fill"));
    head.append(el("span", "", t(target === "memory" ? "mem.mine" : "mem.user", { name: o.name })), el("span", "ui-mem__count", `${used.toLocaleString()} / ${limit.toLocaleString()}`));
    block.append(head, bar);

    const entries = mem.entries.filter((e) => e.target === target);
    const ul = el("ul", "ui-mem__list");
    for (const e of entries) {
      const li = el("li", `ui-mem__entry is-${e.source}`);
      if (this.memEdit?.id === e.id) {
        const edit = this.memEdit;
        const area = el("textarea", "ui-mem__input");
        area.rows = 2;
        area.maxLength = 400;
        area.value = edit.text;
        area.dataset.field = `edit-${e.id}`;
        area.addEventListener("input", () => (edit.text = area.value));
        const save = el("button", "ui-btn ui-btn--sm ui-btn--primary", t("mem.save"));
        save.type = "button";
        save.addEventListener("click", () => {
          area.blur();
          if (edit.text.trim()) void this.changeMemory("PUT", `/${e.id}`, { text: edit.text });
        });
        const cancel = el("button", "ui-btn ui-btn--sm", t("mem.cancel"));
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          this.memEdit = null;
          this.render();
        });
        const row = el("div", "ui-mem__actions");
        row.append(save, cancel);
        li.append(area, row);
      } else {
        const badge = el("span", "ui-mem__who", e.source === "you" ? "✍️" : "🤖");
        badge.title = e.source === "you" ? t("mem.byYou") : t("mem.byAgent", { name: o.name });
        const row = el("div", "ui-mem__actions");
        const edit = el("button", "ui-btn ui-btn--sm", t("mem.edit"));
        edit.type = "button";
        edit.addEventListener("click", () => {
          this.memEdit = { id: e.id, text: e.text };
          this.render();
        });
        const del = el("button", "ui-btn ui-btn--sm", t("mem.delete"));
        del.type = "button";
        del.addEventListener("click", () => void this.changeMemory("DELETE", `/${e.id}`));
        row.append(edit, del);
        li.append(badge, el("span", "ui-mem__text", e.text), row);
      }
      ul.append(li);
    }
    if (entries.length) block.append(ul);
    else if (target === "memory") block.append(el("p", "ui-faint ui-small", t("mem.empty")));

    const form = el("form", "ui-mem__add");
    const input = el("input", "ui-mem__input");
    input.maxLength = 400;
    input.placeholder = target === "memory" ? t("mem.addMine", { name: o.name }) : t("mem.addUser");
    input.value = this.memDraft[target];
    input.dataset.field = `add-${target}`;
    input.addEventListener("input", () => (this.memDraft[target] = input.value));
    const add = el("button", "ui-btn ui-btn--sm", t("mem.add"));
    add.type = "submit";
    form.append(input, add);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.blur();
      void this.changeMemory("POST", "", { target, text });
    });
    block.append(form);
    return block;
  }

  /** Accept a delivery, or send it back with a reason (it goes into the agent's memory, and it tries again). */
  private reviewBox(task: Task) {
    const box = el("div", "ui-review");
    if (task.review === "accepted") {
      box.append(el("span", "ui-review__done", t("review.accepted")));
      return box;
    }
    if (task.review === "rejected") {
      box.append(el("span", "ui-review__back", t("review.rejected", { note: task.reviewNote || "—" })));
      return box;
    }
    const send = (verdict: "accepted" | "rejected", note = "") =>
      void api("POST", `/api/tasks/${task.id}/review`, { verdict, note })
        .then(() => {
          this.rejecting = null;
          return this.loadTasks();
        })
        .catch((err: Error) => (this.sendError = err.message))
        .finally(() => this.render());
    if (this.rejecting?.id === task.id) {
      const reason = this.rejecting;
      const input = el("textarea", "ui-mem__input");
      input.rows = 2;
      input.maxLength = 2000;
      input.placeholder = t("review.reasonPlaceholder");
      input.value = reason.note;
      input.dataset.field = `reject-${task.id}`;
      input.addEventListener("input", () => (reason.note = input.value));
      const ok = el("button", "ui-btn ui-btn--sm ui-btn--primary", t("review.send"));
      ok.type = "button";
      ok.addEventListener("click", () => {
        input.blur();
        send("rejected", reason.note.trim());
      });
      const cancel = el("button", "ui-btn ui-btn--sm", t("sched.cancel"));
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        this.rejecting = null;
        this.render();
      });
      const row = el("div", "ui-review__row");
      row.append(ok, cancel);
      box.append(input, row);
      return box;
    }
    const accept = el("button", "ui-btn ui-btn--sm", `👍 ${t("review.accept")}`);
    accept.type = "button";
    accept.addEventListener("click", () => send("accepted"));
    const reject = el("button", "ui-btn ui-btn--sm", `↩ ${t("review.reject")}`);
    reject.type = "button";
    reject.addEventListener("click", () => {
      this.rejecting = { id: task.id, note: "" };
      this.render();
    });
    const row = el("div", "ui-review__row");
    row.append(accept, reject);
    box.append(row);
    return box;
  }

  private taskCard(task: Task) {
    const open = this.openTask === task.id || task.status === "running";
    const li = el("li", `ui-taskcard is-${task.status}${open ? " is-open" : ""}`);
    const head = el("button", "ui-taskcard__head");
    head.type = "button";
    const when = task.finishedAt ?? task.startedAt ?? task.createdAt;
    const badge = task.kind === "ask" ? "🙋 " : task.kind === "delegate" ? "🤝 " : task.kind === "project" ? "📋 " : task.scheduleId !== null ? "⏰ " : "";
    head.append(el("span", "ui-taskcard__icon", TASK_ICON[task.status]), el("span", "ui-taskcard__title", `${badge}${task.title}`), el("span", "ui-taskcard__time", `${t(`task.${task.status}`)} · ${relativeTime(Date.parse(when))}`));
    head.addEventListener("click", () => {
      this.openTask = this.openTask === task.id ? null : task.id;
      this.render();
    });
    li.append(head);
    if (!open) return li;

    const body = el("div", "ui-taskcard__body");
    if (task.requestedBy && task.parentTaskId !== null) {
      const ref = { occupantId: task.requestedBy, taskId: task.parentTaskId };
      const from = el("button", "ui-taskcard__from", `${t(task.kind === "ask" ? "collab.askFrom" : "collab.delegateFrom", { name: this.opts.nameOf(task.requestedBy) })} → ${t("collab.open")}`);
      from.type = "button";
      from.addEventListener("click", () => this.jump(ref));
      body.append(from);
    }
    if (task.kind === "project" && task.projectId !== null) {
      const pid = task.projectId;
      const link = el("button", "ui-taskcard__from", `📋 ${t("proj.open")} →`);
      link.type = "button";
      link.addEventListener("click", () => this.openProject(pid));
      body.append(link);
    }
    if (task.prompt !== task.title && task.kind === "task") body.append(el("p", "ui-taskcard__prompt", task.prompt));
    if (task.steps.length) {
      const steps = el("ol", "ui-timeline ui-taskcard__steps");
      for (const s of task.steps) {
        const li = el("li", `ui-tl${s.ref ? " is-link" : ""}`);
        li.append(el("span", "ui-tl__icon", STEP_ICON[s.kind] ?? "•"), el("span", "ui-tl__text", s.text), el("time", "ui-tl__time", relativeTime(Date.parse(s.at))));
        const ref = s.ref;
        if (ref) {
          li.tabIndex = 0;
          li.setAttribute("role", "link");
          li.addEventListener("click", () => this.jump(ref));
          li.addEventListener("keydown", (e) => e.key === "Enter" && this.jump(ref));
        }
        steps.append(li);
      }
      body.append(steps);
    }
    if (task.status === "done" && task.result) {
      const result = el("div", "ui-taskcard__result");
      result.append(renderMarkdown(task.result), taskFiles(task.id, `${task.status}:${task.finishedAt ?? ""}`), taskCost(task.id, `${task.status}:${task.finishedAt ?? ""}`));
      const copy = el("button", "ui-btn ui-btn--sm", t("drawer.copy"));
      copy.type = "button";
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(task.result).then(() => (copy.textContent = t("drawer.copied")));
      });
      const actions = el("div", "ui-taskcard__actions");
      actions.append(copy);
      if (task.scheduleId === null && task.kind === "task") {
        const repeat = el("button", "ui-btn ui-btn--sm", `⏰ ${t("sched.fromTask")}`);
        repeat.type = "button";
        repeat.addEventListener("click", () => {
          this.schedForm = { id: null, draft: draftOf({ prompt: task.prompt, rule: { type: "weekly", time: "09:00", days: WEEKDAYS } }) };
          this.render();
          this.body.querySelector(".ui-sched__form")?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
        actions.append(repeat);
      }
      body.append(result, actions);
      if (task.kind === "task") body.append(this.reviewBox(task));
    }
    if (task.status === "failed") body.append(el("p", "ui-error ui-small", task.error));
    if (task.status === "queued" || task.status === "running") {
      const cancel = el("button", "ui-btn ui-btn--sm", t("drawer.cancel"));
      cancel.type = "button";
      cancel.addEventListener("click", () => void api("POST", `/api/tasks/${task.id}/cancel`).then(() => this.loadTasks().then(() => this.render())));
      body.append(cancel);
    }
    li.append(body);
    return li;
  }
}
