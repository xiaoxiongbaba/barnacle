import { mulberry32 } from "../vendor/habblaud/shared/hash";
import * as H from "../vendor/habblaud/art/index";
import { carSprite, propSprite } from "../vendor/habblaud/world/props";
import type { ExteriorProp } from "../vendor/habblaud/world/types";

/**
 * The grounds around the building, laid out like Habblaud's (client/src/world/layout/exterior.ts, MIT):
 * grass with rows of trees, a hedge along the front, a sidewalk, a two-lane street with lamps, and more
 * trees beyond. Sizes are in tiles around a building of w × h; drawing is in art pixels (16 per tile).
 */
export const MARGIN = { left: 40, right: 40, top: 28, bottom: 40 } as const;

const HT = H.TILE;

export interface Grounds {
  /** Street lanes, in art pixels from the building's top-left: y and direction (+1 east). */
  lanes: { y: number; dir: 1 | -1 }[];
  /** Horizontal extent of the drawn area, in art pixels from the building's top-left. */
  x0: number;
  x1: number;
}

/**
 * Paints the grounds into `ctx`, whose (0, 0) is the top-left of the drawn area (MARGIN.left / MARGIN.top
 * tiles before the building's corner). Returns where the street lanes are, for the cars.
 */
export function paintGrounds(ctx: CanvasRenderingContext2D, w: number, h: number): Grounds {
  const ox = MARGIN.left * HT;
  const oy = MARGIN.top * HT;
  const px = (t: number) => t * HT;
  const bounds = { x: -MARGIN.left, y: -MARGIN.top, w: w + MARGIN.left + MARGIN.right, h: h + MARGIN.top + MARGIN.bottom };
  const floor = (kind: H.FloorKind, x: number, y: number, fw: number, fh: number, seed: number) => {
    // The floor painter works in world coordinates (its tiles are seamless); shift the context instead.
    ctx.save();
    ctx.translate(ox, oy);
    H.drawFloor(ctx, kind, px(x), px(y), px(fw), px(fh), { seed });
    ctx.restore();
  };
  const rng = mulberry32(0xc0de + w * 31 + h);
  const props: ExteriorProp[] = [];
  const south = h;

  floor("grass", bounds.x, bounds.y, bounds.w, bounds.h, 11);
  floor("sidewalk", bounds.x, south + 2, bounds.w, 2, 12);
  floor("street", bounds.x, south + 4, bounds.w, 5, 13);
  floor("sidewalk", bounds.x, south + 9, bounds.w, 2, 14);

  // A row of trees along the north side and a wood behind it, thinning out.
  for (let x = bounds.x + 1; x < bounds.x + bounds.w - 1; x += 4 + Math.floor(rng() * 3)) {
    props.push({ kind: rng() < 0.25 ? "pine" : "tree", x: px(x) + Math.floor(rng() * 8), y: px(-3) - Math.floor(rng() * 20), seed: Math.floor(rng() * 1e9) });
    if (rng() < 0.6) props.push({ kind: "bush", x: px(x + 2), y: px(-1) - 2, seed: Math.floor(rng() * 1e9) });
  }
  for (const [row, gap] of [
    [-6, 5],
    [-10, 6],
    [-14, 8],
    [-18, 8],
    [-22, 9],
    [-26, 10],
  ] as const) {
    for (let x = bounds.x + 2; x < bounds.x + bounds.w - 1; x += gap + Math.floor(rng() * 4)) {
      props.push({ kind: rng() < 0.3 ? "pine" : "tree", x: px(x) + Math.floor(rng() * 8), y: px(row) - Math.floor(rng() * 12), seed: Math.floor(rng() * 1e9) });
    }
  }
  // Trees down both sides.
  for (const side of [-1, 1]) {
    for (const band of [0, 5, 10, 15, 20, 25, 30, 35]) {
      const baseX = side < 0 ? -5 - band : w + 2 + band;
      for (let y = 1; y < h; y += 3 + Math.floor(rng() * 3)) {
        props.push({ kind: rng() < 0.3 ? "pine" : "tree", x: px(baseX + Math.floor(rng() * 3)), y: px(y + 1), seed: Math.floor(rng() * 1e9) });
        if (band === 0 && rng() < 0.5) props.push({ kind: "bush", x: px(side < 0 ? -2 : w + 1), y: px(y + 2), seed: Math.floor(rng() * 1e9) });
      }
    }
  }
  // Hedge and flowers along the front, lamps on the sidewalk, trees across the street.
  for (let x = 0; x < w; x += 2) props.push({ kind: (x / 2) % 3 === 1 ? "flowers" : "hedge", x: px(x) + HT, y: px(south + 1) + 10, seed: x * 7 + 3 });
  for (let x = bounds.x + 4; x < bounds.x + bounds.w; x += 10) props.push({ kind: "lamp", x: px(x), y: px(south + 3) + 6, seed: x });
  for (const row of [13, 17, 21, 25, 29, 33, 37]) {
    for (let x = bounds.x + 3; x < bounds.x + bounds.w - 2; x += 6 + Math.floor(rng() * 5)) {
      props.push({ kind: rng() < 0.2 ? "pine" : "tree", x: px(x) + Math.floor(rng() * 10), y: px(south + row) + Math.floor(rng() * 10), seed: Math.floor(rng() * 1e9) });
      if (rng() < 0.3) props.push({ kind: "bush", x: px(x + 3), y: px(south + row + 1), seed: Math.floor(rng() * 1e9) });
    }
  }

  // Dashed centre line of the street.
  const streetY = px(south + 4);
  const streetH = px(5);
  ctx.fillStyle = "rgba(240, 236, 220, 0.75)";
  for (let x = px(bounds.x); x < px(bounds.x + bounds.w); x += 16) ctx.fillRect(ox + x, oy + streetY + Math.round(streetH / 2) - 1, 8, 2);

  props.sort((a, b) => a.y - b.y);
  for (const p of props) {
    const s = propSprite(p);
    ctx.drawImage(s.canvas, Math.round(ox + p.x - s.ax), Math.round(oy + p.y - s.ay));
  }
  return {
    lanes: [
      { y: streetY + Math.round(streetH * 0.36), dir: 1 },
      { y: streetY + Math.round(streetH * 0.86), dir: -1 },
    ],
    x0: px(bounds.x),
    x1: px(bounds.x + bounds.w),
  };
}

/** A car sprite (canvas plus its anchor) for a lane direction. */
export const car = (variant: number, dir: 1 | -1) => carSprite(variant, dir < 0);
