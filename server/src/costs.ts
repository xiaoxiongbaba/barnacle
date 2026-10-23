import { onUsage, type Usage, type UsageTag } from "./ai.js";
import type { GateContext } from "./governance.js";
import { startOfDay, startOfMonth } from "./schedule.js";
import type { Settings } from "./settings.js";
import type { Store, Task } from "./store.js";

/**
 * What the office spends on models: every call's tokens are booked to whoever it was for (and their
 * department, by the room their desk is in) with an estimated cost; departments and the company can have
 * daily and monthly limits. Over a limit, work stops or waits for approval (yours or the CEO's); routine
 * work can run on a member's lighter model.
 */

/** Per million tokens, USD. First match wins (more specific names first); your prices come before these. */
export const BUILTIN_PRICES: { match: string; input: number; output: number }[] = [
  { match: "claude-fable-5", input: 10, output: 50 },
  { match: "claude-mythos", input: 10, output: 50 },
  { match: "claude-opus-5-5", input: 4, output: 20 },
  { match: "claude-opus-5", input: 5, output: 25 },
  { match: "claude-opus-4-8", input: 5, output: 25 },
  { match: "claude-opus-4-7", input: 5, output: 25 },
  { match: "claude-opus-4-6", input: 5, output: 25 },
  { match: "claude-opus-4-5", input: 5, output: 25 },
  { match: "claude-opus-4", input: 15, output: 75 },
  { match: "claude-sonnet-5", input: 2, output: 10 },
  { match: "claude-sonnet-4", input: 3, output: 15 },
  { match: "claude-3-7-sonnet", input: 3, output: 15 },
  { match: "claude-haiku-5", input: 0.1, output: 0.5 },
  { match: "claude-haiku-4", input: 1, output: 5 },
  { match: "claude-3-5-haiku", input: 0.8, output: 4 },
  { match: "gpt-5-nano", input: 0.05, output: 0.4 },
  { match: "gpt-5-mini", input: 0.25, output: 2 },
  { match: "gpt-5", input: 1.25, output: 10 },
  { match: "gpt-4.1-nano", input: 0.1, output: 0.4 },
  { match: "gpt-4.1-mini", input: 0.4, output: 1.6 },
  { match: "gpt-4.1", input: 2, output: 8 },
  { match: "gpt-4o-mini", input: 0.15, output: 0.6 },
  { match: "gpt-4o", input: 2.5, output: 10 },
  { match: "o4-mini", input: 1.1, output: 4.4 },
  { match: "o3", input: 2, output: 8 },
  { match: "gemini-2.5-flash", input: 0.3, output: 2.5 },
  { match: "gemini-2.5-pro", input: 1.25, output: 10 },
  { match: "deepseek", input: 0.28, output: 0.42 },
  { match: "minimax", input: 0.3, output: 1.2 },
];

export type Scope = "company" | string;

export interface Spend {
  cost: number;
  input: number;
  output: number;
  calls: number;
}

export interface Overrun {
  scope: Scope;
  period: "daily" | "monthly";
  spent: number;
  limit: number;
}

interface Deps {
  store: Store;
  settings: () => Settings;
  /** The department (room id) someone's desk is in, if any. */
  roomOf: (occupantId: string) => string | null;
  roomName: (id: string) => string;
  /** Asks for approval inside a running task (governance). */
  ask: (task: Task, action: string, summary: string, detail: string, ctx: GateContext) => Promise<{ approved: boolean; note: string; how: "decided" | "timeout" }>;
  /** Tells the pages spending changed (no amounts: those need the token). */
  changed: () => void;
}

