import { api, tokenStore, Unauthorized } from "./auth";
import { characterSeed } from "./floor/art-habblaud";
import { projectFiles } from "./files-ui";
import { t } from "./i18n";
import { renderMarkdown } from "./markdown";
import type { Occupant, Project, ProjectDetails, ProjectMessage } from "./types";
import { avatarCanvas } from "./vendor/habblaud/art/index";

/**
 * Projects in the page: the list in the sidebar, and the project view the drawer shows (the thread,
 * the plan, members' notes, and a composer where @mentions hand out the work).
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const STATUS_ICON: Record<Project["status"], string> = { planning: "🗺️", active: "⚙️", idle: "💤", closed: "✅" };

function avatar(id: string, size = 22) {
  const img = document.createElement("img");
  img.src = avatarCanvas(characterSeed(id), { scale: 2 }).toDataURL();
  img.alt = "";
  img.width = size;
  img.height = size;
  img.className = "ui-proj__avatar";
  return img;
}

/** The sidebar list. Titles need the token, so a locked page only says so. */
export class ProjectsList {
  private projects: Project[] | "locked" = [];
  private timer = 0;

  constructor(
    private root: HTMLElement,
    private opts: { onOpen: (id: number | "new") => void; unlock: () => Promise<void> },
  ) {}

  /** Something changed: reload soon (several changes in a row load once). */
  changed() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.load(), 300);
  }

  async load() {
    if (!tokenStore.get()) this.projects = "locked";
    else {
      try {
        this.projects = (await api<{ projects: Project[] }>("GET", "/api/projects")).projects;
      } catch (err) {
        if (err instanceof Unauthorized) this.projects = "locked";
      }
    }
    this.render();
  }

  private render() {
    const head = el("div", "ui-projects__head");
    head.append(el("span", "ui-projects__title", t("proj.title")));
    const add = el("button", "ui-btn ui-btn--sm", `＋ ${t("proj.new")}`);
    add.type = "button";
    add.addEventListener("click", () => this.opts.onOpen("new"));
    head.append(add);
    const body: HTMLElement[] = [];
    if (this.projects === "locked") {
      const unlock = el("button", "ui-link-btn", t("proj.unlock"));
      unlock.type = "button";
      unlock.addEventListener("click", () => void this.opts.unlock().then(() => this.load()));
      body.push(unlock);
      add.hidden = true;
    } else if (!this.projects.length) body.push(el("p", "ui-projects__empty", t("proj.empty")));
    else {
      const list = el("ul", "ui-projects__list");
      for (const p of this.projects) {
        const li = el("li");
        const row = el("button", `ui-projects__row is-${p.status}${p.needsYou ? " needs-you" : ""}`);
        row.type = "button";
        row.addEventListener("click", () => this.opts.onOpen(p.id));
        const faces = el("span", "ui-projects__faces");
        for (const id of p.members.slice(0, 4)) faces.append(avatar(id, 18));
        row.append(el("span", "ui-projects__icon", p.needsYou ? "✋" : STATUS_ICON[p.status]), el("span", "ui-projects__name", p.title), faces);
        row.title = p.needsYou ? t("proj.needsYou") : t(`proj.status.${p.status}`);
        li.append(row);
        list.append(li);
      }
      body.push(list);
    }
    this.root.replaceChildren(head, ...body);
  }
}

/** Name chips that insert an @mention into a text field. */
export function mentionChips(agents: Occupant[], target: HTMLTextAreaElement, onInput: (v: string) => void) {
  const row = el("div", "ui-proj__chips");
  row.title = t("proj.mentionHint");
  for (const a of agents) {
    const chip = el("button", "ui-proj__chip");
    chip.type = "button";
    chip.append(avatar(a.id, 16), el("span", "", `@${a.name}`));
    chip.addEventListener("click", () => {
      const pos = target.selectionStart ?? target.value.length;
      const before = target.value.slice(0, pos);
      const insert = `${before && !/\s$/.test(before) ? " " : ""}@${a.name} `;
      target.value = before + insert + target.value.slice(pos);
      onInput(target.value);
      target.focus();
      target.setSelectionRange(pos + insert.length, pos + insert.length);
    });
    row.append(chip);
  }
  return row;
}

export interface ProjectViewContext {
  /** Agents that can be mentioned (they have a model). */
  agents: () => Occupant[];
  nameOf: (id: string) => string;
  openAgent: (id: string) => void;
  /** Opens a project (after creating one). */
  openProject: (id: number) => void;
  /** Opens the schedule form (in the first member's panel) to repeat this project. */
  scheduleProject: (project: Project, message: string) => void;
  close: () => void;
  reload: () => void;
}

/** The project view in the drawer, and the form for a new project. Keeps what you type across redraws. */
export class ProjectView {
  private draft = { title: "", brief: "", message: "" };
  private reply = "";
  private editingBrief: string | null = null;
  private error = "";
  private busy = false;

  constructor(private ctx: ProjectViewContext) {}

  reset() {
    this.draft = { title: "", brief: "", message: "" };
    this.reply = "";
    this.editingBrief = null;
    this.error = "";
  }

