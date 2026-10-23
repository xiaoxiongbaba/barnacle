import Phaser from "phaser";
import { hueFor, type Occupant } from "./types";

/** HSL (h in degrees, s/l in 0..1) to a 0xRRGGBB integer. */
export function hsl(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** A 12×16 pixel character drawn at 2× into a texture: humans get hair, agents get a visor and antenna. Returns the texture key. */
export function characterTexture(scene: Phaser.Scene, o: Pick<Occupant, "id" | "kind">): string {
  const hue = hueFor(o.id);
  const key = `occ-${o.kind}-${hue}`;
  if (scene.textures.exists(key)) return key;
  const g = scene.make.graphics({}, false);
  const P = 2;
  const px = (x: number, y: number, w: number, h: number, color: number) => {
    g.fillStyle(color, 1);
    g.fillRect(x * P, y * P, w * P, h * P);
  };
  const shirt = hsl(hue, 0.6, 0.55);
  const shirtDark = hsl(hue, 0.6, 0.38);
  if (o.kind === "human") {
    px(3, 0, 6, 2, hsl((hue + 30) % 360, 0.45, 0.28)); // hair
    px(2, 1, 1, 3, hsl((hue + 30) % 360, 0.45, 0.28));
    px(3, 2, 6, 4, 0xf1c27d); // face
    px(4, 3, 1, 1, 0x2b2b35);
    px(7, 3, 1, 1, 0x2b2b35);
  } else {
    px(5, 0, 2, 1, shirt); // antenna tip
    px(6, 1, 1, 1, 0x9aa4b2);
    px(3, 2, 6, 4, 0xc9d1d9); // head
    px(4, 3, 4, 2, shirtDark); // visor
    px(4, 3, 1, 1, 0xe8fbff);
  }
  px(2, 6, 8, 6, shirt); // body
  px(2, 6, 8, 1, shirtDark);
  px(1, 7, 1, 4, o.kind === "human" ? 0xf1c27d : 0x9aa4b2); // arms
  px(10, 7, 1, 4, o.kind === "human" ? 0xf1c27d : 0x9aa4b2);
  px(3, 12, 2, 3, 0x3b3b58); // legs
  px(7, 12, 2, 3, 0x3b3b58);
  px(3, 15, 2, 1, 0x1d1d27);
  px(7, 15, 2, 1, 0x1d1d27);
  g.generateTexture(key, 12 * P, 16 * P);
  g.destroy();
  return key;
}
