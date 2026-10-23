import { t } from "../i18n";
import type { Occupant, State } from "../types";
import { resizeLayer, type Floor, type Room, type RouteTarget } from "./model";

const STATES: State[] = ["idle", "writing", "researching", "executing", "syncing", "waiting", "error", "offline"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

const labelled = (text: string, field: HTMLElement) => el("label", {}, el("span", { textContent: text }), field);

function select<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void) {
  const s = el("select");
  s.append(...options.map((o) => new Option(o.label, o.value, false, o.value === value)));
  s.addEventListener("change", () => onChange(s.value as T));
  return s;
}

function numberInput(value: number, min: number, max: number, onChange: (v: number) => void) {
  const input = el("input", { type: "number", min: String(min), max: String(max), value: String(value) });
  input.addEventListener("change", () => onChange(Math.round(Number(input.value) || min)));
  return input;
}

/** First position where a w×h zone fits without overlapping another. */
export function findSpace(floor: Floor, w: number, h: number): { x: number; y: number } | null {
  for (let y = 0; y + h <= floor.height; y++) {
    for (let x = 0; x + w <= floor.width; x++) {
      const clear = floor.rooms.every((o) => x + w <= o.x || o.x + o.w <= x || y + h <= o.y || o.y + o.h <= y);
      if (clear) return { x, y };
    }
  }
  return null;
}

/** A new room (zone) with an id made from its name. */
export function newRoom(floor: Floor, name: string, x: number, y: number, w: number, h: number): Room {
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "room";
  while (floor.rooms.some((r) => r.id === id)) id = `${id.slice(0, 30)}-${Math.floor(Math.random() * 1000)}`;
  return { id, name, purpose: "", x, y, w, h, hue: (floor.rooms.length * 67 + 20) % 360, routing: {} };
}

/** Changes the floor's size, keeping tiles, furniture and rooms that still fit. */
export function resizeFloor(f: Floor, width: number, height: number) {
  f.width = width;
  f.height = height;
  f.floor = resizeLayer(f.floor, width, height);
  f.walls = resizeLayer(f.walls, width, height);
  f.items = f.items.filter((i) => i.x < width && i.y < height);
  for (const r of f.rooms) {
    r.x = Math.min(r.x, width - 1);
    r.y = Math.min(r.y, height - 1);
    r.w = Math.max(1, Math.min(r.w, width - r.x));
    r.h = Math.max(1, Math.min(r.h, height - r.y));
  }
}

/**
 * The Floor plan tab: floor size, default routing, rooms and their overrides. Edits a draft copy;
 * "Save floor plan" sends the whole floor to the server, which validates overlaps and references.
 */
export class FloorEditor {
  private draft: Floor | null = null;
  private dirty = false;
  private open = new Set<string>();

  constructor(
    private root: HTMLElement,
    private opts: {
      getFloor: () => Floor | null;
      getOccupants: () => Occupant[];
      save: (floor: Floor, status: HTMLElement) => Promise<boolean>;
    },
  ) {}

  /** Re-reads the server floor unless there are unsaved edits. */
  sync() {
    if (this.dirty && this.draft) return;
    const floor = this.opts.getFloor();
    this.draft = floor ? structuredClone(floor) : null;
    this.render();
  }

  private change(fn: (f: Floor) => void) {
    if (!this.draft) return;
    fn(this.draft);
    this.dirty = true;
    this.render();
  }

  private roomOptions(extra: { value: string; label: string }[]) {
    return [...extra, ...(this.draft?.rooms ?? []).map((r) => ({ value: `room:${r.id}`, label: r.name }))];
  }

  render() {
    const f = this.draft;
    if (!f) {
      this.root.replaceChildren();
      return;
    }
    const status = el("span", { className: "status", role: "status" });
    const save = el("button", { type: "button", className: "primary", textContent: t("floor.save"), disabled: !this.dirty });
    save.addEventListener("click", () => {
      void this.opts.save(f, status).then((ok) => {
        if (!ok) return;
        this.dirty = false;
        status.textContent = t("floor.saved");
        status.className = "status status--ok";
        save.disabled = true;
      });
    });
    const reset = el("button", { type: "button", textContent: t("floor.reset"), disabled: !this.dirty });
    reset.addEventListener("click", () => {
      this.dirty = false;
      this.sync();
    });

    const routing = el(
      "table",
      { className: "route-table" },
      el("thead", {}, el("tr", {}, el("th", { textContent: t("floor.state") }), el("th", { textContent: t("floor.goTo") }))),
      el(
        "tbody",
        {},
        ...STATES.map((state) =>
          el(
            "tr",
            {},
            el("td", { textContent: t(`state.${state}`) }),
            el(
              "td",
              {},
              select(this.roomOptions([{ value: "home", label: t("floor.own") }]), f.routing[state], (v) =>
                this.change((d) => (d.routing[state] = v as Floor["routing"][State])),
              ),
            ),
          ),
        ),
      ),
    );

    const members = (roomId: string) => Object.values(f.assignments).filter((r) => r === roomId).length;

    this.root.replaceChildren(
      el("p", { className: "help", textContent: t("floor.intro") }),
      el("h3", { textContent: t("floor.size") }),
      el(
        "div",
        { className: "row" },
        labelled(t("floor.width"), numberInput(f.width, 10, 80, (v) => this.change((d) => resizeFloor(d, v, d.height)))),
        labelled(t("floor.height"), numberInput(f.height, 10, 80, (v) => this.change((d) => resizeFloor(d, d.width, v)))),
      ),
      el("h3", { textContent: t("floor.routing") }),
      el("p", { className: "help", textContent: t("floor.routingHelp") }),
      routing,
      el("h3", { textContent: t("floor.rooms") }),
      el("ul", { className: "manage-list" }, ...f.rooms.map((r) => this.roomItem(r, members(r.id)))),
      this.addRoomForm(),
      el("div", { className: "row sticky-actions" }, save, reset, status),
    );
  }

