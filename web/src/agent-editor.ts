import { api, tokenStore } from "./auth";
import { language, t } from "./i18n";
import type { Occupant } from "./types";

/**
 * Giving agents a soul and skills, OpenClaw style: a job title, SOUL.md (persona, tone, boundaries),
 * AGENTS.md (how it works) and the skills it may use, picked from a shared library of SKILL.md files.
 */

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  updatedAt: string;
}

export interface SoulData {
  soul: { role: string; soul: string; instructions: string };
  skills: string[];
}

type Guard = <T>(status: Element | null, fn: () => Promise<T>) => Promise<T | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

const labelled = (text: string, field: HTMLElement, help?: string) =>
  el("label", {}, el("span", { textContent: text }), field, ...(help ? [el("small", { className: "help", textContent: help })] : []));

function setStatus(node: Element | null, text: string, ok: boolean) {
  if (!node) return;
  node.textContent = text;
  node.className = `status ${ok ? "status--ok" : "status--error"}`;
}

/** Starting points for a soul, in English and Traditional Chinese (Japanese pages get English). */
const TEMPLATES: { id: string; skills: string[]; en: [string, string, string]; zh: [string, string, string] }[] = [
  {
    id: "researcher",
    skills: ["research-brief"],
    en: [
      "Researcher",
      "Curious and precise. You go to primary sources, you say when something is uncertain, and you never make up facts or links. Calm, concise, a little dry.",
      "- Start every task by restating the question in one line.\n- Prefer official and recent sources; always list the links you used.\n- End with what you could not confirm.",
    ],
    zh: [
      "研究員",
      "好奇、嚴謹。你會去找第一手資料，不確定的地方會直說，絕不編造事實或連結。語氣冷靜、簡潔，帶一點冷幽默。",
      "- 每個任務先用一句話重述問題。\n- 優先使用官方與最新的來源，並列出用到的連結。\n- 最後說明哪些地方無法確認。",
    ],
  },
  {
    id: "writer",
    skills: ["copy-polish", "weekly-report"],
    en: [
      "Writer",
      "Warm, clear and a bit playful. You write for real readers: short sentences, concrete words, no filler. You have taste and you say so.",
      "- Ask yourself who reads this and what they should do next.\n- Give the finished text first, notes after.\n- Match the tone the task asks for.",
    ],
    zh: [
      "寫手",
      "溫暖、清楚、帶點俏皮。你為真實的讀者寫作：短句、具體的詞、不說廢話。你有自己的品味，也敢說出來。",
      "- 先想清楚誰會讀、讀完要做什麼。\n- 先交成品，再附說明。\n- 依任務要求調整語氣。",
    ],
  },
  {
    id: "marketer",
    skills: ["social-post", "research-brief"],
    en: [
      "Growth marketer",
      "Energetic and data-minded. You know each platform's style, you love a good hook, and you never invent numbers.",
      "- Always name the audience and the one takeaway.\n- Give several variants to choose from.\n- End with a clear call to action.",
    ],
    zh: [
      "行銷營運",
      "有活力、重數據。你熟悉各平台的風格，擅長下鉤子，從不捏造數字。",
      "- 一定先說明受眾和最重要的一句話。\n- 提供多個版本讓人挑選。\n- 結尾要有明確的行動呼籲。",
    ],
  },
  {
    id: "assistant",
    skills: ["weekly-report", "copy-polish"],
    en: [
      "Project assistant",
      "Organised, friendly and dependable. You turn messy notes into plans, keep track of what matters and flag risks early.",
      "- Turn requests into checklists with owners and dates when possible.\n- Keep answers short; use tables for comparisons.\n- Flag anything blocking or risky at the top.",
    ],
    zh: [
      "專案助理",
      "有條理、友善、可靠。你能把雜亂的筆記整理成計畫，盯住重點，及早提醒風險。",
      "- 盡量把需求整理成有負責人和日期的清單。\n- 回答簡短；比較用表格。\n- 有阻礙或風險時放在最前面。",
    ],
  },
];

