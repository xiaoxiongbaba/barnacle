import { language } from "../i18n";
import { mulberry32 } from "../vendor/habblaud/shared/hash";
import { characterSeed } from "./art-habblaud";
import type { Facing } from "./art";
import type { FloorScene, LifeAgent } from "./floor-scene";
import { cells, isWall, itemDef, knownItems, seatFacing, type Furniture, type Seat, type Tile } from "./model";

/**
 * Idle life, after Habblaud's (client/src/world/social and sim/sim.ts, MIT): people with nothing to do
 * take outings — coffee, water, a sofa, a book, the arcade, the mirror — or get together for ping-pong,
 * rock-paper-scissors, a chat or the TV. Everyone has a personality from their seed that tilts what they
 * pick. Given work, they say so and go back to their desk.
 */

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];
const key = (t: Tile) => `${t.x},${t.y}`;

class Interrupted extends Error {}

// ---------------------------------------------------------------- personalities

type Trait = "caffeine" | "games" | "sports" | "napper" | "gossip" | "jokes" | "competitive" | "vanity" | "reading" | "shy";
const TRAITS: Trait[] = ["caffeine", "games", "sports", "napper", "gossip", "jokes", "competitive", "vanity", "reading", "shy"];
const CLASH: [Trait, Trait][] = [
  ["shy", "jokes"],
  ["shy", "gossip"],
  ["sports", "napper"],
];

interface Persona {
  traits: Set<Trait>;
  /** 0..1: how often they get others together. */
  social: number;
  /** 0..1: how good they are at games. */
  skill: number;
}

function personaOf(id: string): Persona {
  const rng = mulberry32(characterSeed(id) ^ 0x50c1a1);
  const traits = new Set<Trait>();
  const count = rng() < 0.55 ? 2 : 3;
  for (let tries = 0; traits.size < count && tries < 40; tries++) {
    const t = TRAITS[Math.floor(rng() * TRAITS.length)];
    if (CLASH.some(([a, b]) => (a === t && traits.has(b)) || (b === t && traits.has(a)))) continue;
    traits.add(t);
  }
  const clamp = (n: number) => Math.max(0.05, Math.min(0.95, n));
  const has = (t: Trait) => traits.has(t);
  return {
    traits,
    social: clamp(0.45 + rng() * 0.3 - (has("shy") ? 0.3 : 0) + (has("gossip") ? 0.2 : 0) + (has("jokes") ? 0.12 : 0)),
    skill: clamp(0.3 + rng() * 0.4 + (has("games") ? 0.2 : 0) + (has("sports") ? 0.15 : 0) - (has("napper") ? 0.1 : 0)),
  };
}

// ---------------------------------------------------------------- lines

type Lang = "en" | "ja" | "zh-Hant";
type Lines = Record<string, string[]>;