  private mentionChips(target: HTMLTextAreaElement, onInput: (v: string) => void) {
    return mentionChips(this.ctx.agents(), target, onInput);
  }

  renderNew(): HTMLElement {
    const view = el("div", "ui-drawer__view ui-proj");
    view.append(el("h2", "ui-hero__name", t("proj.new")));
    if (!this.ctx.agents().length) {
      view.append(el("p", "ui-faint ui-small", t("proj.noAgents")));
      return view;
    }
    const form = el("form", "ui-proj__form");
    const label = (text: string, field: HTMLElement) => {
      const l = el("label", "ui-proj__label");
      l.append(el("span", "", text), field);
      return l;
    };
    const title = el("input", "ui-mem__input");
    title.maxLength = 80;
    title.placeholder = t("proj.namePlaceholder");
    title.value = this.draft.title;
    title.dataset.field = "proj-title";
    title.addEventListener("input", () => (this.draft.title = title.value));
    const brief = el("textarea", "ui-composer__input");
    brief.rows = 3;
    brief.maxLength = 8000;
    brief.placeholder = t("proj.briefPlaceholder");
    brief.value = this.draft.brief;
    brief.addEventListener("input", () => (this.draft.brief = brief.value));
    const message = el("textarea", "ui-composer__input");
    message.rows = 4;
    message.maxLength = 8000;
    message.placeholder = t("proj.messagePlaceholder");
    message.value = this.draft.message;
    message.addEventListener("input", () => (this.draft.message = message.value));
    const start = el("button", "ui-btn ui-btn--primary", t("proj.start"));
    start.type = "submit";
    start.disabled = this.busy;
    form.append(label(t("proj.name"), title), label(t("proj.brief"), brief), label(t("proj.message"), message), this.mentionChips(message, (v) => (this.draft.message = v)), start);
    if (this.error) form.append(el("p", "ui-error ui-small", this.error));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const body = { title: this.draft.title.trim(), brief: this.draft.brief, message: this.draft.message.trim() };
      if (!body.title || !body.message || this.busy) return;
      (document.activeElement as HTMLElement | null)?.blur();
      this.busy = true;
      void api<{ project: Project }>("POST", "/api/projects", body)
        .then((res) => {
          this.reset();
          this.ctx.openProject(res.project.id);
        })
        .catch((err: Error) => {
          this.error = err.message;
          this.ctx.reload();
        })
        .finally(() => (this.busy = false));
    });
    view.append(form);
    return view;
  }

  render(d: ProjectDetails, relativeTime: (at: number) => string): HTMLElement {
    const p = d.project;
    const view = el("div", "ui-drawer__view ui-proj");

    // Title, status, members.
    const hero = el("div", "ui-proj__hero");
    hero.append(el("h2", "ui-hero__name", p.title));
    const status = el("span", `ui-proj__status is-${p.status}${p.needsYou ? " needs-you" : ""}`, `${p.needsYou ? "✋" : STATUS_ICON[p.status]} ${p.needsYou ? t("proj.needsYou") : t(`proj.status.${p.status}`)}`);
    hero.append(status);
    const members = el("div", "ui-proj__members");
    for (const id of p.members) {
      const m = el("button", `ui-proj__member${p.active.includes(id) ? " is-active" : ""}`);
      m.type = "button";
      m.append(avatar(id), el("span", "", this.ctx.nameOf(id)));
      m.addEventListener("click", () => this.ctx.openAgent(id));
      members.append(m);
    }
    hero.append(members);
    view.append(hero);

    // What the latest round delivered.
    if (p.summary) {
      const summary = el("details", "ui-proj__fold ui-proj__summary");
      summary.open = true;
      summary.append(el("summary", "", `📦 ${t("proj.summary")}`), renderMarkdown(p.summary));
      view.append(summary);
    }
    view.append(projectFiles(p.id, p.updatedAt));

    // About the project (yours to edit) and the plan.
    const about = el("details", "ui-proj__fold");
    about.open = !!p.brief || this.editingBrief !== null;
    about.append(el("summary", "", t("proj.brief")));
    if (this.editingBrief !== null) {
      const area = el("textarea", "ui-composer__input");
      area.rows = 4;
      area.value = this.editingBrief;
      area.addEventListener("input", () => (this.editingBrief = area.value));
      const save = el("button", "ui-btn ui-btn--sm ui-btn--primary", t("proj.save"));
      save.type = "button";
      save.addEventListener("click", () => this.act(() => api("PUT", `/api/projects/${p.id}`, { brief: this.editingBrief ?? "" }), () => (this.editingBrief = null)));
      about.append(area, save);
    } else {
      if (p.brief) about.append(renderMarkdown(p.brief));
      const edit = el("button", "ui-btn ui-btn--sm", t("proj.editBrief"));
      edit.type = "button";
      edit.addEventListener("click", () => {
        this.editingBrief = p.brief;
        this.ctx.reload();
      });
      about.append(edit);
    }
    view.append(about);
    if (p.plan) {
      const plan = el("details", "ui-proj__fold");
      plan.append(el("summary", "", `${t("proj.plan")} · ${t(`proj.mode.${p.plan.mode}`)}`), renderMarkdown(p.plan.plan));
      view.append(plan);
    }

    // The thread.
    const thread = el("ol", "ui-proj__thread");
    for (const m of d.messages) thread.append(this.message(m, relativeTime));
    if (p.status === "planning") thread.append(el("li", "ui-proj__typing", t("proj.planning")));
    for (const id of p.active) thread.append(el("li", "ui-proj__typing", t("proj.working", { name: this.ctx.nameOf(id) })));
    view.append(thread);

    // Composer.
    if (p.status !== "closed") {
      const form = el("form", "ui-composer ui-proj__composer");
      const input = el("textarea", "ui-composer__input");
      input.rows = 3;
      input.maxLength = 8000;
      input.placeholder = t("proj.composer");
      input.value = this.reply;
      input.addEventListener("input", () => (this.reply = input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
      });
      const send = el("button", "ui-btn ui-btn--primary", t("proj.send"));
      send.type = "submit";
      form.append(input, this.mentionChips(input, (v) => (this.reply = v)), send);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = this.reply.trim();
        if (!text) return;
        input.blur();
        this.act(() => api("POST", `/api/projects/${p.id}/messages`, { text }), () => (this.reply = ""));
      });
      view.append(form);
    }
    if (this.error) view.append(el("p", "ui-error ui-small", this.error));

    // Members' notes.
    const notes = el("details", "ui-proj__fold");
    notes.append(el("summary", "", t("proj.notes")));
    const entries = Object.entries(d.notes).filter(([, text]) => text.trim());
    if (!entries.length) notes.append(el("p", "ui-faint ui-small", t("proj.noNotes")));
    for (const [id, text] of entries) {
      const note = el("div", "ui-proj__note");
      const who = el("div", "ui-proj__who");
      who.append(avatar(id, 18), el("strong", "", this.ctx.nameOf(id)));
      note.append(who, renderMarkdown(text));
      notes.append(note);
    }
    view.append(notes);

    // Stop, close or reopen, delete.
    const actions = el("div", "ui-proj__actions");
    const button = (text: string, fn: () => void, danger = false) => {
      const b = el("button", `ui-btn ui-btn--sm${danger ? " ui-btn--danger" : ""}`, text);
      b.type = "button";
      b.addEventListener("click", fn);
      actions.append(b);
    };
    if (p.status === "active" || p.status === "planning") button(t("proj.stop"), () => this.act(() => api("POST", `/api/projects/${p.id}/stop`)));
    const first = d.messages.find((m) => m.author === "you");
    if (first) button(t("proj.schedule"), () => this.ctx.scheduleProject(p, first.text));
    if (p.status === "closed") button(t("proj.reopen"), () => this.act(() => api("PUT", `/api/projects/${p.id}`, { closed: false })));
    else button(t("proj.close"), () => this.act(() => api("PUT", `/api/projects/${p.id}`, { closed: true })));
    button(
      t("proj.delete"),
      () => {
        if (confirm(t("proj.confirmDelete"))) void api("DELETE", `/api/projects/${p.id}`).then(() => this.ctx.close());
      },
      true,
    );
    view.append(actions);
    return view;
  }

  private message(m: ProjectMessage, relativeTime: (at: number) => string) {
    const mine = m.author === "you";
    const li = el("li", `ui-proj__msg is-${m.kind}${mine ? " is-you" : ""}`);
    const head = el("div", "ui-proj__who");
    const name = mine ? t("proj.you") : m.author === "planner" ? t("proj.planner") : m.author === "office" ? t("proj.office") : m.author === "summary" ? t("proj.summaryBy") : this.ctx.nameOf(m.author);
    if (!mine && m.kind === "message") {
      const who = el("button", "ui-proj__name");
      who.type = "button";
      who.append(avatar(m.author, 18), el("strong", "", name));
      who.addEventListener("click", () => this.ctx.openAgent(m.author));
      head.append(who);
    } else head.append(el("strong", "", `${m.kind === "plan" ? "🗺️ " : m.kind === "summary" ? "📦 " : m.kind === "system" ? "ℹ️ " : ""}${name}`));
    const time = el("time", "ui-proj__time", relativeTime(Date.parse(m.at)));
    time.dateTime = m.at;
    head.append(time);
    const body = renderMarkdown(m.text);
    highlightMentions(body);
    li.append(head, body);
    return li;
  }

  /** Runs a change, then redraws (showing the error if it failed). */
  private act(fn: () => Promise<unknown>, then?: () => void) {
    void fn()
      .then(() => {
        this.error = "";
        then?.();
      })
      .catch((err: Error) => (this.error = err.message))
      .finally(() => this.ctx.reload());
  }
}

/** Wraps @mentions in the rendered text so they stand out. */
function highlightMentions(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes("@")) nodes.push(n as Text);
  for (const node of nodes) {
    const parts = node.data.split(/(@[\p{L}\p{N}_-]+)/u);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((part, i) => frag.append(i % 2 ? el("span", "ui-proj__mention", part) : document.createTextNode(part)));
    node.replaceWith(frag);
  }
}
