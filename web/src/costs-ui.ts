import { api } from "./auth";
import { t } from "./i18n";

/** Spending: the panel in the chairman's office, the Costs tab in Settings, and a task's cost. */

interface Spend {
  cost: number;
  input: number;
  output: number;
  calls: number;
}

interface Line {
  scope: string;
  today: number;
  month: number;
  daily: number | null;
  monthly: number | null;
}

type Limits = { daily: number | null; monthly: number | null };

export interface CostSettings {
  prices: Record<string, { input: number; output: number }>;
  company: Limits;
  rooms: Record<string, Limits>;
  onExceed: "ask" | "pause";
  light: { scheduled: boolean; ask: boolean; reports: boolean; project: boolean };
}

export interface CostData {
  summary: {
    days: ({ day: string } & Spend)[];
    rooms: ({ key: string } & Spend)[];
    people: ({ key: string } & Spend)[];
    models: ({ key: string } & Spend)[];
    kinds: ({ key: string } & Spend)[];
    unpriced: string[];
    estimatedCalls: number;
    calls: number;
  };
  status: { company: Line; rooms: Line[] };
  settings: CostSettings;
  departments: { id: string; name: string }[];
  builtin: { match: string; input: number; output: number }[];
}

type Guard = <T>(status: Element | null, fn: () => Promise<T>) => Promise<T | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "$0.054", "$1.23", "$120". */
export const money = (n: number) => `$${n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n > 0 ? n.toFixed(4) : "0"}`;
export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// ---------------------------------------------------------------- a task's cost

const cache = new Map<string, Promise<{ spend: Spend }>>();

/** "💸 $0.054 · 3.0k tokens · 2 calls", once the task has used the model. */
export function taskCost(taskId: number, key: string) {
  const line = el("p", "ui-taskcost ui-faint ui-small");
  const k = `${taskId}:${key}`;
  if (!cache.has(k)) cache.set(k, api<{ spend: Spend }>("GET", `/api/tasks/${taskId}/cost`));
  void cache
    .get(k)!
    .then(({ spend }) => {
      if (spend.calls) line.textContent = `💸 ${money(spend.cost)} · ${tokens(spend.input + spend.output)} tokens · ${t("cost.calls", { n: String(spend.calls) })}`;
    })
    .catch(() => cache.delete(k));
  return line;
}

// ---------------------------------------------------------------- the chairman's office

/** A spent / limit meter: the bar fills toward the limit and turns to a warning at 80%, over at 100%. */
function meter(label: string, spent: number, limit: number | null) {
  const box = el("div", "ui-cost__meter");
  const head = el("div", "ui-cost__meterhead");
  head.append(el("span", "", label), el("strong", "", limit === null ? money(spent) : `${money(spent)} / ${money(limit)}`));
  box.append(head);
  if (limit !== null) {
    const ratio = limit > 0 ? spent / limit : 1;
    const bar = el("div", `ui-cost__bar${ratio >= 1 ? " is-over" : ratio >= 0.8 ? " is-near" : ""}`);
    const fill = el("span");
    fill.style.width = `${Math.min(100, ratio * 100)}%`;
    bar.append(fill);
    box.append(bar);
    if (ratio >= 1) box.append(el("small", "ui-cost__flag", `⛔ ${t("cost.over")}`));
    else if (ratio >= 0.8) box.append(el("small", "ui-cost__flag is-near", `⚠️ ${t("cost.near")}`));
  } else box.append(el("small", "ui-faint", t("cost.noLimit")));
  return box;
}

/** Daily spending as columns (one series: no legend), with a tooltip per day. */
function dailyChart(days: CostData["summary"]["days"]) {
  const wrap = el("div", "ui-cost__chart");
  const max = Math.max(...days.map((d) => d.cost), 0);
  const cols = el("div", "ui-cost__cols");
  cols.setAttribute("role", "img");
  cols.setAttribute("aria-label", t("cost.trend"));
  const tip = el("div", "ui-cost__tip");
  tip.hidden = true;
  days.forEach((d, i) => {
    const col = el("div", "ui-cost__col");
    const bar = el("span", "ui-cost__colbar");
    bar.style.height = max ? `${Math.max(d.cost ? 2 : 0, (d.cost / max) * 100)}%` : "0";
    col.append(bar);
    const show = () => {
      tip.hidden = false;
      tip.replaceChildren(el("strong", "", d.day.slice(5)), el("span", "", ` ${money(d.cost)} · ${tokens(d.input + d.output)} tokens · ${t("cost.calls", { n: String(d.calls) })}`));
      tip.style.left = `${((i + 0.5) / days.length) * 100}%`;
      col.classList.add("is-on");
    };
    const hide = () => {
      tip.hidden = true;
      col.classList.remove("is-on");
    };
    col.addEventListener("mouseenter", show);
    col.addEventListener("mouseleave", hide);
    col.addEventListener("focus", show);
    col.addEventListener("blur", hide);
    col.tabIndex = 0;
    col.setAttribute("aria-label", `${d.day}: ${money(d.cost)}`);
    cols.append(col);
  });
  const axis = el("div", "ui-cost__axis");
  axis.append(el("span", "", days[0]?.day.slice(5) ?? ""), el("span", "", `${t("cost.peak")} ${money(max)}`), el("span", "", days.at(-1)?.day.slice(5) ?? ""));
  wrap.append(tip, cols, axis);
  return wrap;
}

