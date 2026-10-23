import { teamTable, type Profile } from "./profile-ui";
import { costPanel, type CostData } from "./costs-ui";
import { api, tokenStore, Unauthorized } from "./auth";
import { characterSeed } from "./floor/art-habblaud";
import { InboxView } from "./governance-ui";
import { language, t } from "./i18n";
import { renderMarkdown } from "./markdown";
import type { Dashboard, Decision, DelegationCategory, DepartmentView, Inbox, Occupant, OrgSettings, Report } from "./types";
import { avatarCanvas } from "./vendor/habblaud/art/index";

/**
 * The company in the page: Settings → Organization (switch it on, the chairman, a manager per
 * department, when reports are made), and the chairman's desk (every department at a glance with its
 * latest report, work for a department, and everything that waits for you).
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function avatar(id: string, size = 22) {
  const img = document.createElement("img");
  img.src = avatarCanvas(characterSeed(id), { scale: 2 }).toDataURL();
  img.alt = "";
  img.width = size;
  img.height = size;
  img.className = "ui-proj__avatar";
  return img;
}

function btn(text: string, fn: () => void, cls = "ui-btn ui-btn--sm") {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}

/** "Mon" / "週一" / "月" for 0 = Sunday … 6 = Saturday (25 Oct 2026 was a Sunday). */
const dayName = (d: number) => new Intl.DateTimeFormat(language(), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 25 + d)));

/** Turns [#12] and [project #3] in a report into links. */
function linkRefs(root: HTMLElement, open: { task: (id: number) => void; project: (id: number) => void }) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\[(project )?#\d+\]/.test((n as Text).data)) nodes.push(n as Text);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of node.data.matchAll(/\[(project )?#(\d+)\]/g)) {
      frag.append(document.createTextNode(node.data.slice(last, m.index)));
      const id = Number(m[2]);
      const link = el("button", "ui-ref", m[0]);
      link.type = "button";
      link.addEventListener("click", () => (m[1] ? open.project(id) : open.task(id)));
      frag.append(link);
      last = (m.index ?? 0) + m[0].length;
    }
    frag.append(document.createTextNode(node.data.slice(last)));
    node.replaceWith(frag);
  }
}

type Guard = <T>(status: Element | null, fn: () => Promise<T>) => Promise<T | undefined>;

/** "Search the web", "Experience drafts"… for a delegation category. */
export const categoryLabel = (key: string) => (key.startsWith("approval:") ? t(`policy.${key.slice(9)}`) : t(`ceo.cat.${key}`));

interface OrgView {
  org: OrgSettings;
  hasSuite: boolean;
  departments: { id: string; name: string; hue: number; manager: string | null; members: string[] }[];
}

/** Settings → Organization. Every change saves at once (with your time zone and the page's language). */
export class OrgTab {
  constructor(
    private root: HTMLElement,
    private guard: Guard,
    private occupants: () => Occupant[],
  ) {}

  private async save(patch: Partial<OrgSettings>, status: Element) {
    const body = { ...patch, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: language() };
    const res = await this.guard(status, () => api("PUT", "/api/org", body));
    if (res) {
      status.textContent = t("org.saved");
      status.className = "status status--ok";
    }
    return res;
  }