  private roomItem(r: Room, count: number) {
    const swatch = el("span", { className: "swatch" });
    swatch.style.background = `hsl(${r.hue} 45% 60%)`;
    const toggle = el("button", { type: "button", className: "small", textContent: t("room.edit") });
    toggle.setAttribute("aria-expanded", String(this.open.has(r.id)));
    toggle.addEventListener("click", () => {
      if (this.open.has(r.id)) this.open.delete(r.id);
      else this.open.add(r.id);
      this.render();
    });
    const info = el(
      "div",
      { className: "occupant-info" },
      el("strong", {}, swatch, ` ${r.name}`),
      el("small", { className: "help", textContent: `${r.w}×${r.h} · ${t("room.members", { count: String(count) })}` }),
      ...(r.purpose ? [el("small", { className: "help", textContent: r.purpose })] : []),
    );
    const li = el("li", { className: "occupant-item" }, el("div", { className: "occupant-row" }, info, toggle));
    if (this.open.has(r.id)) li.append(this.roomEditor(r));
    return li;
  }

  private roomEditor(r: Room) {
    const edit = (fn: (room: Room) => void) => this.change((d) => fn(d.rooms.find((x) => x.id === r.id)!));
    const name = el("input", { type: "text", maxLength: 40, value: r.name });
    name.addEventListener("change", () => edit((room) => (room.name = name.value.trim() || room.name)));
    const purpose = el("textarea", { rows: 2, maxLength: 200, value: r.purpose, placeholder: t("room.purposePlaceholder") });
    purpose.addEventListener("change", () => edit((room) => (room.purpose = purpose.value)));
    const hue = el("input", { type: "range", min: "0", max: "359", value: String(r.hue) });
    hue.addEventListener("change", () => edit((room) => (room.hue = Number(hue.value))));
    const overrides = el(
      "table",
      { className: "route-table" },
      el(
        "tbody",
        {},
        ...STATES.map((state) =>
          el(
            "tr",
            {},
            el("td", { textContent: t(`state.${state}`) }),
            el(
              "td",
              {},
              select(
                this.roomOptions([
                  { value: "inherit", label: t("floor.inherit") },
                  { value: "home", label: t("floor.own") },
                ]),
                r.routing[state] ?? "inherit",
                (v) =>
                  edit((room) => {
                    if (v === "inherit") delete room.routing[state];
                    else room.routing[state] = v as RouteTarget;
                  }),
              ),
            ),
          ),
        ),
      ),
    );
    const remove = el("button", { type: "button", className: "danger small", textContent: t("room.delete") });
    let armed = false;
    remove.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        remove.textContent = t("room.confirm");
        setTimeout(() => {
          armed = false;
          remove.textContent = t("room.delete");
        }, 3000);
        return;
      }
      this.change((d) => {
        d.rooms = d.rooms.filter((x) => x.id !== r.id);
        for (const [occ, roomId] of Object.entries(d.assignments)) if (roomId === r.id) delete d.assignments[occ];
        const gone = `room:${r.id}`;
        for (const s of STATES) if (d.routing[s] === gone) d.routing[s] = "home";
        for (const room of d.rooms) for (const s of STATES) if (room.routing[s] === gone) delete room.routing[s];
      });
    });
    return el(
      "div",
      { className: "subform__body brain-editor" },
      labelled(t("room.name"), name),
      labelled(t("room.purpose"), purpose),
      el(
        "div",
        { className: "row" },
        labelled(t("room.x"), numberInput(r.x, 0, 79, (v) => edit((room) => (room.x = v)))),
        labelled(t("room.y"), numberInput(r.y, 0, 79, (v) => edit((room) => (room.y = v)))),
        labelled(t("floor.width"), numberInput(r.w, 1, 80, (v) => edit((room) => (room.w = v)))),
        labelled(t("floor.height"), numberInput(r.h, 1, 80, (v) => edit((room) => (room.h = v)))),
      ),
      labelled(t("room.hue"), hue),
      el("strong", { className: "help", textContent: t("room.routing") }),
      overrides,
      el("div", { className: "row" }, remove),
    );
  }

  private addRoomForm() {
    const name = el("input", { type: "text", maxLength: 40, placeholder: t("room.name") });
    const error = el("p", { className: "error", hidden: true, textContent: t("floor.noSpace") });
    const add = el("button", { type: "button", textContent: t("floor.addRoom") });
    add.addEventListener("click", () => {
      const f = this.draft;
      if (!f) return;
      const spot = findSpace(f, 8, 6);
      if (!spot) {
        error.hidden = false;
        return;
      }
      const room = newRoom(f, name.value.trim() || t("room.newName"), spot.x, spot.y, 8, 6);
      this.open.add(room.id);
      this.change((d) => d.rooms.push(room));
    });
    return el("div", { className: "subform subform__body" }, el("div", { className: "row" }, name, add), error);
  }
}
