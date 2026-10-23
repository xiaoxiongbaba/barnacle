import Phaser from "phaser";
import { t } from "../i18n";
import type { Occupant, State } from "../types";
import type { CharacterView, Facing, FloorArt } from "./art";
import { Life } from "./life";
import { depthOf, findPath, homeRoom, knownItems, layoutRooms, nearestWalkable, targetRoom, workstationAt, type Workstation, TILE, walkGrid, type Floor, type Furniture, type RoomLayout, type Seat, type Tile, type WalkMap } from "./model";

const FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";
const T = TILE;
const STEP_MS = 260; // per tile
const WORKING: ReadonlySet<State> = new Set(["writing", "researching", "executing", "syncing", "waiting", "error"]);

interface Walker {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  view: CharacterView;
  bubble: Phaser.GameObjects.Text;
  occupant: Occupant;
  tile: Tile;
  goal: Seat | null;
  walk?: Phaser.Tweens.TweenChain;
  bob?: Phaser.Tweens.Tween;
  maxChars: number;
  /** The seat placeAll gave them (where they go back to). */
  home: Seat | null;
  /** Out doing something on their own or with others (see life.ts); placeAll leaves them be. */
  outing: boolean;
  /** A line they are saying until this time (ms), shown instead of the status. */
  sayUntil: number;
  icon?: Phaser.GameObjects.Image;
}

/** What the idle life (life.ts) sees of someone. */
export interface LifeAgent {
  id: string;
  name: string;
  state: State;
  tile: Tile;
  home: Seat | null;
  outing: boolean;
  /** At their seat, not walking. */
  settled: boolean;
  /** In a running project's meeting: stays put. */
  meeting: boolean;
}

/** What the map editor plugs into the scene: pointer input on tiles, and an overlay it draws. */
export interface MapTool {
  pointer(phase: "down" | "move" | "up" | "hover", tile: Tile, shift: boolean): void;
  drawOverlay(g: Phaser.GameObjects.Graphics): void;
}

/** Screen pixels covered by floating panels on each side. */
export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FloorSceneData {
  floor: Floor;
  art: FloorArt;
  insets?: Insets;
  onReady: () => void;
}

/** The office floor: a tile map with walls and furniture, people walking between rooms along real paths. */
export class FloorScene extends Phaser.Scene {
  private floor!: Floor;
  art!: FloorArt;
  private layouts: RoomLayout[] = [];
  private grid!: WalkMap;
  private world: Phaser.GameObjects.GameObject[] = [];
  private walkers = new Map<string, Walker>();
  private onReady: () => void = () => {};
  private tool: MapTool | null = null;
  private overlay: Phaser.GameObjects.Graphics | null = null;
  private ghost: Phaser.GameObjects.GameObject | null = null;
  private panning = false;
  private painting = false;
  private spaceDown = false;
  private fitted = false;
  private insets: Insets = { left: 0, top: 0, right: 0, bottom: 0 };
  /** Last zoom the on-screen text sizes were computed for. */
  private lastZoom = 0;
  private life = new Life(this);
  /** Clicks in the office (not while editing): on a person, or on a desk / its computer. */
  onPerson: (id: string) => void = () => {};
  onDesk: (ws: Workstation, owner: string | null, part: "chair" | "computer", at: { x: number; y: number }) => void = () => {};
  /** Choosing a desk for someone: highlights desks; a click picks one. */
  private picking: { id: string; done: (chair: Tile | null) => void; overlay: Phaser.GameObjects.Graphics } | null = null;
  /** Managers (room id → occupant), shown on their name plates. */
  private managers: Record<string, string> = {};
  /** Name plates on desks whose owner is away. */
  private plates = new Map<string, Phaser.GameObjects.Text>();
  private downAt: { x: number; y: number } | null = null;
  private platesAt = 0;
  /** Scale for on-screen text so it stays readable when zoomed out. */
  private textScale = 1;
  /** Members of running projects meet in the room with the meeting table: occupant id → room id. */
  private meetings = new Map<string, string>();

  constructor() {
    super("floor");
  }

