import { api, tokenStore } from "./auth";
import { characterSeed } from "./floor/art-habblaud";
import { language, t } from "./i18n";
import { PRESETS, type Provider } from "./settings";
import { avatarCanvas } from "./vendor/habblaud/art/index";

/**
 * "Start a company": four steps — name, team template, model, confirm — and the server builds the team
 * (members with souls, skills, desks and a model; managers; a CEO; scheduled work). Opens by itself the
 * first time an unlocked page has no agent with a model yet.
 */

interface TemplateView {
  id: string;
  name: string;
  description: string;
  members: { key: string; name: string; role: string; room: string; skills: string[]; manager: boolean; ceo: boolean }[];
  schedules: { member: string; title: string; rule: { type: string; time?: string; days?: number[] }; project: boolean }[];
  runsPerDay: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function avatar(seed: string, size = 26) {
  const img = document.createElement("img");
  img.src = avatarCanvas(characterSeed(seed), { scale: 2 }).toDataURL();
  img.alt = "";
  img.width = size;
  img.height = size;
  img.className = "ui-proj__avatar";
  return img;
}

/** Downloads the current team as a file (members, souls, skills, scheduled work; no keys). Resolves with how many members. */
export async function exportTeam(officeName: string): Promise<number> {
  const team = await api<{ members: unknown[] }>("GET", "/api/company/export");
  const blob = new Blob([`${JSON.stringify(team, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = `${officeName.replace(/[\\/:*?"<>|]+/g, " ").trim() || "barnacle"}.barnacle-team.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return team.members.length;
}

const dayName = (d: number) => new Intl.DateTimeFormat(language(), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 25 + d)));

export interface WizardContext {
  officeName: () => string;
  roomName: (id: string) => string;
  unlock: () => Promise<void>;
  openHeadquarters: () => void;
}

export class Wizard {
  private dialog = document.getElementById("wizard") as HTMLDialogElement;
  private step = 0;
  private name = "";
  private templates: TemplateView[] = [];
  private template: string | null = null;
  private providers: Provider[] = [];
  /** An existing provider's id, or "new". */
  private provider = "";
  private fresh = { preset: PRESETS[0].id, baseUrl: PRESETS[0].baseUrl, apiKey: "" };
  private models: string[] = [];
  private model = "";
  private busy = "";
  private error = "";
  /** Shown on the model step only: the model list couldn't be read. */
  private modelNote = "";
  private options = { org: true, ceo: false, schedules: true };
  private result: { members: { id: string; name: string }[]; schedules: number } | null = null;
  /** A team read from a file: the file as it was, and what the office made of it. */
  private imported: { file: unknown; view: TemplateView; warnings: { kind: string; who: string; what: string }[] } | null = null;

  constructor(private ctx: WizardContext) {
    document.getElementById("wizard-close")?.addEventListener("click", () => this.close());
  }

  close() {
    this.dialog.close();
    try {
      localStorage.setItem("barnacle.wizardSeen", "1");
    } catch {
      // Private mode: it may show again, which is fine.
    }
  }

  /** The first time: only on an unlocked page with no agent that has a model, and not after "later". */
  maybeOpen(hasTeam: boolean) {
    let seen = false;
    try {
      seen = localStorage.getItem("barnacle.wizardSeen") === "1";
    } catch {
      seen = false;
    }
    if (!hasTeam && !seen && tokenStore.get() && !this.dialog.open) void this.open();
  }

  async open() {
    if (!tokenStore.get()) {
      await this.ctx.unlock().catch(() => {});
      if (!tokenStore.get()) return;
    }
    this.step = 0;
    this.result = null;
    this.error = "";
    this.name = this.ctx.officeName();
    try {
      const [tpl, prov] = await Promise.all([
        api<{ templates: TemplateView[] }>("GET", `/api/company/templates?lang=${encodeURIComponent(language())}`),
        api<{ providers: Provider[] }>("GET", "/api/providers"),
      ]);
      this.templates = tpl.templates;
      this.providers = prov.providers;
      this.provider = this.providers[0]?.id ?? "new";
      this.options.ceo = false;
    } catch (err) {
      this.error = (err as Error).message;
    }
    if (!this.dialog.open) this.dialog.showModal();
    this.render();
  }

  private async loadModels() {
    const id = this.provider;
    this.models = [];
    try {
      const res = await api<{ models: { id: string }[] }>("GET", `/api/providers/${encodeURIComponent(id)}/models`);
      if (this.provider !== id) return;
      this.models = res.models.map((m) => m.id);
      if (!this.models.includes(this.model)) this.model = this.models[0] ?? this.model;
      this.modelNote = "";
    } catch {
      this.modelNote = t("wiz.noModels");
    }
    this.render();
  }

  /** Adds the provider being typed in, then lists its models. */
  private async connect() {
    const preset = PRESETS.find((p) => p.id === this.fresh.preset)!;
    this.busy = t("wiz.connecting");
    this.render();
    try {
      const res = await api<{ provider: Provider }>("POST", "/api/providers", {
        name: preset.name,
        kind: preset.kind,
        baseUrl: this.fresh.baseUrl || preset.baseUrl,
        apiKey: this.fresh.apiKey,
      });
      this.providers = [...this.providers, res.provider];
      this.provider = res.provider.id;
      this.fresh.apiKey = "";
      this.busy = "";
      await this.loadModels();
    } catch (err) {
      this.busy = "";
      this.error = (err as Error).message;
      this.render();
    }
  }

  private async create() {
    this.busy = t("wiz.creating");
    this.error = "";
    this.render();
    try {
      this.result = await api("POST", "/api/company/setup", {
        ...(this.template === "file" && this.imported ? { team: this.imported.file } : { template: this.template }),
        language: language(),
        providerId: this.provider,
        model: this.model,
        officeName: this.name.trim() || undefined,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        options: this.options,
      });
      this.step = 4;
      try {
        localStorage.setItem("barnacle.wizardSeen", "1");
      } catch {
        // Fine.
      }
    } catch (err) {
      this.error = (err as Error).message;
    }
    this.busy = "";
    this.render();
  }

  private go(step: number) {
    if (step === 2 && !this.template) return this.fail(t("wiz.needTemplate"));
    if (step === 3 && (!this.model.trim() || this.provider === "new")) return this.fail(t("wiz.needModel"));
    this.error = "";
    const entering = step === 2 && this.step !== 2;
    this.step = step;
    this.render();
    if (entering && this.provider !== "new" && !this.models.length) void this.loadModels();
  }

  private fail(message: string) {
    this.error = message;
    this.render();
  }

  private render() {
    const body = this.dialog.querySelector<HTMLElement>(".ui-wiz__body")!;
    const view = el("div", "ui-wiz");
    if (this.step < 4) {
      const steps = el("ol", "ui-wiz__steps");
      ["wiz.step0", "wiz.step1", "wiz.step2", "wiz.step3"].forEach((k, i) => steps.append(el("li", i === this.step ? "is-on" : i < this.step ? "is-done" : "", `${i + 1}. ${t(k)}`)));
      view.append(steps);
    }
    if (this.step === 0) view.append(this.stepCompany());
    if (this.step === 1) view.append(this.stepTeam());
    if (this.step === 2) view.append(this.stepModel());
    if (this.step === 3) view.append(this.stepConfirm());
    if (this.step === 4) view.append(this.stepDone());
    if (this.error) view.append(el("p", "ui-error ui-small", this.error));
    if (this.busy) view.append(el("p", "ui-faint", this.busy));

    if (this.step < 4) {
      const nav = el("div", "ui-wiz__nav");
      const button = (text: string, fn: () => void, primary = false) => {
        const b = el("button", `ui-btn${primary ? " ui-btn--primary" : ""}`, text);
        b.type = "button";
        b.disabled = !!this.busy;
        b.addEventListener("click", fn);
        nav.append(b);
      };
      if (this.step === 0) button(t("wiz.later"), () => this.close());
      else button(t("wiz.back"), () => this.go(this.step - 1));
      if (this.step < 3) button(t("wiz.next"), () => this.go(this.step + 1), true);
      else button(t("wiz.create"), () => void this.create(), true);
      view.append(nav);
    }
    body.replaceChildren(view);
  }

  private stepCompany() {
    const box = el("div", "ui-wiz__step");
    const name = el("input", "ui-mem__input");
    name.maxLength = 60;
    name.value = this.name;
    name.addEventListener("input", () => (this.name = name.value));
    const label = el("label", "ui-proj__label");
    label.append(el("span", "", t("wiz.name")), name);
    box.append(el("p", "ui-wiz__intro", t("wiz.intro")), label);
    return box;
  }

  /** Reads a team file and asks the office what it would create. */
  private async importFile(file: File) {
    this.error = "";
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error(t("team.tooBig"));
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error(t("team.notJson"));
      }
      const res = await api<{ preview: TemplateView; warnings: { kind: string; who: string; what: string }[] }>("POST", "/api/company/team-preview", { team: data });
      this.imported = { file: data, view: { ...res.preview, name: res.preview.name || file.name.replace(/\.barnacle-team\.json$|\.json$/, "") }, warnings: res.warnings };
      this.template = "file";
      this.options.ceo = res.preview.members.some((m) => m.ceo);
    } catch (err) {
      this.error = `${t("team.importFailed")}：${(err as Error).message}`;
    }
    this.render();
  }

  private stepTeam() {
    const grid = el("div", "ui-wiz__grid");
    const all = this.imported ? [...this.templates, this.imported.view] : this.templates;
    // A team someone exported (or you did, from another office).
    const input = el("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.hidden = true;
    input.addEventListener("change", () => input.files?.[0] && void this.importFile(input.files[0]));
    const pick = el("button", "ui-wiz__card ui-wiz__import");
    pick.type = "button";
    pick.append(el("strong", "ui-wiz__name", `📂 ${t("team.import")}`), el("span", "ui-wiz__desc", t("team.importHelp")), input);
    pick.addEventListener("click", (e) => e.target !== input && input.click());
    for (const tpl of all) {
      const card = el("button", `ui-wiz__card${tpl.id === this.template ? " is-on" : ""}`);
      card.type = "button";
      card.addEventListener("click", () => {
        this.template = tpl.id;
        this.options.ceo = tpl.members.some((m) => m.ceo);
        this.render();
      });
      const faces = el("div", "ui-wiz__faces");
      for (const m of tpl.members) faces.append(avatar(m.name.toLowerCase(), 24));
      card.append(el("strong", "ui-wiz__name", tpl.name), el("span", "ui-wiz__desc", tpl.description), faces);
      if (tpl.id === this.template) {
        const list = el("ul", "ui-wiz__members");
        for (const m of tpl.members) {
          const li = el("li");
          li.append(avatar(m.name.toLowerCase(), 20), el("span", "", `${m.name} · ${m.role}`), el("span", "ui-faint", this.ctx.roomName(m.room)));
          if (m.manager) li.append(el("span", "ui-wiz__tag", t("wiz.manager")));
          if (m.ceo) li.append(el("span", "ui-wiz__tag", t("wiz.ceo")));
          list.append(li);
        }
        const jobs = el("ul", "ui-wiz__jobs");
        for (const s of tpl.schedules) {
          const days = s.rule.days ?? [];
          const when = days.length === 7 ? t("sched.daily") : days.length === 5 ? t("sched.weekdays") : `${t("wiz.weekly")} ${days.map(dayName).join("、")}`;
          jobs.append(el("li", "", `${s.project ? "📋" : "⏰"} ${s.title} · ${when} ${s.rule.time ?? ""}`));
        }
        card.append(el("h5", "", t("wiz.members")), list, el("h5", "", t("wiz.schedules")), jobs, el("p", "ui-faint ui-small", t("wiz.runs", { n: String(tpl.runsPerDay) })));
        if (tpl.id === "file" && this.imported) {
          card.append(el("p", "ui-wiz__warn", `⚠️ ${t("team.trust")}`));
          for (const w of this.imported.warnings) card.append(el("p", "ui-faint ui-small", `• ${t(`team.warn.${w.kind}`, { who: w.who, what: w.what })}`));
        }
      }
      grid.append(card);
    }
    grid.append(pick);
    return grid;
  }

  private stepModel() {
    const box = el("div", "ui-wiz__step");
    box.append(el("h4", "", t("wiz.model")));
    const choose = el("select", "ui-sched__select");
    choose.append(...this.providers.map((p) => new Option(`${t("wiz.existing")}：${p.name}`, p.id, false, p.id === this.provider)), new Option(`＋ ${t("wiz.new")}`, "new", false, this.provider === "new"));
    choose.addEventListener("change", () => {
      this.provider = choose.value;
      this.models = [];
      if (this.provider !== "new") void this.loadModels();
      else this.render();
    });
    box.append(choose);

    if (this.provider === "new") {
      const form = el("div", "ui-wiz__form");
      const preset = el("select", "ui-sched__select");
      preset.append(...PRESETS.map((p) => new Option(p.name, p.id, false, p.id === this.fresh.preset)));
      preset.addEventListener("change", () => {
        this.fresh.preset = preset.value;
        this.fresh.baseUrl = PRESETS.find((p) => p.id === preset.value)?.baseUrl ?? "";
        this.render();
      });
      const key = el("input", "ui-mem__input");
      key.type = "password";
      key.autocomplete = "off";
      key.placeholder = t("wiz.apiKey");
      key.value = this.fresh.apiKey;
      key.addEventListener("input", () => (this.fresh.apiKey = key.value));
      const url = el("input", "ui-mem__input");
      url.placeholder = t("wiz.baseUrl");
      url.value = this.fresh.baseUrl;
      url.addEventListener("input", () => (this.fresh.baseUrl = url.value));
      const connect = el("button", "ui-btn ui-btn--primary", t("wiz.connect"));
      connect.type = "button";
      connect.disabled = !!this.busy;
      connect.addEventListener("click", () => void this.connect());
      const row = (label: string, field: HTMLElement) => {
        const l = el("label", "ui-proj__label");
        l.append(el("span", "", label), field);
        return l;
      };
      form.append(row(t("wiz.preset"), preset), row(t("wiz.apiKey"), key), row(t("wiz.baseUrl"), url), connect, el("p", "ui-faint ui-small", t("wiz.keyNote")));
      box.append(form);
      return box;
    }

    const model = el("input", "ui-mem__input");
    model.setAttribute("list", "wiz-models");
    model.value = this.model;
    model.placeholder = t("wiz.pickModel");
    model.addEventListener("input", () => (this.model = model.value));
    const list = el("datalist");
    list.id = "wiz-models";
    list.append(...this.models.map((m) => new Option(m, m)));
    const label = el("label", "ui-proj__label");
    label.append(el("span", "", t("wiz.pickModel")), model, list);
    box.append(label, el("p", "ui-faint ui-small", t("wiz.modelHint")));
    if (this.modelNote) box.append(el("p", "ui-faint ui-small", this.modelNote));
    return box;
  }

  private stepConfirm() {
    const box = el("div", "ui-wiz__step");
    const tpl = this.template === "file" ? this.imported?.view : this.templates.find((x) => x.id === this.template);
    const provider = this.providers.find((p) => p.id === this.provider);
    box.append(el("h4", "", `${this.name || this.ctx.officeName()} · ${tpl?.name ?? ""}`), el("p", "ui-faint", `${provider?.name ?? ""} · ${this.model}`));
    const check = (key: keyof Wizard["options"], label: string, disabled = false) => {
      const l = el("label", "ui-sched__check");
      const c = el("input");
      c.type = "checkbox";
      c.checked = this.options[key];
      c.disabled = disabled;
      c.addEventListener("change", () => (this.options[key] = c.checked));
      l.append(c, el("span", "", label));
      box.append(l);
    };
    check("org", t("wiz.optOrg"));
    if (tpl?.members.some((m) => m.ceo)) check("ceo", t("wiz.optCeo"));
    check("schedules", t("wiz.optSchedules"));
    if (tpl) {
      const faces = el("div", "ui-wiz__faces");
      for (const m of tpl.members) if (!m.ceo || this.options.ceo) faces.append(avatar(m.name.toLowerCase(), 30));
      box.append(faces);
    }
    return box;
  }

  private stepDone() {
    const box = el("div", "ui-wiz__step ui-wiz__done");
    const r = this.result!;
    const faces = el("div", "ui-wiz__faces");
    for (const m of r.members) faces.append(avatar(m.id, 36));
    box.append(el("h3", "", `🎉 ${t("wiz.done")}`), faces, el("p", "", t("wiz.doneText", { n: String(r.members.length), s: String(r.schedules) })));
    const nav = el("div", "ui-wiz__nav");
    const see = el("button", "ui-btn", t("wiz.see"));
    see.type = "button";
    see.addEventListener("click", () => this.close());
    nav.append(see);
    if (this.options.org) {
      const hq = el("button", "ui-btn ui-btn--primary", t("wiz.hq"));
      hq.type = "button";
      hq.addEventListener("click", () => {
        this.close();
        this.ctx.openHeadquarters();
      });
      nav.append(hq);
    }
    box.append(nav);
    return box;
  }
}
