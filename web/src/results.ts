import { taskCost } from "./costs-ui";
import { api, tokenStore, Unauthorized } from "./auth";
import { characterSeed } from "./floor/art-habblaud";
import { taskFiles } from "./files-ui";
import { t } from "./i18n";
import { renderMarkdown } from "./markdown";
import type { Occupant, Report, Task } from "./types";
import { avatarCanvas } from "./vendor/habblaud/art/index";

/**
 * Results: one place to read and check everything the agents finished. A list of deliveries (waiting for
 * your check first), each readable in full with what was asked, how it was done and the pages it read,
 * so you can verify it, then accept it or send it back. A badge counts what waits, and a toast says when
 * something new is done.
 */

type Status = "pending" | "accepted" | "rejected" | "failed" | "all" | "projects" | "reports";

interface Item {
  type: "task" | "project" | "report";
  id: number;
  occupantId?: string;
  members?: string[];
  title: string;
  snippet: string;
  status: string;
  review?: "accepted" | "rejected" | null;
  scheduled?: boolean;
  redoOf?: number | null;
  at: string;
}

interface Detail {
  task: Task;
  sources: { url: string; by: string }[];
  redoneBy: number | null;
  helpers: { id: number; occupantId: string; kind: string; title: string; status: string }[];
  /** Earlier versions, and who sent each back. */
  rounds?: { id: number; by: "manager" | "you"; note: string; managerId: string | null }[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function avatar(id: string, size = 20) {
  const img = document.createElement("img");
  img.src = avatarCanvas(characterSeed(id), { scale: 2 }).toDataURL();
  img.alt = "";
  img.width = size;
  img.height = size;
  img.className = "ui-proj__avatar";
  return img;
}

const STATUSES: Status[] = ["pending", "accepted", "rejected", "failed", "all", "projects", "reports"];

export interface ResultsContext {
  occupants: () => Occupant[];
  nameOf: (id: string) => string;
  relativeTime: (at: number) => string;
  unlock: () => Promise<void>;
  /** Opens someone's drawer (to find them in the office). */
  openAgent: (id: string) => void;
  openProject: (id: number) => void;
  /** A room's name (for department reports). */
  roomName: (id: string) => string;
}

export class ResultsBoard {
  private dialog = document.getElementById("results") as HTMLDialogElement;
  private status: Status = "pending";
  private occupant = "";
  private query = "";
  private items: Item[] = [];
  private counts: Partial<Record<Status, number>> = {};
  private selected: number | null = null;
  private detail: Detail | null = null;
  /** In the reports list: the reports, and the one shown. */
  private reports: Report[] = [];
  private report: Report | null = null;
  private rejecting = "";
  private showReject = false;
  private error = "";
  private seen = new Set<number>();
  /** The badge was loaded once: deliveries after that get a toast. */
  private primed = false;

  constructor(private ctx: ResultsContext) {
    this.dialog.addEventListener("close", () => (this.selected = null));
    document.getElementById("results-close")?.addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  /** Opens the board (at one task, if given). */
  async open(taskId?: number) {
    if (!tokenStore.get()) {
      await this.ctx.unlock().catch(() => {});
      if (!tokenStore.get()) return;
    }
    if (taskId !== undefined) {
      this.status = "all";
      this.selected = taskId;
    }
    if (!this.dialog.open) this.dialog.showModal();
    await this.load();
  }

  /** Reloads the list (and the open delivery). */
  async load() {
    const params = new URLSearchParams({ status: this.status, occupant: this.occupant, q: this.query });
    if (this.status === "reports") return this.loadReports();
    this.report = null;
    try {
      const res = await api<{ items: Item[]; counts: Partial<Record<Status, number>> }>("GET", `/api/deliveries?${params}`);
      this.items = res.items;
      this.counts = res.counts;
      if (this.selected === null && this.items[0]?.type === "task") this.selected = this.items[0].id;
      if (this.selected !== null) {
        const id = this.selected;
        const d = await api<Detail>("GET", `/api/deliveries/task/${id}`);
        if (this.selected === id) this.detail = d;
      } else this.detail = null;
    } catch (err) {
      this.error = err instanceof Unauthorized ? t("drawer.unlockToGive") : (err as Error).message;
    }
    this.render();
  }

  /** Department reports, newest first (shown like deliveries). */
  private async loadReports() {
    try {
      const [list, counts] = await Promise.all([
        api<{ reports: Report[] }>("GET", "/api/org/reports?limit=100"),
        api<{ counts: Partial<Record<Status, number>> }>("GET", "/api/deliveries?status=pending"),
      ]);
      this.counts = counts.counts;
      const words = this.query.trim().toLowerCase();
      this.reports = list.reports.filter((r) => (!this.occupant || r.author === this.occupant) && (!words || r.content.toLowerCase().includes(words)));
      this.items = this.reports.map((r) => ({
        type: "report" as const,
        id: r.id,
        occupantId: r.author ?? undefined,
        title: `${this.ctx.roomName(r.roomId)} · ${new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(r.createdAt))}`,
        snippet: r.content.replace(/[#>*_`|-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160),
        status: "done",
        at: r.createdAt,
      }));
      this.report = this.reports.find((r) => r.id === this.selected) ?? this.reports[0] ?? null;
      this.selected = this.report?.id ?? null;
      this.detail = null;
    } catch (err) {
      this.error = (err as Error).message;
    }
    this.render();
  }

  /**
   * A task changed somewhere: refresh the badge, and when a new delivery is done, say so.
   * Without the token this does nothing (titles are private).
   */
  async taskChanged(taskId: number, status: string) {
    if (!tokenStore.get()) return;
    try {
      const res = await api<{ pending: number; latest: { id: number; occupantId: string; title: string; status: string } | null }>("GET", "/api/deliveries/summary");
      this.setBadge(res.pending);
      const latest = res.latest;
      if (this.primed && latest && latest.id === taskId && (status === "done" || status === "failed") && !this.seen.has(latest.id)) {
        this.seen.add(latest.id);
        this.toast(latest);
      }
      this.primed = true;
      if (this.dialog.open) void this.load();
    } catch {
      // The badge waits for the next change.
    }
  }

  /** Called once at start (and after unlocking) to set the badge. */
  async refreshBadge() {
    await this.taskChanged(-1, "");
  }

  private setBadge(n: number) {
    const badge = document.getElementById("results-badge");
    if (!badge) return;
    badge.hidden = !n;
    badge.textContent = n > 99 ? "99+" : String(n);
  }

  private toast(latest: { id: number; occupantId: string; title: string; status: string }) {
    const box = document.getElementById("toasts");
    if (!box) return;
    const toast = el("button", `ui-toast${latest.status === "failed" ? " is-failed" : ""}`);
    toast.type = "button";
    const text = el("span", "ui-toast__text");
    text.append(el("strong", "", this.ctx.nameOf(latest.occupantId)), document.createTextNode(` ${t(latest.status === "failed" ? "results.toastFailed" : "results.toastDone")}「${latest.title}」`));
    toast.append(avatar(latest.occupantId, 24), text, el("span", "ui-toast__go", `${t("results.check")} →`));
    toast.addEventListener("click", () => {
      toast.remove();
      void this.open(latest.id);
    });
    box.append(toast);
    window.setTimeout(() => toast.classList.add("is-leaving"), 9000);
    window.setTimeout(() => toast.remove(), 9600);
  }

  private render() {
    const body = this.dialog.querySelector<HTMLElement>(".ui-results__body")!;
    const scroll = body.querySelector(".ui-results__detail")?.scrollTop ?? 0;
    const listScroll = body.querySelector(".ui-results__list")?.scrollTop ?? 0;

    // Filters: status tabs, member, search.
    const filters = el("div", "ui-results__filters");
    const tabs = el("div", "ui-results__tabs");
    for (const s of STATUSES) {
      const tab = el("button", `ui-results__tab${s === this.status ? " is-on" : ""}`);
      tab.type = "button";
      const n = s === "all" ? undefined : this.counts[s];
      tab.append(el("span", "", t(`results.${s}`)), ...(n ? [el("span", "ui-results__n", String(n))] : []));
      tab.addEventListener("click", () => {
        this.status = s;
        this.selected = null;
        void this.load();
      });
      tabs.append(tab);
    }
    const who = el("select", "ui-sched__select");
    who.append(new Option(t("results.everyone"), ""), ...this.ctx.occupants().filter((o) => o.kind === "agent").map((o) => new Option(o.name, o.id, false, o.id === this.occupant)));
    who.addEventListener("change", () => {
      this.occupant = who.value;
      this.selected = null;
      void this.load();
    });
    const search = el("input", "ui-mem__input ui-results__search");
    search.type = "search";
    search.placeholder = t("results.search");
    search.value = this.query;
    let debounce = 0;
    search.addEventListener("input", () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        this.query = search.value;
        this.selected = null;
        void this.load().then(() => body.querySelector<HTMLInputElement>(".ui-results__search")?.focus());
      }, 350);
    });
    filters.append(tabs, el("div", "ui-results__row", undefined));
    filters.lastElementChild!.append(who, search);

    // The list.
    const list = el("ul", "ui-results__list");
    if (!this.items.length) list.append(el("li", "ui-results__empty", t(this.status === "pending" ? "results.allChecked" : "results.none")));
    for (const item of this.items) {
      const li = el("li");
      const row = el("button", `ui-results__item${item.type !== "project" && item.id === this.selected ? " is-on" : ""}`);
      row.type = "button";
      const icon = item.type === "report" ? "📊" : item.type === "project" ? "📋" : item.status === "failed" ? "⚠️" : item.review === "accepted" ? "✅" : item.review === "rejected" ? "↩" : "🆕";
      const top = el("div", "ui-results__top");
      top.append(el("span", "ui-results__icon", icon), el("span", "ui-results__title", item.title));
      const meta = el("div", "ui-results__meta");
      const people = item.type === "project" ? (item.members ?? []) : item.occupantId ? [item.occupantId] : [];
      for (const id of people.slice(0, 4)) meta.append(avatar(id, 16));
      meta.append(el("span", "", `${item.type !== "project" && item.occupantId ? this.ctx.nameOf(item.occupantId) : ""}${item.scheduled ? " · ⏰" : ""} · ${this.ctx.relativeTime(Date.parse(item.at))}`));
      row.append(top, meta, el("p", "ui-results__snippet", item.snippet));
      row.addEventListener("click", () => {
        if (item.type === "project") {
          this.dialog.close();
          this.ctx.openProject(item.id);
          return;
        }
        this.selected = item.id;
        if (item.type === "report") {
          this.report = this.reports.find((r) => r.id === item.id) ?? null;
          this.render();
          return;
        }
        this.showReject = false;
        this.rejecting = "";
        void this.load();
      });
      li.append(row);
      list.append(li);
    }

    const detail = el("div", "ui-results__detail");
    detail.append(this.detailView());
    body.replaceChildren(filters, list, detail);
    if (this.error) body.append(el("p", "ui-error ui-small", this.error));
    body.querySelector(".ui-results__list")!.scrollTop = listScroll;
    detail.scrollTop = scroll;
  }

  private detailView(): HTMLElement {
    const d = this.detail;
    const view = el("article", "ui-results__doc");
    if (this.status === "reports") {
      const r = this.report;
      if (!r) {
        view.append(el("p", "ui-faint", t("results.pick")));
        return view;
      }
      const head = el("header", "ui-results__head");
      head.append(el("h2", "ui-results__h", `📊 ${this.ctx.roomName(r.roomId)}`));
      if (r.author) head.append(avatar(r.author, 28), el("strong", "", this.ctx.nameOf(r.author)));
      else head.append(el("span", "ui-faint", t("hq.byOffice")));
      head.append(el("span", "ui-faint ui-small", this.ctx.relativeTime(Date.parse(r.createdAt))));
      view.append(head, renderMarkdown(r.content));
      return view;
    }
    if (!d) {
      view.append(el("p", "ui-faint", t("results.pick")));
      return view;
    }
    const task = d.task;

    // Who, when, and what was asked.
    const head = el("header", "ui-results__head");
    const who = el("button", "ui-proj__name");
    who.type = "button";
    who.append(avatar(task.occupantId, 28), el("strong", "", this.ctx.nameOf(task.occupantId)));
    who.addEventListener("click", () => {
      this.dialog.close();
      this.ctx.openAgent(task.occupantId);
    });
    head.append(el("h2", "ui-results__h", task.title), who, el("span", "ui-faint ui-small", this.ctx.relativeTime(Date.parse(task.finishedAt ?? task.createdAt))));
    view.append(head);
    const asked = el("details", "ui-proj__fold");
    asked.append(el("summary", "", t("results.asked")), el("p", "ui-taskcard__prompt", task.prompt.split("\n---\n")[0]));
    view.append(asked);

    // The department manager's check, and the versions sent back before this one.
    if (task.managerReview === "passed" && task.managerId) {
      const check = el("div", "ui-results__check");
      check.append(avatar(task.managerId, 20), el("strong", "", t("quality.checkedBy", { name: this.ctx.nameOf(task.managerId) })), el("span", "", task.managerNote));
      view.append(check);
    }
    if (d.rounds?.length) {
      const rounds = el("details", "ui-proj__fold");
      rounds.append(el("summary", "", t("quality.rounds", { n: String(d.rounds.length) })));
      const ul = el("ul", "ui-results__rounds");
      d.rounds.forEach((r, i) => {
        const li = el("li");
        const open = el("button", "ui-proj__name", t("quality.version", { n: String(i + 1) }));
        open.type = "button";
        open.addEventListener("click", () => {
          this.status = "all";
          this.selected = r.id;
          void this.load();
        });
        const who = r.by === "manager" ? t("quality.sentBackBy", { name: this.ctx.nameOf(r.managerId ?? "") }) : t("quality.sentBackByYou");
        li.append(open, el("span", "ui-faint", ` · ${who}：`), el("span", "", r.note || "—"));
        ul.append(li);
      });
      rounds.append(ul);
      view.append(rounds);
    }

    // The result, with what to do about it.
    if (task.status === "failed") view.append(el("p", "ui-error", `${t("task.failed")}: ${task.error}`));
    else view.append(renderMarkdown(task.result));
    view.append(taskFiles(task.id, `${task.status}:${task.finishedAt ?? ""}`), taskCost(task.id, `${task.status}:${task.finishedAt ?? ""}`), this.verdict(task, d));

    // What it read, and who helped: for checking.
    const sources = el("section", "ui-results__sources");
    sources.append(el("h3", "ui-sec__title", `🔗 ${t("results.sources")}`));
    if (!d.sources.length) sources.append(el("p", "ui-faint ui-small", t("results.noSources")));
    else {
      const ul = el("ol", "ui-results__links");
      for (const s of d.sources) {
        const li = el("li");
        const a = el("a", "", s.url);
        a.href = s.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.append(a);
        if (s.by !== task.occupantId) li.append(el("span", "ui-faint ui-small", ` · ${this.ctx.nameOf(s.by)}`));
        ul.append(li);
      }
      sources.append(ul);
    }
    if (d.helpers.length) {
      const helped = el("p", "ui-small ui-faint");
      helped.textContent = `${t("results.helpers")}: ${d.helpers.map((h) => `${this.ctx.nameOf(h.occupantId)}（${h.title}）`).join("、")}`;
      sources.append(helped);
    }
    view.append(sources);

    const steps = el("details", "ui-proj__fold");
    steps.append(el("summary", "", `${t("results.steps")} (${task.steps.length})`));
    const ol = el("ol", "ui-timeline");
    for (const s of task.steps) {
      const li = el("li", "ui-tl");
      li.append(el("span", "ui-tl__text", s.text), el("time", "ui-tl__time", this.ctx.relativeTime(Date.parse(s.at))));
      ol.append(li);
    }
    steps.append(ol);
    view.append(steps);
    return view;
  }

  /** Accept, send back with a reason, copy, download. */
  private verdict(task: Task, d: Detail) {
    const box = el("div", "ui-results__verdict");
    const row = el("div", "ui-review__row");
    const btn = (text: string, fn: () => void, cls = "") => {
      const b = el("button", `ui-btn ${cls}`.trim(), text);
      b.type = "button";
      b.addEventListener("click", fn);
      row.append(b);
      return b;
    };
    const review = (verdict: "accepted" | "rejected", note = "") =>
      void api("POST", `/api/tasks/${task.id}/review`, { verdict, note })
        .then(() => {
          this.showReject = false;
          this.rejecting = "";
          // Move on to the next one waiting.
          if (this.status === "pending") this.selected = null;
          return this.load();
        })
        .catch((err: Error) => {
          this.error = err.message;
          this.render();
        });
    if (task.status === "done" && !task.review) {
      btn(`👍 ${t("review.accept")}`, () => review("accepted"), "ui-btn--primary");
      btn(`↩ ${t("review.reject")}`, () => {
        this.showReject = !this.showReject;
        this.render();
      });
    } else if (task.review === "accepted") row.append(el("span", "ui-review__done", t("review.accepted")));
    else if (task.review === "rejected") {
      row.append(el("span", "ui-review__back", t("review.rejected", { note: task.reviewNote || "—" })));
      if (d.redoneBy !== null) {
        const id = d.redoneBy;
        btn(`${t("results.redo")} →`, () => {
          this.selected = id;
          void this.load();
        });
      }
    }
    if (task.result) {
      const copy = btn(t("drawer.copy"), () => void navigator.clipboard.writeText(task.result).then(() => (copy.textContent = t("drawer.copied"))));
      btn(t("results.download"), () => {
        const url = URL.createObjectURL(new Blob([`# ${task.title}\n\n${task.result}\n`], { type: "text/markdown" }));
        const a = el("a");
        a.href = url;
        a.download = `${task.title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "result"}.md`;
        a.click();
        URL.revokeObjectURL(url);
      });
    }
    box.append(row);
    if (this.showReject) {
      const input = el("textarea", "ui-composer__input");
      input.rows = 3;
      input.placeholder = t("review.reasonPlaceholder");
      input.value = this.rejecting;
      input.addEventListener("input", () => (this.rejecting = input.value));
      const send = el("button", "ui-btn ui-btn--primary", t("review.send"));
      send.type = "button";
      send.addEventListener("click", () => review("rejected", this.rejecting.trim()));
      box.append(input, send);
      window.setTimeout(() => input.focus(), 0);
    }
    return box;
  }
}