  async render() {
    const [res, ceoInfo] = await Promise.all([
      this.guard(null, () => api<OrgView>("GET", "/api/org")),
      this.guard(null, () => api<{ categories: DelegationCategory[] }>("GET", "/api/org/ceo")),
    ]);
    if (!res) return;
    const { org } = res;
    const status = el("span", "status");
    const name = (id: string) => this.occupants().find((o) => o.id === id)?.name ?? id;

    const enabled = el("label", "checkbox");
    const check = el("input");
    check.type = "checkbox";
    check.checked = org.enabled;
    check.addEventListener("change", () => void this.save({ enabled: check.checked }, status).then(() => this.render()));
    enabled.append(check, el("span", "", t("org.enabled")));

    const chairman = el("select");
    chairman.append(new Option(t("org.none"), ""), ...this.occupants().map((o) => new Option(o.name, o.id, false, o.id === org.chairman)));
    chairman.addEventListener("change", () => void this.save({ chairman: chairman.value || null }, status));
    const chairRow = el("label");
    chairRow.append(el("span", "", t("org.chairman")), chairman);

    // The CEO, and what it may decide for you.
    const ceo = el("select");
    ceo.append(new Option(t("org.ceoNone"), ""), ...this.occupants().filter((o) => o.kind === "agent" && o.id !== org.chairman).map((o) => new Option(o.name, o.id, false, o.id === org.ceo)));
    ceo.addEventListener("change", () => void this.save({ ceo: ceo.value || null }, status).then(() => this.render()));
    const ceoRow = el("label");
    ceoRow.append(el("span", "", t("org.ceo")), ceo);
    const ceoPerson = org.ceo ? this.occupants().find((o) => o.id === org.ceo) : undefined;
    if (ceoPerson && !ceoPerson.model) ceoRow.append(el("small", "help", t("org.ceoNeedsModel")));
    const delegation = el("div", "ui-org__delegation");
    if (org.ceo && ceoInfo) {
      delegation.append(el("h4", "", t("org.delegation")), el("p", "help", t("org.delegationIntro")));
      const table = el("table", "ui-org__table");
      const head = el("tr");
      head.append(el("th", "", ""), el("th", "", t("org.delegate")), el("th", "", t("org.limit")), el("th", "", t("org.highRisk")));
      table.append(head);
      const saveDelegation = () => void this.save({ delegation: org.delegation, highRisk: org.highRisk }, status);
      for (const c of ceoInfo.categories) {
        const tr = el("tr");
        const name = el("td");
        name.append(el("div", "", categoryLabel(c.key)), el("small", "help", t("org.record", { n: String(c.decided), streak: String(c.streak) })));
        const on = el("input");
        on.type = "checkbox";
        on.checked = c.delegated;
        on.disabled = c.highRisk;
        const limit = el("input");
        limit.type = "number";
        limit.min = "1";
        limit.max = "200";
        limit.value = String(c.dailyLimit);
        limit.className = "ui-org__limit";
        const risky = el("input");
        risky.type = "checkbox";
        risky.checked = c.highRisk;
        on.addEventListener("change", () => {
          org.delegation = { ...org.delegation, [c.key]: { enabled: on.checked, dailyLimit: Number(limit.value) || 10 } };
          saveDelegation();
        });
        limit.addEventListener("change", () => {
          org.delegation = { ...org.delegation, [c.key]: { enabled: on.checked, dailyLimit: Math.max(1, Math.min(200, Number(limit.value) || 10)) } };
          saveDelegation();
        });
        risky.addEventListener("change", () => {
          org.highRisk = risky.checked ? [...new Set([...org.highRisk, c.key])] : org.highRisk.filter((k) => k !== c.key);
          on.disabled = risky.checked;
          saveDelegation();
        });
        const cell = (input: HTMLElement) => {
          const td = el("td");
          td.append(input);
          return td;
        };
        tr.append(name, cell(on), cell(limit), cell(risky));
        table.append(tr);
      }
      delegation.append(table);
    }

    const suite = el("div", "row");
    if (!res.hasSuite) {
      suite.append(
        el("small", "help", t("org.suite")),
        btn(t("org.addSuite"), () => void this.guard(status, () => api("POST", "/api/org/suite")).then(() => this.render()), "small"),
      );
    }

    const list = el("ul", "manage-list");
    for (const d of res.departments) {
      const select = el("select");
      select.append(new Option(t("org.noManager"), ""), ...d.members.map((id) => new Option(name(id), id, false, id === org.managers[d.id])));
      select.addEventListener("change", () => {
        const managers = { ...org.managers };
        if (select.value) managers[d.id] = select.value;
        else delete managers[d.id];
        org.managers = managers;
        void this.save({ managers }, status);
      });
      const li = el("li", "occupant-item");
      const row = el("div", "occupant-row");
      const info = el("div", "occupant-info");
      info.append(el("strong", "", d.name), el("small", "help", t("org.members", { n: String(d.members.length) })));
      // The manager checks members' work before it reaches you.
      const review = el("label", "check org-review");
      const box = el("input");
      box.type = "checkbox";
      box.checked = !!org.managerReview?.[d.id];
      box.disabled = !org.managers[d.id];
      box.title = t("org.reviewHelp");
      box.addEventListener("change", () => {
        org.managerReview = { ...(org.managerReview ?? {}), [d.id]: box.checked };
        void this.save({ managerReview: org.managerReview }, status);
      });
      review.append(box, el("span", "", t("org.review")));
      row.append(info, select, review);
      li.append(row);
      list.append(li);
    }

    const time = el("input");
    time.type = "time";
    time.value = org.reportTime;
    time.addEventListener("change", () => time.value && void this.save({ reportTime: time.value }, status));
    const days = el("div", "ui-sched__days");
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      const chip = el("button", `ui-sched__day${org.reportDays.includes(d) ? " is-on" : ""}`, dayName(d));
      chip.type = "button";
      chip.addEventListener("click", () => {
        org.reportDays = org.reportDays.includes(d) ? org.reportDays.filter((x) => x !== d) : [...org.reportDays, d];
        chip.classList.toggle("is-on");
        void this.save({ reportDays: org.reportDays }, status);
      });
      days.append(chip);
    }
    const timeRow = el("label");
    timeRow.append(el("span", "", t("org.reportTime")), time);
    const daysRow = el("div", "ui-org__days");
    daysRow.append(el("span", "", t("org.reportDays")), days);

