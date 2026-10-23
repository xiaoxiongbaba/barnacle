import Phaser from "phaser";
import { characterTexture } from "./characters";
import { hasKey, t } from "./i18n";
import { hueFor, type Area, type Layout, type Occupant, type Prop, type State } from "./types";

const FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";
const WALK_SPEED = 120; // px per second
const WORKING: ReadonlySet<State> = new Set(["writing", "researching", "executing", "syncing", "waiting", "error"]);

/** HSL (h in degrees, s/l in 0..1) to a 0xRRGGBB integer. */
function hsl(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** Deterministic pseudo-random numbers, so procedural furniture looks the same on every load. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

interface Character {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  bubble: Phaser.GameObjects.Text;
  bob?: Phaser.Tweens.Tween;
  walk?: Phaser.Tweens.Tween;
  occupant: Occupant;
  /** Bubble length; shorter when the area is crowded (the side panel keeps the full text). */
  maxChars: number;
}

export class OfficeScene extends Phaser.Scene {
  private layout!: Layout;
  private characters = new Map<string, Character>();
  private leds: Phaser.GameObjects.Rectangle[] = [];
  private props: { def: Prop; sprite: Phaser.GameObjects.Sprite; anim?: string }[] = [];
  private areaLabels: { key: string; area: Area; text: Phaser.GameObjects.Text }[] = [];
  /** Text scales with the room, so labels stay readable when a large background is shrunk to fit. */
  private textScale = 1;
  private px = (n: number) => `${Math.round(n * this.textScale)}px`;

  constructor() {
    super("office");
  }

  private onReady: () => void = () => {};

  init(data: { layout: Layout; onReady: () => void }) {
    this.layout = data.layout;
    this.onReady = data.onReady;
    this.textScale = Math.max(1, data.layout.width / 960);
  }

  /** Loads the active pack's background, skins and props, if it has any. */
  preload() {
    const base = this.layout.assetBase ?? "/pack/";
    if (this.layout.background) this.load.image("bg", base + this.layout.background);
    for (const skin of this.layout.skins ?? []) {
      this.load.spritesheet(`skin-${skin.id}`, base + skin.image, { frameWidth: skin.frameWidth, frameHeight: skin.frameHeight });
    }
    for (const prop of this.layout.props ?? []) {
      const key = `prop-${prop.id}`;
      if (prop.frameWidth && prop.frameHeight) {
        this.load.spritesheet(key, base + prop.image, { frameWidth: prop.frameWidth, frameHeight: prop.frameHeight });
      } else {
        this.load.image(key, base + prop.image);
      }
    }
  }

  create() {
    if (this.layout.background) {
      this.add.image(0, 0, "bg").setOrigin(0, 0).setDepth(-1000);
    } else {
      this.drawRoom();
      for (const [key, area] of Object.entries(this.layout.areas)) this.drawArea(key, area);
    }
    this.createSkinAnimations();
    this.createProps();
    this.time.addEvent({
      delay: 400,
      loop: true,
      callback: () => {
        for (const led of this.leds) led.setVisible(Math.random() > 0.3);
      },
    });
    // Browsers pause animation in background tabs; snap everyone into place when the page is shown again.
    const onVisible = () => {
      if (document.visibilityState === "visible") this.placeAll(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    this.events.once("shutdown", () => document.removeEventListener("visibilitychange", onVisible));
    this.onReady();
  }

  // ---------------------------------------------------------------- occupants

  setOccupants(occupants: Occupant[]) {
    const ids = new Set(occupants.map((o) => o.id));
    for (const id of this.characters.keys()) if (!ids.has(id)) this.remove(id);
    for (const o of occupants) this.upsert(o, false);
    this.placeAll(false);
    this.updateProps();
  }

  upsert(occupant: Occupant, animate = true) {
    let ch = this.characters.get(occupant.id);
    if (!ch) {
      ch = this.spawn(occupant);
      this.characters.set(occupant.id, ch);
    }
    ch.occupant = occupant;
    this.updateBubble(ch);
    if (animate) {
      this.placeAll(true);
      this.updateProps();
    }
  }

  remove(id: string) {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.container.destroy();
    this.characters.delete(id);
    this.placeAll(true);
    this.updateProps();
  }

  private spawn(o: Occupant): Character {
    const door = this.layout.areas[this.layout.stateAreas.offline] ?? Object.values(this.layout.areas)[0];
    const sprite = this.characterSprite(o);
    const name = this.add
      .text(0, 4, o.name, { fontFamily: FONT, fontSize: this.px(11), color: "#ffffff", resolution: 2 })
      .setOrigin(0.5, 0)
      .setShadow(1, 1, "#000000", 0, false, true);
    const bubble = this.add
      .text(0, -40, "", {
        fontFamily: FONT,
        fontSize: this.px(10),
        color: "#1d1d27",
        backgroundColor: "#fdfbf3",
        padding: { x: 4 * this.textScale, y: 2 * this.textScale },
        resolution: 2,
      })
      .setOrigin(0.5, 1);
    const container = this.add.container(door.x + door.w / 2, door.y + door.h - 16, [sprite, name, bubble]);
    return { container, sprite, bubble, occupant: o, maxChars: 26 };
  }

  private updateBubble(ch: Character) {
    const { state, detail } = ch.occupant;
    const text = detail || t(`state.${state}`);
    ch.bubble.setText(text.length > ch.maxChars ? `${text.slice(0, ch.maxChars - 1)}…` : text);
    ch.bubble.setVisible(state !== "offline");
    ch.bubble.setBackgroundColor(state === "error" ? "#ffd6d6" : "#fdfbf3");
    ch.container.setAlpha(state === "offline" ? 0.4 : 1);
  }

  /** Gives every occupant a slot in the area its state maps to, then walks them there. */
  private placeAll(animate: boolean) {
    const byArea = new Map<string, Character[]>();
    for (const ch of [...this.characters.values()].sort((a, b) => a.occupant.id.localeCompare(b.occupant.id))) {
      const key = this.layout.stateAreas[ch.occupant.state] ?? "lounge";
      byArea.set(key, [...(byArea.get(key) ?? []), ch]);
    }
    for (const [key, list] of byArea) {
      const area = this.layout.areas[key];
      if (!area) continue;
      const slots = this.slots(area);
      list.forEach((ch, i) => {
        const slot = slots[i % slots.length];
        // Neighbours alternate bubble heights so their text never overlaps.
        const top = -(ch.sprite.displayHeight + 8 * this.textScale);
        ch.bubble.setY(top - (i % 2) * 16 * this.textScale);
        ch.maxChars = list.length >= 3 ? 16 : 26;
        this.updateBubble(ch);
        this.moveTo(ch, slot.x, slot.y, animate);
      });
    }
  }

  private slots(area: Area): { x: number; y: number }[] {
    const gapX = 72 * this.textScale;
    const gapY = 48 * this.textScale;
    const cols = Math.max(1, Math.floor((area.w - 48) / gapX) + 1);
    const rows = Math.max(1, Math.floor((area.h - 104) / gapY) + 1);
    const out: { x: number; y: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push({ x: area.x + 40 + c * gapX + (r % 2) * (gapX / 2), y: area.y + area.h - 20 - r * gapY });
      }
    }
    return out;
  }

  private moveTo(ch: Character, x: number, y: number, animate: boolean) {
    const { container, sprite } = ch;
    ch.walk?.stop();
    ch.bob?.stop();
    sprite.setY(0).setAngle(0).setScale(sprite.getData("baseScale") ?? 1);
    const dist = Phaser.Math.Distance.Between(container.x, container.y, x, y);
    const done = () => {
      container.setDepth(container.y);
      this.startIdleMotion(ch);
    };
    if (!animate || dist < 2) {
      container.setPosition(x, y);
      done();
      return;
    }
    sprite.setFlipX(x < container.x);
    const hop = this.tweens.add({ targets: sprite, y: -3, duration: 120, yoyo: true, repeat: -1 });
    ch.walk = this.tweens.add({
      targets: container,
      x,
      y,
      duration: (dist / (WALK_SPEED * this.textScale)) * 1000,
      onUpdate: () => container.setDepth(container.y),
      onComplete: () => {
        hop.stop();
        sprite.setY(0);
        done();
      },
    });
  }

  /** Small loops that say what someone is doing: typing bob, slow breathing, error wobble. */
  private startIdleMotion(ch: Character) {
    const state = ch.occupant.state;
    if (state === "error") {
      ch.bob = this.tweens.add({ targets: ch.sprite, angle: { from: -6, to: 6 }, duration: 160, yoyo: true, repeat: -1 });
    } else if (WORKING.has(state)) {
      ch.bob = this.tweens.add({ targets: ch.sprite, y: -2, duration: state === "researching" ? 600 : 180, yoyo: true, repeat: -1 });
    } else if (state === "idle") {
      if (ch.sprite.anims.isPlaying) return; // skins already animate while idle
      const base = (ch.sprite.getData("baseScale") as number | undefined) ?? 1;
      ch.bob = this.tweens.add({ targets: ch.sprite, scaleY: base * 0.96, duration: 1400, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
  }

  /** Uses a pack skin when the pack has skins (picked by id, so it stays stable), otherwise a procedural character. */
  private characterSprite(o: Occupant): Phaser.GameObjects.Sprite {
    const skins = this.layout.skins ?? [];
    if (skins.length === 0) return this.add.sprite(0, 0, this.characterTexture(o)).setOrigin(0.5, 1);
    const skin = skins[hueFor(o.id) % skins.length];
    const scale = skin.scale ?? 1;
    const sprite = this.add.sprite(0, 0, `skin-${skin.id}`, skin.frames[0]).setOrigin(0.5, 1).setScale(scale);
    sprite.setData("baseScale", scale);
    sprite.play(`skin-${skin.id}-loop`);
    return sprite;
  }

  private createSkinAnimations() {
    for (const skin of this.layout.skins ?? []) {
      this.anims.create({
        key: `skin-${skin.id}-loop`,
        frames: this.anims.generateFrameNumbers(`skin-${skin.id}`, { frames: skin.frames }),
        frameRate: skin.fps,
        repeat: -1,
      });
    }
  }

  private createProps() {
    for (const def of this.layout.props ?? []) {
      const key = `prop-${def.id}`;
      const [ox, oy] = def.origin ?? [0.5, 0.5];
      const sprite = this.add.sprite(def.x, def.y, key, def.frame ?? 0).setOrigin(ox, oy).setScale(def.scale ?? 1);
      sprite.setDepth(def.depth ?? def.y + sprite.displayHeight * (1 - oy));
      let anim: string | undefined;
      if (def.frameWidth && def.behaviour !== "static") {
        anim = `${key}-anim`;
        this.anims.create({
          key: anim,
          frames: def.frames ? this.anims.generateFrameNumbers(key, { frames: def.frames }) : this.anims.generateFrameNumbers(key),
          frameRate: def.fps ?? 12,
          repeat: -1,
        });
      }
      this.props.push({ def, sprite, anim });
    }
    this.updateProps();
  }

  /** Re-evaluates every prop's condition against who is in which state. */
  private updateProps() {
    const states = new Set([...this.characters.values()].map((c) => c.occupant.state));
    for (const { def, sprite, anim } of this.props) {
      const active = def.when ? def.when.anyOccupantIn.some((s) => states.has(s)) : true;
      const behaviour = def.behaviour ?? (def.when ? "play" : "always");
      if (behaviour === "show") sprite.setVisible(active);
      const shouldPlay = !!anim && (behaviour === "always" || active);
      if (shouldPlay && !sprite.anims.isPlaying) sprite.play(anim!);
      if (!shouldPlay && sprite.anims.isPlaying) sprite.stop().setFrame(def.frame ?? 0);
    }
  }

  private characterTexture(o: Occupant): string {
    return characterTexture(this, o);
  }

  // ---------------------------------------------------------------- room

  private drawRoom() {
    const { width, height, tile } = this.layout;
    const g = this.add.graphics();
    for (let y = 64; y < height; y += tile) {
      for (let x = 0; x < width; x += tile) {
        g.fillStyle(((x + y) / tile) % 2 === 0 ? 0x8a6a4b : 0x816245, 1);
        g.fillRect(x, y, tile, tile);
        g.fillStyle(0x6f533a, 1);
        g.fillRect(x, y + tile - 2, tile, 2);
      }
    }
    g.fillStyle(0x3b3850, 1);
    g.fillRect(0, 0, width, 64);
    g.fillStyle(0x2c2a3d, 1);
    g.fillRect(0, 56, width, 8);
    for (let x = 64; x < width - 64; x += 160) {
      g.fillStyle(0x24324a, 1);
      g.fillRect(x, 12, 72, 36);
      g.fillStyle(0x8fc6ff, 0.55);
      g.fillRect(x + 4, 16, 30, 28);
      g.fillRect(x + 38, 16, 30, 28);
    }
  }

  /** Re-translates everything drawn on the canvas. */
  refreshLanguage() {
    for (const { key, area, text } of this.areaLabels) text.setText(this.areaLabel(key, area));
    for (const ch of this.characters.values()) this.updateBubble(ch);
  }

  private areaLabel(key: string, area: Area) {
    return (hasKey(`area.${key}`) ? t(`area.${key}`) : area.label).toUpperCase();
  }

  private drawArea(key: string, a: Area) {
    const g = this.add.graphics();
    const rugs: Record<string, number> = {
      lounge: 0x5d7fa3, desks: 0x4f5866, library: 0x6b5a7e, servers: 0x283040, bug: 0x7a3b3b, door: 0x5b4636,
    };
    g.fillStyle(rugs[a.theme] ?? 0x555555, 0.85);
    g.fillRoundedRect(a.x, a.y, a.w, a.h, 6);
    g.lineStyle(2, 0x000000, 0.18);
    g.strokeRoundedRect(a.x, a.y, a.w, a.h, 6);
    const label = this.add
      .text(a.x + 8, a.y + 6, this.areaLabel(key, a), { fontFamily: FONT, fontSize: this.px(10), color: "#ffffff", resolution: 2 })
      .setAlpha(0.75);
    this.areaLabels.push({ key, area: a, text: label });
    const draw: Record<string, (g: Phaser.GameObjects.Graphics, a: Area) => void> = {
      lounge: (g, a) => this.drawLounge(g, a),
      desks: (g, a) => this.drawDesks(g, a),
      library: (g, a) => this.drawLibrary(g, a),
      servers: (g, a) => this.drawServers(g, a),
      bug: (g, a) => this.drawBug(g, a),
      door: (g, a) => this.drawDoor(g, a),
    };
    draw[a.theme]?.(g, a);
  }

  private drawLounge(g: Phaser.GameObjects.Graphics, a: Area) {
    const sofa = (x: number, y: number, w: number) => {
      g.fillStyle(0x9c4a42, 1).fillRect(x, y, w, 14);
      g.fillStyle(0xb5574d, 1).fillRect(x, y + 14, w, 14);
      g.fillStyle(0x7f3a34, 1).fillRect(x - 6, y + 6, 6, 22).fillRect(x + w, y + 6, 6, 22);
    };
    sofa(a.x + 30, a.y + 30, 96);
    sofa(a.x + 160, a.y + 30, 96);
    g.fillStyle(0x5a3d2b, 1).fillRect(a.x + 100, a.y + 80, 88, 26);
    g.fillStyle(0xf3efe2, 1).fillRect(a.x + 118, a.y + 86, 8, 8);
    g.fillStyle(0x7b5a3c, 1).fillRect(a.x + a.w - 34, a.y + 92, 16, 14);
    g.fillStyle(0x4f9a5a, 1).fillCircle(a.x + a.w - 26, a.y + 84, 12);
    g.fillStyle(0x6cbf73, 1).fillCircle(a.x + a.w - 30, a.y + 80, 6);
  }

  private drawDesks(g: Phaser.GameObjects.Graphics, a: Area) {
    for (let i = 0; i < 4; i++) {
      const x = a.x + 22 + i * 74;
      const y = a.y + 40;
      g.fillStyle(0x2a2c36, 1).fillRect(x + 18, y - 18, 30, 20);
      g.fillStyle(0x6fd3ff, 0.9).fillRect(x + 21, y - 15, 24, 13);
      g.fillStyle(0x9c7650, 1).fillRect(x, y + 2, 66, 22);
      g.fillStyle(0x7d5c3d, 1).fillRect(x, y + 20, 66, 4);
      g.fillStyle(0x3a3f4b, 1).fillRect(x + 24, y + 30, 18, 16);
    }
  }

  private drawLibrary(g: Phaser.GameObjects.Graphics, a: Area) {
    const rand = seeded(7);
    for (let s = 0; s < 2; s++) {
      const x = a.x + 16 + s * 100;
      const y = a.y + 26;
      g.fillStyle(0x6b4a2f, 1).fillRect(x, y, 88, 70);
      for (let row = 0; row < 3; row++) {
        let bx = x + 4;
        while (bx < x + 82) {
          const w = 4 + Math.floor(rand() * 5);
          g.fillStyle(hsl(Math.floor(rand() * 360), 0.45, 0.5), 1).fillRect(bx, y + 4 + row * 22, w, 18);
          bx += w + 1;
        }
        g.fillStyle(0x4f3622, 1).fillRect(x, y + 22 + row * 22, 88, 3);
      }
    }
  }

  private drawServers(g: Phaser.GameObjects.Graphics, a: Area) {
    for (let i = 0; i < 5; i++) {
      const x = a.x + 22 + i * 58;
      const y = a.y + 26;
      g.fillStyle(0x1b202b, 1).fillRect(x, y, 40, 72);
      g.lineStyle(1, 0x3a4357, 1).strokeRect(x, y, 40, 72);
      for (let u = 0; u < 6; u++) {
        g.fillStyle(0x2a3142, 1).fillRect(x + 4, y + 5 + u * 11, 32, 8);
        const led = this.add.rectangle(x + 31, y + 9 + u * 11, 3, 3, u % 3 === 0 ? 0xffb347 : 0x5dff8f);
        this.leds.push(led);
      }
    }
  }

  private drawBug(g: Phaser.GameObjects.Graphics, a: Area) {
    const cx = a.x + a.w - 56;
    const cy = a.y + 62;
    g.lineStyle(3, 0x2b1414, 1);
    for (const dy of [-10, 0, 10]) {
      g.lineBetween(cx - 26, cy + dy - 4, cx + 26, cy + dy + 4);
    }
    g.fillStyle(0x2b1414, 1).fillEllipse(cx, cy, 34, 44);
    g.fillStyle(0xd94b4b, 1).fillEllipse(cx, cy + 4, 28, 34);
    g.fillStyle(0xffffff, 1).fillCircle(cx - 6, cy - 14, 3).fillCircle(cx + 6, cy - 14, 3);
    g.fillStyle(0xffd23f, 1).fillTriangle(a.x + 40, a.y + 30, a.x + 60, a.y + 66, a.x + 20, a.y + 66);
    g.fillStyle(0x2b1414, 1).fillRect(a.x + 38, a.y + 42, 4, 14).fillRect(a.x + 38, a.y + 59, 4, 4);
  }

  private drawDoor(g: Phaser.GameObjects.Graphics, a: Area) {
    const x = a.x + a.w / 2 - 22;
    g.fillStyle(0x4a3322, 1).fillRect(x - 4, a.y + 22, 52, 74);
    g.fillStyle(0x7b5636, 1).fillRect(x, a.y + 26, 44, 70);
    g.fillStyle(0xe2c15b, 1).fillCircle(x + 36, a.y + 62, 3);
    g.fillStyle(0x8f3d3d, 1).fillRect(x - 6, a.y + 104, 56, 14);
  }
}
