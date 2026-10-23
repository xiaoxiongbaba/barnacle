import { EXECUTIVE_ROOMS, type Floor } from "./floor.js";

/**
 * Desks: everyone in the office has their own office chair (with the desk and computer in front of it),
 * kept in the floor plan as occupant id → chair tile. Their room is the room that desk is in. Anyone
 * without one gets a free desk in the room that fits their job title, and keeps it: the office shows it
 * with a name plate, and you can move people around. Bindings follow chairs that are moved in the
 * editor; a removed chair (or person) frees the desk and the person gets another one.
 */

export interface Person {
  id: string;
  role: string;
}

type Tile = { x: number; y: number };

/** Words in a job title that point to a kind of work room (matched against the room's id, name and purpose too). */
const ROOM_HINTS: Record<string, string[]> = {
  research: ["research", "analy", "investig", "研究", "調研", "调研", "調查", "调查", "分析", "リサーチ", "調査"],
  writing: ["writ", "edit", "copy", "content", "author", "寫", "写", "文案", "編輯", "编辑", "記者", "记者", "ライター", "編集", "作家"],
  design: ["design", "art", "illustr", "設計", "设计", "美術", "美术", "繪", "绘", "デザイン"],
  operations: ["market", "growth", "operat", "assist", "manag", "project", "sales", "行銷", "营销", "營運", "运营", "助理", "專案", "项目", "經理", "经理", "企劃", "企划", "マーケ", "アシスタント", "企画"],
};

const key = (t: Tile) => `${t.x},${t.y}`;

/** Office chairs: the seats that make a desk. */
export function chairs(floor: Floor): Tile[] {
  return floor.items.filter((i) => i.kind === "officeChair").map((i) => ({ x: i.x, y: i.y }));
}

export function roomAt(floor: Floor, t: Tile) {
  return floor.rooms.find((r) => t.x >= r.x && t.y >= r.y && t.x < r.x + r.w && t.y < r.y + r.h);
}

/** The room someone should sit in: the one you picked for them, else the one their job title fits. */
function preferredRoom(floor: Floor, p: Person, rooms: Floor["rooms"]) {
  const picked = rooms.find((r) => r.id === floor.assignments[p.id]);
  if (picked) return picked;
  const role = p.role.toLowerCase();
  if (!role) return undefined;
  for (const r of rooms) {
    const words = [...(ROOM_HINTS[r.id] ?? []), r.name.toLowerCase()];
    if (words.some((w) => w.length > 1 && role.includes(w))) return r;
  }
  for (const r of rooms) {
    const about = `${r.id} ${r.name} ${r.purpose}`.toLowerCase();
    if (Object.values(ROOM_HINTS).some((hints) => hints.some((w) => role.includes(w) && about.includes(w)))) return r;
  }
  return undefined;
}

/**
 * Makes the desks consistent with the floor and the people: drops bindings to chairs that are gone, to
 * people who left and duplicates; gives everyone without a desk a free one. Changes `floor.desks` in
 * place; true if anything changed.
 */
/** Who sits in the executive offices: room id → occupant. */
export type Executives = { chairman?: string | null; ceo?: string | null };

export function ensureDesks(floor: Floor, people: Person[], executives: Executives = {}): boolean {
  const before = JSON.stringify(floor.desks);
  const all = chairs(floor);
  const exists = new Set(all.map(key));
  const known = new Set(people.map((p) => p.id));
  const taken = new Set<string>();
  const desks: Floor["desks"] = {};
  for (const [id, t] of Object.entries(floor.desks)) {
    if (!known.has(id) || !exists.has(key(t)) || taken.has(key(t))) continue;
    desks[id] = { x: t.x, y: t.y };
    taken.add(key(t));
  }
  // The chairman and the CEO sit in their offices; nobody else is put in the executive offices on their own.
  const executive = (c: Tile) => EXECUTIVE_ROOMS.includes(roomAt(floor, c)?.id ?? "");
  const chosen = new Set([executives.chairman, executives.ceo].filter((x): x is string => !!x));
  for (const [roomId, who] of [["chairman", executives.chairman], ["ceo", executives.ceo]] as const) {
    if (!who || !known.has(who) || (desks[who] && roomAt(floor, desks[who])?.id === roomId)) continue;
    // The office is theirs: anyone else sitting there gets a desk elsewhere (below).
    const inRoom = all.filter((c) => roomAt(floor, c)?.id === roomId);
    const seat = inRoom.find((c) => !taken.has(key(c))) ?? inRoom.find((c) => !chosen.has(Object.entries(desks).find(([, t]) => key(t) === key(c))?.[0] ?? ""));
    if (!seat) continue;
    const sitter = Object.entries(desks).find(([id, t]) => id !== who && key(t) === key(seat))?.[0];
    if (sitter) delete desks[sitter];
    if (desks[who]) taken.delete(key(desks[who]));
    desks[who] = seat;
    taken.add(key(seat));
  }
  const free = () => all.filter((c) => !taken.has(key(c)) && !executive(c)).sort((a, b) => a.y - b.y || a.x - b.x);
  const rooms = floor.rooms.filter((r) => !EXECUTIVE_ROOMS.includes(r.id) && all.some((c) => roomAt(floor, c)?.id === r.id));
  for (const p of [...people].sort((a, b) => a.id.localeCompare(b.id))) {
    if (desks[p.id]) continue;
    const open = free();
    if (!open.length) break;
    const room = preferredRoom(floor, p, rooms);
    // In the room that fits, else the work room with the most free desks.
    const inRoom = (id: string) => open.filter((c) => roomAt(floor, c)?.id === id);
    const target = room && inRoom(room.id).length ? inRoom(room.id) : rooms.map((r) => inRoom(r.id)).sort((a, b) => b.length - a.length)[0];
    const chair = target?.[0] ?? open[0];
    desks[p.id] = chair;
    taken.add(key(chair));
  }
  floor.desks = desks;
  return JSON.stringify(desks) !== before;
}

/**
 * Moves someone to a desk (a chair tile) or to a free desk in a room. Taking someone else's desk swaps
 * the two. Returns an error to show, or null.
 */
export function moveDesk(floor: Floor, people: Person[], id: string, target: Tile | { room: string }, executives: Executives = {}): string | null {
  const all = chairs(floor);
  let chair: Tile | undefined;
  if ("room" in target) {
    const taken = new Set(Object.entries(floor.desks).filter(([who]) => who !== id).map(([, t]) => key(t)));
    chair = all.filter((c) => roomAt(floor, c)?.id === target.room && !taken.has(key(c))).sort((a, b) => a.y - b.y || a.x - b.x)[0];
    if (!chair) return "There is no free desk in that room.";
  } else {
    chair = all.find((c) => c.x === target.x && c.y === target.y);
    if (!chair) return "There is no desk (office chair) there.";
  }
  const old = floor.desks[id];
  const owner = Object.entries(floor.desks).find(([who, t]) => who !== id && key(t) === key(chair))?.[0];
  floor.desks[id] = { x: chair.x, y: chair.y };
  const room = roomAt(floor, chair);
  if (room) floor.assignments[id] = room.id;
  if (owner) {
    if (old) {
      floor.desks[owner] = old;
      const ownerRoom = roomAt(floor, old);
      if (ownerRoom) floor.assignments[owner] = ownerRoom.id;
    } else delete floor.desks[owner];
  }
  ensureDesks(floor, people, executives);
  return null;
}
