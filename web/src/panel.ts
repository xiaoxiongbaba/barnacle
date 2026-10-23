import { characterSeed } from "./floor/art-habblaud";
import { targetRoom, type Floor } from "./floor/model";
import { formatTime, t } from "./i18n";
import type { Occupant, OfficeEvent, State } from "./types";
import { avatarCanvas } from "./vendor/habblaud/art/index";
import { ICONS, pixelIcon } from "./vendor/habblaud/ui/icons";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Fills every `[data-icon]` element with its pixel icon (icons are our own static markup). */
export function applyIcons(root: ParentNode = document) {
  for (const node of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const key = node.dataset.icon as keyof typeof ICONS;
    if (ICONS[key]) node.innerHTML = ICONS[key];
  }
}

/** Barnacle's mark: a little pixel barnacle on a rock. */
export const BRAND_MARK = pixelIcon(
  [
    "......oo......",
    ".....owwo.....",
    "....owssso....",
    "...owsoossso..",
    "...owso..oso..",
    "..owssoossso..",
    "..owsssssssso.",
    ".owsosssosssso",
    ".owsossssossso",
    "rrrrrrrrrrrrrr",
    ".rrrrrrrrrrrr.",
  ],
  { o: "#2b3247", w: "#f4f1ea", s: "#c9d1dc", r: "#7d6a58" },
  "ui-brand__svg",
);

/** What each state looks like in lists: the status dot's class and a small emoji. */
export const LOOK: Record<State, { dot: string; icon: string }> = {
  idle: { dot: "is-idle", icon: "☕" },
  writing: { dot: "is-working", icon: "✏️" },
  researching: { dot: "is-working", icon: "📖" },
  executing: { dot: "is-working", icon: "💻" },
  syncing: { dot: "is-working", icon: "🔄" },
  waiting: { dot: "is-waiting", icon: "✋" },
  error: { dot: "is-error", icon: "⚠️" },
  offline: { dot: "is-offline", icon: "💤" },
};

const WORKING: ReadonlySet<State> = new Set(["writing", "researching", "executing", "syncing"]);

/** Pixel avatars (head and shoulders), one image per occupant, matching their character in the office. */
const avatars = new Map<string, string>();
function avatar(id: string, size: "xs" | "md") {
  let src = avatars.get(id);
  if (!src) {
    src = avatarCanvas(characterSeed(id), { scale: 2 }).toDataURL();
    avatars.set(id, src);
  }
  const box = el("span", `ui-avatar ui-avatar--${size}`);
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.width = size === "md" ? 40 : 20;
  img.height = size === "md" ? 40 : 20;
  box.append(img);
  return box;
}

/**
 * The page around the office, laid out like Habblaud: a top bar with counters, the "Office" side panel
 * (rooms and who is in them) and the activity feed. Plain DOM; text is never set as HTML.
 */
export class Panel {
  private names = new Map<string, string>();
  private rooms = new Map<string, string>();
  private connected = false;
  private inbox = 0;
  private query = "";
  private last: { occupants: Occupant[]; events: OfficeEvent[]; floor: Floor | null } = { occupants: [], events: [], floor: null };

