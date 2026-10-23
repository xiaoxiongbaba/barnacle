import Phaser from "phaser";
import type { Occupant } from "../types";
import * as H from "../vendor/habblaud/art/index";
import { capColor } from "../vendor/habblaud/art/surfaces/walls";
import { car, MARGIN, paintGrounds } from "./exterior";
import { DEPTH, thumbCanvas, wallPieces, type CharacterView, type Facing, type FloorArt, type Part, type PoseOptions } from "./art";
import { itemDef, styleAt, TILE, type Floor, type Furniture, type ItemKind } from "./model";

/**
 * The built-in art: Habblaud's procedural pixel art (web/src/vendor/habblaud, MIT). It draws at 16px per
 * tile; Barnacle's tiles are 32px, so everything is shown at 2× with crisp pixels.
 */

const S = TILE / H.TILE;
const HT = H.TILE;

/** Floor styles (palette keys) → Habblaud floor kinds and carpet tints. Old keys from art packs map too. */
const FLOORS: Record<string, { kind: H.FloorKind; tint?: string; tint2?: string }> = {
  concrete: { kind: "concrete" },
  marble: { kind: "marble" },
  wood: { kind: "wood" },
  tileWhite: { kind: "tile_white" },
  tileCheck: { kind: "tile_check" },
  carpetGray: { kind: "carpet", tint: "#c9d1dc", tint2: "#bdc6d3" },
  carpetBlue: { kind: "carpet", tint: "#c0d2e7", tint2: "#b3c7e0" },
  carpetSand: { kind: "carpet", tint: "#dbcfba", tint2: "#d0c2ab" },
  carpetGreen: { kind: "carpet", tint: "#c4cfbb", tint2: "#b8c5af" },
  carpetLilac: { kind: "carpet", tint: "#cdc8de", tint2: "#c2bbd5" },
  carpetRose: { kind: "carpet", tint: "#e0cad2", tint2: "#d6bdc6" },
  carpetSlate: { kind: "carpet", tint: "#aab1bd", tint2: "#9fa7b4" },
  grass: { kind: "grass" },
  sidewalk: { kind: "sidewalk" },
};
const FLOOR_ALIASES: Record<string, string> = {
  hall: "concrete",
  officeTile: "carpetGray",
  carpetDark: "carpetSlate",
  woodPlank: "wood",
  woodGold: "wood",
  creamTile: "marble",
  serverTile: "tileCheck",
  woodDiagonal: "wood",
};

/** Wall styles → Habblaud wall looks (from its room themes). */
const WALLS: Record<string, H.WallStyle> = {
  plain: { base: "#eef1f4", trim: "#9fb0c4", pattern: "plain" },
  stripes: { base: "#f6f0e5", trim: "#b99f7a", pattern: "stripes" },
  woodPanel: { base: "#f4efe8", trim: "#8a6a52", pattern: "wood_panel" },
  brick: { base: "#e8eaee", trim: "#6d7583", pattern: "brick" },
  tiles: { base: "#eef6f4", trim: "#7fb3a6", pattern: "tiles" },
  glass: { base: "#dfeaf3", trim: "#8aa6c8", pattern: "glass" },
  marble: { base: "#f3f1f8", trim: "#a59cc4", pattern: "marble" },
};
const WALL_ALIASES: Record<string, string> = { lavender: "stripes", stone: "tiles" };

/** Poses the idle life may ask for by name. */
const POSES: Record<string, true> = Object.fromEntries(
  ["stand", "walk", "sit", "type", "sleep", "drink", "use", "raise_hand", "talk", "stretch", "read", "play", "wait", "cheer", "laugh", "game", "rps", "groom", "sulk"].map((p) => [p, true]),
);
const HELD: Record<string, true> = Object.fromEntries(
  ["none", "coffee", "water", "papers", "laptop", "book", "box", "paddle", "popcorn", "controller", "rock", "paper", "scissors", "phone", "lipstick", "comb"].map((p) => [p, true]),
);

