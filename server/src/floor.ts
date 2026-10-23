import { z } from "zod";
import { STATES } from "./states.js";

/**
 * The office floor, built like a map in a tile editor:
 * - `floor` and `walls`: one character per tile ("." = nothing, otherwise an index into that layer's style
 *   list). Styles are art keys such as "officeTile" or "brick"; the page draws them.
 * - `items`: furniture and decorations placed on tiles.
 * - `rooms`: named zones (departments). They draw nothing; they decide who sits where and where people walk
 *   for each state (routing).
 */

const MAX_FLOOR = 80;
const MAX_ROOMS = 30;
const MAX_ITEMS = 4000;
/** Characters that encode a style index in a tile row, in order. */
export const TILE_CODES = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Where an occupant goes for a state: its own room, a specific room, or the global rule. */
const routeTarget = z.union([z.literal("home"), z.literal("inherit"), z.string().regex(/^room:[a-z0-9-]{1,40}$/)]);
export type RouteTarget = z.infer<typeof routeTarget>;

const routing = z.partialRecord(z.enum(STATES), routeTarget);

const room = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(40),
  purpose: z.string().trim().max(200).default(""),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(MAX_FLOOR),
  h: z.number().int().min(1).max(MAX_FLOOR),
  /** 0..359; the zone's colour in the editor and lists. */
  hue: z.number().int().min(0).max(359),
  /** Overrides the floor's default routing for occupants who belong to this room. */
  routing: routing.default({}),
});

export type Room = z.infer<typeof room>;

const styleKey = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const layer = z.object({
  styles: z.array(styleKey).max(TILE_CODES.length),
  rows: z.array(z.string()),
});

const item = z.object({
  kind: z.string().regex(/^[A-Za-z0-9]{1,24}$/),
  x: z.number().int(),
  y: z.number().int(),
  variant: z.number().int().min(0).max(99).optional(),
  dx: z.number().int().min(-64).max(64).optional(),
  dy: z.number().int().min(-64).max(64).optional(),
});

export const floorSchema = z
  .object({
    version: z.literal(2),
    width: z.number().int().min(10).max(MAX_FLOOR),
    height: z.number().int().min(10).max(MAX_FLOOR),
    floor: layer,
    walls: layer,
    items: z.array(item).max(MAX_ITEMS),
    rooms: z.array(room).max(MAX_ROOMS),
    /** Default routing for everyone; "home" means the occupant's own room. */
    routing: z.record(z.enum(STATES), z.union([z.literal("home"), z.string().regex(/^room:[a-z0-9-]{1,40}$/)])),
    /** occupant id → room id */
    assignments: z.record(z.string(), z.string()).default({}),
    /** occupant id → their desk: the office chair they sit on (see desks.ts). */
    desks: z.record(z.string(), z.object({ x: z.number().int().min(0), y: z.number().int().min(0) })).default({}),
  })
  .superRefine((floor, ctx) => {
    for (const name of ["floor", "walls"] as const) {
      const l = floor[name];
      const allowed = new Set(`.${TILE_CODES.slice(0, l.styles.length)}`);
      if (l.rows.length !== floor.height) ctx.addIssue({ code: "custom", path: [name, "rows"], message: `needs ${floor.height} rows` });
      l.rows.forEach((row, y) => {
        if (row.length !== floor.width || [...row].some((c) => !allowed.has(c))) {
          ctx.addIssue({ code: "custom", path: [name, "rows", y], message: `row must be ${floor.width} tile codes` });
        }
      });
    }
    floor.items.forEach((it, i) => {
      if (it.x < 0 || it.y < 0 || it.x >= floor.width || it.y >= floor.height) ctx.addIssue({ code: "custom", path: ["items", i], message: "item is outside the floor" });
    });
    const ids = new Set<string>();
    floor.rooms.forEach((r, i) => {
      if (ids.has(r.id)) ctx.addIssue({ code: "custom", path: ["rooms", i, "id"], message: "duplicate room id" });
      ids.add(r.id);
      if (r.x + r.w > floor.width || r.y + r.h > floor.height) {
        ctx.addIssue({ code: "custom", path: ["rooms", i], message: `room "${r.name}" is outside the floor` });
      }
      floor.rooms.slice(0, i).forEach((o) => {
        const overlap = r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
        if (overlap) ctx.addIssue({ code: "custom", path: ["rooms", i], message: `room "${r.name}" overlaps "${o.name}"` });
      });
    });
    const checkTarget = (t: string, path: (string | number)[]) => {
      if (t.startsWith("room:") && !ids.has(t.slice(5))) ctx.addIssue({ code: "custom", path, message: `unknown room ${t.slice(5)}` });
    };
    for (const [state, t] of Object.entries(floor.routing)) checkTarget(t, ["routing", state]);
    floor.rooms.forEach((r, i) => {
      for (const [state, t] of Object.entries(r.routing)) if (t) checkTarget(t, ["rooms", i, "routing", state]);
    });
    for (const [occupant, roomId] of Object.entries(floor.assignments)) {
      if (!ids.has(roomId)) ctx.addIssue({ code: "custom", path: ["assignments", occupant], message: `unknown room ${roomId}` });
    }
  });

