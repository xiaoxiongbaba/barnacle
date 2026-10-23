import type { Occupant, State } from "../types";

export const TILE = 32;
/** Characters that encode a style index in a tile row (same as the server). */
export const TILE_CODES = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export type RouteTarget = "home" | "inherit" | `room:${string}`;

/** A named zone (department). It draws nothing; it decides who sits where and where people go. */
export interface Room {
  id: string;
  name: string;
  purpose: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hue: number;
  routing: Partial<Record<State, RouteTarget>>;
}

/** One tile layer: a style list and one character per tile ("." = nothing). */
export interface Layer {
  styles: string[];
  rows: string[];
}

export interface Floor {
  version: 2;
  width: number;
  height: number;
  floor: Layer;
  walls: Layer;
  items: Furniture[];
  rooms: Room[];
  routing: Record<State, "home" | `room:${string}`>;
  assignments: Record<string, string>;
  /** occupant id → their desk (the office chair they sit on). */
  desks?: Record<string, Tile>;
}

export type Facing4 = "up" | "down" | "left" | "right";

export interface ItemDef {
  w: number;
  h: number;
  /** Where a person sitting here looks; "variant" when the variant name says it (up/down/left/right). */
  seat?: Facing4 | "variant";
  layer?: "rug" | "wall" | "top";
  group: "work" | "rest" | "decor" | "misc";
  /** Named looks; a placed item's `variant` indexes this list. */
  variants?: readonly string[];
}

const DIRS = ["up", "down", "left", "right"] as const;

/**
 * What can be placed (the catalogue follows Habblaud's furniture, plus a few pieces only some art packs
 * draw). `w × h` is the footprint in tiles; it blocks walking unless the item is a seat or isn't on the
 * floor. Layers: `rug` lies under everything, `wall` hangs on a wall's face (its footprint is the face's
 * two rows), `top` stands on a desk or counter.
 */
