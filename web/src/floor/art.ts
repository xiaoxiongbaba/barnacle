import type Phaser from "phaser";
import type { Occupant } from "../types";
import { isWall, styleAt, TILE, type Floor, type Furniture, type ItemKind } from "./model";

export type Facing = "up" | "down" | "left" | "right";

/** What a person is doing, for arts that have poses for it. */
export interface PoseOptions {
  seated?: boolean;
  working?: boolean;
  /** Needs attention (raises a hand). */
  alert?: boolean;
  /** A specific pose for arts that have it (Habblaud's: drink, use, play, game, rps, cheer, sulk, laugh, talk…). */
  pose?: string;
  /** Something in hand: coffee, water, paddle, controller, phone, popcorn, book, rock, paper, scissors, comb… */
  held?: string;
}

/** A person's sprite plus how to turn and animate it. */
export interface CharacterView {
  sprite: Phaser.GameObjects.Sprite;
  /** Height of the drawn body in pixels, for placing the speech bubble. */
  height: number;
  /** true when the art has its own walk/idle animations (no bobbing tweens needed). */
  animated: boolean;
  /** How far (pixels) to lift someone sitting down, by the way they face, so they sit on the seat. */
  sitLift: Record<Facing, number>;
  pose(facing: Facing, moving: boolean, opts?: PoseOptions): void;
}

/** A part shown in the editor's palette. */
export type Part = { floor: string } | { wall: string } | { item: ItemKind; variant: number };

/** Everything the floor scene and the map editor need from an art style. */
export interface FloorArt {
  credit?: { text: string; url: string };
  preload(scene: Phaser.Scene): void;
  /** Called once in create(), after loading. */
  setup(scene: Phaser.Scene): void;
  /** Style keys this art can paint, in palette order. */
  floorStyles(): string[];
  wallStyles(): string[];
  /** The looks (variant indexes) this art can draw for an item; empty when it can't draw it. */
  variants(kind: ItemKind): number[];
  drawFloors(scene: Phaser.Scene, floor: Floor): void;
  drawWalls(scene: Phaser.Scene, floor: Floor): void;
  drawFurniture(scene: Phaser.Scene, f: Furniture, depth: number): Phaser.GameObjects.GameObject | null;
  /** Tiles of scenery drawn around the floor (the camera may scroll over them). */
  margin?: { left: number; right: number; top: number; bottom: number };
  /** A small icon over someone's head (zzz, coffee, heart, trophy, coin…), or null if the art has none. */
  icon?(scene: Phaser.Scene, name: string): Phaser.GameObjects.Image | null;
  /** A small picture of a part for the palette. */
  thumbnail(part: Part): HTMLCanvasElement;
  character(scene: Phaser.Scene, o: Occupant): CharacterView;
}

/** Drawing order of the fixed layers; walls, furniture and people sort by their bottom edge in pixels. */
export const DEPTH = { floor: -10_000, rug: -9_000 } as const;

/**
 * How each wall tile looks, like walls in a tile editor:
 * - `cap`: the top of a wall seen from above (another wall tile continues below it);
 * - `face`: the front of a wall two tiles thick (the face covers this tile and the one above);
 * - `low`: the front of a one-tile wall (a short face under a thin cap).
 * `open` lists the sides with no wall next to them, which get an outline.
 */
export interface WallPiece {
  x: number;
  y: number;
  style: string;
  look: "cap" | "face" | "low";
  open: { left: boolean; right: boolean; top: boolean; bottom: boolean };
}

export function wallPieces(floor: Floor): WallPiece[] {
  const wall = (x: number, y: number) => isWall(floor, x, y);
  const out: WallPiece[] = [];
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      const style = styleAt(floor.walls, x, y);
      if (!style) continue;
      const open = { left: !wall(x - 1, y), right: !wall(x + 1, y), top: !wall(x, y - 1), bottom: !wall(x, y + 1) };
      let look: WallPiece["look"] = "cap";
      if (open.bottom) {
        // A tall face where the wall above runs sideways too (a thick wall) or stands alone (a pillar end).
        const tall = !open.top && (wall(x - 1, y - 1) || wall(x + 1, y - 1) || (open.left && open.right));
        look = tall ? "face" : "low";
      }
      out.push({ x, y, style, look, open });
    }
  }
  return out;
}

/** Draws a wall piece's outlines (the dark edges where no wall continues). */
export function outlineWall(g: Phaser.GameObjects.Graphics, p: WallPiece, line: number) {
  const T = TILE;
  const top = p.look === "face" ? (p.y - 1) * T : p.y * T;
  const height = (p.y + 1) * T - top;
  g.fillStyle(line, 1);
  if (p.open.left) g.fillRect(p.x * T, top, 2, height);
  if (p.open.right) g.fillRect((p.x + 1) * T - 2, top, 2, height);
  if (p.look !== "face" && p.open.top) g.fillRect(p.x * T, p.y * T, T, 2);
  if (p.look !== "cap") g.fillRect(p.x * T, (p.y + 1) * T - 2, T, 2);
}

/** A canvas of the given size with crisp scaling, for thumbnails. */
export function thumbCanvas(w = 44, h = 44) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return { canvas: c, ctx };
}