const RUG_COLORS: Record<string, string> = { blue: "#5b7fb8", green: "#5f9a6e", red: "#b8565a", sand: "#c8a878" };

/** Barnacle item kinds drawn by Habblaud furniture (camelCase → snake_case). Anything else isn't drawn. */
const habbKind = (kind: ItemKind): H.FurnitureKind | null => {
  const k = kind.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return k in H.FURNITURE ? (k as H.FurnitureKind) : null;
};

/** The seed of an occupant's look; the side panel's avatars use the same one. */
export const characterSeed = (id: string) => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Characters' animations: which Habblaud pose to play. */
function poseFor(moving: boolean, o: PoseOptions): { pose: H.Pose; seated: boolean } {
  if (moving) return { pose: "walk", seated: false };
  if (o.pose && o.pose in POSES) return { pose: o.pose as H.Pose, seated: Boolean(o.seated) };
  if (o.seated) return { pose: o.alert ? "raise_hand" : o.working ? "type" : "sit", seated: true };
  return { pose: o.alert ? "raise_hand" : "stand", seated: false };
}

export class HabbArt implements FloorArt {
  private scene: Phaser.Scene | null = null;
  private background: string | null = null;
  private builds = 0;
  private traffic: Phaser.Time.TimerEvent | null = null;
  /** Tiles of grounds drawn around the building (the camera may show them). */
  margin = MARGIN;

  preload() {}

  setup(scene: Phaser.Scene) {
    this.scene = scene;
  }

  floorStyles() {
    return Object.keys(FLOORS);
  }

  wallStyles() {
    return Object.keys(WALLS);
  }

  variants(kind: ItemKind) {
    const d = itemDef(kind);
    if (kind !== "rug" && !habbKind(kind)) return [];
    return Array.from({ length: d.variants?.length ?? 1 }, (_, i) => i);
  }

  private floorOf(style: string) {
    return FLOORS[style] ?? FLOORS[FLOOR_ALIASES[style] ?? ""] ?? FLOORS.concrete;
  }

  private wallOf(style: string) {
    return WALLS[style] ?? WALLS[WALL_ALIASES[style] ?? ""] ?? WALLS.plain;
  }

  /**
   * Floors and walls never cover anything that moves, so the grounds, the floors and the walls all go into
   * one picture; only the cars on the street move.
   */
  drawFloors(scene: Phaser.Scene, floor: Floor) {
    const canvas = document.createElement("canvas");
    canvas.width = (floor.width + MARGIN.left + MARGIN.right) * HT;
    canvas.height = (floor.height + MARGIN.top + MARGIN.bottom) * HT;
    const ctx = canvas.getContext("2d")!;
    const grounds = paintGrounds(ctx, floor.width, floor.height);
    ctx.translate(MARGIN.left * HT, MARGIN.top * HT);
    for (let y = 0; y < floor.height; y++) {
      for (let x = 0; x < floor.width; x++) {
        const style = styleAt(floor.floor, x, y);
        if (!style) continue;
        const f = this.floorOf(style);
        H.drawFloor(ctx, f.kind, x * HT, y * HT, HT, HT, { seed: 7, tint: f.tint, tint2: f.tint2 });
      }
    }
    this.drawWallPieces(ctx, floor);
    if (this.background) scene.textures.remove(this.background);
    this.background = `hb-floor-${this.builds++}`;
    scene.textures.addCanvas(this.background, canvas);
    scene.add.image(-MARGIN.left * TILE, -MARGIN.top * TILE, this.background).setOrigin(0, 0).setScale(S).setDepth(DEPTH.floor);
    this.startTraffic(scene, grounds);
  }

