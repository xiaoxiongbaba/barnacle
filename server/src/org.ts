import { reportModel } from "./costs.js";
import { chat } from "./ai.js";
import type { Ceo } from "./ceo.js";
import type { Handoff, TaskRunner } from "./agents.js";
import { chairs, roomAt } from "./desks.js";
import { EXECUTIVE_ROOMS, type Floor } from "./floor.js";
import { nextRun } from "./schedule.js";
import type { Settings } from "./settings.js";
import type { Change, Report, Store, Task } from "./store.js";

/**
 * The company: every work room is a department, and a department may have a manager (one of its agents)
 * who writes a daily report from what actually happened (finished, failed and open tasks, deliveries
 * you haven't checked, approvals waiting, projects that moved). Reports go up to the chairman (you); a
 * department without a manager gets the same report counted by the office, without a model.
 */

type Org = Settings["org"];
type Lang = Org["language"];

const TICK_MS = 30_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/[#>*_`|]+/g, " ").replace(/\s+/g, " ").trim();
const withoutThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();

const HEADINGS: Record<Lang, { done: string; open: string; risks: string; decide: string; nothing: string; none: string; counted: string }> = {
  "zh-Hant": { done: "今日完成", open: "進行中", risks: "問題與風險", decide: "需要上級決定", nothing: "這段時間沒有進展。", none: "無", counted: "（未設部門經理，由辦公室自動統計）" },
  en: { done: "Done", open: "In progress", risks: "Problems and risks", decide: "Needs a decision", nothing: "Nothing happened in this period.", none: "None", counted: "(No manager: counted by the office.)" },
  ja: { done: "完了", open: "進行中", risks: "課題とリスク", decide: "判断が必要", nothing: "この期間の進捗はありません。", none: "なし", counted: "（部門長なし：オフィスが自動集計）" },
};
const LANGUAGE_NAMES: Record<Lang, string> = { "zh-Hant": "Traditional Chinese", en: "English", ja: "Japanese" };

export interface Department {
  room: Floor["rooms"][number];
  manager: string | null;
  members: string[];
}

/** What a report is built from: ids, so every line can be traced. */
interface Facts {
  done: number[];
  failed: number[];
  open: number[];
  unchecked: number[];
  approvals: number[];
  projects: number[];
}

export interface OrgDeps {
  store: Store;
  tasks: TaskRunner;
  floor: () => Floor;
  org: () => Org;
  saveOrg: (patch: Partial<Org>) => void;
  publish: (change: Change) => void;
  handoff: (h: Handoff) => void;
  /** Tells the pages a report was made (room and id only). */
  notify: (report: Report) => void;
  log: (message: string) => void;
}

export class Organization {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** The CEO (made after the organization): sums up the departments' reports. */
  ceo: Ceo | null = null;
  /** A line on what a department (or the company) spent in a period, if anything (see costs.ts). */
  spendLine: ((scope: string, since: string, until: string) => string | null) | null = null;

  constructor(private deps: OrgDeps) {}

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Work rooms (with desks), outside the executive offices, with their manager and the people sitting there. */
  departments(): Department[] {
    const floor = this.deps.floor();
    const org = this.deps.org();
    const seats = chairs(floor);
    return floor.rooms
      .filter((r) => !EXECUTIVE_ROOMS.includes(r.id) && seats.some((c) => roomAt(floor, c)?.id === r.id))
      .map((room) => {
        const members = Object.entries(floor.desks)
          .filter(([, t]) => roomAt(floor, t)?.id === room.id)
          .map(([id]) => id)
          .filter((id) => this.deps.store.exists(id));
        const manager = org.managers[room.id];
        return { room, members, manager: manager && members.includes(manager) ? manager : null };
      });
  }

  /** Makes the reports when their time has come (and remembers when, so the next ones start there). */
  private async tick(now = new Date()) {
    const org = this.deps.org();
    if (!org.enabled || this.running) return;
    if (!org.lastReportAt) return this.deps.saveOrg({ lastReportAt: now.toISOString() });
    const due = nextRun({ type: "weekly", time: org.reportTime, days: org.reportDays }, org.timeZone, new Date(org.lastReportAt));
    if (due && due <= now) await this.runAll(now);
  }

  /** Every department's report for the time since the last ones. */
  async runAll(now = new Date()): Promise<Report[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const org = this.deps.org();
      const since = org.lastReportAt ?? new Date(now.getTime() - 24 * 3600_000).toISOString();
      this.deps.saveOrg({ lastReportAt: now.toISOString() });
      const made: Report[] = [];
      for (const d of this.departments()) {
        const r = await this.report(d, since, now.toISOString());
        if (r) made.push(r);
      }
      const company = await this.ceo?.companyReport(made, since, now.toISOString());
      if (company) made.push(company);
      return made;
    } finally {
      this.running = false;
    }
  }

  /** One department's report now (for the time since its last one, or the last 24 hours). */
  async runOne(roomId: string, now = new Date()): Promise<Report | null> {
    const d = this.departments().find((x) => x.room.id === roomId);
    if (!d) return null;
    const last = this.deps.store.reports({ roomId, limit: 1 })[0];
    return this.report(d, last?.periodEnd ?? new Date(now.getTime() - 24 * 3600_000).toISOString(), now.toISOString());
  }

  /** What happened in a department in a period. */
  facts(d: Department, since: string, until: string): { facts: Facts; tasks: Map<number, Task> } {
    const { store } = this.deps;
    const tasks = store.tasksBetween(d.members, since, until);
    const finished = tasks.filter((t) => t.finishedAt && t.finishedAt >= since);
    const facts: Facts = {
      done: finished.filter((t) => t.status === "done").map((t) => t.id),
      failed: finished.filter((t) => t.status === "failed").map((t) => t.id),
      open: tasks.filter((t) => t.status === "queued" || t.status === "running").map((t) => t.id),
      unchecked: store
        .deliveries({ status: "pending", limit: 500 })
        .filter((t) => d.members.includes(t.occupantId))
        .map((t) => t.id),
      approvals: store
        .approvals("pending")
        .filter((a) => d.members.includes(a.occupantId))
        .map((a) => a.id),
      projects: store
        .projects()
        .filter((p) => p.members.some((m) => d.members.includes(m)) && p.updatedAt >= since)
        .map((p) => p.id),
    };
    const all = new Map<number, Task>(tasks.map((t) => [t.id, t]));
    for (const id of facts.unchecked) if (!all.has(id)) all.set(id, store.task(id)!);
    return { facts, tasks: all };
  }

  /** Writes (manager) or counts (no manager) a department's report, stores it and sends it up. */
  private async report(d: Department, since: string, until: string): Promise<Report | null> {
    const { store } = this.deps;
    const org = this.deps.org();
    const lang = org.language;
    const h = HEADINGS[lang] ?? HEADINGS.en;
    const { facts, tasks } = this.facts(d, since, until);
    const name = (id: string) => store.occupant(id)?.name ?? id;
    const line = (id: number) => {
      const t = tasks.get(id) ?? store.task(id);
      if (!t) return `[#${id}]`;
      const tail = t.status === "failed" ? t.error : t.result;
      return `[#${t.id}] ${name(t.occupantId)}: ${t.title}${tail ? ` — ${clip(oneLine(tail), 240)}` : ""}${t.review === "accepted" ? " (accepted)" : t.review === "rejected" ? " (sent back)" : ""}`;
    };
    const projects = facts.projects.map((id) => store.project(id)).filter((p) => p !== undefined);
    const quiet = !facts.done.length && !facts.failed.length && !facts.open.length && !facts.unchecked.length && !facts.approvals.length && !projects.length;

    let content = "";
    const manager = d.manager;
    const brain = manager ? store.brain(manager) : undefined;
    const provider = brain && store.providerConfig(brain.providerId);
    if (manager && brain && provider && !quiet) {
      // The manager writes it, from the facts only.
      const occupant = store.occupant(manager);
      const idle = occupant?.state === "idle" || occupant?.state === "offline";
      if (idle) this.deps.publish(store.report(manager, { state: "writing", detail: `📊 ${d.room.name}` }));
      const role = store.soul(manager).role;
      const factsText = [
        `Department: ${d.room.name} (members: ${d.members.map((m) => `${name(m)}${store.soul(m).role ? ` — ${store.soul(m).role}` : ""}`).join(", ") || "none"})`,
        `Period: ${since} to ${until}`,
        `Model spending: ${this.spendLine?.(d.room.id, since, until) ?? "none"}`,
        `Finished:\n${facts.done.map(line).join("\n") || "none"}`,
        `Failed:\n${facts.failed.map(line).join("\n") || "none"}`,
        `Still open (queued or running):\n${facts.open.map(line).join("\n") || "none"}`,
        `Deliveries the chairman hasn't checked yet: ${facts.unchecked.length ? facts.unchecked.map((id) => `[#${id}]`).join(" ") : "none"}`,
        `Approvals waiting for the chairman: ${facts.approvals.length ? facts.approvals.map((id) => store.approval(id)?.summary ?? `#${id}`).join("; ") : "none"}`,
        `Projects that moved:\n${projects.map((p) => `[project #${p.id}] ${p.title} (${p.status}${p.needsYou ? ", waiting for the chairman" : ""})${p.summary ? ` — ${clip(oneLine(p.summary), 240)}` : ""}`).join("\n") || "none"}`,
      ].join("\n\n");
      const system = [
        `You are ${occupant?.name ?? manager}${role ? `, ${role},` : ""} the manager of the ${d.room.name} department. Write the department's report for this period, for the chairman.`,
        "Use only the facts you are given. Never invent progress, numbers, results or links. Mention items with their ids as given ([#12], [project #3]) so the chairman can open them.",
        `Use exactly these Markdown sections: "## ${h.done}", "## ${h.open}", "## ${h.risks}", "## ${h.decide}". One short line per item; group related items; write "${h.none}" in a section with nothing in it.`,
        `Under "${h.risks}": failures, things that are stuck or waiting too long. Under "${h.decide}": approvals, deliveries not yet checked, projects waiting for the chairman, and any decision you need.`,
        `Start with one sentence summing up the period. Write in ${LANGUAGE_NAMES[lang] ?? "English"}.`,
      ].join("\n");
      try {
        content = withoutThinking(
          await chat(provider, {
            model: reportModel(brain),
            tag: { occupantId: manager, kind: "report" },
            system,
            maxTokens: Math.max(brain.maxTokens, 2048),
            messages: [{ role: "user", content: factsText }],
            signal: AbortSignal.timeout(180_000),
            onText: () => {},
          }),
        );
      } catch (error) {
        this.deps.log(`Report for ${d.room.id} by ${manager} failed: ${(error as Error).message}`);
      } finally {
        if (idle) this.deps.publish(store.report(manager, { state: "idle" }));
      }
    }
    if (!content) {
      // Counted by the office: the same sections, straight from the records.
      const list = (ids: number[]) => (ids.length ? ids.map((id) => `- ${line(id)}`).join("\n") : `- ${h.none}`);
      const decide = [
        ...facts.approvals.map((id) => `- ✋ ${store.approval(id)?.summary ?? `#${id}`}`),
        ...(facts.unchecked.length ? [`- 📦 ${facts.unchecked.map((id) => `[#${id}]`).join(" ")}`] : []),
        ...projects.filter((p) => p.needsYou).map((p) => `- 📋 [project #${p.id}] ${p.title}`),
      ];
      content = quiet
        ? h.nothing
        : [
            manager ? "" : h.counted,
            `## ${h.done}\n${list(facts.done)}`,
            `## ${h.open}\n${list(facts.open)}`,
            `## ${h.risks}\n${list(facts.failed)}`,
            `## ${h.decide}\n${decide.join("\n") || `- ${h.none}`}`,
          ]
            .filter(Boolean)
            .join("\n\n");
    }
    const spend = this.spendLine?.(d.room.id, since, until);
    if (spend && content) content = `${content.trim()}\n\n${spend}`;
    const report = store.addReport({ roomId: d.room.id, author: manager && content && !quiet ? manager : null, periodStart: since, periodEnd: until, content, facts: { ...facts } });
    // The manager walks the report over to the CEO, or to the chairman when there is no CEO.
    const boss = org.ceo && store.exists(org.ceo) ? org.ceo : org.chairman;
    if (manager && boss && boss !== manager && store.exists(boss) && !quiet) this.deps.handoff({ from: manager, to: boss, kind: "pass" });
    this.deps.notify(report);
    return report;
  }

  /** Work for a department: its manager splits it among the members (delegating) and delivers the whole. */
  dispatch(roomId: string, prompt: string): Task | string {
    const { store, tasks } = this.deps;
    const d = this.departments().find((x) => x.room.id === roomId);
    if (!d) return "No such department.";
    if (!d.manager) return "This department has no manager; give the task to one of its members instead.";
    if (!store.brain(d.manager)) return "The manager has no model yet.";
    const members = d.members.filter((m) => m !== d.manager).map((m) => `${store.occupant(m)?.name ?? m}${store.soul(m).role ? ` (${store.soul(m).role})` : ""}`);
    const full = [
      `Task for your department (${d.room.name}), from the chairman:`,
      "",
      prompt,
      "",
      "---",
      `You manage this department. Its members: ${members.join(", ") || "none besides you"}.`,
      "Split the work sensibly: hand parts to the members who fit best (delegate), do your own part, then deliver the combined result.",
    ].join("\n");
    return tasks.add(d.manager, clip(`${d.room.name}：${prompt.split("\n")[0]}`, 80), full);
  }
}