/** Ranked rows with a bar (share of the top one) and the amount. */
function ranking(title: string, rows: ({ key: string } & Spend)[], label: (key: string) => string, limit = 6) {
  const box = el("div", "ui-cost__rank");
  box.append(el("h4", "", title));
  const top = rows[0]?.cost || 0;
  const ul = el("ul");
  for (const r of rows.slice(0, limit)) {
    const li = el("li");
    const bar = el("span", "ui-cost__rankbar");
    const fill = el("span");
    fill.style.width = top ? `${(r.cost / top) * 100}%` : "0";
    bar.append(fill);
    li.title = `${tokens(r.input + r.output)} tokens · ${t("cost.calls", { n: String(r.calls) })}`;
    li.append(el("span", "ui-cost__rankname", label(r.key)), bar, el("strong", "", money(r.cost)));
    ul.append(li);
  }
  if (!rows.length) ul.append(el("li", "ui-faint ui-small", t("cost.none")));
  box.append(ul);
  return box;
}

/** The spending panel in the chairman's office. */
export function costPanel(data: CostData, ctx: { nameOf: (id: string) => string; openSettings: () => void }) {
  const roomName = (id: string) => data.departments.find((d) => d.id === id)?.name ?? id;
  const box = el("section", "ui-cost");
  const head = el("div", "ui-cost__head");
  head.append(el("h3", "ui-hq__h", `💸 ${t("cost.title")}`));
  const edit = el("button", "ui-btn ui-btn--sm", t("cost.budgets"));
  edit.type = "button";
  edit.addEventListener("click", ctx.openSettings);
  head.append(edit);
  box.append(head);

  const { company, rooms } = data.status;
  const meters = el("div", "ui-cost__meters");
  meters.append(meter(t("cost.today"), company.today, company.daily), meter(t("cost.month"), company.month, company.monthly));
  box.append(meters);
  box.append(dailyChart(data.summary.days));

  const grid = el("div", "ui-cost__grid");
  const roomLabel = (k: string) => (k ? roomName(k) : t("cost.noRoom"));
  grid.append(
    ranking(t("cost.byDept"), data.summary.rooms, roomLabel),
    ranking(t("cost.byPerson"), data.summary.people, (k) => (k ? ctx.nameOf(k) : t("cost.office"))),
    ranking(t("cost.byModel"), data.summary.models, (k) => k),
    ranking(t("cost.byKind"), data.summary.kinds, (k) => t(`cost.kind.${k}`)),
  );
  box.append(grid);

  // Departments with limits: where they stand this month.
  const limited = rooms.filter((r) => r.daily !== null || r.monthly !== null);
  if (limited.length) {
    const list = el("div", "ui-cost__meters");
    for (const r of limited) {
      list.append(r.monthly !== null ? meter(`${roomName(r.scope)} · ${t("cost.month")}`, r.month, r.monthly) : meter(`${roomName(r.scope)} · ${t("cost.today")}`, r.today, r.daily));
    }
    box.append(el("h4", "", t("cost.deptBudgets")), list);
  }
  const notes: string[] = [];
  if (data.summary.unpriced.length) notes.push(t("cost.unpriced", { models: data.summary.unpriced.join(", ") }));
  if (data.summary.estimatedCalls) notes.push(t("cost.estimated", { n: String(data.summary.estimatedCalls) }));
  notes.push(t("cost.disclaimer"));
  for (const n of notes) box.append(el("p", "ui-faint ui-small", n));
  return box;
}

// ---------------------------------------------------------------- Settings → Costs

export class CostsTab {
  constructor(
    private root: HTMLElement,
    private guard: Guard,
  ) {}