  /** Cars now and then, on both lanes. */
  private startTraffic(scene: Phaser.Scene, grounds: ReturnType<typeof paintGrounds>) {
    this.traffic?.remove();
    this.traffic = scene.time.addEvent({
      delay: 2600,
      loop: true,
      callback: () => {
        if (Math.random() < 0.35) return;
        const lane = grounds.lanes[Math.floor(Math.random() * grounds.lanes.length)];
        const sprite = car(Math.floor(Math.random() * 6), lane.dir);
        const key = this.texture(`hb-car-${sprite.canvas.width}-${lane.dir}-${Math.floor(Math.random() * 6)}`, sprite.canvas);
        const [from, to] = lane.dir > 0 ? [grounds.x0, grounds.x1] : [grounds.x1, grounds.x0];
        const img = scene.add
          .image(from * S, lane.y * S, key)
          .setOrigin(sprite.ax / sprite.canvas.width, sprite.ay / sprite.canvas.height)
          .setScale(S)
          .setDepth(lane.y * S);
        scene.tweens.add({ targets: img, x: to * S, duration: (Math.abs(to - from) / (38 + Math.random() * 30)) * 1000, onComplete: () => img.destroy() });
      },
    });
  }

  /** Drawn into the floor picture by drawFloors. */
  drawWalls() {}

  private drawWallPieces(ctx: CanvasRenderingContext2D, floor: Floor) {
    for (const p of wallPieces(floor)) {
      const style = this.wallOf(p.style);
      const cap = capColor(style);
      const x = p.x * HT;
      const y = p.y * HT;
      if (p.look === "face") H.drawWallFace(ctx, x, y - HT, HT, style);
      else if (p.look === "low") H.drawSouthWall(ctx, x, y, HT, style);
      else {
        ctx.fillStyle = cap;
        ctx.fillRect(x, y, HT, HT);
      }
      // Darker edges where the wall ends, so thick walls read as blocks.
      const top = p.look === "face" ? y - HT : y;
      const bottom = y + HT;
      ctx.fillStyle = "rgba(20, 24, 36, 0.55)";
      if (p.open.left) ctx.fillRect(x, top, 1, bottom - top);
      if (p.open.right) ctx.fillRect(x + HT - 1, top, 1, bottom - top);
      if (p.look === "cap" && p.open.top) ctx.fillRect(x, y, HT, 1);
    }
  }

  private texture(key: string, canvas: HTMLCanvasElement) {
    const scene = this.scene!;
    if (!scene.textures.exists(key)) scene.textures.addCanvas(key, canvas);
    return key;
  }

  private sprites(f: Furniture) {
    const d = itemDef(f.kind);
    const variant = d.variants?.[f.variant ?? 0];
    if (f.kind === "rug") {
      const w = d.w * HT;
      const h = d.h * HT;
      const color = RUG_COLORS[variant ?? "blue"] ?? RUG_COLORS.blue;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      H.drawRug(canvas.getContext("2d")!, 0, 0, w, h, color, 3);
      return { base: { canvas, ax: w / 2, ay: h }, front: undefined, key: `hb-rug-${variant}` };
    }
    const kind = habbKind(f.kind);
    if (!kind) return null;
    const seed = f.x * 31 + f.y * 17;
    const s = H.furnitureSprites(kind, variant, 0, { seed });
    return { ...s, key: `hb-${kind}-${variant ?? "-"}-${seed}` };
  }

  drawFurniture(scene: Phaser.Scene, f: Furniture, depth: number) {
    const s = this.sprites(f);
    if (!s) return null;
    const d = itemDef(f.kind);
    // Habblaud anchors floor pieces at the footprint's bottom centre and wall pieces on the baseboard line.
    const x = (f.x + d.w / 2) * TILE + (f.dx ?? 0);
    const y = (f.y + d.h) * TILE + (f.dy ?? 0);
    const place = (sprite: H.Sprite, part: string, z: number) =>
      scene.add
        .image(x, y, this.texture(`${s.key}-${part}`, sprite.canvas))
        .setOrigin(sprite.ax / sprite.canvas.width, sprite.ay / sprite.canvas.height)
        .setScale(S)
        .setDepth(z);
    const z = d.layer === "rug" ? DEPTH.rug : depth;
    // A seat's backrest (`front`) covers whoever sits there; the rest of the seat goes behind them.
    if (s.front) place(s.front, "front", z);
    return place(s.base, "base", s.front ? z - 10 : z);
  }