  constructor(private opts: { onSelect: (id: string) => void; onChat: (id: string) => void; onInbox: () => void }) {
    $("brand-mark").innerHTML = BRAND_MARK;
    applyIcons();
    const search = $<HTMLInputElement>("search");
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.renderRooms();
    });
    window.addEventListener("keydown", (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        search.focus();
      }
    });
  }

  setOfficeName(name: string) {
    $("office-name").textContent = name;
    document.title = name;
  }

  setConnected(up: boolean) {
    this.connected = up;
    const conn = $("conn");
    conn.className = `ui-pill ${up ? "is-open" : "is-closed"}`;
    const text = conn.querySelector<HTMLElement>(".ui-pill__text")!;
    text.removeAttribute("data-i18n");
    text.textContent = t(up ? "conn.live" : "conn.reconnecting");
  }

  /** Re-applies translated text that is not covered by data-i18n attributes. */
  refreshLanguage() {
    if (!$("conn").querySelector("[data-i18n]")) this.setConnected(this.connected);
    this.render(this.last.occupants, this.last.events, this.last.floor);
  }

  /** The room someone is in (or heading to), by name. */
  roomName(id: string) {
    return this.rooms.get(id) ?? null;
  }

  /** How many things wait for you (from the server). */
  setInbox(count: number) {
    this.inbox = count;
    this.renderCounters();
  }

  render(occupants: Occupant[], events: OfficeEvent[], floor: Floor | null) {
    this.last = { occupants, events, floor };
    for (const o of occupants) this.names.set(o.id, o.name);
    this.renderCounters();
    this.renderRooms();
    this.renderFeed();
  }

  // ---------------------------------------------------------------- top bar

  private renderCounters() {
    const { occupants, floor } = this.last;
    const present = occupants.filter((o) => o.state !== "offline");
    const working = occupants.filter((o) => WORKING.has(o.state)).length;
    const waiting = occupants.filter((o) => o.state === "waiting");
    const counter = (cls: string, value: number, label: string) => {
      const box = el("div", `ui-counter ui-counter--${cls}`);
      box.append(el("span", "ui-counter__value", String(value)), el("span", "ui-counter__label", label));
      return box;
    };
    // Approvals, projects that asked you, drafts and proposals; agents reporting "waiting" from outside count too.
    const needs = Math.max(this.inbox, waiting.length);
    const need = el("button", `ui-counter ui-counter--waiting${needs ? " is-active" : ""}`);
    need.type = "button";
    need.append(el("span", "ui-counter__value", String(needs)), el("span", "ui-counter__label", t("ui.needYou")));
    need.addEventListener("click", () => this.opts.onInbox());
    $("counters").replaceChildren(
      ...(floor ? [counter("rooms", floor.rooms.length, t("ui.rooms"))] : []),
      counter("agents", present.length, t("ui.members")),
      counter("working", working, t("ui.working")),
      need,
    );
  }

  // ---------------------------------------------------------------- side panel

  private renderRooms() {
    const { occupants, floor } = this.last;
    const q = this.query;
    const shown = occupants.filter((o) => !q || o.name.toLowerCase().includes(q) || o.detail.toLowerCase().includes(q));
    // Group by the room each person is in (or heading to) right now.
    const groups = new Map<string, { name: string; hue: number; people: Occupant[] }>();
    for (const r of floor?.rooms ?? []) groups.set(r.id, { name: r.name, hue: r.hue, people: [] });
    const elsewhere = { name: t("ui.everyone"), hue: 220, people: [] as Occupant[] };
    for (const o of shown) {
      const room = floor ? targetRoom(floor, o) : undefined;
      (room ? groups.get(room.id)! : elsewhere).people.push(o);
      if (room) this.rooms.set(o.id, room.name);
    }
    const sections = [...groups.values(), elsewhere].filter((g) => g.people.length || (!q && g !== elsewhere));
    $("rooms").replaceChildren(...sections.map((g) => this.roomCard(g.name, g.hue, g.people)));
    $("empty").hidden = occupants.length > 0;
  }

  private roomCard(name: string, hue: number, people: Occupant[]) {
    const section = el("section", `ui-room${people.length ? "" : " is-empty"}`);
    section.setAttribute("role", "listitem");
    const head = el("div", "ui-room__head");
    head.style.setProperty("--room", `hsl(${hue} 70% 62%)`);
    const line = el("span", "ui-room__line");
    line.append(el("span", "ui-room__name", name), el("span", "ui-room__count", String(people.length)));
    const busy = people.filter((p) => WORKING.has(p.state)).length;
    head.append(line, el("span", "ui-room__path", people.length ? t("ui.roomBusy", { busy: String(busy), count: String(people.length) }) : t("ui.roomEmpty")));
    const list = el("ul", "ui-nodes");
    for (const o of [...people].sort((a, b) => a.name.localeCompare(b.name))) list.append(this.agentRow(o));
    section.append(head, list);
    return section;
  }

  private agentRow(o: Occupant) {
    const li = el("li", "ui-node");
    const look = LOOK[o.state];
    const row = el("button", `ui-agent ${look.dot}`);
    row.type = "button";
    row.title = t(`state.${o.state}`);
    row.addEventListener("click", () => this.opts.onSelect(o.id));
    const main = el("span", "ui-agent__main");
    const top = el("span", "ui-agent__top");
    top.append(el("span", "ui-agent__name", o.name));
    top.append(el("span", `ui-role${o.role ? " ui-role--title" : " ui-role--main"}`, o.role ?? (o.kind === "human" ? t("ui.human") : t("ui.agent"))));
    const activity = el("span", `ui-activity${o.state === "error" ? " is-error" : ""}`);
    activity.append(el("span", "ui-activity__icon", look.icon), el("span", "ui-activity__text", o.detail || t(`state.${o.state}`)));
    main.append(top, activity);
    row.append(avatar(o.id, "md"), main, el("span", `ui-status-dot ${look.dot}`));
    li.append(row);
    if (o.model) {
      const chat = el("button", "ui-btn ui-agent__chat", t("chat.open"));
      chat.type = "button";
      chat.addEventListener("click", () => this.opts.onChat(o.id));
      li.append(chat);
    }
    return li;
  }

  // ---------------------------------------------------------------- feed

  private renderFeed() {
    const { events } = this.last;
    $("events").replaceChildren(
      ...events.map((e) => {
        const li = el("li", `ui-feed__item${e.state === "error" ? " is-error" : ""}`);
        const row = el("button", "ui-feed__row");
        row.type = "button";
        row.addEventListener("click", () => this.opts.onSelect(e.occupantId));
        row.append(
          el("time", "ui-feed__time", formatTime(e.at)),
          avatar(e.occupantId, "xs"),
          el("span", "ui-feed__who", this.names.get(e.occupantId) ?? e.occupantId),
          el("span", "ui-feed__room", this.rooms.get(e.occupantId) ?? ""),
          el("span", "ui-feed__icon", LOOK[e.state].icon),
          el("span", "ui-feed__text", e.detail || t(`state.${e.state}`)),
        );
        li.append(row);
        return li;
      }),
    );
    $("feed-empty").hidden = events.length > 0;
    const latest = events[0];
    $("feed-ticker").textContent = latest ? `${this.names.get(latest.occupantId) ?? latest.occupantId} · ${latest.detail || t(`state.${latest.state}`)}` : "";
  }
}
