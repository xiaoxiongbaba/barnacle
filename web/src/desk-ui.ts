import { characterSeed } from "./floor/art-habblaud";
import type { Workstation } from "./floor/model";
import { t } from "./i18n";
import type { Occupant } from "./types";
import { avatarCanvas } from "./vendor/habblaud/art/index";

/**
 * The little menu that opens when you click a desk in the office: whose it is (workstation, details,
 * move desk), or, for a free desk, who to give it to. A hint bar shows while you pick a desk.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface DeskMenuContext {
  occupants: () => Occupant[];
  /** "Research · desk 3" for a chair, or for someone's desk. */
  label: (chair: { x: number; y: number }) => string;
  deskOf: (id: string) => { x: number; y: number } | undefined;
  workstation: (id: string) => void;
  details: (id: string) => void;
  move: (id: string) => void;
  assign: (id: string, chair: { x: number; y: number }) => void;
}

export class DeskMenu {
  private box: HTMLElement | null = null;
  private hint: HTMLElement | null = null;

  constructor(private ctx: DeskMenuContext) {
    document.addEventListener("pointerdown", (e) => {
      if (this.box && !this.box.contains(e.target as Node)) this.close();
    });
    window.addEventListener("keydown", (e) => e.key === "Escape" && this.close());
  }

  close() {
    this.box?.remove();
    this.box = null;
  }

  open(ws: Workstation, owner: string | null, at: { x: number; y: number }) {
    this.close();
    const box = el("div", "ui-deskmenu");
    const head = el("div", "ui-deskmenu__head");
    const o = owner ? this.ctx.occupants().find((x) => x.id === owner) : undefined;
    if (o) {
      const img = document.createElement("img");
      img.src = avatarCanvas(characterSeed(o.id), { scale: 2 }).toDataURL();
      img.alt = "";
      img.width = 32;
      img.height = 32;
      img.className = "ui-proj__avatar";
      const who = el("div", "ui-deskmenu__who");
      who.append(el("strong", "", o.name), el("span", "ui-faint ui-small", [o.role, this.ctx.label(ws.chair)].filter(Boolean).join(" · ")));
      head.append(img, who);
      box.append(head);
      const row = el("div", "ui-deskmenu__actions");
      const btn = (text: string, fn: () => void, primary = false) => {
        const b = el("button", `ui-btn ui-btn--sm${primary ? " ui-btn--primary" : ""}`, text);
        b.type = "button";
        b.addEventListener("click", () => {
          this.close();
          fn();
        });
        row.append(b);
      };
      if (o.kind === "agent") btn(t("desk.bench"), () => this.ctx.workstation(o.id), true);
      btn(t("desk.details"), () => this.ctx.details(o.id));
      btn(t("desk.move"), () => this.ctx.move(o.id));
      box.append(row);
    } else {
      head.append(el("strong", "", `${t("desk.empty")} · ${this.ctx.label(ws.chair)}`));
      box.append(head);
      const select = el("select", "ui-sched__select");
      select.append(new Option(t("desk.choose"), ""));
      for (const p of this.ctx.occupants()) {
        const desk = this.ctx.deskOf(p.id);
        select.append(new Option(`${p.name}${desk ? ` — ${t("desk.current", { desk: this.ctx.label(desk) })}` : ""}`, p.id));
      }
      const assign = el("button", "ui-btn ui-btn--sm ui-btn--primary", t("desk.assign"));
      assign.type = "button";
      assign.addEventListener("click", () => {
        if (!select.value) return;
        this.close();
        this.ctx.assign(select.value, ws.chair);
      });
      const row = el("div", "ui-deskmenu__actions");
      row.append(el("span", "ui-small ui-faint", t("desk.assignTo")), select, assign);
      box.append(row);
    }
    document.getElementById("ui")?.append(box);
    // Next to the click, kept on screen.
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    box.style.left = `${Math.max(8, Math.min(at.x + 12, window.innerWidth - w - 8))}px`;
    box.style.top = `${Math.max(8, Math.min(at.y + 12, window.innerHeight - h - 8))}px`;
    this.box = box;
  }

  /** The bar that says what to do while picking a desk (null hides it). */
  picking(text: string | null) {
    this.hint?.remove();
    this.hint = null;
    if (!text) return;
    this.hint = el("div", "ui-deskhint", text);
    document.getElementById("ui")?.append(this.hint);
  }
}