  icon(scene: Phaser.Scene, name: string) {
    let s: H.Sprite;
    try {
      s = H.iconSprite(name as H.IconName);
    } catch {
      return null;
    }
    return scene.add
      .image(0, 0, this.texture(`hb-icon-${name}`, s.canvas))
      .setOrigin(s.ax / s.canvas.width, s.ay / s.canvas.height)
      .setScale(S);
  }

  thumbnail(part: Part) {
    const { canvas, ctx } = thumbCanvas();
    if ("floor" in part) {
      const f = this.floorOf(part.floor);
      const tile = document.createElement("canvas");
      tile.width = HT * 2;
      tile.height = HT * 2;
      H.drawFloor(tile.getContext("2d")!, f.kind, 0, 0, HT * 2, HT * 2, { seed: 7, tint: f.tint, tint2: f.tint2 });
      ctx.drawImage(tile, 0, 0, 44, 44);
    } else if ("wall" in part) {
      const face = document.createElement("canvas");
      face.width = HT * 2;
      face.height = HT * 2;
      H.drawWallFace(face.getContext("2d")!, 0, 0, HT * 2, this.wallOf(part.wall));
      ctx.drawImage(face, 0, 0, 44, 44);
    } else {
      const s = this.sprites({ kind: part.item, x: 0, y: 0, variant: part.variant });
      if (s) {
        const c = s.base.canvas;
        const scale = Math.min(2, 44 / c.width, 44 / c.height);
        const w = Math.round(c.width * scale);
        const h = Math.round(c.height * scale);
        ctx.drawImage(c, Math.floor((44 - w) / 2), Math.floor((44 - h) / 2), w, h);
        if (s.front) ctx.drawImage(s.front.canvas, Math.floor((44 - w) / 2), Math.floor((44 - h) / 2), Math.round(s.front.canvas.width * scale), Math.round(s.front.canvas.height * scale));
      }
    }
    return canvas;
  }

  character(scene: Phaser.Scene, o: Occupant): CharacterView {
    const seed = characterSeed(o.id);
    const appearance = H.appearanceFromSeed(seed);
    const anim = (pose: H.Pose, dir: H.Dir, seated: boolean, held: H.HeldItem) => {
      const key = `hb-char-${seed}-${pose}-${dir}-${seated ? 1 : 0}-${held}`;
      if (scene.anims.exists(key)) return key;
      const count = H.poseFrameCount(pose);
      const frames = Array.from({ length: count }, (_, frame) => {
        const sprite = H.characterSprite({ appearance, dir, pose, frame, seated, held });
        return { key: this.texture(`${key}-${frame}`, sprite.canvas) };
      });
      scene.anims.create({ key, frames, frameRate: 1000 / H.poseFrameDuration(pose), repeat: -1 });
      return key;
    };
    const first = H.characterSprite({ appearance, dir: "down", pose: "stand", frame: 0 });
    const sprite = scene.add
      .sprite(0, 0, this.texture(`hb-char-${seed}-first`, first.canvas))
      .setOrigin(first.ax / first.canvas.width, first.ay / first.canvas.height)
      .setScale(S);
    let current = "";
    return {
      sprite,
      height: 30 * S,
      animated: true,
      sitLift: { up: 2, down: 2, left: 2, right: 2 },
      pose: (facing: Facing, moving: boolean, opts: PoseOptions = {}) => {
        const { pose, seated } = poseFor(moving, opts);
        const held = (opts.held && opts.held in HELD ? opts.held : "none") as H.HeldItem;
        const key = anim(pose, facing, seated, held);
        if (key !== current) {
          current = key;
          sprite.play(key);
        }
      },
    };
  }
}