export type Floor = z.infer<typeof floorSchema>;

type Door = "top" | "bottom" | "left" | "right";
interface Shell {
  room: Room;
  floorStyle: string;
  wallStyle: string;
  door: Door;
}

/**
 * Empty rooms with walls: each room's floor painted, a two-tile back wall along its top, a wall on its left
 * and bottom (the next room's wall closes the right), the building's outer walls, and a two-tile door gap.
 */
function shell(width: number, height: number, rooms: Shell[], hallStyle: string): Pick<Floor, "floor" | "walls"> {
  const floorStyles = [...new Set([hallStyle, ...rooms.map((r) => r.floorStyle)])];
  const wallStyles = [...new Set(["plain", ...rooms.map((r) => r.wallStyle)])];
  const ground = Array.from({ length: height }, () => Array<string>(width).fill(TILE_CODES[0]));
  const wall = Array.from({ length: height }, () => Array<string>(width).fill("."));
  const put = (x: number, y: number, style: string) => {
    if (x >= 0 && y >= 0 && x < width && y < height) wall[y][x] = TILE_CODES[wallStyles.indexOf(style)];
  };
  for (const { room: r, floorStyle } of rooms) {
    const code = TILE_CODES[floorStyles.indexOf(floorStyle)];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) ground[y][x] = code;
  }
  for (let x = 0; x < width; x++) {
    put(x, 0, "plain");
    put(x, 1, "plain");
    put(x, height - 1, "plain");
  }
  for (let y = 0; y < height; y++) {
    put(0, y, "plain");
    put(width - 1, y, "plain");
  }
  const gaps: [number, number][] = [];
  for (const { room: r, wallStyle, door } of rooms) {
    for (let x = r.x; x < r.x + r.w; x++) {
      put(x, r.y, wallStyle);
      put(x, r.y + 1, wallStyle);
      if (r.y + r.h < height) put(x, r.y + r.h - 1, "plain");
    }
    if (r.x > 0) for (let y = r.y; y < r.y + r.h; y++) put(r.x, y, "plain");
    const cx = r.x + Math.floor(r.w / 2) - 1;
    const cy = r.y + 2 + Math.floor((r.h - 2) / 2) - 1;
    if (door === "top") gaps.push([cx, r.y], [cx + 1, r.y], [cx, r.y + 1], [cx + 1, r.y + 1]);
    if (door === "bottom") gaps.push([cx, r.y + r.h - 1], [cx + 1, r.y + r.h - 1]);
    if (door === "left") gaps.push([r.x, cy], [r.x, cy + 1]);
    if (door === "right") gaps.push([r.x + r.w, cy], [r.x + r.w, cy + 1]);
  }
  for (const [x, y] of gaps) if (x >= 0 && y >= 0 && x < width && y < height) wall[y][x] = ".";
  return {
    floor: { styles: floorStyles, rows: ground.map((r) => r.join("")) },
    walls: { styles: wallStyles, rows: wall.map((r) => r.join("")) },
  };
}

/** Floor and wall styles the old room presets used. */
const PRESET_STYLES: Record<string, [string, string]> = {
  workspace: ["officeTile", "lavender"],
  office: ["carpetDark", "brick"],
  meeting: ["woodPlank", "plain"],
  lounge: ["woodGold", "brick"],
  reception: ["creamTile", "plain"],
  servers: ["serverTile", "stone"],
  empty: ["woodDiagonal", "plain"],
};

const DEFAULT_ROUTING: Floor["routing"] = {
  idle: "room:lounge",
  writing: "home",
  researching: "home",
  executing: "room:servers",
  syncing: "room:servers",
  waiting: "home",
  error: "home",
  offline: "room:reception",
};