const LANGS = {
  en: { over: "Over budget: {scope} spent ${spent} of its {period} ${limit}.", daily: "daily", monthly: "monthly", company: "the company", stop: "Work stopped: {why}", declined: "{why} Going on was not approved.", finish: "The budget is used up: don't call more tools; finish now with what you have." },
  ja: { over: "予算超過：{scope}の{period}予算 ${limit} のうち ${spent} を使用済み。", daily: "日次", monthly: "月次", company: "会社全体", stop: "作業を停止：{why}", declined: "{why}続行は承認されませんでした。", finish: "The budget is used up: don't call more tools; finish now with what you have." },
  "zh-Hant": { over: "超出預算：{scope}{period}預算 ${limit}，已花 ${spent}。", daily: "每日", monthly: "每月", company: "全公司", stop: "已停止工作：{why}", declined: "{why}未獲准繼續。", finish: "The budget is used up: don't call more tools; finish now with what you have." },
} as const;

const money = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));

let current: Costs | null = null;

/** The model for reports and summaries: the member's lighter one when routine work uses it. */
export function reportModel(brain: { model: string; lightModel?: string | null }) {
  return brain.lightModel && current?.lightReports() ? brain.lightModel : brain.model;
}

export class Costs {
  /** Tasks allowed to go over budget (approved), until the period ends. */
  private allowed = new Map<number, string>();
  /** Tasks told to stop (or turned down) for this period: not asked again. */
  private blocked = new Map<number, string>();