/** The "Soul & skills" editor for one agent (inside Settings → Members). */
export function soulEditor(o: Occupant, guard: Guard, getSkills: () => Promise<Skill[]>): HTMLElement {
  const box = el("div", { className: "subform__body brain-editor soul-editor" });
  const status = el("span", { className: "status" });
  box.append(el("p", { className: "help", textContent: t("soul.loading") }));
  void Promise.all([guard(status, () => api<SoulData>("GET", `/api/occupants/${encodeURIComponent(o.id)}/soul`)), getSkills()]).then(([data, skills]) => {
    if (!data) return;
    const role = el("input", { type: "text", maxLength: 60, value: data.soul.role, placeholder: t("soul.rolePlaceholder") });
    const soul = el("textarea", { rows: 6, maxLength: 20000, value: data.soul.soul, placeholder: t("soul.soulPlaceholder") });
    const instructions = el("textarea", { rows: 5, maxLength: 20000, value: data.soul.instructions, placeholder: t("soul.instructionsPlaceholder") });
    const picked = new Set(data.skills);
    const checks = skills.map((s) => {
      const box = el("input", { type: "checkbox", checked: picked.has(s.id), value: s.id });
      return el("label", { className: "checkbox skill-check", title: s.description }, box, el("span", {}, el("strong", { textContent: s.name }), el("small", { className: "help", textContent: s.description })));
    });
    const template = el("select");
    template.append(new Option(t("soul.template"), ""), ...TEMPLATES.map((tpl) => new Option((language() === "zh-Hant" ? tpl.zh : tpl.en)[0], tpl.id)));
    template.addEventListener("change", () => {
      const tpl = TEMPLATES.find((x) => x.id === template.value);
      if (!tpl) return;
      const [r, s, i] = language() === "zh-Hant" ? tpl.zh : tpl.en;
      role.value = r;
      soul.value = s;
      instructions.value = i;
      for (const label of checks) {
        const input = label.querySelector("input")!;
        if (tpl.skills.includes(input.value)) input.checked = true;
      }
      template.value = "";
    });
    const save = el("button", { type: "button", className: "primary small", textContent: t("soul.save") });
    save.addEventListener("click", () => {
      const body = {
        role: role.value.trim(),
        soul: soul.value,
        instructions: instructions.value,
        skills: checks.map((c) => c.querySelector("input")!).filter((i) => i.checked).map((i) => i.value),
      };
      void guard(status, () => api("PUT", `/api/occupants/${encodeURIComponent(o.id)}/soul`, body)).then((res) => {
        if (res) setStatus(status, t("soul.saved"), true);
      });
    });
    box.replaceChildren(
      el("div", { className: "row" }, labelled(t("soul.role"), role), labelled(t("soul.fromTemplate"), template)),
      labelled(t("soul.soul"), soul, t("soul.soulHelp")),
      labelled(t("soul.instructions"), instructions, t("soul.instructionsHelp")),
      el("strong", { className: "help", textContent: t("soul.skills") }),
      skills.length ? el("div", { className: "skill-checks" }, ...checks) : el("p", { className: "help", textContent: t("skills.none") }),
      el("div", { className: "row" }, save, status),
    );
  });
  return box;
}

/** Settings → Skills: the shared library. */
export class SkillsTab {
  private skills: Skill[] = [];
  private open: string | null = null;

  constructor(
    private root: HTMLElement,
    private guard: Guard,
  ) {}

  async list(): Promise<Skill[]> {
    const res = await this.guard(null, () => api<{ skills: Skill[] }>("GET", "/api/skills"));
    if (res) this.skills = res.skills;
    return this.skills;
  }