/** Turns a version 1 floor (rooms with furniture presets) into empty walled rooms with the same layout. */
export function migrateFloor(saved: unknown): unknown {
  const upgraded = fromVersion1(saved) as { routing?: Record<string, string> } | undefined;
  // "waiting" (needs you) came later: people stay where they work.
  if (upgraded?.routing && !upgraded.routing.waiting) upgraded.routing.waiting = "home";
  return upgraded;
}

function fromVersion1(saved: unknown): unknown {
  type OldRoom = Room & { preset?: string; door?: Door };
  const v1 = saved as { version?: number; width: number; height: number; rooms: OldRoom[]; routing: Floor["routing"]; assignments?: Record<string, string> } | undefined;
  if (!v1 || v1.version !== 1 || !Array.isArray(v1.rooms)) return saved;
  const shells: Shell[] = v1.rooms.map(({ preset, door, ...room }) => {
    const [floorStyle, wallStyle] = PRESET_STYLES[preset ?? "empty"] ?? PRESET_STYLES.empty;
    return { room, floorStyle, wallStyle, door: door ?? "bottom" };
  });
  return {
    version: 2,
    width: v1.width,
    height: v1.height,
    ...shell(v1.width, v1.height, shells, "hall"),
    items: [],
    rooms: shells.map((s) => s.room),
    routing: v1.routing,
    assignments: v1.assignments ?? {},
  };
}

type Item = Floor["items"][number];

/**
 * Six desks in two rows, each with a computer and a chair, in a 10-wide room (top or bottom row of the
 * building). Leaves walkways under the door and between the rows.
 */
function deskBlock(items: Item[], ox: number, firstRow: number, look: { desk: number; chair: number; top: "pc" | "laptop" }) {
  for (const row of [firstRow, firstRow + 3]) {
    for (const col of [1, 4, 7]) {
      items.push({ kind: "desk", x: ox + col, y: row, variant: look.desk });
      items.push({ kind: look.top, x: ox + col, y: row });
      items.push({ kind: "officeChair", x: ox + col, y: row + 1, dx: 16, variant: look.chair });
    }
  }
}

/**
 * The starter office: four work rooms (research, writing, design, operations), a meeting room for
 * projects, a lounge for breaks, reception and a server room, furnished and ready to use. Agents go to
 * the work room that matches their job title and keep their own desk there.
 */