export const ITEMS = {
  desk: { w: 2, h: 1, group: "work", variants: ["wood", "white", "dark"] },
  deskBack: { w: 2, h: 1, group: "work", variants: ["wood", "white", "dark"] },
  officeChair: { w: 1, h: 1, seat: "up", group: "work", variants: ["black", "blue", "red", "green", "gray"] },
  officeChairFront: { w: 1, h: 1, seat: "down", group: "work", variants: ["black", "blue", "red", "green", "gray"] },
  meetingTable: { w: 3, h: 2, group: "work" },
  receptionDesk: { w: 3, h: 1, group: "work" },
  bookshelf: { w: 2, h: 1, group: "work" },
  binderShelf: { w: 1, h: 1, group: "work" },
  filingCabinet: { w: 1, h: 1, group: "work" },
  printer: { w: 1, h: 1, group: "work" },
  copier: { w: 1, h: 1, group: "work" },
  rack: { w: 2, h: 1, group: "work" },
  trashBin: { w: 1, h: 1, group: "work" },
  glassPartition: { w: 1, h: 1, group: "work", variants: ["h", "v", "end"] },
  whiteboard: { w: 3, h: 2, layer: "wall", group: "work" },
  pc: { w: 2, h: 1, layer: "top", group: "work" },
  laptop: { w: 2, h: 1, layer: "top", group: "work" },
  lamp: { w: 1, h: 1, layer: "top", group: "work" },
  phone: { w: 1, h: 1, layer: "top", group: "work" },
  papers: { w: 1, h: 1, layer: "top", group: "work" },
  counter: { w: 1, h: 1, group: "rest", variants: ["plain", "drawers"] },
  counterSink: { w: 1, h: 1, group: "rest" },
  coffeeMachine: { w: 1, h: 1, group: "rest" },
  microwave: { w: 1, h: 1, group: "rest" },
  stove: { w: 1, h: 1, group: "rest" },
  fridge: { w: 1, h: 1, group: "rest" },
  vendingMachine: { w: 1, h: 1, group: "rest" },
  waterCooler: { w: 1, h: 1, group: "rest" },
  cafeTable: { w: 1, h: 1, group: "rest" },
  cafeChair: { w: 1, h: 1, seat: "variant", group: "rest", variants: DIRS },
  sofa: { w: 3, h: 1, seat: "variant", group: "rest", variants: ["down", "up"] },
  armchair: { w: 1, h: 1, seat: "variant", group: "rest", variants: DIRS },
  coffeeTable: { w: 2, h: 1, group: "rest" },
  beanbag: { w: 1, h: 1, seat: "down", group: "rest", variants: ["red", "blue", "yellow", "green"] },
  stool: { w: 1, h: 1, seat: "down", group: "rest" },
  bench: { w: 2, h: 1, seat: "down", group: "rest" },
  pingpongTable: { w: 3, h: 2, group: "rest" },
  arcade: { w: 1, h: 1, group: "rest" },
  tv: { w: 2, h: 2, layer: "wall", group: "rest" },
  rug: { w: 3, h: 2, layer: "rug", group: "decor", variants: ["blue", "green", "red", "sand"] },
  plantSmall: { w: 1, h: 1, group: "decor", variants: ["fern", "succulent", "flower"] },
  plantTall: { w: 1, h: 1, group: "decor", variants: ["palm", "ficus", "monstera", "bonsai"] },
  floorLamp: { w: 1, h: 1, group: "decor" },
  window: { w: 2, h: 2, layer: "wall", group: "decor" },
  clock: { w: 1, h: 2, layer: "wall", group: "decor" },
  poster: { w: 1, h: 2, layer: "wall", group: "decor", variants: ["code", "coffee", "rocket", "cat", "bug", "ship_it"] },
  painting: { w: 2, h: 2, layer: "wall", group: "decor" },
  sign: { w: 3, h: 2, layer: "wall", group: "decor" },
  shelfWall: { w: 2, h: 2, layer: "wall", group: "decor" },
  ac: { w: 2, h: 2, layer: "wall", group: "decor" },
  mirror: { w: 1, h: 2, layer: "wall", group: "misc" },
  sink: { w: 1, h: 1, group: "misc" },
  toiletStall: { w: 2, h: 2, group: "misc" },
} satisfies Record<string, ItemDef>;

export type ItemKind = keyof typeof ITEMS;
export const ITEM_KINDS = Object.keys(ITEMS) as ItemKind[];
export const isItemKind = (k: string): k is ItemKind => k in ITEMS;
export const itemDef = (kind: ItemKind): ItemDef => ITEMS[kind];

/** One placed item: its footprint's top-left tile. `dx`/`dy` nudge the drawing in pixels; `variant` picks the look. */
export interface Furniture {
  kind: ItemKind;
  x: number;
  y: number;
  dx?: number;
  dy?: number;
  variant?: number;
}

export interface Tile {
  x: number;
  y: number;
}

/** A place to stand or sit; `face` is where the person looks, `sit` when it is a chair or sofa. */
export interface Seat extends Tile {
  face?: Facing4;
  sit?: boolean;
  /** Sideways nudge in pixels (a chair centred under a two-tile desk). */
  dx?: number;
  /** An office chair: someone's own desk. */
  desk?: boolean;
}

/** Where someone sitting on this item looks. */
export function seatFacing(f: Furniture): Facing4 | null {
  const d = itemDef(f.kind);
  if (!d.seat) return null;
  if (d.seat !== "variant") return d.seat;
  const name = d.variants?.[f.variant ?? 0];
  return name === "up" || name === "down" || name === "left" || name === "right" ? name : "down";
}

export interface RoomLayout {
  room: Room;
  /** Where people stand or sit, in the order they are filled. */
  seats: Seat[];
}

// ------------------------------------------------------------------ tiles

