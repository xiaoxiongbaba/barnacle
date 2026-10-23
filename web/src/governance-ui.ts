import { api } from "./auth";
import { characterSeed } from "./floor/art-habblaud";
import { t } from "./i18n";
import { renderMarkdown } from "./markdown";
import type { Experience, Inbox, Occupant } from "./types";
import { avatarCanvas } from "./vendor/habblaud/art/index";

/**
 * Keeping agents in check, in the page: the inbox of everything that waits for you (approvals, projects
 * that asked you something, experience drafts, skill proposals), the permissions tab and the experience
 * library tab in Settings.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, fn: () => void, cls = "") {
  const b = el("button", `ui-btn ui-btn--sm ${cls}`.trim(), text);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}

function who(id: string, name: string) {
  const span = el("span", "ui-inbox__who");
  const img = document.createElement("img");
  img.src = avatarCanvas(characterSeed(id), { scale: 2 }).toDataURL();
  img.alt = "";
  img.width = 18;
  img.height = 18;
  img.className = "ui-proj__avatar";
  span.append(img, el("strong", "", name));
  return span;
}

export interface InboxContext {
  nameOf: (id: string) => string;
  waiting: () => Occupant[];
  openAgent: (id: string) => void;
  openProject: (id: number) => void;
  reload: () => void;
}

/** The inbox in the drawer. Keeps notes you type across redraws. */
export class InboxView {
  private notes = new Map<string, string>();
  private assign = new Map<number, boolean>();
  private error = "";

  constructor(private ctx: InboxContext) {}

  private act(fn: () => Promise<unknown>, key?: string) {
    void fn()
      .then(() => {
        this.error = "";
        if (key) this.notes.delete(key);
      })
      .catch((err: Error) => (this.error = err.message))
      .finally(() => this.ctx.reload());
  }

  private note(key: string, placeholder: string) {
    const input = el("input", "ui-mem__input");
    input.placeholder = placeholder;
    input.value = this.notes.get(key) ?? "";
    input.addEventListener("input", () => this.notes.set(key, input.value));
    return input;
  }