/** What people say, in the page's language. {name}, {room}, {v}, {a} and {b} are filled in. */
const LINES: Record<Lang, Lines> = {
  "zh-Hant": {
    accept: ["走！", "好啊", "來了來了", "正好休息一下"],
    calledAway: ["我被叫走啦！🏃", "馬上回來！", "有活了，先走一步"],
    pingInvite: ["來打一局乒乓？🏓", "誰來接我的殺球？", "乒乓球，五分一局？"],
    pingPoint: ["好球！", "擦邊！", "看我這招", "接不到吧 😎"],
    win: ["{a} 比 {b}！🏆", "贏啦！🏆", "實力說話 😎"],
    lose: ["運氣好而已…", "再來！", "下次一定贏"],
    rpsInvite: ["猜拳，賭 🪙{v}？", "剪刀石頭布，輸的請咖啡？"],
    rpsCount: ["剪刀…", "石頭…", "布！"],
    rpsTie: ["想到一塊去了 😂", "再來！"],
    rpsWin: ["給錢給錢 🪙", "承讓了 😎"],
    talkInvite: ["聊兩句？", "休息一下吧", "來喝杯咖啡？☕"],
    work: ["{room} 那個 bug 好難搞", "需求又改了 😩", "週五上線？😈", "在我電腦上是好的！😂", "這週進度還行"],
    chat: ["午餐吃什麼？", "週末有什麼安排？", "這咖啡真不錯 ☕", "最近在追什麼劇？", "好想放假 🏖️"],
    joke: ["為什麼程式設計師分不清萬聖節和聖誕節？因為 Oct 31 = Dec 25 😂", "我的程式沒有 bug，只有隨機功能 😂"],
    gossip: ["聽說 {name} 又在加班 👀", "你們知道 {name} 最近在忙什麼嗎？👀"],
    react: ["真的假的？！", "哈哈哈哈", "確實", "笑死 😂", "有道理"],
    tvInvite: ["一起看球？⚽", "追劇走起 📺", "電視要開始了！"],
    tvGoal: ["進球啦！⚽", "好球！！"],
    tvSulk: ["唉…", "裁判！😤"],
    tvTwist: ["不會吧 😱", "怎麼會這樣！"],
    tvLaugh: ["哈哈哈 😂", "太好笑了"],
    tvEnd: ["明天繼續 📺", "看完了，回去幹活"],
    gameInvite: ["來一把遊戲？🎮", "誰敢跟我對戰？"],
    gameTalk: ["這什麼延遲？！", "連招！💥", "別跑！", "看我的"],
    cheer: ["加油，{name}！", "衝啊！"],
    mirror: ["完美 ✨", "今天狀態不錯", "帥/美到自己了 ✨"],
    handAsk: ["問你個事 🙋", "請教一下？", "有空嗎？想問問你"],
    handDelegate: ["幫我個忙？📄", "這個交給你了 📄", "麻煩你了！📄"],
    handAccept: ["好！", "交給我吧 💪", "沒問題 👍"],
    handReturn: ["做好了！📦", "給你 📦", "搞定 ✅"],
    thanks: ["謝啦！🙏", "太好了！", "收到 👍"],
  },
  en: {
    accept: ["Let's go!", "Sure", "Coming!", "Good time for a break"],
    calledAway: ["Duty calls! 🏃", "Be right back!", "Got work, gotta go"],
    pingInvite: ["Ping-pong? 🏓", "Who can take my smash?", "First to 5?"],
    pingPoint: ["Nice!", "Edge!", "Watch this", "Too fast? 😎"],
    win: ["{a} to {b}! 🏆", "I win! 🏆", "Skill 😎"],
    lose: ["Lucky shot…", "Rematch!", "Next time"],
    rpsInvite: ["Rock-paper-scissors for 🪙{v}?", "RPS, loser buys coffee?"],
    rpsCount: ["Rock…", "Paper…", "Scissors!"],
    rpsTie: ["Great minds 😂", "Again!"],
    rpsWin: ["Pay up 🪙", "Too easy 😎"],
    talkInvite: ["Quick chat?", "Break time?", "Coffee? ☕"],
    work: ["That bug in {room} is nasty", "The spec changed again 😩", "Deploy on Friday? 😈", "Works on my machine! 😂", "Good progress this week"],
    chat: ["Lunch plans?", "Doing anything this weekend?", "Great coffee ☕", "Watching anything good?", "I need a holiday 🏖️"],
    joke: ["Why do programmers mix up Halloween and Christmas? Oct 31 = Dec 25 😂", "It's not a bug, it's a feature 😂"],
    gossip: ["Heard {name} is working late again 👀", "Know what {name} is up to? 👀"],
    react: ["No way!", "Hahaha", "True", "LOL 😂", "Fair point"],
    tvInvite: ["Match is on! ⚽", "Next episode? 📺", "TV time!"],
    tvGoal: ["GOAL! ⚽", "What a shot!!"],
    tvSulk: ["Ugh…", "Ref! 😤"],
    tvTwist: ["No way 😱", "Didn't see that coming!"],
    tvLaugh: ["Hahaha 😂", "So funny"],
    tvEnd: ["More tomorrow 📺", "Back to work"],
    gameInvite: ["Quick game? 🎮", "Who wants to lose?"],
    gameTalk: ["Lag?!", "Combo! 💥", "Get back here!", "Watch this"],
    cheer: ["Go {name}!", "Come on!"],
    mirror: ["Perfect ✨", "Looking good", "Nailed it ✨"],
    handAsk: ["Quick question 🙋", "Got a sec?", "Can I ask you something?"],
    handDelegate: ["Could you help? 📄", "This one's for you 📄", "Mind taking this? 📄"],
    handAccept: ["Sure!", "On it 💪", "No problem 👍"],
    handReturn: ["Here you go 📦", "Done! 📦", "All set ✅"],
    thanks: ["Thanks! 🙏", "Great!", "Got it 👍"],
  },
  ja: {
    accept: ["行こう！", "いいね", "今行く！", "ちょうど休憩したかった"],
    calledAway: ["呼ばれた！🏃", "すぐ戻る！", "仕事きた、行ってくる"],
    pingInvite: ["卓球しない？🏓", "スマッシュ受けてみる？", "5点先取で？"],
    pingPoint: ["ナイス！", "エッジ！", "見てて", "速すぎた？😎"],
    win: ["{a} 対 {b}！🏆", "勝った！🏆", "実力だね 😎"],
    lose: ["まぐれだよ…", "もう一回！", "次は勝つ"],
    rpsInvite: ["じゃんけん、🪙{v}賭ける？", "じゃんけんで負けたらコーヒーおごり？"],
    rpsCount: ["じゃん…", "けん…", "ぽん！"],
    rpsTie: ["気が合うね 😂", "もう一回！"],
    rpsWin: ["払ってね 🪙", "楽勝 😎"],
    talkInvite: ["ちょっと話そう？", "休憩しよう", "コーヒーどう？☕"],
    work: ["{room} のバグ、手ごわい", "また仕様変更 😩", "金曜リリース？😈", "手元では動くんだけど！😂", "今週は順調"],
    chat: ["お昼どうする？", "週末の予定は？", "このコーヒーおいしい ☕", "最近何見てる？", "休みたい 🏖️"],
    joke: ["プログラマーがハロウィンとクリスマスを混同する理由は？Oct 31 = Dec 25 😂", "バグじゃない、仕様です 😂"],
    gossip: ["{name} また残業らしいよ 👀", "{name} 最近何してるか知ってる？👀"],
    react: ["マジで！？", "あはは", "たしかに", "ウケる 😂", "なるほど"],
    tvInvite: ["試合始まるよ！⚽", "続き見る？📺", "テレビの時間！"],
    tvGoal: ["ゴール！⚽", "すごいシュート！！"],
    tvSulk: ["あー…", "審判！😤"],
    tvTwist: ["うそでしょ 😱", "まさかの展開！"],
    tvLaugh: ["あはは 😂", "おもしろすぎ"],
    tvEnd: ["また明日 📺", "仕事に戻ろう"],
    gameInvite: ["ゲームしない？🎮", "対戦する人？"],
    gameTalk: ["ラグい！？", "コンボ！💥", "逃げるな！", "見てて"],
    cheer: ["がんばれ {name}！", "いけー！"],
    mirror: ["完璧 ✨", "今日もいい感じ", "決まった ✨"],
    handAsk: ["ちょっと質問 🙋", "今いい？", "聞いてもいい？"],
    handDelegate: ["手伝ってくれる？📄", "これお願い 📄", "任せてもいい？📄"],
    handAccept: ["いいよ！", "任せて 💪", "了解 👍"],
    handReturn: ["できたよ 📦", "はい、どうぞ 📦", "完了 ✅"],
    thanks: ["ありがとう！🙏", "助かる！", "了解 👍"],
  },
};