/** The style key at a tile, or null. */
export function styleAt(layer: Layer, x: number, y: number): string | null {
  const c = layer.rows[y]?.[x];
  if (!c || c === ".") return null;
  return layer.styles[TILE_CODES.indexOf(c)] ?? null;
}

/** Sets (or clears, with null) a tile's style, adding the style to the layer's list when needed. */
export function setStyle(layer: Layer, x: number, y: number, style: string | null) {
  const row = layer.rows[y];
  if (row === undefined || x < 0 || x >= row.length) return;
  let code = ".";
  if (style) {
    let i = layer.styles.indexOf(style);
    if (i < 0) {
      if (layer.styles.length >= TILE_CODES.length) return;
      i = layer.styles.push(style) - 1;
    }
    code = TILE_CODES[i];
  }
  layer.rows[y] = row.slice(0, x) + code + row.slice(x + 1);
}

/** Grows or shrinks a layer to a new size, keeping what fits. */
export function resizeLayer(layer: Layer, width: number, height: number): Layer {
  const rows = Array.from({ length: height }, (_, y) => (layer.rows[y] ?? "").slice(0, width).padEnd(width, "."));
  return { styles: [...layer.styles], rows };
}

export const isWall = (f: Floor, x: number, y: number) => styleAt(f.walls, x, y) !== null;

// ------------------------------------------------------------------ furniture

export const blocks = (f: Furniture) => {
  const d = itemDef(f.kind);
  return !d.seat && !d.layer;
};

export function cells(f: Furniture): Tile[] {
  const d = itemDef(f.kind);
  const out: Tile[] = [];
  for (let y = f.y; y < f.y + d.h; y++) for (let x = f.x; x < f.x + d.w; x++) out.push({ x, y });
  return out;
}

/** Items the floor holds that this version of the page knows how to draw. */
export const knownItems = (floor: Floor) => floor.items.filter((f) => isItemKind(f.kind));

/**
 * Drawing depth (pixels) of an item among people, walls and other furniture, which sort by their bottom
 * edge. Seats facing down sit just behind the person on them; a chair seen from the back sits just in front.
 * Things on a desk sit just above the desk under them; wall decorations just above the wall's face.
 */
export function depthOf(f: Furniture, all: Furniture[]): number {
  const d = itemDef(f.kind);
  const bottom = (f.y + d.h) * TILE;
  if (d.layer === "wall") return bottom + 1;
  const face = seatFacing(f);
  if (face === "up") return bottom + 2;
  if (face) return bottom - 8;
  if (d.layer === "top") {
    const under = all.find((o) => o !== f && blocks(o) && cells(o).some((c) => c.x === f.x + Math.floor(d.w / 2) && c.y === f.y));
    return (under ? (under.y + itemDef(under.kind).h) * TILE : bottom) + 1;
  }
  return bottom;
}

// ------------------------------------------------------------------ walking

/** Where people can stand: floor painted, no wall, no solid furniture. */
export interface WalkMap {
  width: number;
  height: number;
  open: boolean[][];
}

export function walkGrid(floor: Floor): WalkMap {
  const open = Array.from({ length: floor.height }, (_, y) =>
    Array.from({ length: floor.width }, (_, x) => styleAt(floor.floor, x, y) !== null && !isWall(floor, x, y)),
  );
  for (const f of knownItems(floor)) if (blocks(f)) for (const c of cells(f)) if (open[c.y]?.[c.x]) open[c.y][c.x] = false;
  return { width: floor.width, height: floor.height, open };
}