  async render(note = "") {
    const data = await this.guard(null, () => api<CostData>("GET", "/api/costs?days=31"));
    if (!data) return;
    const s = structuredClone(data.settings);
    const status = el("p", "status", note);

    const num = (value: number | null, set: (v: number | null) => void, placeholder = "∞") => {
      const input = el("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.placeholder = placeholder;
      input.title = t("cost.noLimit");
      input.value = value === null ? "" : String(value);
      input.addEventListener("input", () => set(input.value.trim() === "" ? null : Math.max(0, Number(input.value))));
      return input;
    };
    const spentNow = (scope: string) => (scope === "company" ? data.status.company : data.status.rooms.find((r) => r.scope === scope));

    // Budgets: the company and each department.
    const table = el("table", "cost-table");
    const head = el("tr");
    head.append(el("th", "", ""), el("th", "", `${t("cost.daily")} (USD)`), el("th", "", `${t("cost.monthly")} (USD)`), el("th", "", t("cost.spentNow")));
    table.append(head);
    const row = (scope: string, name: string, limits: Limits, set: (l: Limits) => void) => {
      const tr = el("tr");
      const now = spentNow(scope);
      tr.append(
        el("td", "", name),
        el("td"),
        el("td"),
        el("td", "help", now ? `${t("cost.today")} ${money(now.today)} · ${t("cost.month")} ${money(now.month)}` : "—"),
      );
      tr.children[1].append(
        num(limits.daily, (v) => {
          limits.daily = v;
          set(limits);
        }),
      );
      tr.children[2].append(
        num(limits.monthly, (v) => {
          limits.monthly = v;
          set(limits);
        }),
      );
      table.append(tr);
    };
    row("company", `🏢 ${t("kb.company")}`, s.company, (l) => (s.company = l));
    for (const d of data.departments) {
      const limits = s.rooms[d.id] ?? { daily: null, monthly: null };
      row(d.id, `🚪 ${d.name}`, limits, (l) => (s.rooms[d.id] = l));
    }

    const exceed = el("select");
    for (const v of ["ask", "pause"] as const) exceed.append(new Option(t(`cost.exceed.${v}`), v, false, s.onExceed === v));
    exceed.addEventListener("change", () => (s.onExceed = exceed.value as CostSettings["onExceed"]));

    // Routine work on the lighter model.
    const light = el("div", "cost-light");
    for (const k of ["scheduled", "ask", "reports", "project"] as const) {
      const label = el("label", "check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = s.light[k];
      box.addEventListener("change", () => (s.light[k] = box.checked));
      label.append(box, el("span", "", t(`cost.light.${k}`)));
      light.append(label);
    }

    // Prices: yours (editable) over the built-in table.
    const prices = el("table", "cost-table");
    const phead = el("tr");
    phead.append(el("th", "", t("cost.model")), el("th", "", t("cost.inputPrice")), el("th", "", t("cost.outputPrice")), el("th"));
    prices.append(phead);
    const rows: { model: HTMLInputElement; input: HTMLInputElement; output: HTMLInputElement }[] = [];
    const priceRow = (model = "", p = { input: 0, output: 0 }) => {
      const tr = el("tr");
      const m = el("input");
      m.value = model;
      m.placeholder = "e.g. qwen-max";
      m.maxLength = 120;
      const i = el("input");
      const o = el("input");
      for (const [x, v] of [[i, p.input], [o, p.output]] as const) {
        x.type = "number";
        x.min = "0";
        x.step = "0.01";
        x.value = String(v);
      }
      const del = el("button", "small", "×");
      del.type = "button";
      del.addEventListener("click", () => {
        tr.remove();
        rows.splice(rows.findIndex((r) => r.model === m), 1);
      });
      const cells = [m, i, o, del].map((c) => {
        const td = el("td");
        td.append(c);
        return td;
      });
      tr.append(...cells);
      prices.append(tr);
      rows.push({ model: m, input: i, output: o });
    };
    for (const [model, p] of Object.entries(s.prices)) priceRow(model, p);
    const addPrice = el("button", "small", `＋ ${t("cost.addPrice")}`);
    addPrice.type = "button";
    addPrice.addEventListener("click", () => priceRow());
    const builtin = el("details", "cost-builtin");
    builtin.append(el("summary", "", t("cost.builtin")));
    const bl = el("table", "cost-table");
    for (const p of data.builtin) {
      const tr = el("tr");
      tr.append(el("td", "", p.match), el("td", "", `$${p.input}`), el("td", "", `$${p.output}`));
      bl.append(tr);
    }
    builtin.append(bl);

    const save = el("button", "primary", t("cost.save"));
    save.type = "button";
    save.addEventListener("click", () => {
      s.prices = Object.fromEntries(rows.filter((r) => r.model.value.trim()).map((r) => [r.model.value.trim(), { input: Number(r.input.value) || 0, output: Number(r.output.value) || 0 }]));
      void this.guard(status, () => api("PUT", "/api/costs/settings", s)).then((res) => res && this.render(t("cost.saved")));
    });

    this.root.replaceChildren(
      el("p", "help", t("cost.intro")),
      el("h4", "", t("cost.budgetsTitle")),
      table,
      el("label", "", t("cost.onExceed")),
      exceed,
      el("p", "help", t(`cost.exceedHelp`)),
      el("h4", "", t("cost.lightTitle")),
      el("p", "help", t("cost.lightIntro")),
      light,
      el("h4", "", t("cost.pricesTitle")),
      el("p", "help", t("cost.pricesIntro")),
      prices,
      addPrice,
      builtin,
      el("div", "row cost-save"),
      status,
    );
    this.root.querySelector(".cost-save")!.append(save);
  }
}
