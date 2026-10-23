import type Phaser from "phaser";
import { hsl } from "../characters";
import { t } from "../i18n";
import { wallPieces, type Part } from "./art";
import type { FloorScene, MapTool } from "./floor-scene";
import { newRoom } from "./floor-settings";
import { blocks, cells, isWall, ITEM_KINDS, itemDef, knownItems, setStyle, TILE, type Floor, type Furniture, type ItemKind, type Tile } from "./model";

type ToolId = "floor" | "wall" | "item" | "move" | "erase" | "room";
const TOOLS: ToolId[] = ["floor", "wall", "item", "move", "erase", "room"];
const GROUPS = ["work", "rest", "decor", "misc"] as const;
const T = TILE;
const UNDO_LIMIT = 60;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

const rectOf = (a: Tile, b: Tile) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 });

/**
 * The map editor: a palette of parts (floors, walls, furniture) beside the floor, painted and placed with the
 * mouse. It edits a draft copy of the floor; "Save" sends it to the server. Left button paints or places,
 * right button (or space + drag) pans, Ctrl+Z / Ctrl+Shift+Z undo and redo.
 */
export class MapEditor implements MapTool {
  private draft!: Floor;
  private original!: Floor;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private tool: ToolId = "floor";
  private rectMode = false;
  private floorStyle: string | null = null;
  private wallStyle: string | null = null;
  private item: { kind: ItemKind; variant: number } = { kind: "desk", variant: 0 };
  private hover: Tile | null = null;
  private drag: { start: Tile; last: Tile } | null = null;
  /** An item picked up with the move tool, and where it came from. */
  private carried: { item: Furniture; from: Furniture; grab: Tile } | null = null;
  /** The room being moved with the room tool, and the grab offset. */
  private roomDrag: { id: string; dx: number; dy: number; x: number; y: number } | null = null;
  private selectedRoom: string | null = null;
  private dirty = false;
  private refreshQueued = false;
  private panel: HTMLElement | null = null;
  /** The last save result, kept across panel re-renders. */
  private statusText: { text: string; ok: boolean } | null = null;
  private onKey = (e: KeyboardEvent) => this.keydown(e);

  constructor(
    private scene: FloorScene,
    private host: HTMLElement,
    private opts: { save: (floor: Floor) => Promise<boolean>; closed: () => void; nameOf?: (id: string) => string },
  ) {}

  get isOpen() {
    return this.panel !== null;
  }

  open(floor: Floor) {
    this.original = floor;
    this.draft = structuredClone(floor);
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.floorStyle ??= this.scene.art.floorStyles()[0] ?? null;
    this.wallStyle ??= this.scene.art.wallStyles()[0] ?? null;
    this.panel = el("div", { className: "map-editor" });
    this.host.append(this.panel);
    this.host.classList.add("editing");
    window.addEventListener("keydown", this.onKey);
    this.render();
    this.scene.setTool(this);
  }

  /** Leaves the editor; unsaved changes are thrown away unless saved first. */
  close() {
    if (!this.panel) return;
    window.removeEventListener("keydown", this.onKey);
    this.panel.remove();
    this.panel = null;
    this.host.classList.remove("editing");
    this.scene.setTool(null);
    if (this.dirty) this.scene.setFloor(this.original);
    this.opts.closed();
  }

  refreshLanguage() {
    this.render();
  }

  // ---------------------------------------------------------------- panel