  init(data: FloorSceneData) {
    this.floor = data.floor;
    this.art = data.art;
    this.insets = data.insets ?? this.insets;
    this.onReady = data.onReady;
  }

  preload() {
    this.art.preload(this);
  }

  create() {
    this.art.setup(this);
    this.buildWorld();
    this.setupCamera();
    this.setupInput();
    const onVisible = () => {
      if (document.visibilityState === "visible") this.placeAll(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    this.events.once("shutdown", () => document.removeEventListener("visibilitychange", onVisible));
    this.onReady();
  }

  // ---------------------------------------------------------------- world

  private buildWorld() {
    for (const obj of this.world) obj.destroy();
    this.world = [];
    const before = new Set(this.children.list);
    this.grid = walkGrid(this.floor);
    this.layouts = layoutRooms(this.floor, this.grid);
    this.art.drawFloors(this, this.floor);
    this.art.drawWalls(this, this.floor);
    const items = knownItems(this.floor);
    for (const f of items) this.art.drawFurniture(this, f, depthOf(f, items));
    for (const r of this.floor.rooms) {
      this.add
        .text((r.x + r.w / 2) * T, r.y * T + 4, r.name, {
          fontFamily: FONT,
          fontSize: "13px",
          fontStyle: "bold",
          color: "#ffffff",
          backgroundColor: "#1d1d27cc",
          padding: { x: 8, y: 3 },
          resolution: 2,
        })
        .setOrigin(0.5, 0)
        .setDepth(900_000)
        .setData("sign", true);
    }
    this.world = this.children.list.filter((o) => !before.has(o) && o !== this.ghost && o !== this.overlay);
    this.lastZoom = 0;
    this.redrawOverlay();
  }

  /** Replaces the floor plan. People keep their place; with `reroute` they walk to their (new) seats. */
  setFloor(floor: Floor, reroute = true) {
    const resized = floor.width !== this.floor.width || floor.height !== this.floor.height;
    this.floor = floor;
    this.buildWorld();
    if (resized) this.updateBounds();
    if (!reroute) return;
    for (const w of this.walkers.values()) {
      w.tile = nearestWalkable(this.grid, w.tile);
      w.goal = null;
    }
    this.placeAll(true);
  }

  /** Turns the map editor on (with its tool) or off. */
  setTool(tool: MapTool | null) {
    this.tool = tool;
    this.setGhost(null);
    this.redrawOverlay();
  }

  /** Shows a semi-transparent preview of an item under the cursor; red when it can't go there. */
  setGhost(f: Furniture | null, ok = true) {
    this.ghost?.destroy();
    this.ghost = null;
    if (!f) return;
    const obj = this.art.drawFurniture(this, f, 950_000) as Phaser.GameObjects.Image | null;
    if (!obj) return;
    obj.setAlpha(0.75).setDepth(950_000);
    if (!ok && typeof obj.setTint === "function") obj.setTint(0xff7070);
    this.ghost = obj;
  }

  redrawOverlay() {
    this.overlay?.destroy();
    this.overlay = null;
    if (!this.tool) return;
    const g = this.add.graphics().setDepth(1_000_000);
    g.lineStyle(1, 0xffffff, 0.1);
    for (let x = 0; x <= this.floor.width; x++) g.lineBetween(x * T, 0, x * T, this.floor.height * T);
    for (let y = 0; y <= this.floor.height; y++) g.lineBetween(0, y * T, this.floor.width * T, y * T);
    g.lineStyle(2, 0xffffff, 0.5).strokeRect(0, 0, this.floor.width * T, this.floor.height * T);
    this.tool.drawOverlay(g);
    this.overlay = g;
  }

  // ---------------------------------------------------------------- camera and input

  private setupCamera() {
    this.updateBounds();
    this.scale.on("resize", () => this.fit());
    this.fit();
  }

  private updateBounds() {
    const m = this.art.margin ?? { left: 6, right: 6, top: 6, bottom: 6 };
    this.cameras.main.setBounds(-m.left * T, -m.top * T, (this.floor.width + m.left + m.right) * T, (this.floor.height + m.top + m.bottom) * T);
  }

  /**
   * Zooms so the building fills the screen beside the side panel and under the top bar. The feed floats
   * over the grounds, and the street in front sits at the bottom edge of the screen.
   */
  fit() {
    const cam = this.cameras.main;
    const { left, top, right, bottom } = this.insets;
    const pad = 12;
    const w = (this.floor.width + 1) * T;
    const h = (this.floor.height + (this.art.margin ? 3 : 1)) * T;
    const availW = cam.width - left - right - pad * 2;
    // The feed may cover the street but not much of the building: leave half its height free.
    const availH = cam.height - top - bottom / 2 - pad * 2;
    const zoom = Math.max(this.minZoom(), Phaser.Math.Clamp(Math.min(availW / w, availH / h), 0.2, 3));
    cam.setZoom(zoom);
    // Building centred in the uncovered area, a little high so the street shows at the bottom.
    const cx = (this.floor.width * T) / 2 - (left - right) / 2 / zoom;
    const cy = ((this.floor.height + (this.art.margin ? 2 : 0)) * T) / 2 - (top - bottom / 2) / 2 / zoom;
    cam.centerOn(cx, cy);
    this.fitted = true;
  }

  /** The panels moved: frame the office again in the space that's left. */
  setInsets(insets: Insets) {
    this.insets = insets;
    if (this.cameras?.main) this.fit();
  }

  /** Pans to someone (from the side panel or the feed). */
  focus(id: string) {
    const w = this.walkers.get(id);
    if (!w) return;
    const cam = this.cameras.main;
    const zoom = Math.max(cam.zoom, 1.2);
    cam.zoomTo(zoom, 300);
    const { left, top, right, bottom } = this.insets;
    cam.pan(w.container.x - (left - right) / 2 / zoom, w.container.y - 24 - (top - bottom) / 2 / zoom, 400, "Sine.easeInOut");
  }

  /** With scenery around the building, never zoom out past it (the screen would show its edge). */
  private minZoom() {
    const m = this.art.margin;
    if (!m) return 0.2;
    const cam = this.cameras.main;
    return Math.max(cam.width / ((this.floor.width + m.left + m.right) * T), cam.height / ((this.floor.height + m.top + m.bottom) * T));
  }

  zoomBy(factor: number) {
    const cam = this.cameras.main;
    cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, Math.max(0.2, this.minZoom()), 3));
  }