/** Seats in each room: chairs and sofas inside its zone first, then free tiles to stand on. */
export function layoutRooms(floor: Floor, map: WalkMap): RoomLayout[] {
  const items = knownItems(floor);
  return floor.rooms.map((room) => {
    const inside = (t: Tile) => t.x >= room.x && t.y >= room.y && t.x < room.x + room.w && t.y < room.y + room.h;
    const seats: Seat[] = [];
    for (const f of items) {
      const face = seatFacing(f);
      if (!face || !inside(f)) continue;
      const w = itemDef(f.kind).w;
      for (let i = 0; i < w; i++) seats.push({ x: f.x + i, y: f.y, face, sit: true, ...(w === 1 && f.dx ? { dx: f.dx } : {}), ...(f.kind === "officeChair" || f.kind === "officeChairFront" ? { desk: true } : {}) });
    }
    seats.sort((a, b) => a.y - b.y || a.x - b.x);
    for (let y = room.y + 1; y < room.y + room.h; y += 2) {
      for (let x = room.x + 1; x < room.x + room.w; x += 2) if (map.open[y]?.[x]) seats.push({ x, y, face: "down" });
    }
    const unique = new Map<string, Seat>();
    for (const s of seats) if (!unique.has(`${s.x},${s.y}`)) unique.set(`${s.x},${s.y}`, s);
    return { room, seats: [...unique.values()] };
  });
}

/** Words in a job title that point to a kind of work room (matched against the room's id, name and purpose too). */
const ROOM_HINTS: Record<string, string[]> = {
  research: ["research", "analy", "investig", "研究", "調研", "调研", "調查", "调查", "分析", "リサーチ", "調査"],
  writing: ["writ", "edit", "copy", "content", "author", "寫", "写", "文案", "編輯", "编辑", "記者", "记者", "ライター", "編集", "作家"],
  design: ["design", "art", "illustr", "設計", "设计", "美術", "美术", "繪", "绘", "デザイン"],
  operations: ["market", "growth", "operat", "assist", "manag", "project", "sales", "行銷", "营销", "營運", "运营", "助理", "專案", "项目", "經理", "经理", "企劃", "企划", "マーケ", "アシスタント", "企画"],
};

const hashId = (id: string) => [...id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7) >>> 0;

/** A workstation: an office chair and the desk in front of it. */
export interface Workstation {
  chair: Tile;
  desk: Furniture | undefined;
}

/** The workstation a tile belongs to (its chair, desk or the computer on it), if any. */
export function workstationAt(floor: Floor, t: Tile): Workstation | null {
  const items = knownItems(floor);
  const chairs = items.filter((f) => f.kind === "officeChair");
  const deskFor = (c: Tile) => items.find((f) => (f.kind === "desk" || f.kind === "deskBack") && f.y === c.y - 1 && (f.x === c.x || f.x + 1 === c.x));
  const chair = chairs.find((c) => c.x === t.x && c.y === t.y);
  if (chair) return { chair: { x: chair.x, y: chair.y }, desk: deskFor(chair) };
  // The desk's tile, or the monitor drawn just above it.
  for (const c of chairs) {
    const desk = deskFor(c);
    if (desk && (t.y === desk.y || t.y === desk.y - 1) && (t.x === desk.x || t.x === desk.x + 1)) return { chair: { x: c.x, y: c.y }, desk };
  }
  return null;
}

/** "Research · 3": the room and the desk's number in it. */
export function deskLabel(floor: Floor, chair: Tile): { room: Room | undefined; number: number } {
  const room = floor.rooms.find((r) => chair.x >= r.x && chair.y >= r.y && chair.x < r.x + r.w && chair.y < r.y + r.h);
  const inRoom = knownItems(floor)
    .filter((f) => f.kind === "officeChair" && (!room || (f.x >= room.x && f.y >= room.y && f.x < room.x + room.w && f.y < room.y + room.h)))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return { room, number: inRoom.findIndex((f) => f.x === chair.x && f.y === chair.y) + 1 };
}

/** Rooms with desks (office chairs): where people work. */
export function workRooms(floor: Floor): Room[] {
  const chairs = knownItems(floor).filter((f) => f.kind === "officeChair");
  return floor.rooms.filter((r) => chairs.some((c) => c.x >= r.x && c.y >= r.y && c.x < r.x + r.w && c.y < r.y + r.h));
}