  private render() {
    const panel = this.panel;
    if (!panel) return;
    const tools = el(
      "div",
      { className: "me-tools", role: "toolbar" },
      ...TOOLS.map((id) => {
        const b = el("button", { type: "button", textContent: t(`editor.tool.${id}`), className: id === this.tool ? "primary" : "" });
        b.setAttribute("aria-pressed", String(id === this.tool));
        b.addEventListener("click", () => {
          this.tool = id;
          this.dropCarried();
          this.scene.setGhost(null);
          this.render();
          this.scene.redrawOverlay();
        });
        return b;
      }),
    );
    const parts: HTMLElement[] = [];
    if (this.tool === "floor" || this.tool === "wall" || this.tool === "erase") parts.push(this.modeSwitch());
    if (this.tool === "floor") parts.push(this.styleGrid("floor"));
    if (this.tool === "wall") parts.push(this.styleGrid("wall"));
    if (this.tool === "item") parts.push(...this.itemGrid());
    if (this.tool === "room") parts.push(this.roomForm());

    const undo = el("button", { type: "button", textContent: t("editor.undo"), disabled: !this.undoStack.length });
    undo.addEventListener("click", () => this.undo());
    const redo = el("button", { type: "button", textContent: t("editor.redo"), disabled: !this.redoStack.length });
    redo.addEventListener("click", () => this.redo());
    const save = el("button", { type: "button", className: "primary", textContent: t("editor.save"), disabled: !this.dirty });
    save.addEventListener("click", () => void this.save());
    const done = el("button", { type: "button", textContent: t("editor.done") });
    done.addEventListener("click", () => void this.finish());
    const status = el("span", { className: "status", role: "status" });
    if (this.statusText) {
      status.textContent = this.statusText.text;
      status.className = `status ${this.statusText.ok ? "status--ok" : "status--error"}`;
    }

    panel.replaceChildren(
      tools,
      el("p", { className: "help me-hint", textContent: t(`editor.hint.${this.tool}`) }),
      el("div", { className: "me-body" }, ...parts),
      el("p", { className: "help me-keys", textContent: t("editor.keys") }),
      el("div", { className: "me-actions" }, undo, redo, save, done, status),
    );
  }

  private modeSwitch() {
    const make = (rect: boolean) => {
      const b = el("button", { type: "button", className: `small ${rect === this.rectMode ? "primary" : ""}`, textContent: t(rect ? `editor.rect.${this.tool}` : "editor.brush") });
      b.addEventListener("click", () => {
        this.rectMode = rect;
        this.render();
      });
      return b;
    };
    return el("div", { className: "me-mode" }, make(false), make(true));
  }

  private swatch(part: Part | null, title: string, selected: boolean, onPick: () => void) {
    const b = el("button", { type: "button", className: `me-part${selected ? " selected" : ""}`, title });
    b.setAttribute("aria-label", title);
    b.setAttribute("aria-pressed", String(selected));
    if (part) b.append(this.scene.art.thumbnail(part));
    else b.append(el("span", { className: "me-none", textContent: "∅" }));
    b.addEventListener("click", () => {
      onPick();
      this.render();
    });
    return b;
  }

  private styleGrid(layer: "floor" | "wall") {
    const styles = layer === "floor" ? this.scene.art.floorStyles() : this.scene.art.wallStyles();
    const current = layer === "floor" ? this.floorStyle : this.wallStyle;
    const set = (s: string | null) => (layer === "floor" ? (this.floorStyle = s) : (this.wallStyle = s));
    return el(
      "div",
      { className: "me-grid" },
      ...styles.map((s) => this.swatch(layer === "floor" ? { floor: s } : { wall: s }, t(`style.${s}`), current === s, () => set(s))),
      this.swatch(null, t(`editor.clear.${layer}`), current === null, () => set(null)),
    );
  }

  private itemGrid() {
    return GROUPS.map((group) => {
      const kinds = ITEM_KINDS.filter((k) => itemDef(k).group === group && this.scene.art.variants(k).length > 0);
      return el(
        "section",
        {},
        el("h4", { textContent: t(`editor.group.${group}`) }),
        el(
          "div",
          { className: "me-grid" },
          ...kinds.flatMap((kind) =>
            this.scene.art.variants(kind).map((variant) =>
              this.swatch({ item: kind, variant }, t(`item.${kind}`), this.item.kind === kind && this.item.variant === variant, () => (this.item = { kind, variant })),
            ),
          ),
        ),
      );
    });
  }

