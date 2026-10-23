import { McpTab } from "./mcp-ui";
import { CostsTab } from "./costs-ui";
import { KnowledgeTab } from "./files-ui";
import { SkillsTab, soulEditor } from "./agent-editor";
import { api, tokenStore, Unauthorized } from "./auth";
import { ExperienceTab, PolicyTab } from "./governance-ui";
import { OrgTab } from "./org-ui";
import { FloorEditor } from "./floor/floor-settings";
import { homeRoom, workRooms, type Floor } from "./floor/model";
import { formatTime, LANGUAGE_NAMES, LANGUAGES, onLanguageChange, t } from "./i18n";
import type { Occupant } from "./types";

interface OfficeSettings {
  officeName: string;
  language: string;
  pack: string;
  scene: string;
  floorArt: string;
  stateTtlSeconds: number;
  offlineAfterSeconds: number;
}

interface PackInfo {
  id: string;
  name: string;
  local: boolean;
}

export interface Provider {
  id: string;
  name: string;
  kind: "openai" | "anthropic";
  baseUrl: string | null;
  hasKey: boolean;
  keyHint: string | null;
}

interface ModelInfo {
  id: string;
  name: string;
  maxTokens: number | null;
}

interface Brain {
  providerId: string;
  model: string;
  lightModel?: string | null;
  systemPrompt: string;
  maxTokens: number;
}

/** Presets only fill the form; everything stays editable. */
export const PRESETS: { id: string; name: string; kind: Provider["kind"]; baseUrl: string }[] = [
  { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "" },
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "gemini", name: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "minimax", name: "MiniMax", kind: "openai", baseUrl: "https://api.minimax.cn/v1" },
  { id: "ollama", name: "Ollama (local)", kind: "openai", baseUrl: "http://localhost:11434/v1" },
  { id: "custom", name: "Custom (OpenAI-compatible)", kind: "openai", baseUrl: "" },
];

const DEFAULT_MAX_TOKENS = 4096;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Creates an element, assigns DOM properties (textContent, type, value, …) and appends children. Never innerHTML. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function labelled(text: string, field: HTMLElement, help?: string) {
  return el("label", {}, el("span", { textContent: text }), field, ...(help ? [el("small", { className: "help", textContent: help })] : []));
}

function setStatus(node: Element | null, text: string, ok: boolean) {
  if (!node) return;
  node.textContent = text;
  node.className = `status ${ok ? "status--ok" : "status--error"}`;
}

/** The settings dialog. Everything it changes goes through the token-protected API. */
export class SettingsDialog {
  private dialog = $<HTMLDialogElement>("settings");
  private settings: OfficeSettings | null = null;
  private floorArtPack: { id: string; name: string } | null = null;
  private packs: PackInfo[] = [];
  private providers: Provider[] = [];
  private models = new Map<string, ModelInfo[]>();
  private brains = new Map<string, Brain | null>();
  private expanded: string | null = null;
  private editingProvider: string | null = null;
  private tokenFromEnv = false;
  private showToken = false;
  private unlockWaiters: (() => void)[] = [];
  private floorEditor: FloorEditor;
  private skillsTab = new SkillsTab($("tab-skills"), (status, fn) => this.guarded(status, fn));
  private experienceTab = new ExperienceTab($("tab-experience"), (status, fn) => this.guarded(status, fn), (id) => this.getOccupants().find((o) => o.id === id)?.name ?? id);
  private mcpTab = new McpTab($("tab-mcp"), (status, fn) => this.guarded(status, fn), () => this.getOccupants());
  private costsTab = new CostsTab($("tab-costs"), (status, fn) => this.guarded(status, fn));
  private knowledgeTab = new KnowledgeTab($("tab-knowledge"), (status, fn) => this.guarded(status, fn));
  private policyTab = new PolicyTab($("tab-policy"), (status, fn) => this.guarded(status, fn));
  private orgTab = new OrgTab($("tab-org"), (status, fn) => this.guarded(status, fn), () => this.getOccupants());