  render(inbox: Inbox): HTMLElement {
    const view = el("div", "ui-drawer__view ui-inbox");
    view.append(el("h2", "ui-hero__name", `✋ ${t("inbox.title")}`));
    const section = (title: string, count: number) => {
      const sec = el("section", "ui-sec");
      const head = el("div", "ui-sec__head");
      head.append(el("h3", "ui-sec__title", title), el("span", "ui-sec__extra", String(count)));
      sec.append(head);
      view.append(sec);
      return sec;
    };
    const waiting = this.ctx.waiting().filter((o) => !inbox.approvals.some((a) => a.occupantId === o.id));
    if (!inbox.count && !waiting.length) view.append(el("p", "ui-faint", t("inbox.empty")));
    if (this.error) view.append(el("p", "ui-error ui-small", this.error));

    if (inbox.approvals.length) {
      const sec = section(t("inbox.approvals"), inbox.approvals.length);
      for (const a of inbox.approvals) {
        const card = el("div", "ui-inbox__card");
        const key = `a${a.id}`;
        const note = this.note(key, t("inbox.notePlaceholder"));
        const row = el("div", "ui-inbox__actions");
        row.append(
          button(t("inbox.approve"), () => this.act(() => api("POST", `/api/approvals/${a.id}`, { approve: true, note: this.notes.get(key) ?? "" }), key), "ui-btn--primary"),
          button(t("inbox.deny"), () => this.act(() => api("POST", `/api/approvals/${a.id}`, { approve: false, note: this.notes.get(key) ?? "" }), key)),
        );
        const head = el("div", "ui-inbox__head");
        const open = el("button", "ui-inbox__link");
        open.type = "button";
        open.append(who(a.occupantId, this.ctx.nameOf(a.occupantId)));
        open.addEventListener("click", () => this.ctx.openAgent(a.occupantId));
        head.append(open, el("span", "ui-inbox__tag", t(`policy.${a.action}`)));
        card.append(head, el("p", "ui-inbox__text", a.summary));
        const why = inbox.ceoNotes?.[`approval:${a.id}`];
        if (why) card.append(el("p", "ui-inbox__ceo", t("inbox.ceoNote", { note: why })));
        card.append(note, row);
        sec.append(card);
      }
    }

    if (inbox.projects.length) {
      const sec = section(t("inbox.projects"), inbox.projects.length);
      for (const p of inbox.projects) {
        const row = el("button", "ui-inbox__row");
        row.type = "button";
        row.append(el("span", "", `📋 ${p.title}`), el("span", "ui-inbox__go", `${t("inbox.open")} →`));
        row.addEventListener("click", () => this.ctx.openProject(p.id));
        sec.append(row);
      }
    }

    if (inbox.experiences.length) {
      const sec = section(t("inbox.experiences"), inbox.experiences.length);
      for (const e of inbox.experiences) {
        const card = el("div", "ui-inbox__card");
        const head = el("div", "ui-inbox__head");
        if (e.proposedBy) head.append(who(e.proposedBy, t("inbox.by", { name: this.ctx.nameOf(e.proposedBy) })));
        if (e.tags.length) head.append(el("span", "ui-inbox__tag", e.tags.join(" · ")));
        const body = renderMarkdown(e.body);
        const applies = el("p", "ui-inbox__applies", `📌 ${e.applicability}`);
        const row = el("div", "ui-inbox__actions");
        row.append(
          button(t("inbox.keep"), () => this.act(() => api("PUT", `/api/experiences/${e.id}`, { status: "approved" })), "ui-btn--primary"),
          button(t("inbox.reject"), () => this.act(() => api("PUT", `/api/experiences/${e.id}`, { status: "rejected" }))),
        );
        card.append(head, el("h4", "ui-inbox__title", e.title), body, applies);
        const why = inbox.ceoNotes?.[`experience:${e.id}`];
        if (why) card.append(el("p", "ui-inbox__ceo", t("inbox.ceoNote", { note: why })));
        card.append(row);
        sec.append(card);
      }
    }

    if (inbox.skills.length) {
      const sec = section(t("inbox.skills"), inbox.skills.length);
      for (const p of inbox.skills) {
        const card = el("div", "ui-inbox__card");
        const head = el("div", "ui-inbox__head");
        head.append(who(p.proposedBy, t("inbox.by", { name: this.ctx.nameOf(p.proposedBy) })), el("span", "ui-inbox__tag", p.skillId ? t("inbox.changeSkill", { name: p.name }) : t("inbox.newSkill")));
        card.append(head, el("h4", "ui-inbox__title", p.name), el("p", "ui-inbox__text", p.description));
        if (p.reason) card.append(el("p", "ui-inbox__applies", `${t("inbox.why")}：${p.reason}`));
        if (p.current?.editedByYou) card.append(el("p", "ui-inbox__warn", t("inbox.editedByYou")));
        const why = inbox.ceoNotes?.[`skill:${p.id}`];
        if (why) card.append(el("p", "ui-inbox__ceo", t("inbox.ceoNote", { note: why })));
        const body = el("details", "ui-proj__fold");
        body.append(el("summary", "", "SKILL.md"), el("pre", "ui-inbox__pre", p.body));
        card.append(body);
        if (!p.skillId) {
          const label = el("label", "ui-sched__check");
          const check = el("input");
          check.type = "checkbox";
          check.checked = this.assign.get(p.id) ?? true;
          check.addEventListener("change", () => this.assign.set(p.id, check.checked));
          label.append(check, el("span", "", t("inbox.assign", { name: this.ctx.nameOf(p.proposedBy) })));
          card.append(label);
        }
        const row = el("div", "ui-inbox__actions");
        row.append(
          button(t("inbox.saveSkill"), () => this.act(() => api("POST", `/api/skill-proposals/${p.id}`, { approve: true, assign: this.assign.get(p.id) ?? true })), "ui-btn--primary"),
          button(t("inbox.reject"), () => this.act(() => api("POST", `/api/skill-proposals/${p.id}`, { approve: false }))),
        );
        card.append(row);
        sec.append(card);
      }
    }

    if (waiting.length) {
      const sec = section(t("inbox.waiting"), waiting.length);
      for (const o of waiting) {
        const row = el("button", "ui-inbox__row");
        row.type = "button";
        row.append(who(o.id, o.name), el("span", "ui-inbox__text", o.detail));
        row.addEventListener("click", () => this.ctx.openAgent(o.id));
        sec.append(row);
      }
    }
    return view;
  }
}

type Guard = <T>(status: Element | null, fn: () => Promise<T>) => Promise<T | undefined>;

/** Settings → Permissions: allow / ask me / never, per action. */
export class PolicyTab {
  constructor(
    private root: HTMLElement,
    private guard: Guard,
  ) {}