  constructor(private deps: Deps) {
    deps.store.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        occupant_id TEXT,
        task_id INTEGER,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        room_id TEXT,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cost REAL NOT NULL,
        priced INTEGER NOT NULL,
        estimated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_by_time ON usage (at);
      CREATE INDEX IF NOT EXISTS usage_by_task ON usage (task_id);
    `);
    onUsage((model, tag, usage) => this.record(model, tag, usage));
    current = this;
  }

  lightReports() {
    return this.deps.settings().costs.light.reports;
  }

  /** The price of a model (per million tokens), or null if unknown. */
  price(model: string): { input: number; output: number } | null {
    const id = model.toLowerCase();
    // Of your prices, the most specific (longest) match wins.
    const mine = Object.entries(this.deps.settings().costs.prices)
      .filter(([k]) => id.includes(k.toLowerCase()))
      .sort((x, y) => y[0].length - x[0].length)[0];
    if (mine) return mine[1];
    return BUILTIN_PRICES.find((p) => id.includes(p.match)) ?? null;
  }

  record(model: string, tag: UsageTag, usage: Usage) {
    const price = this.price(model);
    const cost = price ? (usage.input * price.input + usage.output * price.output) / 1_000_000 : 0;
    const room = tag.occupantId ? this.deps.roomOf(tag.occupantId) : null;
    this.deps.store.sql
      .prepare("INSERT INTO usage (at, occupant_id, task_id, kind, model, room_id, input, output, cost, priced, estimated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), tag.occupantId, tag.taskId ?? null, tag.kind, model, room, usage.input, usage.output, cost, price ? 1 : 0, usage.estimated ? 1 : 0);
    this.deps.changed();
  }

  private tz() {
    return this.deps.settings().org.timeZone || "UTC";
  }

  /** Spending since a time, for the company or one department. */
  spent(since: Date, scope: Scope = "company"): Spend {
    const r = this.deps.store.sql
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COUNT(*) AS calls FROM usage WHERE at >= ?${scope === "company" ? "" : " AND room_id = ?"}`,
      )
      .get(...(scope === "company" ? [since.toISOString()] : [since.toISOString(), scope])) as unknown as Spend;
    return { cost: Number(r.cost), input: Number(r.input), output: Number(r.output), calls: Number(r.calls) };
  }

  /** "💸 Model spending this period: $1.23 (45 calls)" for a report, or null when nothing was spent. */
  spendLine(scope: Scope, since: string, until: string): string | null {
    const r = this.deps.store.sql
      .prepare(`SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls FROM usage WHERE at >= ? AND at < ?${scope === "company" ? "" : " AND room_id = ?"}`)
      .get(...(scope === "company" ? [since, until] : [since, until, scope])) as { cost: number; calls: number };
    if (!Number(r.calls)) return null;
    const lang = this.deps.settings().org.language;
    const cost = `$${money(Number(r.cost))}`;
    const limits = scope === "company" ? this.deps.settings().costs.company : this.deps.settings().costs.rooms[scope];
    const month = limits?.monthly ? ` · ${{ en: "this month", ja: "今月", "zh-Hant": "本月" }[lang]} $${money(this.spent(startOfMonth(this.tz()), scope).cost)} / $${money(limits.monthly)}` : "";
    const n = Number(r.calls);
    return { en: `💸 Model spending this period: ${cost} (${n} calls)${month}`, ja: `💸 今期のモデル費用：${cost}（${n} 回）${month}`, "zh-Hant": `💸 本期模型花費：${cost}（${n} 次呼叫）${month}` }[lang];
  }

  /** What someone's calls cost since a time. */
  personSpend(occupantId: string, since: Date): number {
    const r = this.deps.store.sql.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage WHERE occupant_id = ? AND at >= ?").get(occupantId, since.toISOString()) as { cost: number };
    return Number(r.cost);
  }

  /** What a task cost, with the colleagues it asked. */
  taskSpend(task: Task, depth = 0): Spend {
    const r = this.deps.store.sql
      .prepare("SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COUNT(*) AS calls FROM usage WHERE task_id = ?")
      .get(task.id) as unknown as Spend;
    const own = { cost: Number(r.cost), input: Number(r.input), output: Number(r.output), calls: Number(r.calls) };
    if (depth >= 3) return own;
    for (const c of this.deps.store.childTasks(task.id)) {
      const s = this.taskSpend(c, depth + 1);
      own.cost += s.cost;
      own.input += s.input;
      own.output += s.output;
      own.calls += s.calls;
    }
    return own;
  }

  /** The first limit someone's work is over: their department's, then the company's. */
  overrun(occupantId: string): Overrun | null {
    const { costs } = this.deps.settings();
    const room = this.deps.roomOf(occupantId);
    const day = startOfDay(this.tz());
    const month = startOfMonth(this.tz());
    const check = (scope: Scope, limits: { daily: number | null; monthly: number | null } | undefined): Overrun | null => {
      if (!limits) return null;
      if (limits.daily !== null) {
        const spent = this.spent(day, scope).cost;
        if (spent >= limits.daily) return { scope, period: "daily", spent, limit: limits.daily };
      }
      if (limits.monthly !== null) {
        const spent = this.spent(month, scope).cost;
        if (spent >= limits.monthly) return { scope, period: "monthly", spent, limit: limits.monthly };
      }
      return null;
    };
    return (room ? check(room, costs.rooms[room]) : null) ?? check("company", costs.company);
  }

  describe(o: Overrun) {
    const w = LANGS[this.deps.settings().language] ?? LANGS.en;
    return w.over
      .replace("{scope}", o.scope === "company" ? w.company : this.deps.roomName(o.scope))
      .replace("{period}", w[o.period])
      .replace("{limit}", money(o.limit))
      .replace("{spent}", money(o.spent));
  }

  /** The budget check for a task (see TaskRunner.hooks.budget). */
  async check(task: Task, ctx: GateContext, starting: boolean): Promise<string | null> {
    const over = this.overrun(task.occupantId);
    if (!over) return null;
    // Approved once for this period: the task (or the one it helps) may go on.
    const key = `${over.scope}:${over.period}:${over.period === "daily" ? startOfDay(this.tz()).toISOString() : startOfMonth(this.tz()).toISOString()}`;
    for (let t: Task | undefined = task, n = 0; t && n < 6; n++) {
      if (this.allowed.get(t.id) === key) return null;
      t = t.parentTaskId === null ? undefined : this.deps.store.task(t.parentTaskId);
    }
    const w = LANGS[this.deps.settings().language] ?? LANGS.en;
    if (this.blocked.get(task.id) === key) return w.finish;
    const why = this.describe(over);
    if (this.deps.settings().costs.onExceed === "pause") {
      this.blocked.set(task.id, key);
      ctx.step("note", `💸 ${why}`, "waiting");
      return starting ? w.stop.replace("{why}", why) : w.finish;
    }
    const decision = await this.deps.ask(task, "budget", why, `${why}\n\nThe task: ${task.title}\n${task.prompt.slice(0, 1200)}`, ctx);
    if (decision.approved) {
      this.allowed.set(task.id, key);
      ctx.step("approval", `✅ ${why}`, "researching");
      return null;
    }
    ctx.step("approval", `🚫 ${why}`, "researching");
    this.blocked.set(task.id, key);
    return starting ? w.declined.replace("{why}", why) : w.finish;
  }

  /** Whether a task should run on the member's lighter model. */
  light(task: Task) {
    const l = this.deps.settings().costs.light;
    if (task.scheduleId !== null) return l.scheduled;
    if (task.kind === "ask") return l.ask;
    if (task.kind === "project") return l.project;
    return false;
  }

  /** Spending over the last `days` days: per day, department, person, model and kind of work. */
  summary(days: number) {
    const tz = this.tz();
    const from = startOfDay(tz, new Date(Date.now() - (days - 1) * 86_400_000));
    const rows = this.deps.store.sql
      .prepare("SELECT at, occupant_id, room_id, model, kind, input, output, cost, priced, estimated FROM usage WHERE at >= ?")
      .all(from.toISOString()) as unknown as { at: string; occupant_id: string | null; room_id: string | null; model: string; kind: string; input: number; output: number; cost: number; priced: number; estimated: number }[];
    const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const add = (map: Map<string, Spend>, key: string, r: (typeof rows)[number]) => {
      const s = map.get(key) ?? { cost: 0, input: 0, output: 0, calls: 0 };
      s.cost += r.cost;
      s.input += r.input;
      s.output += r.output;
      s.calls++;
      map.set(key, s);
    };
    const byDay = new Map<string, Spend>();
    const byRoom = new Map<string, Spend>();
    const byPerson = new Map<string, Spend>();
    const byModel = new Map<string, Spend>();
    const byKind = new Map<string, Spend>();
    const unpriced = new Set<string>();
    let estimated = 0;
    for (const r of rows) {
      add(byDay, dayOf.format(new Date(r.at)), r);
      add(byRoom, r.room_id ?? "", r);
      add(byPerson, r.occupant_id ?? "", r);
      add(byModel, r.model, r);
      add(byKind, r.kind, r);
      if (!r.priced) unpriced.add(r.model);
      if (r.estimated) estimated++;
    }
    const days_: { day: string; cost: number; input: number; output: number; calls: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = dayOf.format(new Date(Date.now() - i * 86_400_000));
      days_.push({ day, ...(byDay.get(day) ?? { cost: 0, input: 0, output: 0, calls: 0 }) });
    }
    const list = (m: Map<string, Spend>) => [...m].map(([key, s]) => ({ key, ...s })).sort((a, b) => b.cost - a.cost || b.input + b.output - a.input - a.output);
    return { days: days_, rooms: list(byRoom), people: list(byPerson), models: list(byModel), kinds: list(byKind), unpriced: [...unpriced], estimatedCalls: estimated, calls: rows.length };
  }

  /** Today's and this month's spending with the limits, for the company and each department that has any. */
  status() {
    const tz = this.tz();
    const { costs } = this.deps.settings();
    const day = startOfDay(tz);
    const month = startOfMonth(tz);
    const line = (scope: Scope, limits?: { daily: number | null; monthly: number | null }) => ({
      scope,
      today: this.spent(day, scope).cost,
      month: this.spent(month, scope).cost,
      daily: limits?.daily ?? null,
      monthly: limits?.monthly ?? null,
    });
    const rooms = new Set([...Object.keys(costs.rooms), ...this.summary(31).rooms.map((r) => r.key).filter(Boolean)]);
    return { company: line("company", costs.company), rooms: [...rooms].map((id) => line(id, costs.rooms[id])) };
  }
}
