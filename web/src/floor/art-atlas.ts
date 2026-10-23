import Phaser from "phaser";
import { hueFor, type Occupant } from "../types";
import { DEPTH, outlineWall, thumbCanvas, wallPieces, type CharacterView, type Facing, type FloorArt, type Part } from "./art";
import { itemDef, styleAt, TILE, type Floor, type Furniture, type ItemKind } from "./model";

const T = TILE;

interface Frame {
  sheet: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The atlas.json written by scripts/import-limezu.mjs (or any pack with the same shape). */
export interface Atlas {
  name: string;
  credit?: { text: string; url: string };
  tile: number;
  sheets: Record<string, string>;
  /** Each floor is a swatch of tiles laid in place, row by row, `cols` wide. */
  floors: Record<string, { cols: number; tiles: Frame[] }>;
  /** Wall faces, 32×64: a white cap at the top, then the wall. */
  walls: Record<string, Frame>;
  wallCap: { fill: string; line: string };
  /** Frames per item kind, one per variant of the item (null where the pack has no such look). */
  furniture: Partial<Record<ItemKind, (Frame | null)[]>>;
  characters: { files: string[]; frameWidth: number; frameHeight: number; idleRow: number; walkRow: number; framesPerDirection: number };
}

const DIRECTIONS: Facing[] = ["right", "up", "left", "down"];
const color = (hex: string) => Number.parseInt(hex.replace("#", ""), 16);

/** Where a wall item's top edge sits below the top of the wall's face, in pixels. */
const WALL_ITEM_TOP = 14;
/** How far above its footprint's bottom edge something on a desk stands, in pixels. */
const ON_DESK = 14;
/** Rows of a wall face's image that are its white cap; a low wall shows the cap and the bottom of the face. */
const FACE_CAP = 12;

/** Art from a sprite-sheet pack: floors, walls and furniture cut from sheets, animated characters. */
export class AtlasArt implements FloorArt {
  credit?: { text: string; url: string };
  private frames = new Map<Frame, string>();
  private scene: Phaser.Scene | null = null;

  constructor(
    private atlas: Atlas,
    private base: string,
  ) {
    this.credit = atlas.credit;
  }

  preload(scene: Phaser.Scene) {
    for (const [key, file] of Object.entries(this.atlas.sheets)) scene.load.image(`atlas-${key}`, this.base + file);
    const c = this.atlas.characters;
    c.files.forEach((file, i) => scene.load.spritesheet(`person-${i}`, this.base + file, { frameWidth: c.frameWidth, frameHeight: c.frameHeight }));
  }

  setup(scene: Phaser.Scene) {
    this.scene = scene;
    // Register every rectangle as a named frame on its sheet texture (plus the parts of a low wall).
    const lows = Object.values(this.atlas.walls).flatMap((f) => [
      { ...f, h: FACE_CAP },
      { ...f, y: f.y + f.h - (T - FACE_CAP), h: T - FACE_CAP },
    ]);
    const all: Frame[] = [
      ...Object.values(this.atlas.floors).flatMap((s) => s.tiles),
      ...Object.values(this.atlas.walls),
      ...lows,
      ...Object.values(this.atlas.furniture)
        .flat()
        .filter((f): f is Frame => f !== null),
    ];
    for (const f of all) this.frameName(f);
    // Idle and walk loops per character and direction.
    const c = this.atlas.characters;
    c.files.forEach((_, i) => {
      const key = `person-${i}`;
      const perRow = scene.textures.get(key).getSourceImage().width / c.frameWidth;
      DIRECTIONS.forEach((dir, d) => {
        for (const [anim, row, fps] of [
          ["idle", c.idleRow, 6],
          ["walk", c.walkRow, 10],
        ] as const) {
          const start = row * perRow + d * c.framesPerDirection;
          if (scene.anims.exists(`${key}-${anim}-${dir}`)) continue;
          scene.anims.create({
            key: `${key}-${anim}-${dir}`,
            frames: scene.anims.generateFrameNumbers(key, { start, end: start + c.framesPerDirection - 1 }),
            frameRate: fps,
            repeat: -1,
          });
        }
      });
    });
  }

  private frameName(f: Frame) {
    let name = this.frames.get(f);
    if (name) return name;
    name = `${f.x},${f.y},${f.w},${f.h}`;
    const texture = this.scene!.textures.get(`atlas-${f.sheet}`);
    if (!texture.has(name)) texture.add(name, 0, f.x, f.y, f.w, f.h);
    this.frames.set(f, name);
    return name;
  }

  private image(scene: Phaser.Scene, f: Frame, x: number, y: number) {
    return scene.add.image(x, y, `atlas-${f.sheet}`, this.frameName(f)).setOrigin(0, 0);
  }

  floorStyles() {
    return Object.keys(this.atlas.floors);
  }

  wallStyles() {
    return Object.keys(this.atlas.walls);
  }

  variants(kind: ItemKind) {
    return (this.atlas.furniture[kind] ?? []).flatMap((f, i) => (f ? [i] : []));
  }

  private frameOf(kind: ItemKind, variant = 0) {
    const options = this.atlas.furniture[kind] ?? [];
    return options[variant] ?? options.find((f) => f) ?? null;
  }