  async render() {
    const res = await this.guard(null, () => api<{ defaults: Record<string, string>; policy: Record<string, string> }>("GET", "/api/policy"));
    if (!res) return;
    const status = el("span", "status");
    const policy = { ...res.policy };
    const list = el("ul", "manage-list");
    for (const [action, fallback] of Object.entries(res.defaults)) {
      const select = el("select");
      for (const rule of ["allow", "ask", "deny"]) select.append(new Option(t(`policy.${rule}`), rule, false, (policy[action] ?? fallback) === rule));
      select.addEventListener("change", () => {
        policy[action] = select.value;
        void this.guard(status, () => api("PUT", "/api/policy", { policy })).then((r) => {
          if (r) {
            status.textContent = t("policy.saved");
            status.className = "status status--ok";
          }
        });
      });
      const li = el("li", "occupant-item");
      const row = el("div", "occupant-row");
      row.append(el("span", "", t(`policy.${action}`)), select);
      li.append(row);
      list.append(li);
    }
    this.root.replaceChildren(el("p", "help", t("policy.intro")), list, status);
  }
}

/** Settings → Experience: the team's library (and drafts waiting for you). */
export class ExperienceTab {
  private open: number | "new" | null = null;

  constructor(
    private root: HTMLElement,
    private guard: Guard,
    private nameOf: (id: string) => string,
  ) {}

  async render() {
    const res = await this.guard(null, () => api<{ experiences: Experience[] }>("GET", "/api/experiences"));
    if (!res) return;
    const add = el("button", "primary small", t("exp.add"));
    add.type = "button";
    add.addEventListener("click", () => {
      this.open = "new";
      void this.render();
    });
    const list = el("ul", "manage-list");
    for (const e of res.experiences) {
      const li = el("li", "occupant-item");
      const info = el("div", "occupant-info");
      info.append(el("strong", "", e.title), el("small", "help", `${t(`exp.${e.status}`)}${e.proposedBy ? ` · ${t("inbox.by", { name: this.nameOf(e.proposedBy) })}` : ""} · ${e.applicability}`));
      const edit = el("button", "small", t("exp.edit"));
      edit.type = "button";
      edit.addEventListener("click", () => {
        this.open = this.open === e.id ? null : e.id;
        void this.render();
      });
      const row = el("div", "occupant-row");
      row.append(info, edit);
      li.append(row);
      if (this.open === e.id) li.append(this.editor(e));
      list.append(li);
    }
    this.root.replaceChildren(
      el("p", "help", t("exp.intro")),
      el("div", "row", undefined),
      ...(this.open === "new" ? [this.editor(null)] : [add]),
      res.experiences.length ? list : el("p", "help", t("exp.none")),
    );
  }

  private editor(e: Experience | null) {
    const box = el("div", "subform__body brain-editor");
    const status = el("span", "status");
    const field = (label: string, input: HTMLElement) => {
      const l = el("label");
      l.append(el("span", "", label), input);
      return l;
    };
    const title = el("input");
    title.maxLength = 120;
    title.value = e?.title ?? "";
    const body = el("textarea");
    body.rows = 6;
    body.value = e?.body ?? "";
    const applicability = el("textarea");
    applicability.rows = 2;
    applicability.value = e?.applicability ?? "";
    const tags = el("input");
    tags.value = e?.tags.join(", ") ?? "";
    const save = el("button", "primary small", t("exp.save"));
    save.type = "button";
    save.addEventListener("click", () => {
      const data = { title: title.value, body: body.value, applicability: applicability.value, tags: tags.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) };
      void this.guard(status, () => (e ? api("PUT", `/api/experiences/${e.id}`, { ...data, status: "approved" }) : api("POST", "/api/experiences", data))).then((r) => {
        if (!r) return;
        this.open = null;
        void this.render();
      });
    });
    const actions = el("div", "row");
    actions.append(save);
    if (e) {
      const del = el("button", "danger small", t("exp.delete"));
      del.type = "button";
      del.addEventListener("click", () => {
        void this.guard(status, () => api("DELETE", `/api/experiences/${e.id}`)).then((r) => {
          if (!r) return;
          this.open = null;
          void this.render();
        });
      });
      actions.append(del);
    }
    actions.append(status);
    box.append(field(t("exp.title"), title), field(t("exp.body"), body), field(t("exp.applicability"), applicability), field(t("exp.tags"), tags), actions);
    return box;
  }
}
