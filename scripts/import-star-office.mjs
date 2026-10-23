#!/usr/bin/env node
// Builds a LOCAL-ONLY development pack from a Star Office UI checkout.
//
//   git clone https://github.com/ringhyacinth/Star-Office-UI /tmp/star-office
//   node scripts/import-star-office.mjs /tmp/star-office
//   PACK_DIR=packs/local/star-office npm start
//
// Star Office's art is licensed for non-commercial learning and demonstration only, and its guest
// characters are LimeZu assets under LimeZu's own terms. This script therefore writes into
// packs/local/, which is git-ignored and excluded from Docker images. Never commit, publish or deploy
// this pack; replace it with original art before any release.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source || !existsSync(path.join(source, "frontend", "office_bg.webp"))) {
  console.error("Usage: node scripts/import-star-office.mjs <path to a Star-Office-UI checkout>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "packs", "local", "star-office");
mkdirSync(out, { recursive: true });

const files = [
  "office_bg.webp",
  "sofa-idle-v3.png",
  "desk-v3.webp",
  "coffee-machine-v3-grid.webp",
  "serverroom-spritesheet.webp",
  "error-bug-spritesheet-grid.webp",
  "sync-animation-v3-grid.webp",
  "plants-spritesheet.webp",
  "posters-spritesheet.webp",
  "cats-spritesheet.webp",
  ...[1, 2, 3, 4, 5, 6].map((i) => `guest_anim_${i}.webp`),
];
for (const f of files) copyFileSync(path.join(source, "frontend", f), path.join(out, f));

const layout = {
  room: "star-office",
  tile: 32,
  width: 1280,
  height: 720,
  background: "office_bg.webp",
  areas: {
    library: { label: "Library", theme: "library", x: 500, y: 236, w: 160, h: 112 },
    desks: { label: "Desks", theme: "desks", x: 160, y: 470, w: 260, h: 140 },
    lounge: { label: "Lounge", theme: "lounge", x: 600, y: 450, w: 280, h: 140 },
    bug: { label: "Bug corner", theme: "bug", x: 930, y: 236, w: 330, h: 110 },
    servers: { label: "Server room", theme: "servers", x: 930, y: 570, w: 300, h: 130 },
    door: { label: "Door", theme: "door", x: 20, y: 610, w: 200, h: 104 },
  },
  stateAreas: {
    idle: "lounge",
    writing: "desks",
    researching: "library",
    executing: "servers",
    syncing: "servers",
    error: "bug",
    offline: "door",
  },
  skins: [1, 2, 3, 4, 5, 6].map((i) => ({
    id: `guest${i}`,
    image: `guest_anim_${i}.webp`,
    frameWidth: 32,
    frameHeight: 32,
    frames: [0, 1, 2, 3, 4, 5, 6, 7],
    fps: 8,
    scale: 3,
  })),
  props: [
    { id: "sofa", image: "sofa-idle-v3.png", x: 670, y: 144, origin: [0, 0], depth: 10 },
    { id: "desk", image: "desk-v3.webp", x: 218, y: 417 },
    { id: "poster", image: "posters-spritesheet.webp", frameWidth: 160, frameHeight: 160, x: 252, y: 66, frame: 0, behaviour: "static", depth: 4 },
    { id: "plant-1", image: "plants-spritesheet.webp", frameWidth: 160, frameHeight: 160, x: 565, y: 178, frame: 1, behaviour: "static", depth: 5 },
    { id: "plant-2", image: "plants-spritesheet.webp", frameWidth: 160, frameHeight: 160, x: 230, y: 185, frame: 6, behaviour: "static", depth: 5 },
    { id: "plant-3", image: "plants-spritesheet.webp", frameWidth: 160, frameHeight: 160, x: 977, y: 496, frame: 11, behaviour: "static", depth: 5 },
    { id: "cat", image: "cats-spritesheet.webp", frameWidth: 160, frameHeight: 160, x: 94, y: 557, frame: 0, behaviour: "static", depth: 2000 },
    {
      id: "coffee-machine", image: "coffee-machine-v3-grid.webp", frameWidth: 230, frameHeight: 230,
      x: 659, y: 397, fps: 12.5, depth: 99, when: { anyOccupantIn: ["idle"] },
    },
    {
      id: "server-rack", image: "serverroom-spritesheet.webp", frameWidth: 180, frameHeight: 251,
      x: 1021, y: 142, fps: 6, depth: 2, when: { anyOccupantIn: ["executing", "syncing"] },
    },
    {
      id: "error-bug", image: "error-bug-spritesheet-grid.webp", frameWidth: 180, frameHeight: 180,
      x: 1080, y: 221, scale: 0.9, fps: 12, depth: 50, behaviour: "show", when: { anyOccupantIn: ["error"] },
    },
    {
      id: "sync", image: "sync-animation-v3-grid.webp", frameWidth: 256, frameHeight: 256,
      x: 1157, y: 592, frames: Array.from({ length: 52 }, (_, i) => i + 1), fps: 12, depth: 40,
      behaviour: "show", when: { anyOccupantIn: ["syncing"] },
    },
  ],
};

writeFileSync(path.join(out, "layout.json"), `${JSON.stringify(layout, null, 2)}\n`);
writeFileSync(
  path.join(out, "NOTICE.md"),
  `# Local development pack — do not distribute

Art in this folder comes from Star Office UI (https://github.com/ringhyacinth/Star-Office-UI),
licensed for non-commercial learning and demonstration only. Guest characters are LimeZu's
"Animated Mini Characters 2 (Platformer) [FREE]" (https://limezu.itch.io/animated-mini-characters-2-platform-free)
under LimeZu's terms.

This folder is git-ignored and excluded from Docker images. Do not commit, publish or deploy it.
Replace it with original art before any release.
`,
);
console.log(`Wrote ${files.length} files and layout.json to ${path.relative(root, out)}`);
console.log("Start with: PACK_DIR=packs/local/star-office npm start");