  constructor(
    private getOccupants: () => Occupant[],
    private getFloor: () => Floor | null,
  ) {
    this.floorEditor = new FloorEditor($("tab-floor"), {
      getFloor,
      getOccupants,
      save: async (floor, status) => !!(await this.guarded(status, () => api("PUT", "/api/floor", floor))),
    });
    $("open-settings").addEventListener("click", () => void this.open());
    $("close-settings").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    $("lock").addEventListener("click", () => this.lock());
    $("unlock-form").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.unlock();
    });
    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      tab.addEventListener("click", () => this.selectTab(tab.dataset.tab!));
    }
    $("tab-general").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveGeneral();
    });
    $("toggle-token").addEventListener("click", () => {
      this.showToken = !this.showToken;
      this.renderConnect();
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
      button.addEventListener("click", () => void this.copy(button));
    }
    this.armTwoClick($("rotate-token"), "security.rotateButton", "security.rotateConfirm", () => void this.rotate());
    this.setupProviderForm();
    this.setupNewAgentForm();
    onLanguageChange(() => {
      if (!this.settings) return;
      this.floorEditor.render();
      this.renderGeneral();
      this.renderOccupants();
      this.renderProviders();
      this.renderConnect();
      this.renderNewAgentFields();
    });
  }

  get unlocked() {
    return this.settings !== null;
  }

  async open(tab?: string) {
    if (!this.dialog.open) this.dialog.showModal();
    if (tokenStore.get()) {
      try {
        await this.load();
        if (tab) this.selectTab(tab);
        return;
      } catch (err) {
        if (!(err instanceof Unauthorized)) throw err;
        this.lock();
      }
    }
    this.showLocked();
  }

  /** Opens Members with one agent's soul and skills editor open. */
  async openSoul(id: string) {
    this.expanded = `${id}:soul`;
    await this.open("occupants");
    this.dialog.querySelector(".soul-editor")?.closest("li")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  close() {
    this.dialog.close();
  }

  /** Opens Settings → Organization. */
  async openOrg() {
    await this.open("org");
  }

  /** Opens Members with one agent's model settings open. */
  async openBrain(id: string) {
    this.expanded = `${id}:brain`;
    await this.open("occupants");
    this.dialog.querySelector(".brain-editor")?.closest("li")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  /** Resolves once the settings are unlocked (opening the dialog if needed). Used by chat. */
  async ensureUnlocked(): Promise<void> {
    if (tokenStore.get()) {
      try {
        await api("GET", "/api/auth");
        return;
      } catch (err) {
        if (!(err instanceof Unauthorized)) throw err;
        tokenStore.clear();
      }
    }
    const done = new Promise<void>((resolve) => this.unlockWaiters.push(resolve));
    await this.open();
    return done;
  }

  /** Saves a whole floor (used by drag-to-move in the scene). Unlocks first if needed. */
  async saveFloor(floor: Floor): Promise<boolean> {
    await this.ensureUnlocked();
    try {
      await api("PUT", "/api/floor", floor);
      return true;
    } catch {
      return false;
    }
  }

  /** Called when the floor changes on the server. */
  refreshFloor() {
    if (this.settings) this.floorEditor.sync();
  }

  /** Called when occupants change, so the Occupants tab stays current. */
  refreshOccupants() {
    // While a model editor is open, re-rendering would wipe what is being typed.
    if (this.dialog.open && this.settings && this.expanded === null) this.renderOccupants();
  }

  // ---------------------------------------------------------------- lock / unlock

  private showLocked() {
    this.settings = null;
    $("unlock-form").hidden = false;
    $("settings-body").hidden = true;
    $("lock").hidden = true;
    $("unlock-error").hidden = true;
    $<HTMLInputElement>("unlock-token").value = "";
    $<HTMLInputElement>("unlock-token").focus();
  }

  private async unlock() {
    const value = $<HTMLInputElement>("unlock-token").value.trim();
    try {
      await api("GET", "/api/auth", undefined, value);
    } catch (err) {
      if (err instanceof Unauthorized) {
        $("unlock-error").hidden = false;
        return;
      }
      throw err;
    }
    tokenStore.set(value, $<HTMLInputElement>("unlock-remember").checked);
    await this.load();
    const waiters = this.unlockWaiters;
    this.unlockWaiters = [];
    if (waiters.length) {
      this.dialog.close();
      for (const resolve of waiters) resolve();
    }
  }

  private lock() {
    tokenStore.clear();
    this.brains.clear();
    this.showLocked();
  }

  private async load() {
    const [data, providers] = await Promise.all([
      api<{ settings: OfficeSettings; packs: PackInfo[]; floorArtPack: { id: string; name: string } | null; tokenFromEnv: boolean }>("GET", "/api/settings"),
      api<{ providers: Provider[] }>("GET", "/api/providers"),
    ]);
    this.settings = data.settings;
    this.packs = data.packs;
    this.floorArtPack = data.floorArtPack;
    this.tokenFromEnv = data.tokenFromEnv;
    this.providers = providers.providers;
    $("unlock-form").hidden = true;
    $("settings-body").hidden = false;
    $("lock").hidden = false;
    this.renderGeneral();
    this.renderOccupants();
    this.renderProviders();
    this.renderConnect();
    this.renderSecurity();
    this.renderNewAgentFields();
    this.floorEditor.sync();
  }

  /** An MCP server connected or failed. */
  mcpChanged() {
    this.mcpTab.changed();
  }

  private selectTab(name: string) {
    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    }
    for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) panel.hidden = panel.dataset.panel !== name;
    if (name === "skills") void this.skillsTab.render();
    if (name === "experience") void this.experienceTab.render();
    if (name === "policy") void this.policyTab.render();
    if (name === "knowledge") void this.knowledgeTab.render();
    if (name === "costs") void this.costsTab.render();
    if (name === "mcp") void this.mcpTab.render();
    if (name === "org") void this.orgTab.render();
  }

  /** Runs an API call; a 401 locks the dialog, other errors are shown in `status`. */
  private async guarded<T>(status: Element | null, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Unauthorized) {
        this.lock();
        return undefined;
      }
      setStatus(status, t("common.failed", { error: (err as Error).message }), false);
      return undefined;
    }
  }

  // ---------------------------------------------------------------- general

  private renderGeneral() {
    const s = this.settings!;
    const form = $<HTMLFormElement>("tab-general");
    const field = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as T;
    field<HTMLInputElement>("officeName").value = s.officeName;
    field<HTMLSelectElement>("language").replaceChildren(
      ...LANGUAGES.map((l) => new Option(LANGUAGE_NAMES[l], l, false, l === s.language)),
    );
    field<HTMLSelectElement>("pack").replaceChildren(
      ...this.packs.map((p) => new Option(p.local ? `${p.name} (${t("general.packLocal")})` : p.name, p.id, false, p.id === s.pack)),
    );
    field<HTMLSelectElement>("scene").value = s.scene;
    const art = field<HTMLSelectElement>("floorArt");
    art.value = s.floorArt;
    (art.options[1] as HTMLOptionElement).disabled = !this.floorArtPack;
    if (this.floorArtPack) art.options[1].textContent = `${t("floorArt.pack")}: ${this.floorArtPack.name}`;
    field<HTMLInputElement>("stateTtlSeconds").value = String(s.stateTtlSeconds);
    field<HTMLInputElement>("offlineAfterSeconds").value = String(s.offlineAfterSeconds);
  }

  private async saveGeneral() {
    const data = new FormData($<HTMLFormElement>("tab-general"));
    const body: OfficeSettings = {
      officeName: String(data.get("officeName")),
      language: String(data.get("language")),
      pack: String(data.get("pack")),
      scene: String(data.get("scene")),
      floorArt: String(data.get("floorArt")),
      stateTtlSeconds: Number(data.get("stateTtlSeconds")),
      offlineAfterSeconds: Number(data.get("offlineAfterSeconds")),
    };
    const status = $("general-status");
    const res = await this.guarded(status, () => api<{ settings: OfficeSettings }>("PUT", "/api/settings", body));
    if (res) {
      this.settings = res.settings;
      setStatus(status, t("general.saved"), true);
    }
  }

  // ---------------------------------------------------------------- brain editor (shared)

  private async loadModels(providerId: string, status: Element | null): Promise<ModelInfo[]> {
    if (this.models.has(providerId)) return this.models.get(providerId)!;
    setStatus(status, t("brain.loading"), true);
    const res = await this.guarded(status, () => api<{ models: ModelInfo[] }>("GET", `/api/providers/${providerId}/models`));
    if (!res) return [];
    this.models.set(providerId, res.models);
    setStatus(status, "", true);
    return res.models;
  }

  /** Provider + model + persona + length fields. Returns a reader for the current values. */
  private brainFields(container: HTMLElement, initial: Brain | null): () => Brain | null {
    container.replaceChildren();
    if (this.providers.length === 0) {
      container.append(el("p", { className: "help", textContent: t("brain.needProvider") }));
      return () => null;
    }
    const listId = `models-${Math.random().toString(36).slice(2)}`;
    const provider = el("select");
    provider.append(...this.providers.map((p) => new Option(p.name, p.id, false, p.id === initial?.providerId)));
    const datalist = el("datalist", { id: listId });
    const model = el("input", { type: "text", required: true, maxLength: 200, value: initial?.model ?? "" });
    model.setAttribute("list", listId);
    const status = el("span", { className: "status" });
    const fill = async () => {
      const list = await this.loadModels(provider.value, status);
      datalist.replaceChildren(...list.map((m) => new Option(m.name === m.id ? m.id : `${m.name}`, m.id)));
      if (!model.value && list[0]) model.value = list[0].id;
    };
    const load = el("button", { type: "button", className: "small", textContent: t("brain.loadModels") });
    load.addEventListener("click", () => {
      this.models.delete(provider.value);
      void fill();
    });
    provider.addEventListener("change", () => {
      model.value = "";
      void fill();
    });
    const light = el("input", { type: "text", maxLength: 200, value: initial?.lightModel ?? "", placeholder: t("brain.lightPlaceholder") });
    light.setAttribute("list", listId);
    const persona = el("textarea", { rows: 3, maxLength: 4000, value: initial?.systemPrompt ?? "", placeholder: t("brain.personaPlaceholder") });
    const maxTokens = el("input", { type: "number", min: "256", max: "128000", value: String(initial?.maxTokens ?? DEFAULT_MAX_TOKENS) });
    model.addEventListener("change", () => {
      const known = this.models.get(provider.value)?.find((m) => m.id === model.value)?.maxTokens;
      if (known && Number(maxTokens.value) > known) maxTokens.value = String(known);
    });
    container.append(
      labelled(t("brain.provider"), provider),
      el("label", {}, el("span", { textContent: t("brain.modelName") }), el("div", { className: "row" }, model, load, status), datalist),
      labelled(t("brain.lightModel"), light),
      el("small", { className: "help", textContent: t("brain.lightHelp") }),
      labelled(t("brain.persona"), persona),
      labelled(t("brain.maxTokens"), maxTokens),
    );
    void fill();
    return () =>
      model.value.trim()
        ? { providerId: provider.value, model: model.value.trim(), lightModel: light.value.trim() || null, systemPrompt: persona.value, maxTokens: Number(maxTokens.value) || DEFAULT_MAX_TOKENS }
        : null;
  }

  // ---------------------------------------------------------------- occupants

  private newAgentBrain: () => Brain | null = () => null;

  private renderNewAgentFields() {
    const container = $("new-agent-form").querySelector<HTMLElement>(".brain-fields")!;
    this.newAgentBrain = this.brainFields(container, null);
  }

  private setupNewAgentForm() {
    const form = $<HTMLFormElement>("new-agent-form");
    const name = form.elements.namedItem("name") as HTMLInputElement;
    const id = form.elements.namedItem("id") as HTMLInputElement;
    let idEdited = false;
    id.addEventListener("input", () => (idEdited = true));
    name.addEventListener("input", () => {
      if (!idEdited) id.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void (async () => {
        const status = form.querySelector(".status");
        const brain = this.newAgentBrain();
        if (!brain) return;
        const ok = await this.guarded(status, async () => {
          await api("POST", `/api/occupants/${encodeURIComponent(id.value)}/status`, { state: "idle", name: name.value, kind: "agent" });
          await api("PUT", `/api/occupants/${encodeURIComponent(id.value)}/brain`, brain);
          return true;
        });
        if (ok) {
          setStatus(status, t("occupants.created"), true);
          form.reset();
          idEdited = false;
          this.brains.delete(id.value);
          this.renderNewAgentFields();
        }
      })();
    });
  }

  private renderOccupants() {
    const list = $("manage-occupants");
    const occupants = this.getOccupants();
    if (occupants.length === 0) {
      list.replaceChildren(el("li", { className: "help", textContent: t("occupants.none") }));
      return;
    }
    list.replaceChildren(...occupants.map((o) => this.occupantRow(o)));
  }

  private occupantRow(o: Occupant) {
    const meta = `${o.id} · ${t(`state.${o.state}`)} · ${t("occupants.lastUpdate", { time: formatTime(o.updatedAt) })}`;
    const info = el(
      "div",
      { className: "occupant-info" },
      el("strong", { textContent: o.name }),
      el("small", { className: "help", textContent: meta }),
      el("small", { className: o.model ? "model-tag" : "help", textContent: o.model ?? t("brain.none") }),
    );
    const toggle = el("button", { type: "button", className: "small", textContent: t(o.model ? "brain.model" : "brain.assign") });
    toggle.setAttribute("aria-expanded", String(this.expanded === `${o.id}:brain`));
    toggle.addEventListener("click", () => {
      this.expanded = this.expanded === `${o.id}:brain` ? null : `${o.id}:brain`;
      this.renderOccupants();
    });
    const soulToggle = el("button", { type: "button", className: "small", textContent: t("soul.edit") });
    soulToggle.setAttribute("aria-expanded", String(this.expanded === `${o.id}:soul`));
    soulToggle.addEventListener("click", () => {
      this.expanded = this.expanded === `${o.id}:soul` ? null : `${o.id}:soul`;
      this.renderOccupants();
    });
    const remove = el("button", { type: "button", className: "danger small", textContent: t("occupants.remove") });
    this.armTwoClick(remove, "occupants.remove", "occupants.confirm", () =>
      void this.guarded(null, () => api("DELETE", `/api/occupants/${encodeURIComponent(o.id)}`)),
    );
    const floor = this.getFloor();
    const roomSelect = el("select");
    if (floor) {
      // Their room is where their desk is; picking another room moves them to a free desk there.
      const home = homeRoom(floor, o)?.id;
      const work = workRooms(floor);
      roomSelect.append(...work.map((r) => new Option(r.name, r.id, false, r.id === home)));
      roomSelect.addEventListener("change", () => {
        void this.guarded(null, () => api("PUT", `/api/desks/${encodeURIComponent(o.id)}`, { room: roomSelect.value }));
      });
      info.append(el("label", { className: "inline-label" }, el("small", { className: "help", textContent: t("occupants.room") }), roomSelect));
    }
    if (o.role) info.append(el("small", { className: "role-tag", textContent: o.role }));
    const head = el("div", { className: "occupant-row" }, info, el("div", { className: "row" }, soulToggle, toggle, remove));
    const li = el("li", { className: "occupant-item" }, head);
    if (this.expanded === `${o.id}:brain`) li.append(this.brainEditor(o));
    if (this.expanded === `${o.id}:soul`) li.append(soulEditor(o, (status, fn) => this.guarded(status, fn), () => this.skillsTab.list()));
    return li;
  }

  private brainEditor(o: Occupant) {
    const box = el("div", { className: "subform__body brain-editor" });
    const fields = el("div");
    const status = el("span", { className: "status" });
    const save = el("button", { type: "button", className: "primary small", textContent: t("brain.save") });
    const remove = el("button", { type: "button", className: "small", textContent: t("brain.remove") });
    box.append(fields, el("div", { className: "row" }, save, remove, status));
    let read: () => Brain | null = () => null;
    const render = (brain: Brain | null) => (read = this.brainFields(fields, brain));
    if (this.brains.has(o.id)) render(this.brains.get(o.id)!);
    else {
      render(null);
      void this.guarded(status, () => api<{ brain: Brain | null }>("GET", `/api/occupants/${encodeURIComponent(o.id)}/brain`)).then((res) => {
        if (!res) return;
        this.brains.set(o.id, res.brain);
        render(res.brain);
      });
    }
    save.addEventListener("click", () => {
      const brain = read();
      if (!brain) return;
      void this.guarded(status, () => api<{ brain: Brain }>("PUT", `/api/occupants/${encodeURIComponent(o.id)}/brain`, brain)).then((res) => {
        if (!res) return;
        this.brains.set(o.id, res.brain);
        remove.hidden = false;
        setStatus(status, t("models.saved"), true);
      });
    });
    remove.addEventListener("click", () => {
      void this.guarded(status, () => api("DELETE", `/api/occupants/${encodeURIComponent(o.id)}/brain`)).then((res) => {
        if (res) this.brains.set(o.id, null);
      });
    });
    remove.hidden = !o.model;
    return box;
  }

  // ---------------------------------------------------------------- providers

  private renderProviders() {
    const list = $("provider-list");
    if (this.providers.length === 0) {
      list.replaceChildren(el("li", { className: "help", textContent: t("models.none") }));
      return;
    }
    list.replaceChildren(
      ...this.providers.map((p) => {
        const status = el("span", { className: "status" });
        const meta = `${p.kind === "anthropic" ? "Anthropic" : "OpenAI-compatible"} · ${p.baseUrl ?? t("models.default")} · ${
          p.hasKey ? `••••${p.keyHint ?? ""}` : t("models.noKey")
        }`;
        const test = el("button", { type: "button", className: "small", textContent: t("models.test") });
        test.addEventListener("click", () => {
          this.models.delete(p.id);
          void this.loadModels(p.id, status).then((models) => {
            if (this.models.has(p.id)) setStatus(status, t("models.testOk", { count: String(models.length) }), true);
          });
        });
        const edit = el("button", { type: "button", className: "small", textContent: t("models.edit") });
        edit.addEventListener("click", () => this.editProvider(p));
        const remove = el("button", { type: "button", className: "danger small", textContent: t("models.delete") });
        this.armTwoClick(remove, "models.delete", "models.confirm", () => {
          void this.guarded(status, () => api("DELETE", `/api/providers/${p.id}`)).then((res) => {
            if (!res) return;
            this.providers = this.providers.filter((x) => x.id !== p.id);
            this.models.delete(p.id);
            this.brains.clear();
            this.renderProviders();
            this.renderNewAgentFields();
          });
        });
        return el(
          "li",
          { className: "occupant-item" },
          el(
            "div",
            { className: "occupant-row" },
            el("div", { className: "occupant-info" }, el("strong", { textContent: p.name }), el("small", { className: "help", textContent: meta })),
            el("div", { className: "row" }, test, edit, remove),
          ),
          status,
        );
      }),
    );
  }

  private setupProviderForm() {
    const form = $<HTMLFormElement>("provider-form");
    const field = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as T;
    const preset = field<HTMLSelectElement>("preset");
    preset.append(...PRESETS.map((p) => new Option(p.name, p.id)));
    preset.addEventListener("change", () => {
      const p = PRESETS.find((x) => x.id === preset.value)!;
      field<HTMLInputElement>("name").value = p.id === "custom" ? "" : p.name;
      field<HTMLSelectElement>("kind").value = p.kind;
      field<HTMLInputElement>("baseUrl").value = p.baseUrl;
    });
    $("add-provider").addEventListener("click", () => this.editProvider(null));
    $("cancel-provider").addEventListener("click", () => {
      form.hidden = true;
      this.editingProvider = null;
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const apiKey = field<HTMLInputElement>("apiKey").value.trim();
      const body = {
        name: field<HTMLInputElement>("name").value,
        kind: field<HTMLSelectElement>("kind").value,
        baseUrl: field<HTMLInputElement>("baseUrl").value.trim(),
        // When editing, an empty field keeps the stored key.
        ...(apiKey || !this.editingProvider ? { apiKey } : {}),
      };
      const status = $("provider-status");
      const id = this.editingProvider;
      void this.guarded(status, () =>
        api<{ provider: Provider }>(id ? "PUT" : "POST", id ? `/api/providers/${id}` : "/api/providers", body),
      ).then((res) => {
        if (!res) return;
        this.providers = id ? this.providers.map((p) => (p.id === id ? res.provider : p)) : [...this.providers, res.provider];
        this.models.delete(res.provider.id);
        form.hidden = true;
        this.editingProvider = null;
        this.renderProviders();
        this.renderNewAgentFields();
      });
    });
  }

  private editProvider(p: Provider | null) {
    const form = $<HTMLFormElement>("provider-form");
    const field = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as T;
    this.editingProvider = p?.id ?? null;
    form.reset();
    $("provider-status").textContent = "";
    field<HTMLSelectElement>("preset").closest("label")!.hidden = p !== null;
    if (p) {
      field<HTMLInputElement>("name").value = p.name;
      field<HTMLSelectElement>("kind").value = p.kind;
      field<HTMLInputElement>("baseUrl").value = p.baseUrl ?? "";
    } else {
      field<HTMLSelectElement>("preset").value = PRESETS[0].id;
      field<HTMLSelectElement>("preset").dispatchEvent(new Event("change"));
    }
    $("api-key-help").textContent = p?.hasKey ? t("models.apiKeyKeep", { hint: p.keyHint ?? "" }) : t("models.apiKeyOptional");
    form.hidden = false;
    field<HTMLInputElement>("name").focus();
  }

  // ---------------------------------------------------------------- connect

  private snippets(): Record<string, { shown: string; real: string }> {
    const origin = location.origin;
    const real = tokenStore.get() ?? "";
    const shown = this.showToken ? real : `${real.slice(0, 4)}••••••••${real.slice(-4)}`;
    const curl = (tok: string) =>
      `curl -X POST ${origin}/api/occupants/me/status \\\n  -H "Authorization: Bearer ${tok}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"state":"writing","detail":"Hello","name":"Me","kind":"human"}'`;
    const hook = `mkdir -p ~/.claude/hooks && curl -fsSL ${origin}/integrations/claude-code/barnacle-hook.mjs -o ~/.claude/hooks/barnacle-hook.mjs`;
    const command = { type: "command", command: "node ~/.claude/hooks/barnacle-hook.mjs", timeout: 5 };
    const claude = (tok: string) =>
      JSON.stringify(
        {
          env: { BARNACLE_URL: origin, BARNACLE_TOKEN: tok },
          hooks: {
            SessionStart: [{ hooks: [command] }],
            UserPromptSubmit: [{ hooks: [command] }],
            PreToolUse: [{ matcher: "*", hooks: [command] }],
            Notification: [{ hooks: [command] }],
            Stop: [{ hooks: [command] }],
            SessionEnd: [{ hooks: [command] }],
          },
        },
        null,
        2,
      );
    return {
      curl: { shown: curl(shown), real: curl(real) },
      hook: { shown: hook, real: hook },
      claude: { shown: claude(shown), real: claude(real) },
    };
  }

  private renderConnect() {
    if (!tokenStore.get()) return;
    const s = this.snippets();
    $("snippet-curl").textContent = s.curl.shown;
    $("snippet-hook").textContent = s.hook.shown;
    $("snippet-claude").textContent = s.claude.shown;
    $("toggle-token").textContent = t(this.showToken ? "connect.hideToken" : "connect.showToken");
  }

  private async copy(button: HTMLButtonElement) {
    const text = this.snippets()[button.dataset.copy!]?.real ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // Clipboard blocked (e.g. plain http on a LAN address); the snippet can still be selected by hand.
    }
    button.textContent = t("connect.copied");
    setTimeout(() => (button.textContent = t("connect.copy")), 1500);
  }

  // ---------------------------------------------------------------- security

  private renderSecurity() {
    $<HTMLButtonElement>("rotate-token").disabled = this.tokenFromEnv;
    $("security-status").textContent = this.tokenFromEnv ? t("security.envToken") : "";
  }

  private async rotate() {
    const status = $("security-status");
    const res = await this.guarded(status, () => api<{ token: string }>("POST", "/api/token/rotate"));
    if (!res) return;
    tokenStore.replace(res.token);
    this.renderConnect();
    setStatus(status, t("security.rotated"), true);
  }

  /** Destructive buttons need a second click within 3 s (no browser confirm dialogs). */
  private armTwoClick(button: HTMLElement, labelKey: string, confirmKey: string, action: () => void) {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        button.textContent = t(confirmKey);
        timer = setTimeout(() => {
          armed = false;
          button.textContent = t(labelKey);
        }, 3000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      button.textContent = t(labelKey);
      action();
    });
  }
}
