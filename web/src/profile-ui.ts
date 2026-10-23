import { money } from "./costs-ui";
import { t } from "./i18n";

/** Employee profiles: one person's record (in their workstation), and the whole team at the chairman's desk. */

export interface Tally {
  key: string;
  name: string;
  done: number;
  accepted: number;
  rejected: number;
}

export interface Profile {
  id: string;
  name: string;
  role: string;
  model: string | null;
  lightModel: string | null;
  room: string | null;
  days: number;
  done: number;
  failed: number;
  open: number;
  accepted: number;
  rejected: number;
  acceptance: number | null;
  firstTry: number | null;
  managerPassed: number;
  managerSentBack: number;
  helped: number;
  projectTurns: number;
  avgMinutes: number | null;
  cost: number;
  costPerTask: number | null;
  skills: Tally[];
  kinds: Tally[];
  reasons: { taskId: number; title: string; by: "you" | "manager"; note: string; at: string }[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const minutes = (n: number | null) => (n === null ? "—" : n < 1 ? "<1 min" : n < 90 ? `${Math.round(n)} min` : `${(n / 60).toFixed(1)} h`);

/** Acceptance as a word and a class: good from 80%, watch below 60%. */
function grade(p: Profile) {
  if (p.acceptance === null) return { cls: "", label: t("profile.noReviews") };
  if (p.acceptance >= 0.8) return { cls: "is-good", label: t("profile.good") };
  if (p.acceptance >= 0.6) return { cls: "", label: t("profile.ok") };
  return { cls: "is-bad", label: t("profile.watch") };
}

/** One person's record. */
export function profileCard(p: Profile, ctx: { openResult: (taskId: number) => void }) {
  const box = el("div", "ui-profile");
  const tiles = el("div", "ui-profile__tiles");
  const tile = (value: string, label: string, cls = "") => {
    const b = el("div", `ui-profile__tile ${cls}`.trim());
    b.append(el("strong", "", value), el("span", "", label));
    tiles.append(b);
  };
  const g = grade(p);
  tile(pct(p.acceptance), t("profile.acceptance"), g.cls);
  tile(pct(p.firstTry), t("profile.firstTry"));
  tile(String(p.done), t("profile.done"));
  tile(String(p.rejected + p.managerSentBack), t("profile.sentBack"), p.rejected + p.managerSentBack ? "is-warn" : "");
  tile(money(p.cost), t("profile.cost"));
  tile(minutes(p.avgMinutes), t("profile.avgTime"));
  box.append(el("p", "ui-faint ui-small", t("profile.period", { days: String(p.days), grade: g.label })), tiles);

  const facts = [
    p.managerPassed || p.managerSentBack ? t("profile.manager", { passed: String(p.managerPassed), back: String(p.managerSentBack) }) : "",
    p.helped ? t("profile.helped", { n: String(p.helped) }) : "",
    p.projectTurns ? t("profile.turns", { n: String(p.projectTurns) }) : "",
    p.failed ? t("profile.failed", { n: String(p.failed) }) : "",
    p.costPerTask !== null && p.cost ? t("profile.perTask", { cost: money(p.costPerTask) }) : "",
  ].filter(Boolean);
  if (facts.length) box.append(el("p", "ui-small", facts.join(" · ")));

  // What goes well: skills by accepted work.
  if (p.skills.length) {
    box.append(el("h4", "ui-profile__h", t("profile.skills")));
    const ul = el("ul", "ui-profile__skills");
    for (const s of p.skills) {
      const li = el("li");
      const rate = s.accepted + s.rejected ? Math.round((s.accepted / (s.accepted + s.rejected)) * 100) : null;
      li.append(el("span", "", s.name), el("small", "ui-faint", `${t("profile.skillUse", { n: String(s.done) })}${rate === null ? "" : ` · ${rate}%`}`));
      ul.append(li);
    }
    box.append(ul);
  }

  // Why work was sent back.
  if (p.reasons.length) {
    box.append(el("h4", "ui-profile__h", t("profile.reasons")));
    const ul = el("ul", "ui-profile__reasons");
    for (const r of p.reasons.slice(0, 5)) {
      const li = el("li");
      const open = el("button", "ui-proj__name", r.title);
      open.type = "button";
      open.addEventListener("click", () => ctx.openResult(r.taskId));
      li.append(el("span", "ui-inbox__tag", r.by === "you" ? t("profile.byYou") : t("profile.byManager")), open, el("span", "ui-faint", r.note || "—"));
      ul.append(li);
    }
    box.append(ul);
  }
  if (!p.done && !p.failed && !p.helped && !p.projectTurns) box.append(el("p", "ui-faint ui-small", t("profile.empty")));
  return box;
}

/** The team at a glance, at the chairman's desk: click a row for the person. */
export function teamTable(list: Profile[], ctx: { roomName: (id: string) => string; openAgent: (id: string) => void }) {
  const sec = el("section", "ui-team");
  sec.append(el("h3", "ui-hq__h", `👥 ${t("profile.team")}`));
  if (!list.length) {
    sec.append(el("p", "ui-faint ui-small", t("profile.noTeam")));
    return sec;
  }
  const wrap = el("div", "ui-team__wrap");
  const table = el("table", "ui-team__table");
  const head = el("tr");
  for (const h of ["profile.name", "profile.dept", "profile.model", "profile.done", "profile.acceptance", "profile.sentBack", "profile.cost"]) head.append(el("th", "", t(h)));
  table.append(head);
  for (const p of [...list].sort((a, b) => (a.acceptance ?? 2) - (b.acceptance ?? 2) || b.done - a.done)) {
    const tr = el("tr");
    tr.tabIndex = 0;
    tr.addEventListener("click", () => ctx.openAgent(p.id));
    tr.addEventListener("keydown", (e) => e.key === "Enter" && ctx.openAgent(p.id));
    const name = el("td");
    name.append(el("strong", "", p.name), el("small", "ui-faint", p.role));
    const g = grade(p);
    tr.append(
      name,
      el("td", "", p.room ? ctx.roomName(p.room) : "—"),
      el("td", "ui-team__model", `${p.model ?? "—"}${p.lightModel ? ` / ${p.lightModel}` : ""}`),
      el("td", "ui-team__num", String(p.done)),
      el("td", `ui-team__num ${g.cls}`.trim(), pct(p.acceptance)),
      el("td", "ui-team__num", String(p.rejected + p.managerSentBack)),
      el("td", "ui-team__num", money(p.cost)),
    );
    table.append(tr);
  }
  wrap.append(table);
  sec.append(wrap, el("p", "ui-faint ui-small", t("profile.teamHelp")));
  return sec;
}