export function defaultFloor(): Floor {
  const s = (room: Omit<Room, "routing" | "purpose"> & { purpose?: string }, floorStyle: string, wallStyle: string, door: Door): Shell => ({
    room: { purpose: "", routing: {}, ...room },
    floorStyle,
    wallStyle,
    door,
  });
  const shells = [
    s({ id: "research", name: "Research", purpose: "Research, analysis and fact-finding", x: 0, y: 0, w: 10, h: 10, hue: 210 }, "carpetBlue", "woodPanel", "bottom"),
    s({ id: "writing", name: "Writing", purpose: "Writing, editing and reports", x: 10, y: 0, w: 10, h: 10, hue: 40 }, "carpetSand", "stripes", "bottom"),
    s({ id: "meeting", name: "Meeting room", purpose: "Projects: where the team works together", x: 20, y: 0, w: 10, h: 10, hue: 30 }, "wood", "glass", "bottom"),
    s({ id: "design", name: "Design", purpose: "Design, images and layout", x: 30, y: 0, w: 10, h: 10, hue: 300 }, "carpetLilac", "marble", "bottom"),
    s({ id: "reception", name: "Reception", purpose: "Where people wait when they are away", x: 0, y: 12, w: 10, h: 10, hue: 50 }, "marble", "plain", "top"),
    s({ id: "operations", name: "Operations", purpose: "Marketing, planning and project assistance", x: 10, y: 12, w: 10, h: 10, hue: 150 }, "carpetGreen", "brick", "top"),
    s({ id: "lounge", name: "Lounge", purpose: "Coffee, games and a break", x: 20, y: 12, w: 12, h: 10, hue: 20 }, "wood", "brick", "top"),
    s({ id: "servers", name: "Server room", purpose: "Running jobs and syncing", x: 32, y: 12, w: 8, h: 10, hue: 190 }, "tileCheck", "tiles", "top"),
  ];
  const items: Item[] = [];
  const add = (kind: string, x: number, y: number, extra: Partial<Item> = {}) => items.push({ kind, x, y, ...extra });

  // Research: desks, books, a whiteboard and a window.
  deskBlock(items, 0, 3, { desk: 0, chair: 1, top: "pc" });
  add("window", 1, 0);
  add("whiteboard", 4, 0);
  add("clock", 8, 0);
  add("binderShelf", 3, 2);
  add("bookshelf", 8, 8);
  add("plantTall", 6, 2, { variant: 1 });
  add("filingCabinet", 9, 2);
  add("plantSmall", 1, 8, { variant: 0 });

  // Writing: desks with laptops, posters, a reading corner.
  deskBlock(items, 10, 3, { desk: 1, chair: 0, top: "laptop" });
  add("window", 11, 0);
  add("poster", 14, 0, { variant: 1 });
  add("shelfWall", 16, 0);
  add("bookshelf", 11, 8);
  add("plantTall", 13, 2, { variant: 2 });
  add("floorLamp", 16, 2);
  add("printer", 19, 2);
  add("plantSmall", 19, 8, { variant: 2 });

  // Meeting room: two tables with chairs round them, a whiteboard and a screen.
  add("rug", 22, 4, { variant: 0 });
  add("rug", 25, 4, { variant: 0 });
  add("meetingTable", 22, 4);
  add("meetingTable", 25, 4);
  for (let x = 22; x <= 27; x++) {
    add("cafeChair", x, 3, { variant: 1 });
    add("cafeChair", x, 6, { variant: 0 });
  }
  add("whiteboard", 21, 0);
  add("tv", 25, 0);
  add("plantTall", 21, 2, { variant: 0 });
  add("plantTall", 29, 2, { variant: 3 });
  add("clock", 28, 0);

  // Design: white desks, art on the walls, plants.
  deskBlock(items, 30, 3, { desk: 1, chair: 3, top: "pc" });
  add("painting", 31, 0);
  add("window", 34, 0);
  add("poster", 37, 0, { variant: 2 });
  add("plantTall", 33, 2, { variant: 2 });
  add("plantSmall", 36, 2, { variant: 2 });
  add("printer", 39, 2);
  add("plantTall", 39, 8, { variant: 3 });

  // Reception: a desk facing the door, benches and plants.
  add("sign", 1, 12);
  add("receptionDesk", 5, 17);
  add("officeChairFront", 6, 16, { variant: 2 });
  add("bench", 1, 19);
  add("bench", 7, 20);
  add("plantTall", 1, 14, { variant: 0 });
  add("plantTall", 9, 14, { variant: 2 });
  add("waterCooler", 9, 17);
  add("rug", 1, 17, { variant: 3 });

  // Operations: desks lower down, the walkway under the door kept free.
  deskBlock(items, 10, 16, { desk: 2, chair: 2, top: "pc" });
  add("whiteboard", 11, 12);
  add("poster", 17, 12, { variant: 5 });
  add("plantTall", 11, 14, { variant: 1 });
  add("filingCabinet", 19, 14);
  add("binderShelf", 18, 14);

  // Lounge: kitchen along the wall, a sofa in front of the TV, ping-pong, games.
  add("tv", 22, 12);
  add("counter", 21, 14, { variant: 1 });
  add("counterSink", 22, 14);
  add("coffeeMachine", 23, 14);
  add("fridge", 24, 14);
  add("vendingMachine", 28, 14);
  add("waterCooler", 29, 14);
  add("arcade", 31, 14);
  add("rug", 21, 16, { variant: 1 });
  add("coffeeTable", 22, 16);
  add("sofa", 21, 18, { variant: 1 });
  add("armchair", 24, 17, { variant: 2 });
  add("pingpongTable", 27, 17);
  add("beanbag", 30, 20, { variant: 1 });
  add("beanbag", 31, 20, { variant: 2 });
  add("cafeTable", 25, 20);
  add("cafeChair", 24, 20, { variant: 3 });
  add("cafeChair", 26, 20, { variant: 2 });
  add("plantTall", 21, 20, { variant: 2 });
  add("painting", 29, 12);

  // Server room: rows of cabinets (the built-in art has no server racks) and a desk to watch them.
  for (const y of [15, 18]) for (const x of [33, 34, 37, 38]) add("filingCabinet", x, y);
  add("deskBack", 33, 20, { variant: 2 });
  add("clock", 38, 12);
  add("trashBin", 39, 20);

  return withExecutiveSuite({
    version: 2,
    width: 40,
    height: 22,
    ...shell(40, 22, shells, "hall"),
    items,
    rooms: shells.map((x) => x.room),
    routing: DEFAULT_ROUTING,
    assignments: {},
    desks: {},
  });
}