  private floorSwatch(style: string) {
    return this.atlas.floors[style] ?? Object.values(this.atlas.floors)[0];
  }

  private face(style: string) {
    return this.atlas.walls[style] ?? Object.values(this.atlas.walls)[0];
  }

  drawFloors(scene: Phaser.Scene, floor: Floor) {
    const g = scene.add.graphics().setDepth(DEPTH.floor - 1);
    g.fillStyle(0x1f2030, 1).fillRect(-T * 8, -T * 8, (floor.width + 16) * T, (floor.height + 16) * T);
    for (let y = 0; y < floor.height; y++) {
      for (let x = 0; x < floor.width; x++) {
        const style = styleAt(floor.floor, x, y);
        if (!style) continue;
        const { cols, tiles } = this.floorSwatch(style);
        const rows = tiles.length / cols;
        this.image(scene, tiles[(y % rows) * cols + (x % cols)], x * T, y * T).setDepth(DEPTH.floor);
      }
    }
  }

  drawWalls(scene: Phaser.Scene, floor: Floor) {
    const cap = color(this.atlas.wallCap.fill);
    const line = color(this.atlas.wallCap.line);
    for (const p of wallPieces(floor)) {
      const depth = (p.y + 1) * T;
      const face = this.face(p.style);
      if (p.look === "face") this.image(scene, face, p.x * T, (p.y - 1) * T).setDepth(depth);
      else if (p.look === "low") {
        this.image(scene, { ...face, h: FACE_CAP }, p.x * T, p.y * T).setDepth(depth);
        this.image(scene, { ...face, y: face.y + face.h - (T - FACE_CAP), h: T - FACE_CAP }, p.x * T, p.y * T + FACE_CAP).setDepth(depth);
      }
      const g = scene.add.graphics().setDepth(depth + 0.5);
      if (p.look === "cap") g.fillStyle(cap, 1).fillRect(p.x * T, p.y * T, T, T);
      outlineWall(g, p, line);
    }
  }

  private placement(f: Furniture, frame: Frame) {
    const d = itemDef(f.kind);
    const x = f.x * T + (d.w * T - frame.w) / 2 + (f.dx ?? 0);
    let y = (f.y + d.h) * T - frame.h + (f.dy ?? 0);
    if (d.layer === "wall") y = f.y * T + WALL_ITEM_TOP + (f.dy ?? 0);
    else if (d.layer === "top") y -= ON_DESK;
    else if (d.layer === "rug") y = f.y * T + (d.h * T - frame.h) / 2 + (f.dy ?? 0);
    return { x: Math.round(x), y: Math.round(y) };
  }

  drawFurniture(scene: Phaser.Scene, f: Furniture, depth: number) {
    const frame = this.frameOf(f.kind, f.variant);
    if (!frame) return null;
    const { x, y } = this.placement(f, frame);
    return this.image(scene, frame, x, y).setDepth(itemDef(f.kind).layer === "rug" ? DEPTH.rug : depth);
  }

  thumbnail(part: Part) {
    const source = (f: Frame) => this.scene!.textures.get(`atlas-${f.sheet}`).getSourceImage() as CanvasImageSource;
    if ("floor" in part) {
      const { canvas, ctx } = thumbCanvas();
      const { cols, tiles } = this.floorSwatch(part.floor);
      // A 2×2 corner of the swatch, at 2/3 size.
      for (let i = 0; i < 4; i++) {
        const t = tiles[Math.floor(i / 2) * cols + (i % 2)] ?? tiles[0];
        ctx.drawImage(source(t), t.x, t.y, t.w, t.h, (i % 2) * 22, Math.floor(i / 2) * 22, 22, 22);
      }
      return canvas;
    }
    if ("wall" in part) {
      const { canvas, ctx } = thumbCanvas();
      const f = this.face(part.wall);
      ctx.drawImage(source(f), f.x, f.y, f.w, f.h, 0, 0, 22, 44);
      ctx.drawImage(source(f), f.x, f.y, f.w, f.h, 22, 0, 22, 44);
      return canvas;
    }
    const { canvas, ctx } = thumbCanvas();
    const f = this.frameOf(part.item, part.variant);
    if (f) {
      const scale = Math.min(1, 44 / f.w, 44 / f.h);
      const w = Math.round(f.w * scale);
      const h = Math.round(f.h * scale);
      ctx.drawImage(source(f), f.x, f.y, f.w, f.h, Math.floor((44 - w) / 2), Math.floor((44 - h) / 2), w, h);
    }
    return canvas;
  }

  character(scene: Phaser.Scene, o: Occupant): CharacterView {
    const count = this.atlas.characters.files.length;
    const key = `person-${hueFor(o.id) % count}`;
    const sprite = scene.add.sprite(0, 0, key, 3).setOrigin(0.5, 1);
    let current = "";
    return {
      sprite,
      height: this.atlas.characters.frameHeight - 14,
      animated: true,
      sitLift: { up: 14, down: 8, left: 8, right: 8 },
      pose: (facing, moving) => {
        const anim = `${key}-${moving ? "walk" : "idle"}-${facing}`;
        if (anim !== current) {
          current = anim;
          sprite.play(anim);
        }
      },
    };
  }
}