/**
 * An occupant's own room: the one you assigned, else the work room that fits their job title (by room id,
 * name or purpose), else a work room picked from their id so they always land in the same one.
 */
export function homeRoom(floor: Floor, o: Occupant): Room | undefined {
  const desk = floor.desks?.[o.id];
  const deskRoom = desk && floor.rooms.find((r) => desk.x >= r.x && desk.y >= r.y && desk.x < r.x + r.w && desk.y < r.y + r.h);
  if (deskRoom) return deskRoom;
  const assigned = floor.rooms.find((r) => r.id === floor.assignments[o.id]);
  if (assigned) return assigned;
  const rooms = workRooms(floor);
  const role = (o.role ?? "").toLowerCase();
  if (role) {
    for (const r of rooms) {
      const words = [...(ROOM_HINTS[r.id] ?? []), r.name.toLowerCase()];
      if (words.some((w) => w.length > 1 && role.includes(w))) return r;
    }
    for (const r of rooms) {
      const about = `${r.id} ${r.name} ${r.purpose}`.toLowerCase();
      if (Object.values(ROOM_HINTS).some((hints) => hints.some((w) => role.includes(w) && about.includes(w)))) return r;
    }
  }
  return rooms.length ? rooms[hashId(o.id) % rooms.length] : floor.rooms[0];
}

/** Which room an occupant goes to for its current state: room override → floor default → home. */
export function targetRoom(floor: Floor, o: Occupant): Room | undefined {
  const home = homeRoom(floor, o);
  const override = home?.routing[o.state];
  const rule = override && override !== "inherit" ? override : floor.routing[o.state];
  if (!rule || rule === "home") return home;
  return floor.rooms.find((r) => r.id === rule.slice(5)) ?? home;
}

/** A* on a 4-connected grid. Returns tiles from start (exclusive) to goal (inclusive), or null. */
export function findPath(m: WalkMap, start: Tile, goal: Tile): Tile[] | null {
  const { width: w, height: h } = m;
  const id = (x: number, y: number) => y * w + x;
  const open: { f: number; i: number }[] = [];
  const push = (f: number, i: number) => {
    open.push({ f, i });
    let n = open.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (open[p].f <= open[n].f) break;
      [open[p], open[n]] = [open[n], open[p]];
      n = p;
    }
  };
  const pop = () => {
    const top = open[0];
    const last = open.pop()!;
    if (open.length) {
      open[0] = last;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1;
        const r = l + 1;
        let k = n;
        if (l < open.length && open[l].f < open[k].f) k = l;
        if (r < open.length && open[r].f < open[k].f) k = r;
        if (k === n) break;
        [open[k], open[n]] = [open[n], open[k]];
        n = k;
      }
    }
    return top;
  };
  const g = new Map<number, number>();
  const from = new Map<number, number>();
  const s = id(start.x, start.y);
  const goalId = id(goal.x, goal.y);
  g.set(s, 0);
  push(Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y), s);
  while (open.length) {
    const { i } = pop();
    if (i === goalId) {
      const path: Tile[] = [];
      for (let c = i; c !== s; c = from.get(c)!) path.push({ x: c % w, y: Math.floor(c / w) });
      return path.reverse();
    }
    const x = i % w;
    const y = Math.floor(i / w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = id(nx, ny);
      if (!m.open[ny][nx] && ni !== goalId) continue;
      const cost = (g.get(i) ?? 0) + 1;
      if (cost < (g.get(ni) ?? Infinity)) {
        g.set(ni, cost);
        from.set(ni, i);
        push(cost + Math.abs(goal.x - nx) + Math.abs(goal.y - ny), ni);
      }
    }
  }
  return null;
}

/** The nearest walkable tile to `t`, for occupants who start somewhere unreachable. */
export function nearestWalkable(m: WalkMap, t: Tile): Tile {
  for (let r = 0; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = t.x + dx;
        const y = t.y + dy;
        if (m.open[y]?.[x]) return { x, y };
      }
    }
  }
  return t;
}