/** Rooms that belong to the company's top, not to a department: nobody is put there automatically. */
export const EXECUTIVE_ROOMS = ["ceo", "chairman"];

/**
 * Adds a column on the right with the CEO's office (top) and the chairman's office (bottom), joined to
 * the corridor. Leaves floors that already have a chairman's office as they are.
 */
export function withExecutiveSuite(floor: Floor): Floor {
  if (floor.rooms.some((r) => r.id === "chairman")) return floor;
  const W = 10;
  const H = floor.height;
  const topH = Math.max(6, Math.floor(H / 2) - 1);
  const shells: Shell[] = [
    {
      room: { id: "ceo", name: "CEO office", purpose: "The CEO: sums up the departments and decides what you let it decide", x: 0, y: 0, w: W, h: topH, hue: 0, routing: {} },
      floorStyle: "carpetRose",
      wallStyle: "woodPanel",
      door: "bottom",
    },
    {
      room: { id: "chairman", name: "Chairman's office", purpose: "You: the whole company at a glance, and what needs your decision", x: 0, y: H - topH, w: W, h: topH, hue: 45, routing: {} },
      floorStyle: "carpetSlate",
      wallStyle: "woodPanel",
      door: "top",
    },
  ];
  const part = shell(W, H, shells, "hall");
  // Merge the style lists and re-code the new column into the floor's codes.
  const merge = (target: Floor["floor"], add: Floor["floor"]) => {
    const styles = [...target.styles];
    for (const st of add.styles) if (!styles.includes(st)) styles.push(st);
    const recode = (c: string) => (c === "." ? "." : TILE_CODES[styles.indexOf(add.styles[TILE_CODES.indexOf(c)])]);
    return { styles, rows: target.rows.map((row, y) => row + [...add.rows[y]].map(recode).join("")) };
  };
  const floorLayer = merge(floor.floor, part.floor);
  const walls = merge(floor.walls, part.walls);
  // Open the old outer wall (and the new one) wherever the corridor runs into the new column.
  const hallCode = TILE_CODES[floor.floor.styles.indexOf("hall")];
  const rows = walls.rows.map((r) => [...r]);
  for (let y = 1; y < H - 1; y++) {
    const corridor = floor.floor.rows[y][floor.width - 2] === hallCode && floor.walls.rows[y][floor.width - 2] === "." && part.walls.rows[y][1] === ".";
    if (corridor) rows[y][floor.width - 1] = rows[y][floor.width] = ".";
  }
  const ox = floor.width;
  const items: Floor["items"] = [];
  const add = (kind: string, x: number, y: number, extra: Partial<Floor["items"][number]> = {}) => items.push({ kind, x: ox + x, y, ...extra });
  // CEO: a desk facing the room, a sofa corner, books.
  add("painting", 2, 0);
  add("window", 6, 0);
  add("desk", 4, 3, { variant: 2 });
  add("pc", 4, 3);
  add("officeChair", 4, 4, { dx: 16, variant: 0 });
  add("bookshelf", 1, 2);
  add("plantTall", 8, 2, { variant: 3 });
  add("sofa", 1, topH - 3, { variant: 1 });
  add("plantSmall", 8, topH - 2, { variant: 2 });
  // Chairman: a wide desk, a sofa and a rug for visitors.
  const cy = H - topH;
  add("sign", 1, cy);
  add("painting", 6, cy);
  add("rug", 2, cy + 5, { variant: 3 });
  add("desk", 4, cy + 3, { variant: 0 });
  add("pc", 4, cy + 3);
  add("officeChair", 4, cy + 4, { dx: 16, variant: 4 });
  add("bookshelf", 7, cy + 2);
  add("plantTall", 1, cy + 2, { variant: 0 });
  add("sofa", 1, cy + 6, { variant: 1 });
  add("armchair", 5, cy + 7, { variant: 0 });
  add("plantTall", 8, cy + 7, { variant: 2 });
  return {
    ...floor,
    width: floor.width + W,
    floor: floorLayer,
    walls: { styles: walls.styles, rows: rows.map((r) => r.join("")) },
    items: [...floor.items, ...items],
    rooms: [...floor.rooms, ...shells.map((x) => ({ ...x.room, x: x.room.x + ox }))],
  };
}