    const run = btn(
      t("org.runNow"),
      () =>
        void this.guard(status, () => api<{ reports: Report[] }>("POST", "/api/org/reports", {})).then((r) => {
          if (!r) return;
          status.textContent = t("org.ran", { n: String(r.reports.length) });
          status.className = "status status--ok";
        }),
      "small",
    );

    this.root.replaceChildren(
      el("p", "help", t("org.intro")),
      enabled,
      ...(org.enabled ? [chairRow, ceoRow, suite, el("h4", "", t("org.departments")), el("small", "help", t("org.reviewIntro")), list, timeRow, daysRow, delegation, el("div", "row")] : []),
      el("div", "row"),
    );
    const last = this.root.lastElementChild!;
    if (org.enabled) last.append(run);
    last.append(status);
  }
}

export interface HeadquartersContext {
  occupants: () => Occupant[];
  nameOf: (id: string) => string;
  relativeTime: (at: number) => string;
  unlock: () => Promise<void>;
  openAgent: (id: string) => void;
  openProject: (id: number) => void;
  openResult: (taskId?: number) => void;
  openOrgSettings: () => void;
  openCostSettings: () => void;
}

/** The chairman's desk: a wide dialog over the office. */
export class Headquarters {
  private dialog = document.getElementById("hq") as HTMLDialogElement;
  private data: Dashboard | null = null;
  private costs: CostData | null = null;
  private team: Profile[] | null = null;
  private inbox: Inbox | null = null;
  private history: { room: DepartmentView; reports: Report[]; selected: number | null } | null = null;
  private assigning: { room: string; text: string; note: string } | null = null;
  private expanded = new Set<string>();
  private error = "";
  private inboxView: InboxView;

