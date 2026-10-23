#!/usr/bin/env node
// Builds a LOCAL-ONLY floor art pack from LimeZu's "Modern Interiors" and "Modern Office Revamped".
//
//   node scripts/import-limezu.mjs <folder with the unzipped packs>
//
// The folder must contain:
//   interiors/1_Interiors/32x32/...            (from moderninteriors-win.zip)
//   interiors/2_Characters/Character_Generator/0_Premade_Characters/32x32/...
//   office/2_Modern_Office_Black_Shadow/..., office/1_Room_Builder_Office/...   (from Modern_Office_Revamped_v1.2.zip)
//
// LimeZu's license allows use in commercial and non-commercial projects with credit, but forbids
// redistributing the files. This script therefore writes into packs/local/, which is git-ignored and
// excluded from Docker images. Each person who self-hosts must buy their own copy.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
const need = (p) => {
  const full = path.join(src ?? "", p);
  if (!src || !existsSync(full)) {
    console.error(`Missing ${p}\nUsage: node scripts/import-limezu.mjs <folder with interiors/ and office/>`);
    process.exit(1);
  }
  return full;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "packs", "local", "limezu");
mkdirSync(path.join(out, "characters"), { recursive: true });

// The "Black Shadow" variant has the same layout with soft drop shadows baked in, which grounds the furniture.
copyFileSync(need("office/2_Modern_Office_Black_Shadow/Modern_Office_Black_Shadow_32x32.png"), path.join(out, "office.png"));
copyFileSync(need("office/1_Room_Builder_Office/Room_Builder_Office_32x32.png"), path.join(out, "builder.png"));
copyFileSync(need("interiors/1_Interiors/32x32/Room_Bulder_subfiles_32x32/Room_Builder_Floors_32x32.png"), path.join(out, "floors.png"));
// A few whole objects from Modern Interiors' theme singles (kitchen and living room).
const SINGLES = {
  fridge: "Theme_Sorter_Singles_32x32/12_Kitchen_Singles_32x32/Kitchen_Singles_32x32_158.png",
  counter: "Theme_Sorter_Singles_32x32/12_Kitchen_Singles_32x32/Kitchen_Singles_32x32_121.png",
  sink: "Theme_Sorter_Singles_32x32/12_Kitchen_Singles_32x32/Kitchen_Singles_32x32_141.png",
  stove: "Theme_Sorter_Singles_32x32/12_Kitchen_Singles_32x32/Kitchen_Singles_32x32_148.png",
  microwave: "Theme_Sorter_Singles_32x32/12_Kitchen_Singles_32x32/Kitchen_Singles_32x32_187.png",
  rug: "Theme_Sorter_Singles_32x32/2_Living_Room_Singles_32x32/Living_Room_Singles_32x32_4.png",
  floorLamp: "Theme_Sorter_Singles_32x32/2_Living_Room_Singles_32x32/Living_Room_Singles_32x32_87.png",
};
mkdirSync(path.join(out, "singles"), { recursive: true });
for (const [name, file] of Object.entries(SINGLES)) copyFileSync(need(`interiors/1_Interiors/32x32/${file}`), path.join(out, "singles", `${name}.png`));

const characters = [];
for (let i = 1; i <= 20; i++) {
  const name = `Premade_Character_32x32_${String(i).padStart(2, "0")}.png`;
  const file = path.join(src, "interiors/2_Characters/Character_Generator/0_Premade_Characters/32x32", name);
  if (!existsSync(file)) continue;
  copyFileSync(file, path.join(out, "characters", `${String(i).padStart(2, "0")}.png`));
  characters.push(`characters/${String(i).padStart(2, "0")}.png`);
}

const f = (sheet, x, y, w = 32, h = 32) => ({ sheet, x, y, w, h });
/** Floors come as 3×2 swatches whose tiles only line up when laid in place, so keep the whole block. */
const swatch = (sheet, x, y) => ({ cols: 3, tiles: [0, 1].flatMap((r) => [0, 1, 2].map((c) => f(sheet, x + c * 32, y + r * 32))) });

/**
 * Coordinates were read off the 32×32 sheets. Furniture frames are anchored at their bottom-left on the
 * footprint's bottom-left tile; anything taller than the footprint (monitors, plants, cabinets) rises above it.
 */