  private roomForm() {
    const room = this.draft.rooms.find((r) => r.id === this.selectedRoom);
    if (!room) return el("p", { className: "help", textContent: t("editor.roomNone") });
    const name = el("input", { type: "text", maxLength: 40, value: room.name });
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (!v) return;
      this.edit(() => (room.name = v));
    });
    const remove = el("button", { type: "button", className: "danger small", textContent: t("room.delete") });
    remove.addEventListener("click", () => {
      this.edit((d) => {
        d.rooms = d.rooms.filter((r) => r.id !== room.id);
        for (const [occ, roomId] of Object.entries(d.assignments)) if (roomId === room.id) delete d.assignments[occ];
        const gone = `room:${room.id}`;
        for (const [s, target] of Object.entries(d.routing)) if (target === gone) d.routing[s as keyof Floor["routing"]] = "home";
        for (const r of d.rooms) for (const [s, target] of Object.entries(r.routing)) if (target === gone) delete r.routing[s as keyof Floor["routing"]];
      });
      this.selectedRoom = null;
      this.render();
    });
    return el(
      "div",
      { className: "me-room" },
      el("label", {}, el("span", { textContent: t("room.name") }), name),
      el("p", { className: "help", textContent: `${room.w}×${room.h} · ${t("editor.roomHelp")}` }),
      remove,
    );
  }

  // ---------------------------------------------------------------- edits

  /** Records an undo step, applies a change to the draft and redraws. */
  private edit(fn: (d: Floor) => void) {
    this.pushUndo();
    fn(this.draft);
    this.changed();
  }

  private pushUndo() {
    this.undoStack.push(JSON.stringify(this.draft));
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private changed() {
    this.dirty = true;
    this.statusText = null;
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.scene.setFloor(this.draft, false);
      this.render();
    });
  }

  private undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.draft));
    this.draft = JSON.parse(prev) as Floor;
    this.changed();
  }

  private redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.draft));
    this.draft = JSON.parse(next) as Floor;
    this.changed();
  }

  private async save() {
    // Desks whose chair is gone: say whose they were (they get another free desk).
    const chairs = new Set(this.draft.items.filter((f) => f.kind === "officeChair").map((f) => `${f.x},${f.y}`));
    const lost = Object.entries(this.draft.desks ?? {}).filter(([, c]) => !chairs.has(`${c.x},${c.y}`));
    if (lost.length && !confirm(t("editor.desksRemoved", { names: lost.map(([id]) => this.opts.nameOf?.(id) ?? id).join("、") }))) return false;
    const ok = await this.opts.save(this.draft);
    this.statusText = { text: t(ok ? "floor.saved" : "editor.saveFailed"), ok };
    if (ok) {
      this.dirty = false;
      this.original = structuredClone(this.draft);
    }
    this.render();
    return ok;
  }

  private async finish() {
    if (this.dirty && !(await this.save())) return;
    this.scene.setFloor(this.draft);
    this.close();
  }

  private keydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void this.save();
    } else if (e.key === "Escape") {
      this.dropCarried();
      this.drag = null;
      this.scene.setGhost(null);
      this.scene.redrawOverlay();
    }
  }

  // ---------------------------------------------------------------- pointer

  pointer(phase: "down" | "move" | "up" | "hover", tile: Tile) {
    const moved = !this.hover || this.hover.x !== tile.x || this.hover.y !== tile.y;
    this.hover = tile;
    switch (this.tool) {
      case "floor":
      case "wall":
      case "erase":
        this.paintPointer(phase, tile, moved);
        break;
      case "item":
        this.itemPointer(phase, tile);
        break;
      case "move":
        this.movePointer(phase, tile);
        break;
      case "room":
        this.roomPointer(phase, tile);
        break;
    }
    if (moved || phase !== "hover") this.scene.redrawOverlay();
  }

  private inside(t: Tile) {
    return t.x >= 0 && t.y >= 0 && t.x < this.draft.width && t.y < this.draft.height;
  }

  /** Brush strokes, or a rectangle between where the button went down and where it came up. */
  private paintPointer(phase: "down" | "move" | "up" | "hover", tile: Tile, moved: boolean) {
    if (phase === "down") {
      this.pushUndo();
      this.drag = { start: tile, last: tile };
      if (!this.rectMode) this.paintTile(tile);
      this.changed();
    } else if (phase === "move" && this.drag) {
      if (!this.rectMode && moved) {
        // Fill in every tile between the last two pointer positions, so fast strokes leave no gaps.
        const { last } = this.drag;
        const steps = Math.max(Math.abs(tile.x - last.x), Math.abs(tile.y - last.y));
        for (let i = 1; i <= steps; i++) this.paintTile({ x: Math.round(last.x + ((tile.x - last.x) * i) / steps), y: Math.round(last.y + ((tile.y - last.y) * i) / steps) });
        this.changed();
      }
      this.drag.last = tile;
    } else if (phase === "up" && this.drag) {
      if (this.rectMode) {
        const r = rectOf(this.drag.start, tile);
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            // Walls draw the rectangle's outline (a room's walls); floors and the eraser fill it.
            const edge = x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1;
            if (this.tool !== "wall" || edge) this.paintTile({ x, y });
          }
        }
        this.changed();
      }
      this.drag = null;
    }
  }

  private paintTile(tile: Tile) {
    if (!this.inside(tile)) return;
    const { x, y } = tile;
    if (this.tool === "floor") setStyle(this.draft.floor, x, y, this.floorStyle);
    else if (this.tool === "wall") {
      setStyle(this.draft.walls, x, y, this.wallStyle);
      // Walls push out solid furniture standing there.
      if (this.wallStyle) this.draft.items = this.draft.items.filter((f) => !(blocks(f) && cells(f).some((c) => c.x === x && c.y === y)));
    } else if (this.tool === "erase") {
      const hit = this.itemAt(tile);
      if (hit) this.draft.items = this.draft.items.filter((f) => f !== hit);
      else setStyle(this.draft.walls, x, y, null);
    }
  }

  /** The topmost item covering a tile (things on desks first, rugs last). */
  private itemAt(tile: Tile): Furniture | null {
    const rank = (f: Furniture) => ({ top: 0, wall: 1, undefined: 2, rug: 3 })[String(itemDef(f.kind).layer) as "top"];
    const hits = knownItems(this.draft).filter((f) => cells(f).some((c) => c.x === tile.x && c.y === tile.y));
    hits.sort((a, b) => rank(a) - rank(b) || (b.y + itemDef(b.kind).h) - (a.y + itemDef(a.kind).h));
    return hits[0] ?? null;
  }

  /** Where an item goes when the pointer is on `tile`: centred on it, standing on its row; wall items onto the face. */
  private anchor(kind: ItemKind, tile: Tile): Furniture {
    const d = itemDef(kind);
    const x = tile.x - Math.floor((d.w - 1) / 2);
    let y = tile.y - (d.h - 1);
    if (d.layer === "wall") {
      const faces = new Set(wallPieces(this.draft).filter((p) => p.look !== "cap").map((p) => `${p.x},${p.y}`));
      y = faces.has(`${tile.x},${tile.y + 1}`) ? tile.y : tile.y - 1;
    }
    return { kind, x, y };
  }

  /** Whether an item can stand there: on the floor, solid things not on walls or other solid things. */
  private fits(f: Furniture, ignore?: Furniture) {
    const d = itemDef(f.kind);
    const c = cells(f);
    if (c.some((t) => !this.inside(t))) return false;
    if (d.layer === "wall") return c.every((t) => isWall(this.draft, t.x, t.y));
    if (d.layer === "rug" || d.layer === "top") return true;
    if (c.some((t) => isWall(this.draft, t.x, t.y))) return false;
    if (!blocks(f)) return true;
    const taken = new Set(
      knownItems(this.draft)
        .filter((o) => o !== ignore && blocks(o))
        .flatMap(cells)
        .map((t) => `${t.x},${t.y}`),
    );
    return c.every((t) => !taken.has(`${t.x},${t.y}`));
  }

  /**
   * A one-tile seat right in front of or behind a two-tile desk or table slides half a tile so it sits
   * centred on it (as Habblaud lays out its desks).
   */
  private snapSeat(f: Furniture): Furniture {
    const d = itemDef(f.kind);
    if (!d.seat || d.w !== 1) return f;
    for (const o of knownItems(this.draft)) {
      const od = itemDef(o.kind);
      if (!blocks(o) || od.w % 2 !== 0 || (o.y + od.h !== f.y && o.y !== f.y + 1)) continue;
      if (o.x === f.x) return { ...f, dx: T / 2 };
      if (o.x + od.w - 1 === f.x) return { ...f, dx: -T / 2 };
    }
    return f;
  }

  private itemPointer(phase: "down" | "move" | "up" | "hover", tile: Tile) {
    const f = this.snapSeat({ ...this.anchor(this.item.kind, tile), ...(this.item.variant ? { variant: this.item.variant } : {}) });
    const ok = this.fits(f);
    this.scene.setGhost(this.inside(tile) ? f : null, ok);
    if (phase === "down" && ok) this.edit((d) => d.items.push(f));
  }

  private movePointer(phase: "down" | "move" | "up" | "hover", tile: Tile) {
    if (phase === "down") {
      const hit = this.itemAt(tile);
      if (!hit) return;
      this.pushUndo();
      this.carried = { item: { ...hit }, from: hit, grab: { x: tile.x - hit.x, y: tile.y - hit.y } };
      this.draft.items = this.draft.items.filter((f) => f !== hit);
      this.changed();
    }
    if (!this.carried) return;
    const c = this.carried;
    c.item = { ...c.item, x: tile.x - c.grab.x, y: tile.y - c.grab.y };
    const ok = this.fits(c.item);
    this.scene.setGhost(c.item, ok);
    if (phase === "up") {
      this.draft.items.push(ok ? c.item : c.from);
      // A desk's owner moves with their chair.
      if (ok && c.item.kind === "officeChair" && this.draft.desks) {
        for (const desk of Object.values(this.draft.desks)) {
          if (desk.x === c.from.x && desk.y === c.from.y) Object.assign(desk, { x: c.item.x, y: c.item.y });
        }
      }
      this.carried = null;
      this.scene.setGhost(null);
      this.changed();
    }
  }

  /** Puts back an item that was being moved (the tool changed or Escape was pressed). */
  private dropCarried() {
    if (!this.carried) return;
    this.draft.items.push(this.carried.from);
    this.carried = null;
    this.changed();
  }

  private roomPointer(phase: "down" | "move" | "up" | "hover", tile: Tile) {
    const overlaps = (r: { x: number; y: number; w: number; h: number }, except?: string) =>
      this.draft.rooms.some((o) => o.id !== except && r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);
    const fitsFloor = (r: { x: number; y: number; w: number; h: number }) => r.x >= 0 && r.y >= 0 && r.x + r.w <= this.draft.width && r.y + r.h <= this.draft.height;
    if (phase === "down") {
      const hit = this.draft.rooms.find((r) => tile.x >= r.x && tile.y >= r.y && tile.x < r.x + r.w && tile.y < r.y + r.h);
      if (hit) {
        this.selectedRoom = hit.id;
        this.roomDrag = { id: hit.id, dx: tile.x - hit.x, dy: tile.y - hit.y, x: hit.x, y: hit.y };
        this.render();
      } else {
        this.drag = { start: tile, last: tile };
      }
    } else if (phase === "move") {
      if (this.roomDrag) {
        this.roomDrag.x = tile.x - this.roomDrag.dx;
        this.roomDrag.y = tile.y - this.roomDrag.dy;
      }
      if (this.drag) this.drag.last = tile;
    } else if (phase === "up") {
      if (this.roomDrag) {
        const drag = this.roomDrag;
        const room = this.draft.rooms.find((r) => r.id === drag.id);
        const next = room && { ...room, x: drag.x, y: drag.y };
        if (room && next && (next.x !== room.x || next.y !== room.y) && fitsFloor(next) && !overlaps(next, room.id)) {
          this.edit(() => Object.assign(room, { x: drag.x, y: drag.y }));
        }
        this.roomDrag = null;
      } else if (this.drag) {
        const r = rectOf(this.drag.start, tile);
        this.drag = null;
        if (r.w >= 2 && r.h >= 2 && fitsFloor(r) && !overlaps(r)) {
          const room = newRoom(this.draft, t("room.newName"), r.x, r.y, r.w, r.h);
          this.edit((d) => d.rooms.push(room));
          this.selectedRoom = room.id;
          this.render();
        }
      }
    }
  }

  // ---------------------------------------------------------------- overlay

  drawOverlay(g: Phaser.GameObjects.Graphics) {
    const zones = this.tool === "room";
    for (const r of this.draft.rooms) {
      const color = hsl(r.hue, 0.6, 0.6);
      const selected = zones && r.id === this.selectedRoom;
      if (zones) g.fillStyle(color, 0.18).fillRect(r.x * T, r.y * T, r.w * T, r.h * T);
      g.lineStyle(selected ? 3 : 2, color, zones ? 0.9 : 0.45).strokeRect(r.x * T + 1, r.y * T + 1, r.w * T - 2, r.h * T - 2);
    }
    if (this.roomDrag) {
      const room = this.draft.rooms.find((r) => r.id === this.roomDrag?.id);
      if (room) g.lineStyle(3, 0xffffff, 0.9).strokeRect(this.roomDrag.x * T, this.roomDrag.y * T, room.w * T, room.h * T);
    }
    if (this.drag && (this.rectMode || this.tool === "room")) {
      const r = rectOf(this.drag.start, this.drag.last);
      g.fillStyle(0xffffff, 0.15).fillRect(r.x * T, r.y * T, r.w * T, r.h * T);
      g.lineStyle(2, 0xffffff, 0.9).strokeRect(r.x * T, r.y * T, r.w * T, r.h * T);
    } else if (this.hover && (this.tool === "floor" || this.tool === "wall" || this.tool === "erase" || this.tool === "move")) {
      g.lineStyle(2, this.tool === "erase" ? 0xff7070 : 0xffffff, 0.9).strokeRect(this.hover.x * T, this.hover.y * T, T, T);
    }
  }
}