  constructor(private ctx: HeadquartersContext) {
    this.inboxView = new InboxView({
      nameOf: ctx.nameOf,
      waiting: () => ctx.occupants().filter((o) => o.state === "waiting"),
      openAgent: (id) => {
        this.dialog.close();
        ctx.openAgent(id);
      },
      openProject: (id) => {
        this.dialog.close();
        ctx.openProject(id);
      },
      reload: () => void this.load(),
    });
    document.getElementById("hq-close")?.addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  close() {
    this.dialog.close();
  }

  async open() {
    if (!tokenStore.get()) {
      await this.ctx.unlock().catch(() => {});
      if (!tokenStore.get()) return;
    }
    this.history = null;
    if (!this.dialog.open) this.dialog.showModal();
    await this.load();
  }

  /** Something changed (a report, the inbox, a task): reload if open. */
  changed() {
    if (this.dialog.open) void this.load();
  }

  private async load() {
    try {
      const [data, inbox, costs, team] = await Promise.all([
        api<Dashboard>("GET", "/api/org/dashboard"),
        api<Inbox>("GET", "/api/inbox"),
        api<CostData>("GET", "/api/costs?days=14").catch(() => null),
        api<{ profiles: Profile[] }>("GET", "/api/profiles").catch(() => null),
      ]);
      this.team = team?.profiles ?? null;
      this.data = data;
      this.inbox = inbox;
      this.costs = costs;
      if (this.history) {
        const room = this.history.room.id;
        const res = await api<{ reports: Report[] }>("GET", `/api/org/reports?room=${encodeURIComponent(room)}&limit=60`);
        this.history.reports = res.reports;
        this.history.selected ??= res.reports[0]?.id ?? null;
      }
      this.error = "";
    } catch (err) {
      this.error = err instanceof Unauthorized ? t("drawer.unlockToGive") : (err as Error).message;
    }
    this.render();
  }

  private report(r: Report) {
    const box = el("div", "ui-hq__report");
    const meta = el("div", "ui-hq__meta");
    if (r.author) meta.append(avatar(r.author, 16), el("span", "", this.ctx.nameOf(r.author)));
    else meta.append(el("span", "", `🧮 ${t("hq.byOffice")}`));
    meta.append(el("span", "ui-faint", `· ${this.ctx.relativeTime(Date.parse(r.createdAt))}`));
    const body = renderMarkdown(r.content);
    linkRefs(body, {
      task: (id) => {
        this.dialog.close();
        this.ctx.openResult(id);
      },
      project: (id) => {
        this.dialog.close();
        this.ctx.openProject(id);
      },
    });
    box.append(meta, body);
    return box;
  }

  private render() {
    const body = this.dialog.querySelector<HTMLElement>(".ui-hq__body")!;
    const scroll = body.scrollTop;
    const d = this.data;
    if (!d) {
      body.replaceChildren(el("p", "ui-faint", this.error || t("drawer.loading")));
      return;
    }
    if (this.history) return this.renderHistory(body);

    const view = el("div", "ui-hq");
    if (!d.org.enabled) {
      const note = el("div", "ui-hq__note");
      note.append(el("span", "", t("hq.disabled")), btn(t("hq.settings"), () => this.ctx.openOrgSettings()));
      view.append(note);
    }

    // Today, across the company.
    const sum = (k: keyof DepartmentView["stats"]) => d.departments.reduce((n, x) => n + x.stats[k], 0);
    const tiles = el("div", "ui-hq__tiles");
    const tile = (value: string, label: string, cls = "") => {
      const box = el("div", `ui-hq__tile ${cls}`.trim());
      box.append(el("span", "ui-hq__value", value), el("span", "ui-hq__label", label));
      tiles.append(box);
    };
    tile(`${sum("working")}/${sum("total")}`, t("hq.working"));
    tile(String(sum("doneToday")), t("hq.done"));
    tile(String(sum("open")), t("hq.openTasks"));
    tile(String(d.unchecked), t("hq.unchecked"), d.unchecked ? "is-warn" : "");
    tile(String(d.inbox), t("hq.approvals"), d.inbox ? "is-warn" : "");
    if (sum("failedToday")) tile(String(sum("failedToday")), t("hq.failed"), "is-bad");
    view.append(el("h3", "ui-hq__h", t("hq.today")), tiles);
    if (this.costs) view.append(costPanel(this.costs, { nameOf: this.ctx.nameOf, openSettings: () => this.ctx.openCostSettings() }));

    if (d.company) {
      const company = el("section", "ui-hq__company");
      company.append(el("h3", "ui-hq__h", `🏢 ${t("hq.company")}`), this.report(d.company));
      view.append(company);
    }

    const columns = el("div", "ui-hq__cols");
    const left = el("section", "ui-hq__depts");
    left.append(el("h3", "ui-hq__h", t("hq.departments")));
    for (const dept of d.departments) left.append(this.card(dept));
    const right = el("section", "ui-hq__side");
    right.append(el("h3", "ui-hq__h", t("hq.needsMe")));
    if (d.unchecked) right.append(btn(t("hq.checkResults", { n: String(d.unchecked) }), () => {
      this.dialog.close();
      this.ctx.openResult();
    }, "ui-btn ui-hq__results"));
    if (this.inbox) {
      const inbox = this.inboxView.render(this.inbox);
      inbox.querySelector(".ui-hero__name")?.remove();
      right.append(inbox);
    }
    if (d.org.ceo) right.append(this.decisions(d.decisions));
    columns.append(left, right);
    view.append(columns);
    if (this.team) {
      view.append(
        teamTable(this.team, {
          roomName: (id) => d.departments.find((x) => x.id === id)?.name ?? id,
          openAgent: (id) => {
            this.dialog.close();
            this.ctx.openAgent(id);
          },
        }),
      );
    }
    if (this.error) view.append(el("p", "ui-error ui-small", this.error));
    body.replaceChildren(view);
    body.scrollTop = scroll;
  }

  /** What the CEO decided for you, with its reasons and precedents; approvals and denials can be overruled. */
  private decisions(list: Decision[]) {
    const box = el("section", "ui-hq__decisions");
    box.append(el("h3", "ui-hq__h", `👔 ${t("hq.decisions")}`));
    if (!list.length) box.append(el("p", "ui-faint ui-small", t("hq.noDecisions")));
    for (const dec of list) {
      const card = el("div", `ui-inbox__card ui-hq__decision is-${dec.decision}${dec.overruledBy ? " is-overruled" : ""}`);
      const head = el("div", "ui-inbox__head");
      const icon = dec.decision === "approve" ? "✅" : dec.decision === "deny" ? "🚫" : "↗️";
      head.append(el("strong", "", `${icon} ${t(`hq.decision.${dec.decision}`)}`), el("span", "ui-inbox__tag", categoryLabel(dec.category)));
      card.append(head, el("p", "ui-inbox__text", dec.summary));
      if (dec.reason) card.append(el("p", "ui-inbox__applies", dec.reason));
      const meta = el("div", "ui-hq__meta");
      meta.append(el("span", "ui-faint", this.ctx.relativeTime(Date.parse(dec.createdAt))));
      if (dec.precedents.length) meta.append(el("span", "ui-faint", `· ${t("hq.precedents")} ${dec.precedents.map((p) => `#${p}`).join(" ")}`));
      card.append(meta);
      if (dec.overruledBy) card.append(el("span", "ui-review__back", t("hq.overruled")));
      else if (dec.decision !== "escalate") {
        card.append(
          btn(t("hq.overrule"), () => {
            const note = prompt(t("hq.overrulePrompt"));
            if (note === null) return;
            void api<{ message: string }>("POST", `/api/org/ceo/decisions/${dec.id}/overrule`, { note })
              .then((r) => {
                this.error = t("hq.overruleDone", { extra: r.message ? `（${r.message}）` : "" });
                return this.load();
              })
              .catch((err: Error) => {
                this.error = err.message;
                this.render();
              });
          }),
        );
      }
      box.append(card);
    }
    return box;
  }

  private card(dept: DepartmentView) {
    const card = el("article", "ui-hq__card");
    card.style.setProperty("--hue", String(dept.hue));
    const head = el("header", "ui-hq__cardhead");
    head.append(el("h4", "", dept.name));
    const who = el("div", "ui-hq__manager");
    if (dept.manager) {
      const m = el("button", "ui-proj__name");
      m.type = "button";
      m.append(avatar(dept.manager, 20), el("span", "", `${this.ctx.nameOf(dept.manager)} · ${t("org.manager")}`));
      m.addEventListener("click", () => {
        this.dialog.close();
        this.ctx.openAgent(dept.manager!);
      });
      who.append(m);
    } else who.append(el("span", "ui-faint ui-small", t("hq.noManager")));
    const faces = el("div", "ui-projects__faces");
    for (const id of dept.members.slice(0, 8)) faces.append(avatar(id, 18));
    head.append(who, faces);
    card.append(head);

    const s = dept.stats;
    const chips = el("div", "ui-hq__chips");
    const chip = (text: string, cls = "") => chips.append(el("span", `ui-hq__chip ${cls}`.trim(), text));
    chip(`${t("hq.working")} ${s.working}/${s.total}`);
    chip(`${t("hq.done")} ${s.doneToday}`);
    chip(`${t("hq.openTasks")} ${s.open}`);
    if (s.unchecked) chip(`${t("hq.unchecked")} ${s.unchecked}`, "is-warn");
    if (s.approvals) chip(`${t("hq.approvals")} ${s.approvals}`, "is-warn");
    if (s.failedToday) chip(`${t("hq.failed")} ${s.failedToday}`, "is-bad");
    card.append(chips);

    if (dept.latest) {
      const r = this.report(dept.latest);
      if (!this.expanded.has(dept.id)) r.classList.add("is-clipped");
      r.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        if (this.expanded.has(dept.id)) this.expanded.delete(dept.id);
        else this.expanded.add(dept.id);
        this.render();
      });
      card.append(r);
    } else card.append(el("p", "ui-faint ui-small", t("hq.noReport")));

    const actions = el("div", "ui-hq__actions");
    if (dept.manager) actions.append(btn(t("hq.assign"), () => {
      this.assigning = this.assigning?.room === dept.id ? null : { room: dept.id, text: "", note: "" };
      this.render();
    }));
    actions.append(
      btn(t("hq.makeReport"), () => void api("POST", "/api/org/reports", { room: dept.id }).then(() => this.load()).catch((err: Error) => ((this.error = err.message), this.render()))),
      btn(t("hq.history"), () => {
        this.history = { room: dept, reports: [], selected: null };
        void this.load();
      }),
    );
    card.append(actions);

    if (this.assigning?.room === dept.id && dept.manager) {
      const a = this.assigning;
      const form = el("div", "ui-hq__assign");
      const input = el("textarea", "ui-composer__input");
      input.rows = 3;
      input.placeholder = t("hq.assignPlaceholder", { room: dept.name, manager: this.ctx.nameOf(dept.manager) });
      input.value = a.text;
      input.addEventListener("input", () => (a.text = input.value));
      const send = btn(t("hq.send"), () => {
        if (!a.text.trim()) return;
        void api("POST", `/api/departments/${encodeURIComponent(dept.id)}/tasks`, { prompt: a.text.trim() })
          .then(() => {
            this.assigning = { room: dept.id, text: "", note: t("hq.sent", { manager: this.ctx.nameOf(dept.manager!) }) };
            return this.load();
          })
          .catch((err: Error) => {
            a.note = err.message;
            this.render();
          });
      }, "ui-btn ui-btn--sm ui-btn--primary");
      form.append(input, send);
      if (a.note) form.append(el("span", "ui-small ui-faint", a.note));
      card.append(form);
      window.setTimeout(() => input.focus(), 0);
    }
    return card;
  }

  private renderHistory(body: HTMLElement) {
    const h = this.history!;
    const view = el("div", "ui-hq ui-hq__history");
    const head = el("div", "ui-hq__histhead");
    head.append(btn(t("hq.back"), () => {
      this.history = null;
      this.render();
    }), el("h3", "ui-hq__h", `${h.room.name} · ${t("hq.history")}`));
    const list = el("ul", "ui-results__list");
    for (const r of h.reports) {
      const li = el("li");
      const row = el("button", `ui-results__item${r.id === h.selected ? " is-on" : ""}`);
      row.type = "button";
      const date = new Intl.DateTimeFormat(language(), { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(r.createdAt));
      row.append(el("span", "ui-results__title", date), el("span", "ui-results__meta", r.author ? this.ctx.nameOf(r.author) : t("hq.byOffice")));
      row.addEventListener("click", () => {
        h.selected = r.id;
        this.render();
      });
      li.append(row);
      list.append(li);
    }
    if (!h.reports.length) list.append(el("li", "ui-results__empty", t("hq.noReport")));
    const selected = h.reports.find((r) => r.id === h.selected);
    const detail = el("div", "ui-results__detail");
    if (selected) detail.append(this.report(selected));
    const grid = el("div", "ui-hq__histgrid");
    grid.append(list, detail);
    view.append(head, grid);
    body.replaceChildren(view);
  }
}
