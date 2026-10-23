# Barnacle mod pack spec — draft v0.1

> Status: **draft for discussion**. Items marked **[decide]** are open.

Mod packs decorate a Barnacle. We ship the shared spaces and a base pack;
everything else in an office comes from packs that anyone can make, share and,
later, sell. This spec exists so packs from different artists look like they
belong in the same building.

## 1. Art baseline (the most important rule)

| Rule          | Value                                                         |
| ------------- | ------------------------------------------------------------- |
| Tile size     | 32 × 32 px **[decide: 16 or 32]**                             |
| Perspective   | Top-down 3/4 (RPG-style: you see the top and front of objects) **[decide]** |
| Scale         | Art is drawn at 1×; the renderer scales by integers only      |
| Light source  | Top-left                                                      |
| Outline       | 1 px dark outline on characters and furniture **[decide]**    |
| Palette       | Free, but the base pack's palette is recommended              |
| Formats       | PNG or lossless WebP, with transparency                       |

## 2. Pack levels

| Level | Contains                                   | Status          |
| ----- | ------------------------------------------ | --------------- |
| 1     | Images + JSON (static objects, skins)      | v0.1            |
| 2     | Declarative behaviour: animations bound to states | v0.1        |
| 3     | Scripts                                    | **Not allowed.** Packs run in visitors' browsers. |

## 3. Layout of a pack

```
my-pack/
  manifest.json
  preview.png          # 320 × 180, shown in the pack picker
  objects/
    sofa.png
    coffee-machine.png # sprite sheet
  skins/
    robot.png          # character sprite sheet
```

Limits: ≤ 4 MB per pack, ≤ 256 files, each image ≤ 2048 × 2048.

## 4. `manifest.json`

```json
{
  "spec": "0.1",
  "id": "cozy-cafe",
  "name": "Cozy Café",
  "version": "1.0.0",
  "author": "pixel-artist@example.com",
  "license": "CC-BY-4.0",
  "rooms": ["standard"],
  "objects": [
    {
      "id": "coffee-machine",
      "image": "objects/coffee-machine.png",
      "frame": { "width": 32, "height": 48 },
      "footprint": { "cols": 1, "rows": 1 },
      "anchor": { "x": 0.5, "y": 1 },
      "walkable": false,
      "animations": {
        "idle":  { "frames": [0], "fps": 1 },
        "brew":  { "frames": [1, 2, 3, 2], "fps": 6, "loop": true }
      },
      "bindings": [
        { "when": { "anyOccupantIn": ["syncing"] }, "play": "brew" }
      ]
    },
    {
      "id": "armchair",
      "image": "objects/armchair.png",
      "frame": { "width": 32, "height": 32 },
      "footprint": { "cols": 1, "rows": 1 },
      "anchor": { "x": 0.5, "y": 1 },
      "walkable": false,
      "seat": { "x": 0, "y": -6, "forStates": ["idle"] }
    }
  ],
  "skins": [
    {
      "id": "robot",
      "image": "skins/robot.png",
      "frame": { "width": 32, "height": 32 },
      "animations": {
        "walk":        { "frames": [0, 1, 2, 3], "fps": 8, "loop": true },
        "idle":        { "frames": [4, 5], "fps": 2, "loop": true },
        "writing":     { "frames": [6, 7], "fps": 6, "loop": true },
        "researching": { "frames": [8, 9], "fps": 3, "loop": true },
        "executing":   { "frames": [6, 7], "fps": 10, "loop": true },
        "error":       { "frames": [10, 11], "fps": 4, "loop": true }
      }
    }
  ]
}
```

### Required fields

`spec`, `id` (`^[a-z0-9-]{3,40}$`), `name`, `version` (semver), `author`,
`license` (an SPDX id or `LicenseRef-…` with a `LICENSE` file in the pack).

### Objects

| Field        | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `frame`      | Size of one frame in px; sheets are read left to right, top to bottom |
| `footprint`  | Tiles the object occupies on the floor                         |
| `anchor`     | Point that sits on the footprint's bottom-centre (0–1)         |
| `walkable`   | Whether characters can walk over it                            |
| `seat`       | Optional: where a character sits, and in which states          |
| `animations` | Named frame lists with `fps` and `loop`                        |
| `bindings`   | Which animation to play when a condition on occupants holds    |

Binding conditions in v0.1: `anyOccupantIn: [states]`, `noOccupantIn: [states]`,
`occupantCountAtLeast: n`. Bindings are evaluated in order; the first match wins;
otherwise the `idle` animation plays.

### Skins

A skin must provide `walk` and `idle`. Missing state animations fall back to `idle`.

## 5. Rooms

| Template   | Size (tiles) |
| ---------- | ------------ |
| `desk`     | 10 × 6       |
| `standard` | 30 × 17      |
| `large`    | 40 × 24      |

The layout (where objects are placed, which area each state maps to) is saved
by the office, not by the pack. A pack only says what exists and how it moves.

## 6. Publishing to Whale (later)

When a Barnacle attaches to Whale, it uploads a snapshot of the packs it uses.
Files are addressed by SHA-256, so a popular pack is stored once. Uploaded packs
are scanned for prohibited content and must carry a license. Visitors never load
images from anyone's own server.

## 7. Tooling (planned)

- `barnacle pack validate <dir>` — checks the manifest, sizes, frame counts and limits
- `barnacle pack preview <dir>` — opens the office with the pack loaded
- A template pack and an Aseprite export guide