  private tileAt(p: Phaser.Input.Pointer): Tile {
    const world = this.cameras.main.getWorldPoint(p.x, p.y);
    return { x: Math.floor(world.x / T), y: Math.floor(world.y / T) };
  }

  private setupInput() {
    this.input.mouse?.disableContextMenu();
    const keys = this.input.keyboard;
    keys?.on("keydown-SPACE", () => (this.spaceDown = true));
    keys?.on("keyup-SPACE", () => (this.spaceDown = false));
    const shiftOf = (p: Phaser.Input.Pointer) => Boolean((p.event as MouseEvent | undefined)?.shiftKey);
    this.input.on("wheel", (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      this.zoomBy(dy > 0 ? 0.9 : 1.1);
    });
    keys?.on("keydown-ESC", () => this.endPick(null));
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.downAt = { x: p.x, y: p.y };
      if (p.rightButtonDown() && this.picking) this.endPick(null);
      if (this.tool && p.leftButtonDown() && !this.spaceDown) {
        this.painting = true;
        this.tool.pointer("down", this.tileAt(p), shiftOf(p));
      } else this.panning = true;
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (this.panning && p.isDown) {
        const cam = this.cameras.main;
        cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
        cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
      } else if (this.tool) {
        this.tool.pointer(this.painting ? "move" : "hover", this.tileAt(p), shiftOf(p));
      }
    });
    const release = (p: Phaser.Input.Pointer) => {
      if (this.painting) this.tool?.pointer("up", this.tileAt(p), shiftOf(p));
      // A press that barely moved is a click, not a pan.
      const click = !this.tool && this.downAt && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) < 6 && p.button === 0;
      this.painting = false;
      this.panning = false;
      this.downAt = null;
      if (click) this.clicked(p);
    };
    this.input.on("pointerup", release);
    this.input.on("pointerupoutside", release);
  }

  private clicked(p: Phaser.Input.Pointer) {
    const tile = this.tileAt(p);
    const ws = workstationAt(this.floor, tile);
    if (this.picking) {
      if (ws) this.endPick(ws.chair);
      return;
    }
    // People first: anyone standing or sitting on that tile (or the one above, where their head is).
    const person = [...this.walkers.values()].find((w) => w.tile.x === tile.x && (w.tile.y === tile.y || w.tile.y === tile.y + 1) && !w.walk?.isPlaying());
    if (person && !(ws && ws.desk && tile.y === ws.desk.y)) return this.onPerson(person.occupant.id);
    if (!ws) return;
    const owner = Object.entries(this.floor.desks ?? {}).find(([, c]) => c.x === ws.chair.x && c.y === ws.chair.y)?.[0] ?? null;
    const rect = this.game.canvas.getBoundingClientRect();
    this.onDesk(ws, owner, tile.x === ws.chair.x && tile.y === ws.chair.y ? "chair" : "computer", { x: rect.left + p.x, y: rect.top + p.y });
  }

  /** Who manages which department (for the name plates). */
  setOrg(roles: { managers: Record<string, string>; ceo?: string | null } | undefined) {
    this.managers = { ...(roles?.managers ?? {}), ...(roles?.ceo ? { "#ceo": roles.ceo } : {}) };
    this.updatePlates();
  }

  /** Lets you click a desk for someone; resolves with the chair, or null if cancelled. */
  pickDesk(id: string): Promise<Tile | null> {
    this.endPick(null);
    const overlay = this.add.graphics().setDepth(950_000);
    const desks = this.floor.desks ?? {};
    for (const f of knownItems(this.floor).filter((i) => i.kind === "officeChair")) {
      const owner = Object.entries(desks).find(([, c]) => c.x === f.x && c.y === f.y)?.[0];
      const color = owner === id ? 0x7cc8ff : owner ? 0xffb547 : 0x4fd18b;
      // The desk is the two tiles above the chair (chair x and x + 1), the chair the row below.
      overlay.fillStyle(color, owner ? 0.22 : 0.32).fillRoundedRect(f.x * T + 2, (f.y - 1) * T + 2, T * 2 - 4, T * 2 - 4, 6);
      overlay.lineStyle(2, color, 0.9).strokeRoundedRect(f.x * T + 2, (f.y - 1) * T + 2, T * 2 - 4, T * 2 - 4, 6);
    }
    return new Promise((resolve) => (this.picking = { id, done: resolve, overlay }));
  }

  private endPick(chair: Tile | null) {
    const pick = this.picking;
    if (!pick) return;
    this.picking = null;
    pick.overlay.destroy();
    pick.done(chair);
  }

  get isPicking() {
    return this.picking !== null;
  }

  /** Name plates on the desks whose owner isn't sitting there (so you see whose desk it is). */
  private updatePlates() {
    const desks = this.floor.desks ?? {};
    for (const [id, plate] of this.plates) {
      if (!desks[id] || !this.walkers.has(id)) {
        plate.destroy();
        this.plates.delete(id);
      }
    }
    for (const [id, chair] of Object.entries(desks)) {
      const w = this.walkers.get(id);
      if (!w) continue;
      let plate = this.plates.get(id);
      if (!plate) {
        plate = this.add
          .text(0, 0, "", { fontFamily: FONT, fontSize: "10px", color: "#e8ecf5", backgroundColor: "rgba(20,24,33,0.78)", padding: { x: 3, y: 1 }, resolution: 2 })
          .setOrigin(0.5, 0)
          .setScale(this.textScale);
        this.plates.set(id, plate);
      }
      const manager = Object.values(this.managers).includes(id);
      plate
        .setText(manager ? `★ ${w.occupant.name}` : w.occupant.name)
        .setPosition(chair.x * T + T, chair.y * T + T - 4)
        // Above the furniture (tall desks in the next row would cover it), like the room names.
        .setDepth(899_000);
      const seated = !w.walk?.isPlaying() && w.tile.x === chair.x && w.tile.y === chair.y;
      plate.setVisible(!seated);
    }
  }

  // ---------------------------------------------------------------- people

  setOccupants(occupants: Occupant[]) {
    const ids = new Set(occupants.map((o) => o.id));
    for (const id of [...this.walkers.keys()]) if (!ids.has(id)) this.remove(id);
    for (const o of occupants) this.upsert(o, false);
    this.placeAll(false);
  }

  upsert(occupant: Occupant, animate = true) {
    let w = this.walkers.get(occupant.id);
    if (!w) {
      w = this.spawn(occupant);
      this.walkers.set(occupant.id, w);
    }
    const prev = w.occupant.state;
    w.occupant = occupant;
    this.life.stateChanged(occupant.id, prev, occupant.state);
    this.updateBubble(w);
    if (animate) this.placeAll(true);
  }

  remove(id: string) {
    const w = this.walkers.get(id);
    if (!w) return;
    this.life.forget(id);
    w.walk?.stop();
    w.container.destroy();
    this.walkers.delete(id);
    this.placeAll(true);
  }

  refreshLanguage() {
    for (const w of this.walkers.values()) this.updateBubble(w);
  }

  private spawn(o: Occupant): Walker {
    const start = this.entrance();
    const view = this.art.character(this, o);
    const sprite = view.sprite;
    sprite.setData("scale", sprite.scaleX);
    const name = this.add
      .text(0, 2, o.name, { fontFamily: FONT, fontSize: "11px", color: "#ffffff", resolution: 2 })
      .setOrigin(0.5, 0)
      .setShadow(1, 1, "#000000", 0, false, true);
    const bubble = this.add
      .text(0, -view.height - 6, "", { fontFamily: FONT, fontSize: "10px", color: "#1d1d27", backgroundColor: "#fdfbf3", padding: { x: 4, y: 2 }, resolution: 2 })
      .setOrigin(0.5, 1);
    const container = this.add.container(0, 0, [sprite, name, bubble]);
    this.lastZoom = 0;
    const w: Walker = { container, sprite, view, bubble, occupant: o, tile: start, goal: null, maxChars: 24, home: null, outing: false, sayUntil: 0 };
    this.setTile(w, start);
    return w;
  }

  /** Where new people appear: in the reception if there is one, else the first room. */
  private entrance(): Tile {
    const r = this.floor.rooms.find((x) => x.id === "reception") ?? this.floor.rooms[0];
    const at = r ? { x: r.x + Math.floor(r.w / 2), y: r.y + r.h - 1 } : { x: 0, y: 0 };
    return nearestWalkable(this.grid, at);
  }

  private setTile(w: Walker, tile: Tile, dx = 0) {
    w.tile = tile;
    w.container.setPosition(tile.x * T + T / 2 + dx, (tile.y + 1) * T - 3);
    w.container.setDepth(w.container.y);
  }

  /** Whether the bubble shows: while saying something, or while working (idle people only talk). */
  private bubbleShown(w: Walker) {
    if (this.cameras.main.zoom < 0.25) return false;
    if (w.sayUntil > Date.now()) return true;
    return w.occupant.state !== "offline" && w.occupant.state !== "idle";
  }

  private updateBubble(w: Walker) {
    if (w.sayUntil > Date.now()) return;
    const { state, detail } = w.occupant;
    const text = detail || t(`state.${state}`);
    w.bubble.setText(text.length > w.maxChars ? `${text.slice(0, w.maxChars - 1)}…` : text);
    w.bubble.setVisible(this.bubbleShown(w));
    w.bubble.setBackgroundColor(state === "error" ? "#ffd6d6" : "#fdfbf3");
    w.container.setAlpha(state === "offline" ? 0.45 : 1);
  }

  /** Assigns every occupant a seat in its target room, then walks them there along a path. */
  private placeAll(animate: boolean) {
    const everyone = [...this.walkers.values()].sort((a, b) => a.occupant.id.localeCompare(b.occupant.id));
    // Everyone keeps their own desk in their home room: the n-th of that room's members gets its n-th
    // desk chair, whatever they are doing right now, so the same person always sits in the same place.
    const deskIndex = new Map<Walker, number>();
    const members = new Map<string, number>();
    for (const w of everyone) {
      const home = homeRoom(this.floor, w.occupant)?.id ?? "";
      deskIndex.set(w, members.get(home) ?? 0);
      members.set(home, (members.get(home) ?? 0) + 1);
    }
    const byRoom = new Map<string, Walker[]>();
    for (const w of everyone) {
      const meeting = w.occupant.state !== "offline" ? this.meetings.get(w.occupant.id) : undefined;
      const room = (meeting && this.floor.rooms.find((r) => r.id === meeting)) || targetRoom(this.floor, w.occupant);
      if (!room) continue;
      byRoom.set(room.id, [...(byRoom.get(room.id) ?? []), w]);
    }
    for (const [roomId, list] of byRoom) {
      const layout = this.layouts.find((l) => l.room.id === roomId);
      if (!layout) continue;
      const crowded = list.length >= 3;
      const centre = { x: layout.room.x + Math.floor(layout.room.w / 2), y: layout.room.y + Math.floor(layout.room.h / 2) };
      const desks = layout.seats.filter((s) => s.desk);
      const bound = this.floor.desks ?? {};
      const owned = new Set(Object.values(bound).map((c) => `${c.x},${c.y}`));
      const used = new Set<Seat>();
      const seatOf = new Map<Walker, Seat>();
      for (const w of list) {
        if (homeRoom(this.floor, w.occupant)?.id !== roomId) continue;
        // Their own desk; without one yet (the server is giving them one), the n-th unowned desk.
        const chair = bound[w.occupant.id];
        const desk = chair ? desks.find((d) => d.x === chair.x && d.y === chair.y) : desks.filter((d) => !owned.has(`${d.x},${d.y}`))[deskIndex.get(w) ?? 0];
        if (desk && !used.has(desk)) {
          seatOf.set(w, desk);
          used.add(desk);
        }
      }
      // Visitors and anyone without a desk take the other seats (never someone's desk), then standing spots.
      const rest = layout.seats.filter((s) => !used.has(s) && !(s.desk && owned.has(`${s.x},${s.y}`)));
      let next = 0;
      list.forEach((w, i) => {
        const seat: Seat = seatOf.get(w) ?? rest[next++ % Math.max(1, rest.length)] ?? nearestWalkable(this.grid, centre);
        w.maxChars = crowded ? 14 : 24;
        w.bubble.setData("lift", 4 + (i % 2) * 16);
        w.home = seat;
        this.lastZoom = 0;
        this.updateBubble(w);
        if (!w.outing) this.walkTo(w, seat, animate);
      });
    }
    this.updatePlates();
  }

  private walkTo(w: Walker, goal: Seat, animate: boolean, onArrive?: () => void) {
    if (!onArrive && w.goal && w.goal.x === goal.x && w.goal.y === goal.y && (w.walk?.isPlaying() || (w.tile.x === goal.x && w.tile.y === goal.y))) {
      this.idleMotion(w);
      return;
    }
    w.goal = goal;
    w.walk?.stop();
    w.bob?.stop();
    // Arts draw at their own scale (the built-in art at 2×); only undo what the idle tweens changed.
    const scale = w.sprite.getData("scale") as number;
    w.sprite.setY(0).setAngle(0).setScale(scale);
    const arrive = () => {
      this.setTile(w, goal, goal.dx ?? 0);
      if (onArrive) onArrive();
      else this.idleMotion(w);
    };
    if (!animate) return arrive();
    const path = findPath(this.grid, nearestWalkable(this.grid, w.tile), goal);
    if (!path || path.length === 0) return arrive();
    const steps = path.map((tile, i) => {
      const prev = i === 0 ? w.tile : path[i - 1];
      const facing: Facing = tile.x > prev.x ? "right" : tile.x < prev.x ? "left" : tile.y < prev.y ? "up" : "down";
      const last = i === path.length - 1;
      return {
        x: tile.x * T + T / 2 + (last ? (goal.dx ?? 0) : 0),
        y: (tile.y + 1) * T - 3,
        duration: STEP_MS,
        onStart: () => w.view.pose(facing, true),
        onUpdate: () => w.container.setDepth(w.container.y),
        onComplete: () => {
          w.tile = tile;
        },
      };
    });
    const hop = w.view.animated ? null : this.tweens.add({ targets: w.sprite, y: -3, duration: STEP_MS / 2, yoyo: true, repeat: -1 });
    w.walk = this.tweens.chain({
      targets: w.container,
      tweens: steps,
      onComplete: () => {
        hop?.stop();
        w.sprite.setY(0);
        if (onArrive) onArrive();
        else this.idleMotion(w);
      },
      onStop: () => hop?.stop(),
    });
  }

  private idleMotion(w: Walker) {
    w.bob?.stop();
    const state = w.occupant.state;
    const seated = Boolean(w.goal?.sit && w.tile.x === w.goal.x && w.tile.y === w.goal.y);
    const face = w.goal?.face ?? "down";
    w.view.pose(face, false, { seated, working: WORKING.has(state) && state !== "error" && state !== "waiting", alert: state === "waiting" });
    w.sprite.setY(seated ? -w.view.sitLift[face] : 0);
    if (w.view.animated) {
      // The art animates idling itself; only errors get an extra wobble.
      if (state === "error") w.bob = this.tweens.add({ targets: w.sprite, angle: { from: -5, to: 5 }, duration: 160, yoyo: true, repeat: -1 });
      return;
    }
    if (state === "error") {
      w.bob = this.tweens.add({ targets: w.sprite, angle: { from: -6, to: 6 }, duration: 160, yoyo: true, repeat: -1 });
    } else if (WORKING.has(state)) {
      w.bob = this.tweens.add({ targets: w.sprite, y: w.sprite.y - 2, duration: state === "researching" ? 600 : 180, yoyo: true, repeat: -1 });
    } else if (state === "idle") {
      w.bob = this.tweens.add({ targets: w.sprite, scaleY: w.sprite.scaleY * 0.96, duration: 1400, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
  }

  /** Keeps names, bubbles and room signs readable at any zoom; hides bubbles when zoomed far out. */
  update(time: number) {
    if (!this.tool) this.life.tick(time);
    if (time - this.platesAt > 500) {
      this.platesAt = time;
      this.updatePlates();
    }
    const zoom = this.cameras.main.zoom;
    if (Math.abs(zoom - this.lastZoom) < 0.001) return;
    this.lastZoom = zoom;
    const s = Phaser.Math.Clamp(1 / zoom, 1, 2);
    this.textScale = s;
    for (const plate of this.plates.values()) plate.setScale(s);
    for (const obj of this.world) {
      if (obj instanceof Phaser.GameObjects.Text && obj.getData("sign")) obj.setScale(s);
    }
    for (const w of this.walkers.values()) {
      (w.container.list[1] as Phaser.GameObjects.Text).setScale(s);
      w.bubble.setScale(s);
      w.bubble.setY(-w.view.height - ((w.bubble.getData("lift") as number | undefined) ?? 4) * s);
      w.bubble.setVisible(this.bubbleShown(w));
    }
  }

  // ---------------------------------------------------------------- idle life (driven by life.ts)

  lifeAgents(): LifeAgent[] {
    return [...this.walkers.values()].map((w) => ({
      id: w.occupant.id,
      name: w.occupant.name,
      state: w.occupant.state,
      tile: w.tile,
      home: w.home,
      outing: w.outing,
      settled: !w.walk?.isPlaying() && !!w.home && w.tile.x === w.home.x && w.tile.y === w.home.y,
      meeting: this.meetings.has(w.occupant.id),
    }));
  }

  lifeFloor() {
    return { floor: this.floor, map: this.grid, layouts: this.layouts };
  }

  /** Walks someone to a spot for an outing; resolves on arrival (rejects if they can't get there). */
  lifeGo(id: string, spot: Seat): Promise<void> {
    const w = this.walkers.get(id);
    if (!w) return Promise.reject(new Error("gone"));
    w.outing = true;
    w.bob?.stop();
    return new Promise((resolve, reject) => {
      if (!findPath(this.grid, nearestWalkable(this.grid, w.tile), spot) && !(w.tile.x === spot.x && w.tile.y === spot.y)) return reject(new Error("no path"));
      this.walkTo(w, spot, true, () => {
        w.goal = spot;
        resolve();
      });
    });
  }

  /** Shows someone in a pose (facing, holding something, seated or not). */
  lifeAct(id: string, act: { pose: string; held?: string; face?: Facing; seated?: boolean }) {
    const w = this.walkers.get(id);
    if (!w) return;
    w.bob?.stop();
    const face = act.face ?? w.goal?.face ?? "down";
    w.view.pose(face, false, { pose: act.pose, held: act.held, seated: act.seated });
    w.sprite.setY(act.seated ? -w.view.sitLift[face] : 0);
  }

  /** A speech bubble for a while. */
  lifeSay(id: string, text: string, ms = 2600) {
    const w = this.walkers.get(id);
    if (!w) return;
    w.sayUntil = Date.now() + ms;
    w.bubble.setText(text).setBackgroundColor("#ffffff").setVisible(this.bubbleShown(w));
    this.time.delayedCall(ms + 20, () => {
      if (w.sayUntil <= Date.now()) {
        w.sayUntil = 0;
        this.updateBubble(w);
      }
    });
  }

  /** A small icon over someone's head (null removes it). */
  lifeIcon(id: string, name: string | null, ms?: number) {
    const w = this.walkers.get(id);
    if (!w) return;
    w.icon?.destroy();
    w.icon = undefined;
    if (!name) return;
    const icon = this.art.icon?.(this, name);
    if (!icon) return;
    icon.setPosition(14, -w.view.height + 2);
    w.container.add(icon);
    w.icon = icon;
    if (ms) this.time.delayedCall(ms, () => w.icon === icon && this.lifeIcon(id, null));
  }

  /** A short floating text (coins won or lost). */
  lifeFloat(id: string, text: string, color: string) {
    const w = this.walkers.get(id);
    if (!w) return;
    const label = this.add
      .text(w.container.x, w.container.y - w.view.height - 4, text, { fontFamily: FONT, fontSize: "12px", fontStyle: "bold", color, resolution: 2 })
      .setOrigin(0.5, 1)
      .setDepth(960_000)
      .setShadow(1, 1, "#000000", 0, false, true);
    this.tweens.add({ targets: label, y: label.y - 26, alpha: 0, duration: 1900, onComplete: () => label.destroy() });
  }

  /** Running projects changed: their members go to (or leave) the meeting room. */
  setProjects(projects: { status: string; members: string[] }[]) {
    const table = knownItems(this.floor).find((f) => f.kind === "meetingTable");
    const room =
      (table && this.floor.rooms.find((r) => table.x >= r.x && table.y >= r.y && table.x < r.x + r.w && table.y < r.y + r.h)) ??
      this.floor.rooms.find((r) => r.id === "meeting");
    const next = new Map<string, string>();
    if (room) for (const p of projects) if (p.status === "active" || p.status === "planning") for (const id of p.members) next.set(id, room.id);
    const same = next.size === this.meetings.size && [...next].every(([k, v]) => this.meetings.get(k) === v);
    this.meetings = next;
    if (!same && this.layouts.length) this.placeAll(true);
  }

  /** A colleague request, acted out (see Life.handoff). */
  handoff(h: { from: string; to: string; kind: "ask" | "delegate" | "return" | "pass" }) {
    if (this.walkers.has(h.from) && this.walkers.has(h.to)) this.life.handoff(h);
  }

  /** Back to their seat; the outing is over. */
  lifeHome(id: string) {
    const w = this.walkers.get(id);
    if (!w) return;
    w.outing = false;
    this.lifeIcon(id, null);
    if (w.home) this.walkTo(w, w.home, true);
  }

  get isFitted() {
    return this.fitted;
  }
}