function say(kind: string, vars: Record<string, string> = {}): string {
  const pool = (LINES[language() as Lang] ?? LINES.en)[kind] ?? LINES.en[kind] ?? [""];
  const usable = pool.filter((l) => [...l.matchAll(/\{(\w+)\}/g)].every((m) => vars[m[1]] !== undefined));
  return pick(usable.length ? usable : pool).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

// ---------------------------------------------------------------- spots

interface Spot extends Seat {
  face: Facing;
}

/** The tile just in front of (below) an item, facing it. */
function frontOf(f: Furniture): Spot {
  const d = itemDef(f.kind);
  const x = f.x + Math.floor((d.w - 1) / 2);
  return { x, y: f.y + d.h, face: "up", dx: d.w % 2 === 0 ? 16 : 0 };
}

// ---------------------------------------------------------------- the director

interface Plan {
  controller: AbortController;
  /** For hangouts: everyone in it ends when one is called away. */
  group?: Set<string>;
}

export class Life {
  private personas = new Map<string, Persona>();
  private nextAt = new Map<string, number>();
  private plans = new Map<string, Plan>();
  private reserved = new Set<string>();
  private coins = new Map<string, number>();
  private lastTick = 0;
  /** People waiting for colleagues: how many requests each has out. */
  private waiting = new Map<string, number>();

  constructor(private scene: FloorScene) {}

  private persona(id: string) {
    let p = this.personas.get(id);
    if (!p) this.personas.set(id, (p = personaOf(id)));
    return p;
  }

  /** Called when someone's state changes: work interrupts whatever they were doing. */
  stateChanged(id: string, prev: string, next: string) {
    if (prev === next) return;
    // Their task ended (done, failed or cancelled): no longer waiting for anyone.
    if ((next === "idle" || next === "error" || next === "offline") && this.waiting.delete(id)) this.scene.lifeIcon(id, null);
    if (next !== "idle") {
      const plan = this.plans.get(id);
      if (plan) {
        this.scene.lifeSay(id, say("calledAway"), 1800);
        this.stop(id);
      }
    }
    this.nextAt.set(id, Date.now() + rand(4000, 12_000));
  }

  /**
   * A colleague request, acted out: the asker walks to the colleague's desk with papers and goes back to
   * wait under an hourglass; the colleague later walks the result back. Short, and not interrupted.
   */
  handoff(h: { from: string; to: string; kind: "ask" | "delegate" | "return" | "pass" }) {
    if (h.kind === "pass") {
      // A project hand-over: nobody waits for it.
    } else if (h.kind === "return") {
      const n = (this.waiting.get(h.to) ?? 1) - 1;
      if (n > 0) this.waiting.set(h.to, n);
      else {
        this.waiting.delete(h.to);
        this.scene.lifeIcon(h.to, null);
      }
    } else this.waiting.set(h.from, (this.waiting.get(h.from) ?? 0) + 1);
    // An idle walker on an outing (coffee…) drops it first.
    if (this.plans.has(h.from)) this.stop(h.from);
    void this.errand(h).catch(() => this.scene.lifeHome(h.from));
  }

  private async errand(h: { from: string; to: string; kind: "ask" | "delegate" | "return" | "pass" }) {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const target = this.scene.lifeAgents().find((a) => a.id === h.to);
    if (!target) return;
    const spot = this.besides(target.home ?? target.tile);
    if (spot) {
      await this.scene.lifeGo(h.from, spot);
      this.scene.lifeAct(h.from, { pose: "use", held: "papers", face: spot.face });
    }
    this.scene.lifeSay(h.from, say(h.kind === "ask" ? "handAsk" : h.kind === "return" ? "handReturn" : "handDelegate"), 2200);
    await pause(1300);
    this.scene.lifeSay(h.to, say(h.kind === "return" ? "thanks" : "handAccept"), 1800);
    await pause(900);
    this.scene.lifeHome(h.from);
    if ((h.kind === "ask" || h.kind === "delegate") && this.waiting.has(h.from)) this.scene.lifeIcon(h.from, "hourglass");
  }

  /** A free tile next to someone's seat, facing them. */
  private besides(t: Tile): Spot | null {
    const around: [number, number, Facing][] = [
      [0, 1, "up"],
      [-1, 0, "right"],
      [1, 0, "left"],
      [0, -1, "down"],
      [-1, 1, "up"],
      [1, 1, "up"],
    ];
    for (const [dx, dy, face] of around) {
      const s = { x: t.x + dx, y: t.y + dy, face };
      if (this.open(s)) return s;
    }
    return null;
  }

  /** Someone left the office. */
  forget(id: string) {
    this.stop(id);
    this.nextAt.delete(id);
  }

  /** Ends someone's outing (and their hangout, for everyone in it). */
  private stop(id: string) {
    const plan = this.plans.get(id);
    if (!plan) return;
    plan.controller.abort();
    for (const member of plan.group ?? [id]) this.plans.delete(member);
  }

  tick(_time: number) {
    const now = Date.now();
    if (now - this.lastTick < 400) return;
    this.lastTick = now;
    const agents = this.scene.lifeAgents();
    const free = agents.filter((a) => this.available(a));
    for (const a of free) {
      const at = this.nextAt.get(a.id);
      if (at === undefined) {
        this.nextAt.set(a.id, now + rand(5000, 20_000));
        continue;
      }
      if (now < at || this.plans.has(a.id) || !this.available(a)) continue;
      this.nextAt.set(a.id, now + rand(6000, 20_000));
      const others = free.filter((o) => o.id !== a.id && !this.plans.has(o.id));
      const p = this.persona(a.id);
      if (others.length && Math.random() < 0.45 + 0.4 * p.social && this.hangout(a, others)) continue;
      this.solo(a);
    }
  }

  /** Idle, at their seat, not already out. */
  private available(a: LifeAgent) {
    return a.state === "idle" && !a.outing && a.settled && !a.meeting && !this.plans.has(a.id);
  }

  // ---------------------------------------------------------------- shared helpers

  private items() {
    return knownItems(this.scene.lifeFloor().floor);
  }

  private open(t: Tile) {
    const { map } = this.scene.lifeFloor();
    const busy = this.scene.lifeAgents().some((a) => a.tile.x === t.x && a.tile.y === t.y);
    return !!map.open[t.y]?.[t.x] && !this.reserved.has(key(t)) && !busy;
  }

  /** Free seats (sofas, armchairs, beanbags, café chairs…), optionally only in one room. */
  private seats(filter?: (s: Seat) => boolean): Seat[] {
    const out: Seat[] = [];
    const taken = new Set(this.scene.lifeAgents().flatMap((a) => [key(a.tile), ...(a.home ? [key(a.home)] : [])]));
    for (const f of this.items()) {
      const face = seatFacing(f);
      if (!face || f.kind === "officeChair" || f.kind === "officeChairFront") continue;
      for (let i = 0; i < itemDef(f.kind).w; i++) {
        const s: Seat = { x: f.x + i, y: f.y, face, sit: true, ...(itemDef(f.kind).w === 1 && f.dx ? { dx: f.dx } : {}) };
        if (!taken.has(key(s)) && !this.reserved.has(key(s)) && (!filter || filter(s))) out.push(s);
      }
    }
    return out;
  }

  private roomOf(t: Tile) {
    return this.scene.lifeFloor().floor.rooms.find((r) => t.x >= r.x && t.y >= r.y && t.x < r.x + r.w && t.y < r.y + r.h);
  }

  /** Starts a script for some people; cleans up (spots, home) however it ends. */
  private run(ids: string[], spots: Tile[], script: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    const group = new Set(ids);
    for (const id of ids) this.plans.set(id, { controller, group });
    for (const s of spots) this.reserved.add(key(s));
    void script(controller.signal)
      .catch(() => {})
      .finally(() => {
        for (const s of spots) this.reserved.delete(key(s));
        for (const id of ids) {
          if (this.plans.get(id)?.controller === controller) this.plans.delete(id);
          this.scene.lifeHome(id);
          this.nextAt.set(id, Date.now() + rand(8000, 24_000));
        }
      });
  }

  private wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Interrupted());
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Interrupted())), { once: true });
    });
  }

  private async go(id: string, spot: Seat, signal: AbortSignal) {
    if (signal.aborted) throw new Interrupted();
    await this.scene.lifeGo(id, spot);
    if (signal.aborted) throw new Interrupted();
  }

  // ---------------------------------------------------------------- solo outings

  private solo(a: LifeAgent) {
    const p = this.persona(a.id);
    const has = (t: Trait) => p.traits.has(t);
    const items = this.items();
    const near = (kinds: string[]) =>
      items
        .filter((f) => kinds.includes(f.kind))
        .map((f) => ({ f, spot: itemDef(f.kind).layer === "wall" ? { ...frontOf(f), y: f.y + 2 } : frontOf(f) }))
        .filter(({ spot }) => this.open(spot));
    const options: { w: number; go: () => void }[] = [];
    const add = (weight: number, ok: boolean, go: () => void) => ok && weight > 0 && options.push({ w: weight, go });

    const coffee = near(["coffeeMachine"]);
    add(18 * (has("caffeine") ? 3 : 1) * (has("gossip") ? 1.4 : 1), coffee.length > 0, () => this.drinkAt(a, pick(coffee).spot, "coffee"));
    const water = near(["waterCooler"]);
    add(12 * (has("sports") ? 1.5 : 1), water.length > 0, () => this.drinkAt(a, pick(water).spot, "water"));
    const snack = near(["vendingMachine", "fridge"]);
    add(5, snack.length > 0, () => this.useAt(a, pick(snack).spot, 1600, "box"));
    const seats = this.seats();
    add(12 * (has("napper") ? 2.5 : 1), seats.length > 0, () => this.lounge(a, pick(seats)));
    add(6 * (has("reading") ? 1.6 : 1) * (has("games") ? 1.4 : 1) * (has("shy") ? 1.5 : 1), seats.length > 0, () => this.phone(a, pick(seats)));
    const shelf = near(["bookshelf", "binderShelf"]);
    add(6 * (has("reading") ? 3 : 1) * (has("shy") ? 1.5 : 1), shelf.length > 0, () => this.read(a, pick(shelf).spot));
    const window = near(["window", "whiteboard"]);
    add(7 * (has("shy") ? 1.5 : 1), window.length > 0, () => this.gaze(a, pick(window).spot));
    const arcade = near(["arcade"]);
    add(5 * (has("games") ? 3 : 1), arcade.length > 0, () => this.useAt(a, pick(arcade).spot, rand(6000, 12_000), undefined, "star"));
    const mirror = near(["mirror"]);
    add(3 * (has("vanity") ? 5 : 1), mirror.length > 0, () => this.groom(a, pick(mirror).spot));
    add(8 * (has("sports") ? 2.5 : 1), true, () => this.stretch(a));

    const total = options.reduce((n, o) => n + o.w, 0);
    let r = Math.random() * total;
    for (const o of options) {
      r -= o.w;
      if (r <= 0) return o.go();
    }
  }

  private drinkAt(a: LifeAgent, spot: Spot, held: "coffee" | "water") {
    this.run([a.id], [spot], async (signal) => {
      await this.go(a.id, spot, signal);
      this.scene.lifeAct(a.id, { pose: "use", face: "up" });
      if (held === "coffee") this.scene.lifeIcon(a.id, "coffee", 1900);
      await this.wait(held === "coffee" ? 1900 : 1000, signal);
      this.scene.lifeAct(a.id, { pose: "drink", held, face: "up" });
      await this.wait(2600, signal);
      // Sometimes take the cup to a seat.
      const seats = this.seats();
      if (held === "coffee" && seats.length && Math.random() < 0.45) {
        const seat = pick(seats);
        this.reserved.add(key(seat));
        try {
          await this.go(a.id, seat, signal);
          this.scene.lifeAct(a.id, { pose: "sit", held, face: seat.face, seated: true });
          await this.wait(rand(6000, 15_000), signal);
        } finally {
          this.reserved.delete(key(seat));
        }
      }
    });
  }

  private useAt(a: LifeAgent, spot: Spot, ms: number, held?: string, icon?: string) {
    this.run([a.id], [spot], async (signal) => {
      await this.go(a.id, spot, signal);
      this.scene.lifeAct(a.id, { pose: "use", face: "up" });
      if (icon && Math.random() < 0.4) this.scene.lifeIcon(a.id, icon, 1600);
      await this.wait(ms, signal);
      if (held) {
        this.scene.lifeAct(a.id, { pose: "stand", held, face: "down" });
        await this.wait(900, signal);
      }
    });
  }

  private lounge(a: LifeAgent, seat: Seat) {
    const napper = this.persona(a.id).traits.has("napper");
    this.run([a.id], [seat], async (signal) => {
      await this.go(a.id, seat, signal);
      this.scene.lifeAct(a.id, { pose: "sit", face: seat.face, seated: true });
      if (Math.random() < (napper ? 0.7 : 0.25)) {
        await this.wait(rand(3000, 6000), signal);
        this.scene.lifeAct(a.id, { pose: "sleep", face: seat.face, seated: true });
        this.scene.lifeIcon(a.id, "zzz");
        await this.wait(rand(8000, 16_000), signal);
      } else {
        if (Math.random() < 0.3) this.scene.lifeIcon(a.id, "music", 2500);
        await this.wait(rand(9000, 22_000), signal);
      }
    });
  }

  private phone(a: LifeAgent, seat: Seat) {
    this.run([a.id], [seat], async (signal) => {
      await this.go(a.id, seat, signal);
      this.scene.lifeAct(a.id, { pose: "read", held: "phone", face: seat.face, seated: true });
      await this.wait(rand(8000, 18_000), signal);
    });
  }

  private read(a: LifeAgent, spot: Spot) {
    this.run([a.id], [spot], async (signal) => {
      await this.go(a.id, spot, signal);
      this.scene.lifeAct(a.id, { pose: "read", held: "book", face: "up" });
      await this.wait(rand(5000, 9000), signal);
    });
  }

  private gaze(a: LifeAgent, spot: Spot) {
    this.run([a.id], [spot], async (signal) => {
      await this.go(a.id, spot, signal);
      this.scene.lifeAct(a.id, { pose: "stand", face: "up" });
      if (Math.random() < 0.3) this.scene.lifeIcon(a.id, "idea", 2000);
      await this.wait(rand(5000, 10_000), signal);
    });
  }

  private groom(a: LifeAgent, spot: Spot) {
    this.run([a.id], [spot], async (signal) => {
      await this.go(a.id, spot, signal);
      const held = Math.random() < 0.5 ? "comb" : "lipstick";
      this.scene.lifeAct(a.id, { pose: "groom", held, face: "up" });
      await this.wait(rand(6000, 11_000), signal);
      this.scene.lifeIcon(a.id, "sparkle", 2000);
      this.scene.lifeSay(a.id, say("mirror"));
      this.scene.lifeAct(a.id, { pose: "stand", face: "down" });
      await this.wait(2000, signal);
    });
  }

  private stretch(a: LifeAgent) {
    this.run([a.id], [], async (signal) => {
      this.scene.lifeAct(a.id, { pose: "stretch", face: "down" });
      await this.wait(2600, signal);
    });
  }

  // ---------------------------------------------------------------- hangouts

  /** Tries to get people together; false if nothing fits. */
  private hangout(host: LifeAgent, others: LifeAgent[]): boolean {
    const p = this.persona(host.id);
    const has = (t: Trait) => p.traits.has(t);
    const ranked = [...others].sort((x, y) => this.score(host, y) - this.score(host, x));
    const kinds: { w: number; start: () => boolean }[] = [];
    const add = (w: number, start: () => boolean) => w > 0 && kinds.push({ w, start });
    add(9 * (has("sports") ? 3 : 1) * (has("competitive") ? 1.8 : 1) * (has("shy") ? 0.7 : 1), () => this.pingpong(host, ranked));
    add(8 * (has("competitive") ? 1.8 : 1) * (has("shy") ? 0.6 : 1), () => this.rps(host, ranked));
    add(10 * (has("gossip") ? 2.5 : 1) * (has("caffeine") ? 2.2 : 1) * (has("jokes") ? 1.5 : 1) * (has("shy") ? 0.7 : 1), () => this.chat(host, ranked));
    add(10 * (has("napper") ? 1.5 : 1) * (has("sports") ? 1.3 : 1) * (has("reading") ? 0.8 : 1), () => this.tv(host, ranked));
    add(9 * (has("games") ? 3 : 1) * (has("competitive") ? 1.8 : 1), () => this.videogame(host, ranked));
    // Weighted order; the first that fits starts.
    while (kinds.length) {
      const total = kinds.reduce((n, k) => n + k.w, 0);
      let r = Math.random() * total;
      const i = kinds.findIndex((k) => (r -= k.w) <= 0);
      const [kind] = kinds.splice(i < 0 ? 0 : i, 1);
      if (kind.start()) return true;
    }
    return false;
  }

  private score(host: LifeAgent, other: LifeAgent) {
    const a = this.persona(host.id);
    const b = this.persona(other.id);
    const shared = [...a.traits].filter((t) => b.traits.has(t)).length;
    return shared * 0.8 + b.social + Math.random() * 1.2;
  }

  /** Invite and accept lines as people set off. */
  private invite(host: string, guests: string[], line: string) {
    this.scene.lifeSay(host, line);
    guests.forEach((g, i) => setTimeout(() => this.scene.lifeSay(g, say("accept")), 900 + i * 650));
  }

  private bet(a: string, b: string) {
    const coins = (id: string) => this.coins.get(id) ?? 100;
    return Math.max(0, Math.min(this.persona(a).traits.has("competitive") ? 15 : 10, coins(a), coins(b)));
  }

  private settle(winner: string, loser: string, v: number) {
    if (!v) return;
    this.coins.set(winner, (this.coins.get(winner) ?? 100) + v);
    this.coins.set(loser, (this.coins.get(loser) ?? 100) - v);
    this.scene.lifeFloat(winner, `+🪙${v}`, "#ffd34d");
    this.scene.lifeFloat(loser, `−🪙${v}`, "#ff8a8a");
  }

  private winChance(a: string, b: string) {
    return Math.max(0.15, Math.min(0.85, 0.5 + (this.persona(a).skill - this.persona(b).skill) * 0.6));
  }

  private pingpong(host: LifeAgent, ranked: LifeAgent[]): boolean {
    const table = this.items().find((f) => f.kind === "pingpongTable");
    if (!table || !ranked.length) return false;
    const left: Spot = { x: table.x - 1, y: table.y + 1, face: "right" };
    const right: Spot = { x: table.x + 3, y: table.y + 1, face: "left" };
    if (!this.open(left) || !this.open(right)) return false;
    const guest = ranked[0];
    const fans = ranked.slice(1, Math.random() < 0.3 ? 2 : 1);
    const watch: Spot[] = [
      { x: table.x, y: table.y - 1, face: "down" },
      { x: table.x + 2, y: table.y - 1, face: "down" },
    ].filter((s) => this.open(s)) as Spot[];
    const fanSpots = fans.slice(0, watch.length).map((f, i) => ({ id: f.id, spot: watch[i] }));
    const ids = [host.id, guest.id, ...fanSpots.map((f) => f.id)];
    this.invite(host.id, [guest.id, ...fanSpots.map((f) => f.id)], say("pingInvite"));
    this.run(ids, [left, right, ...fanSpots.map((f) => f.spot)], async (signal) => {
      await Promise.all([this.go(host.id, left, signal), this.go(guest.id, right, signal), ...fanSpots.map((f) => this.go(f.id, f.spot, signal))]);
      const players = [host.id, guest.id];
      const faces: Facing[] = ["right", "left"];
      players.forEach((id, i) => this.scene.lifeAct(id, { pose: "play", held: "paddle", face: faces[i] }));
      for (const f of fanSpots) this.scene.lifeAct(f.id, { pose: "stand", face: "down" });
      const score = [0, 0];
      await this.wait(rand(1800, 3000), signal);
      while (score[0] < 5 && score[1] < 5) {
        const w = Math.random() < this.winChance(host.id, guest.id) ? 0 : 1;
        score[w]++;
        if (Math.random() < 0.6) this.scene.lifeSay(players[w], Math.random() < 0.5 ? `${score[w]} × ${score[1 - w]} 🏓` : say("pingPoint"), 1800);
        for (const f of fanSpots) {
          if (Math.random() < 0.4) {
            this.scene.lifeAct(f.id, { pose: "cheer", face: "down" });
            if (Math.random() < 0.4) this.scene.lifeSay(f.id, say("cheer", { name: this.name(players[w]) }), 1600);
            setTimeout(() => this.scene.lifeAct(f.id, { pose: "stand", face: "down" }), 1200);
          }
        }
        await this.wait(rand(2200, 3800), signal);
      }
      const w = score[0] === 5 ? 0 : 1;
      await this.finishMatch(players[w], players[1 - w], faces[w], faces[1 - w], fanSpots.map((f) => f.id), say("win", { a: String(Math.max(...score)), b: String(Math.min(...score)) }), signal);
    });
    return true;
  }

  private async finishMatch(winner: string, loser: string, wFace: Facing, lFace: Facing, fans: string[], line: string, signal: AbortSignal) {
    const v = this.bet(winner, loser);
    this.scene.lifeAct(winner, { pose: "cheer", face: wFace });
    this.scene.lifeIcon(winner, "trophy", 3000);
    this.scene.lifeSay(winner, line);
    this.scene.lifeAct(loser, { pose: "sulk", face: lFace });
    setTimeout(() => this.scene.lifeSay(loser, say("lose")), 1000);
    for (const f of fans) this.scene.lifeAct(f, { pose: Math.random() < 0.5 ? "cheer" : "laugh", face: "down" });
    this.settle(winner, loser, v);
    await this.wait(3400, signal);
  }

  /** Two tiles side by side, both free, inside a room where people hang out; they face each other. */
  private talkPair(): [Spot, Spot] | null {
    const { floor, map } = this.scene.lifeFloor();
    const lounges = floor.rooms.filter((r) => /lounge|kitchen|pantry|break|cafe|休息|茶水|ラウンジ/i.test(`${r.id} ${r.name}`));
    const rooms = lounges.length ? lounges : floor.rooms;
    const tries: [Spot, Spot][] = [];
    for (const r of rooms) {
      for (let y = r.y + 2; y < r.y + r.h - 1; y++) {
        for (let x = r.x + 1; x < r.x + r.w - 2; x++) {
          const a: Spot = { x, y, face: "right" };
          const b: Spot = { x: x + 1, y, face: "left" };
          // Room to stand: the tiles around should be open too, so they aren't jammed against furniture.
          if (this.open(a) && this.open(b) && map.open[y + 1]?.[x] && map.open[y + 1]?.[x + 1] && !isWall(floor, x, y - 1)) tries.push([a, b]);
        }
      }
    }
    return tries.length ? pick(tries) : null;
  }

  private name(id: string) {
    return this.scene.lifeAgents().find((a) => a.id === id)?.name ?? "";
  }

  private rps(host: LifeAgent, ranked: LifeAgent[]): boolean {
    const pair = this.talkPair();
    if (!pair || !ranked.length) return false;
    const guest = ranked[0];
    const v = this.bet(host.id, guest.id);
    this.invite(host.id, [guest.id], say("rpsInvite", { v: String(v) }));
    this.run([host.id, guest.id], pair, async (signal) => {
      await Promise.all([this.go(host.id, pair[0], signal), this.go(guest.id, pair[1], signal)]);
      const ids = [host.id, guest.id];
      const faces: Facing[] = ["right", "left"];
      for (let round = 0; round < 3; round++) {
        const counts = (LINES[language() as Lang] ?? LINES.en).rpsCount;
        for (let step = 0; step < 3; step++) {
          ids.forEach((id, i) => this.scene.lifeAct(id, { pose: "rps", face: faces[i] }));
          this.scene.lifeSay(host.id, counts[step], 700);
          await this.wait(540, signal);
        }
        const hands = ids.map((id) => (this.persona(id).traits.has("competitive") && Math.random() < 0.2 ? "rock" : pick(["rock", "paper", "scissors"])));
        ids.forEach((id, i) => {
          this.scene.lifeAct(id, { pose: "rps", held: hands[i], face: faces[i] });
          this.scene.lifeIcon(id, `hand_${hands[i]}`, 2200);
        });
        await this.wait(1500, signal);
        if (hands[0] === hands[1]) {
          ids.forEach((id, i) => this.scene.lifeAct(id, { pose: "laugh", face: faces[i] }));
          this.scene.lifeSay(guest.id, say("rpsTie"), 1400);
          await this.wait(1400, signal);
          continue;
        }
        const beats: Record<string, string> = { rock: "scissors", paper: "rock", scissors: "paper" };
        const w = beats[hands[0]] === hands[1] ? 0 : 1;
        this.scene.lifeAct(ids[w], { pose: "cheer", face: faces[w] });
        this.scene.lifeIcon(ids[w], v ? "coin" : "trophy", 2600);
        this.scene.lifeSay(ids[w], say("rpsWin"));
        this.scene.lifeAct(ids[1 - w], { pose: "sulk", face: faces[1 - w] });
        setTimeout(() => this.scene.lifeSay(ids[1 - w], say("lose")), 1000);
        this.settle(ids[w], ids[1 - w], v);
        await this.wait(2900, signal);
        return;
      }
    });
    return true;
  }

  private chat(host: LifeAgent, ranked: LifeAgent[]): boolean {
    // Sitting if two free seats are close together, otherwise standing face to face.
    const seats = this.seats();
    let spots: Spot[] | null = null;
    for (const s of seats) {
      const mate = seats.find((o) => o !== s && Math.abs(o.x - s.x) + Math.abs(o.y - s.y) <= 3 && this.roomOf(o) === this.roomOf(s));
      if (mate) {
        spots = [s, mate] as Spot[];
        break;
      }
    }
    const seated = !!spots;
    spots ??= this.talkPair();
    if (!spots || !ranked.length) return false;
    const guest = ranked[0];
    const ids = [host.id, guest.id];
    const pair = spots;
    this.invite(host.id, [guest.id], say("talkInvite"));
    this.run(ids, pair, async (signal) => {
      await Promise.all(ids.map((id, i) => this.go(id, pair[i], signal)));
      const held = ids.map((id) => (this.persona(id).traits.has("caffeine") || Math.random() < 0.5 ? "coffee" : undefined));
      const base = (i: number) => this.scene.lifeAct(ids[i], { pose: seated ? "sit" : "stand", held: held[i], face: pair[i].face, seated });
      ids.forEach((_, i) => base(i));
      const end = Date.now() + rand(seated ? 24_000 : 10_000, seated ? 45_000 : 18_000);
      let last = -1;
      await this.wait(1500, signal);
      while (Date.now() < end) {
        const speaker = last === 0 ? 1 : last === 1 ? 0 : this.persona(ids[0]).social > this.persona(ids[1]).social ? 0 : 1;
        last = speaker;
        const p = this.persona(ids[speaker]);
        const room = this.roomOf(pair[speaker])?.name ?? "";
        const other = this.scene.lifeAgents().find((a) => !ids.includes(a.id))?.name;
        const kind = p.traits.has("jokes") && Math.random() < 0.4 ? "joke" : p.traits.has("gossip") && other && Math.random() < 0.4 ? "gossip" : Math.random() < 0.6 ? "work" : "chat";
        this.scene.lifeAct(ids[speaker], { pose: "talk", held: held[speaker], face: pair[speaker].face, seated });
        this.scene.lifeSay(ids[speaker], say(kind, { room, name: other ?? "" }), 2600);
        await this.wait(1700, signal);
        base(speaker);
        const listener = 1 - speaker;
        if (kind === "joke") {
          this.scene.lifeAct(ids[listener], { pose: "laugh", held: held[listener], face: pair[listener].face, seated });
          setTimeout(() => base(listener), 1600);
        } else if (Math.random() < 0.45) {
          this.scene.lifeSay(ids[listener], say("react"), 1800);
        } else if (held[listener] && Math.random() < 0.3) {
          this.scene.lifeAct(ids[listener], { pose: "drink", held: held[listener], face: pair[listener].face, seated });
          setTimeout(() => base(listener), 1400);
        }
        await this.wait(rand(2400, 4200), signal);
      }
    });
    return true;
  }

  /** A TV on a wall, and free seats in the same room. */
  private tvSeats(): { seats: Seat[] } | null {
    const tv = this.items().find((f) => f.kind === "tv");
    if (!tv) return null;
    const room = this.roomOf({ x: tv.x, y: tv.y + 2 });
    const seats = this.seats((s) => this.roomOf(s) === room && !cells(tv).some((c) => c.x === s.x && c.y === s.y));
    return seats.length >= 2 ? { seats } : null;
  }

  private tv(host: LifeAgent, ranked: LifeAgent[]): boolean {
    const found = this.tvSeats();
    if (!found || !ranked.length) return false;
    const guests = ranked.slice(0, Math.min(found.seats.length - 1, 1 + Math.floor(Math.random() * 3)));
    const ids = [host.id, ...guests.map((g) => g.id)];
    const seats = found.seats.slice(0, ids.length);
    const show = this.persona(host.id).traits.has("sports") || Math.random() < 0.4 ? "football" : Math.random() < 0.55 ? "soap" : "cartoon";
    this.invite(host.id, guests.map((g) => g.id), say("tvInvite"));
    this.run(ids, seats, async (signal) => {
      await Promise.all(ids.map((id, i) => this.go(id, seats[i], signal)));
      const popcorn = ids.map((id) => (this.persona(id).traits.has("napper") || Math.random() < 0.3 ? "popcorn" : undefined));
      const base = (i: number) => this.scene.lifeAct(ids[i], { pose: popcorn[i] ? "wait" : "sit", held: popcorn[i], face: seats[i].face, seated: true });
      ids.forEach((_, i) => base(i));
      const end = Date.now() + rand(30_000, 65_000);
      await this.wait(1500, signal);
      while (Date.now() < end) {
        const all = (pose: string, ms: number) => {
          ids.forEach((id, i) => this.scene.lifeAct(id, { pose, face: seats[i].face, seated: true }));
          setTimeout(() => ids.forEach((_, i) => base(i)), ms);
        };
        const r = Math.random();
        if (show === "football") {
          if (r < 0.2) {
            all("cheer", 1900);
            this.scene.lifeSay(pick(ids), say("tvGoal"));
          } else if (r < 0.32) {
            all("sulk", 1600);
            this.scene.lifeSay(pick(ids), say("tvSulk"));
          }
        } else if (show === "soap") {
          if (r < 0.3) this.scene.lifeSay(pick(ids), say("tvTwist"));
          else if (r < 0.5) ids.forEach((id) => this.scene.lifeIcon(id, "heart", 1500));
        } else if (r < 0.45) {
          all("laugh", 1600);
          this.scene.lifeSay(pick(ids), say("tvLaugh"), 1500);
        }
        await this.wait(rand(3500, 6500), signal);
      }
      this.scene.lifeSay(pick(ids), say("tvEnd"));
      await this.wait(1400, signal);
    });
    return true;
  }

  private videogame(host: LifeAgent, ranked: LifeAgent[]): boolean {
    const found = this.tvSeats();
    if (!found || !ranked.length) return false;
    // Two seats next to each other for the players.
    const s = found.seats;
    const i = s.findIndex((a) => s.some((b) => b.y === a.y && b.x === a.x + 1));
    if (i < 0) return false;
    const p1 = s[i];
    const p2 = s.find((b) => b.y === p1.y && b.x === p1.x + 1)!;
    const guest = ranked[0];
    const fans = ranked.slice(1, 3).map((f, k) => ({ id: f.id, seat: s.filter((x) => x !== p1 && x !== p2)[k] })).filter((f) => f.seat);
    const ids = [host.id, guest.id, ...fans.map((f) => f.id)];
    this.invite(host.id, ids.slice(1), say("gameInvite"));
    this.run(ids, [p1, p2, ...fans.map((f) => f.seat)], async (signal) => {
      await Promise.all([this.go(host.id, p1, signal), this.go(guest.id, p2, signal), ...fans.map((f) => this.go(f.id, f.seat, signal))]);
      const players = [host.id, guest.id];
      const seats = [p1, p2];
      const play = () => players.forEach((id, k) => this.scene.lifeAct(id, { pose: "game", held: "controller", face: seats[k].face, seated: true }));
      play();
      for (const f of fans) this.scene.lifeAct(f.id, { pose: "sit", face: f.seat.face, seated: true });
      const wins = [0, 0];
      while (wins[0] < 2 && wins[1] < 2) {
        const end = Date.now() + rand(7000, 10_000);
        while (Date.now() < end) {
          if (Math.random() < 0.75) this.scene.lifeSay(pick(players), say("gameTalk"), 1600);
          for (const f of fans) if (Math.random() < 0.35) this.scene.lifeSay(f.id, say("cheer", { name: this.name(pick(players)) }), 1400);
          await this.wait(rand(2000, 3400), signal);
        }
        const w = Math.random() < this.winChance(host.id, guest.id) ? 0 : 1;
        wins[w]++;
        this.scene.lifeAct(players[w], { pose: "cheer", held: "controller", face: seats[w].face, seated: true });
        this.scene.lifeAct(players[1 - w], { pose: "sulk", held: "controller", face: seats[1 - w].face, seated: true });
        await this.wait(1500, signal);
        play();
      }
      const w = wins[0] === 2 ? 0 : 1;
      await this.finishMatch(players[w], players[1 - w], seats[w].face ?? "down", seats[1 - w].face ?? "down", fans.map((f) => f.id), say("win", { a: String(Math.max(...wins)), b: String(Math.min(...wins)) }), signal);
    });
    return true;
  }
}