const atlas = {
  name: "LimeZu Modern Office",
  credit: { text: "Art: Modern Interiors & Modern Office by LimeZu", url: "https://limezu.itch.io/" },
  tile: 32,
  sheets: {
    office: "office.png",
    builder: "builder.png",
    floors: "floors.png",
    ...Object.fromEntries(Object.keys(SINGLES).map((name) => [name, `singles/${name}.png`])),
  },
  floors: {
    hall: swatch("floors", 0, 1152),
    officeTile: swatch("builder", 320, 160),
    carpetDark: swatch("builder", 320, 288),
    woodPlank: swatch("floors", 0, 768),
    woodGold: swatch("floors", 0, 384),
    creamTile: swatch("floors", 128, 64),
    serverTile: swatch("floors", 256, 896),
    woodDiagonal: swatch("floors", 0, 960),
  },
  /** Wall faces: 32×64, a white cap on top of the wall; shown at the front of walls painted in the editor. */
  walls: {
    lavender: f("builder", 32, 160, 32, 64),
    stone: f("builder", 32, 224, 32, 64),
    brick: f("builder", 32, 288, 32, 64),
    plain: f("builder", 32, 352, 32, 64),
  },
  wallCap: { fill: "#f8f8f8", line: "#3a3a50" },
  /**
   * Tight boxes around each sprite (found by scanning the sheets for connected pixels). A sprite is drawn
   * bottom-centred on its item's footprint; see ITEMS in web/src/floor/model.ts for footprints.
   */
  furniture: {
    // Indexed like the item's variants in web/src/floor/model.ts (ITEMS); null where LimeZu has no such look.
    desk: [f("office", 228, 914, 82, 46), f("office", 36, 978, 82, 46), f("office", 324, 914, 82, 46)],
    deskBack: [f("office", 228, 978, 82, 46), f("office", 36, 978, 82, 46), f("office", 324, 914, 82, 46)],
    officeChair: [f("office", 0, 274, 32, 42), null, f("office", 0, 338, 32, 42), null, f("office", 32, 274, 32, 42)],
    officeChairFront: [f("office", 64, 270, 32, 46), null, f("office", 64, 334, 32, 46), null, f("office", 96, 270, 32, 46)],
    meetingTable: [f("office", 194, 18, 92, 78)],
    receptionDesk: [f("office", 354, 18, 92, 78)],
    bookshelf: [f("office", 226, 400, 60, 60)],
    binderShelf: [f("office", 226, 498, 60, 58)],
    printer: [f("office", 256, 706, 30, 36)],
    copier: [f("office", 320, 706, 30, 38)],
    rack: [f("office", 10, 746, 46, 68)],
    whiteboard: [f("office", 290, 334, 60, 46)],
    pc: [f("office", 352, 838, 52, 44)],
    laptop: [f("office", 452, 832, 48, 52)],
    lamp: [f("office", 352, 482, 30, 34)],
    phone: [f("office", 328, 300, 20, 20)],
    papers: [f("office", 40, 456, 24, 24)],
    counter: [f("counter", 4, 12, 58, 28), null],
    counterSink: [f("sink", 10, 2, 48, 28)],
    coffeeMachine: [f("office", 264, 1230, 52, 64)],
    stove: [f("stove", 0, 4, 32, 50)],
    fridge: [f("fridge", 0, 14, 32, 72)],
    vendingMachine: [f("office", 144, 768, 38, 46)],
    waterCooler: [f("office", 386, 496, 28, 60)],
    cafeTable: [f("office", 152, 576, 40, 48)],
    sofa: [f("office", 2, 552, 62, 48), null],
    armchair: [null, f("office", 0, 680, 32, 48), null, null],
    coffeeTable: [f("office", 200, 640, 50, 42)],
    beanbag: [f("office", 160, 492, 32, 36), f("office", 96, 492, 32, 36), f("office", 192, 492, 32, 36), f("office", 128, 492, 32, 36)],
    rug: [f("rug", 2, 2, 60, 62), null, null, null],
    plantSmall: [f("office", 192, 328, 32, 36), null, null],
    plantTall: [f("office", 196, 408, 24, 52), f("office", 192, 244, 32, 56), null, null],
    floorLamp: [f("floorLamp", 0, 14, 30, 68)],
    poster: [f("office", 482, 16, 28, 34), f("office", 482, 80, 28, 34), null, null, null, null],
    painting: [f("office", 8, 398, 48, 40)],
    sign: [f("office", 264, 278, 50, 28)],
    ac: [f("office", 358, 358, 52, 26)],
  },
  /** Premade characters: 32×64 frames; rows: 0 static, 1 idle, 2 walk; 6 frames per direction (right, up, left, down). */
  characters: { files: characters, frameWidth: 32, frameHeight: 64, idleRow: 1, walkRow: 2, framesPerDirection: 6 },
};

writeFileSync(path.join(out, "atlas.json"), `${JSON.stringify(atlas, null, 2)}\n`);
writeFileSync(
  path.join(out, "NOTICE.md"),
  `# Local art pack — do not distribute

Art in this folder comes from LimeZu's "Modern Interiors" and "Modern Office Revamped"
(https://limezu.itch.io/). The license allows use in commercial and non-commercial projects with
credit, and forbids reselling or redistributing the files.

This folder is git-ignored and excluded from Docker images. Do not commit, publish or share it.
`,
);
console.log(`Wrote ${3 + Object.keys(SINGLES).length + characters.length} images and atlas.json to ${path.relative(root, out)}`);