  async render() {
    await this.list();
    const status = el("span", { className: "status", role: "status" });

    // New skill, or import a SKILL.md (pasted or from a file).
    const name = el("input", { type: "text", maxLength: 60, placeholder: t("skills.name") });
    const create = el("button", { type: "button", className: "primary small", textContent: t("skills.new") });
    create.addEventListener("click", () => {
      if (!name.value.trim()) return;
      void this.guard(status, () => api<{ skill: Skill }>("POST", "/api/skills", { name: name.value.trim(), description: "", body: "" })).then((res) => {
        if (!res) return;
        this.open = res.skill.id;
        void this.render();
      });
    });
    const paste = el("textarea", { rows: 4, placeholder: t("skills.pastePlaceholder") });
    const file = el("input", { type: "file", accept: ".md,text/markdown,text/plain" });
    file.addEventListener("change", () => {
      void file.files?.[0]?.text().then((text) => (paste.value = text));
    });
    const importBtn = el("button", { type: "button", className: "small", textContent: t("skills.import") });
    importBtn.addEventListener("click", () => {
      if (!paste.value.trim()) return;
      void this.guard(status, () => api<{ skill: Skill }>("POST", "/api/skills", { markdown: paste.value })).then((res) => {
        if (!res) return;
        this.open = res.skill.id;
        void this.render();
      });
    });

    this.root.replaceChildren(
      el("p", { className: "help", textContent: t("skills.intro") }),
      el("div", { className: "row" }, name, create),
      el(
        "details",
        { className: "subform" },
        el("summary", { textContent: t("skills.importTitle") }),
        el("div", { className: "subform__body" }, paste, el("div", { className: "row" }, file, importBtn)),
      ),
      el("div", { className: "row" }, status),
      el("ul", { className: "manage-list" }, ...this.skills.map((s) => this.item(s))),
    );
  }

  private item(s: Skill) {
    const toggle = el("button", { type: "button", className: "small", textContent: t("room.edit") });
    toggle.setAttribute("aria-expanded", String(this.open === s.id));
    toggle.addEventListener("click", () => {
      this.open = this.open === s.id ? null : s.id;
      void this.render();
    });
    const info = el("div", { className: "occupant-info" }, el("strong", { textContent: s.name }), el("small", { className: "help", textContent: s.description || "—" }));
    const li = el("li", { className: "occupant-item" }, el("div", { className: "occupant-row" }, info, toggle));
    if (this.open === s.id) li.append(this.editor(s));
    return li;
  }

  private editor(s: Skill) {
    const status = el("span", { className: "status" });
    const name = el("input", { type: "text", maxLength: 60, value: s.name });
    const description = el("textarea", { rows: 2, maxLength: 500, value: s.description, placeholder: t("skills.descriptionPlaceholder") });
    const body = el("textarea", { rows: 12, maxLength: 60000, value: s.body, className: "mono", placeholder: t("skills.bodyPlaceholder") });
    const save = el("button", { type: "button", className: "primary small", textContent: t("soul.save") });
    save.addEventListener("click", () => {
      void this.guard(status, () => api("PUT", `/api/skills/${encodeURIComponent(s.id)}`, { name: name.value.trim(), description: description.value.trim(), body: body.value })).then((res) => {
        if (res) setStatus(status, t("soul.saved"), true);
      });
    });
    const exportBtn = el("button", { type: "button", className: "small", textContent: t("skills.export") });
    exportBtn.addEventListener("click", () => {
      void (async () => {
        const res = await fetch(`/api/skills/${encodeURIComponent(s.id)}/export`, { headers: { authorization: `Bearer ${tokenStore.get() ?? ""}` } });
        if (!res.ok) return setStatus(status, t("common.failed", { error: String(res.status) }), false);
        const url = URL.createObjectURL(await res.blob());
        const a = el("a", { href: url, download: "SKILL.md" });
        a.click();
        URL.revokeObjectURL(url);
      })();
    });
    const remove = el("button", { type: "button", className: "danger small", textContent: t("skills.delete") });
    remove.addEventListener("click", () => {
      void this.guard(status, () => api("DELETE", `/api/skills/${encodeURIComponent(s.id)}`)).then((res) => {
        if (!res) return;
        this.open = null;
        void this.render();
      });
    });
    return el(
      "div",
      { className: "subform__body brain-editor" },
      labelled(t("skills.name"), name),
      labelled(t("skills.description"), description, t("skills.descriptionHelp")),
      labelled(t("skills.body"), body),
      el("div", { className: "row" }, save, exportBtn, remove, status),
    );
  }
}
