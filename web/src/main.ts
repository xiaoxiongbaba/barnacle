import "@fontsource/pixelify-sans/500.css";
import "@fontsource/pixelify-sans/600.css";
import Phaser from "phaser";
import { ChatDialog } from "./chat";
import { Drawer, relativeTime } from "./drawer";
import { deskLabel, targetRoom } from "./floor/model";
import { DeskMenu } from "./desk-ui";
import { api, Unauthorized } from "./auth";
import type { FloorArt } from "./floor/art";
import { AtlasArt } from "./floor/art-atlas";
import { HabbArt } from "./floor/art-habblaud";
import { MapEditor } from "./floor/editor";
import { FloorScene } from "./floor/floor-scene";
import type { Floor } from "./floor/model";
import { initLanguage, language, LANGUAGE_NAMES, LANGUAGES, onLanguageChange, setLanguage, t, type Language } from "./i18n";
import { connect } from "./net";
import { OfficeScene } from "./office-scene";
import { applyIcons, Panel } from "./panel";
import { ProjectsList } from "./projects";
import { ResultsBoard } from "./results";
import { Headquarters } from "./org-ui";
import { Wizard } from "./wizard";
import { SettingsDialog } from "./settings";
import type { Occupant, Office, OfficeEvent, ProjectSummary, ServerMessage } from "./types";

/** What both scenes can do; the floor scene adds camera and editing. */
interface Stage {
  setOccupants(occupants: Occupant[]): void;
  upsert(occupant: Occupant): void;
  remove(id: string): void;
  refreshLanguage(): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const occupants = new Map<string, Occupant>();
let events: OfficeEvent[] = [];
let floor: Floor | null = null;
let stage: Stage | null = null;
let floorScene: FloorScene | null = null;
let pending: (() => void)[] = [];
let started: { scene: string; pack: string; art: string } | null = null;
/** The office as last received (its organization roles, among others). */
let office: Office | null = null;
let editor: MapEditor | null = null;

const sorted = () => [...occupants.values()].sort((a, b) => a.name.localeCompare(b.name));
const withStage = (fn: (s: Stage) => void) => (stage ? fn(stage) : pending.push(() => fn(stage!)));
const settings = new SettingsDialog(sorted, () => floor);
const chat = new ChatDialog(settings, (id) => occupants.get(id));
const ui = $("ui");
/** Below this width the side panel and the drawer float over the office (like Habblaud on small screens). */
const narrow = window.matchMedia("(max-width: 900px)");

const select = (id: string) => {
  drawer.open(id);
  floorScene?.focus(id);
  if (narrow.matches) setPanel("has-sidebar", false);
};
const panel = new Panel({
  onSelect: select,
  onChat: (id) => void chat.open(id),
  onInbox: () => drawer.openInbox(),
});
const drawer = new Drawer({
  nameOf: (id) => occupants.get(id)?.name ?? id,
  agents: () => sorted().filter((o) => o.kind === "agent" && o.model),
  waiting: () => sorted().filter((o) => o.state === "waiting"),
  isChairman: (id) => !!office?.org?.enabled && office.org.chairman === id,
  openHeadquarters: () => void hq.open(),
  orgTitle: (id) => {
    const org = office?.org;
    if (!org?.enabled) return null;
    if (org.chairman === id) return t("org.chairman").replace(/（.*）|\(.*\)/, "").trim();
    if (org.ceo === id) return t("org.ceo");
    const room = Object.entries(org.managers).find(([, m]) => m === id)?.[0];
    const name = room && floor?.rooms.find((r) => r.id === room)?.name;
    return name ? t("org.managerOf", { room: name }) : null;
  },
  deskLabel: (id) => {
    const chair = floor?.desks?.[id];
    return chair ? labelOf(chair) : null;
  },
  pickDesk: (id) => void pickDesk(id),
  onBrain: (id) => void settings.openBrain(id),
  roomOf: (o) => (floor ? (targetRoom(floor, o)?.name ?? null) : null),
  onFocus: (id) => floorScene?.focus(id),
  onChat: (id) => void chat.open(id),
  unlock: () => settings.ensureUnlocked(),
  onSoul: (id) => void settings.openSoul(id),
  onToggle: (open) => {
    ui.classList.toggle("has-drawer", open);
    floorScene?.setInsets(insets());
  },
});

/** Running projects (who is in which; no titles): their members meet in the meeting room. */
let projects = new Map<number, ProjectSummary>();
const projectsList = new ProjectsList($("projects"), {
  onOpen: (id) => drawer.openProject(id),
  unlock: () => settings.ensureUnlocked(),
});
void projectsList.load();
/** "Research · desk 3" for a chair. */
const labelOf = (chair: { x: number; y: number }) => {
  if (!floor) return "";
  const { room, number } = deskLabel(floor, chair);
  return t("desk.label", { room: room?.name ?? "—", n: String(number) });
};

/** Puts someone at a desk (a chair tile); taking someone's desk swaps the two. */
async function moveDesk(id: string, chair: { x: number; y: number }) {
  try {
    await api("PUT", `/api/desks/${encodeURIComponent(id)}`, chair);
  } catch (err) {
    if (err instanceof Unauthorized) {
      await settings.ensureUnlocked();
      return moveDesk(id, chair);
    }
    alert((err as Error).message);
  }
}

/** Lets you click a new desk for someone in the office. */
async function pickDesk(id: string) {
  if (!floorScene) return;
  deskMenu.picking(t("desk.pick", { name: occupants.get(id)?.name ?? id }));
  const chair = await floorScene.pickDesk(id);
  deskMenu.picking(null);
  if (chair) await moveDesk(id, chair);
}

const deskMenu = new DeskMenu({
  occupants: sorted,
  label: labelOf,
  deskOf: (id) => floor?.desks?.[id],
  workstation: (id) => {
    drawer.openWorkbench(id);
    floorScene?.focus(id);
  },
  details: (id) => select(id),
  move: (id) => void pickDesk(id),
  assign: (id, chair) => void moveDesk(id, chair),
});

const hq = new Headquarters({
  occupants: sorted,
  nameOf: (id) => occupants.get(id)?.name ?? id,
  relativeTime: (at) => relativeTime(at),
  unlock: () => settings.ensureUnlocked(),
  openAgent: (id) => select(id),
  openProject: (id) => drawer.openProject(id),
  openResult: (id) => void results.open(id),
  openOrgSettings: () => {
    hq.close();
    void settings.openOrg();
  },
  openCostSettings: () => {
    hq.close();
    void settings.open("costs");
  },
});

const wizard = new Wizard({
  officeName: () => office?.name ?? "Barnacle",
  roomName: (id) => floor?.rooms.find((r) => r.id === id)?.name ?? id,
  unlock: () => settings.ensureUnlocked(),
  openHeadquarters: () => void hq.open(),
});
$("open-wizard").addEventListener("click", () => {
  settings.close();
  void wizard.open();
});

const results = new ResultsBoard({
  occupants: sorted,
  nameOf: (id) => occupants.get(id)?.name ?? id,
  relativeTime: (at) => relativeTime(at),
  unlock: () => settings.ensureUnlocked(),
  openAgent: (id) => select(id),
  openProject: (id) => drawer.openProject(id),
  roomName: (id) => floor?.rooms.find((r) => r.id === id)?.name ?? id,
});
$("open-results").addEventListener("click", () => void results.open());
void results.refreshBadge();
const applyProjects = () => withStage(() => floorScene?.setProjects([...projects.values()]));

const langSelect = $<HTMLSelectElement>("lang-select");
langSelect.addEventListener("change", () => setLanguage(langSelect.value as Language));

function render() {
  panel.render(sorted(), events, floor);
  settings.refreshOccupants();
  chat.refresh();
}

onLanguageChange(() => {
  langSelect.replaceChildren(...LANGUAGES.map((l) => new Option(LANGUAGE_NAMES[l], l, false, l === language())));
  panel.refreshLanguage();
  stage?.refreshLanguage();
  if (editor?.isOpen) editor.refreshLanguage();
  render();
});

// ------------------------------------------------------------------ panels and toolbar

/** The space the floating panels cover, so "fit" frames the office in what's left of the screen. */
function insets() {
  const gap = 10;
  const sidebar = ui.classList.contains("has-sidebar") || editor?.isOpen;
  const feed = ui.classList.contains("has-feed");
  // The top bar wraps to two rows on phones; the feed opens taller there (see ui.css).
  const top = document.querySelector<HTMLElement>(".ui-topbar")?.offsetHeight ?? 64;
  const feedH = feed ? (window.innerWidth <= 600 ? window.innerHeight * 0.44 : 200) : 38;
  if (narrow.matches) return { left: 0, top, right: 0, bottom: feedH + gap * 2 };
  return { left: sidebar ? 304 + gap * 2 : 0, top, right: drawer?.openId ? 380 + gap * 2 : 0, bottom: feedH + gap * 2 };
}

function setPanel(cls: "has-sidebar" | "has-feed", on: boolean) {
  ui.classList.toggle(cls, on);
  if (cls === "has-sidebar") $("toggle-sidebar").setAttribute("aria-pressed", String(on));
  else {
    $("toggle-feed").setAttribute("aria-pressed", String(on));
    const collapse = $("feed-collapse");
    collapse.setAttribute("aria-expanded", String(on));
    collapse.dataset.icon = on ? "chevronDown" : "chevronUp";
    applyIcons(collapse.parentElement!);
  }
  floorScene?.setInsets(insets());
}

$("toggle-sidebar").addEventListener("click", () => setPanel("has-sidebar", !ui.classList.contains("has-sidebar")));
for (const id of ["sidebar-close", "scrim"]) $(id).addEventListener("click", () => setPanel("has-sidebar", false));
const applyNarrow = () => {
  ui.classList.toggle("is-narrow", narrow.matches);
  // On small screens the side panel starts closed and opens over the office.
  setPanel("has-sidebar", !narrow.matches);
};
narrow.addEventListener("change", applyNarrow);
applyNarrow();
for (const id of ["toggle-feed", "feed-collapse", "feed-title"]) $(id).addEventListener("click", () => setPanel("has-feed", !ui.classList.contains("has-feed")));
setPanel("has-feed", true);

$("zoom-in").addEventListener("click", () => floorScene?.zoomBy(1.2));
$("zoom-out").addEventListener("click", () => floorScene?.zoomBy(1 / 1.2));
$("zoom-fit").addEventListener("click", () => floorScene?.fit());
$("edit-floor").addEventListener("click", () => {
  void (async () => {
    if (!editor || !floor || editor.isOpen) return;
    await settings.ensureUnlocked();
    $("edit-floor").setAttribute("aria-pressed", "true");
    ui.classList.add("is-editing");
    editor.open(floor);
    floorScene?.setInsets(insets());
  })();
});

// ------------------------------------------------------------------ scenes

function startGame(msg: Extract<ServerMessage, { type: "snapshot" }>) {
  const office = msg.office;
  const useFloor = office.scene === "floor";
  document.body.classList.toggle("mode-floor", useFloor);
  $("camera-tools").hidden = !useFloor;
  $("edit-floor").hidden = !useFloor;
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    pixelArt: true,
    backgroundColor: "#12151d",
    ...(useFloor
      ? { scale: { mode: Phaser.Scale.RESIZE } }
      : { width: office.layout.width, height: office.layout.height, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_HORIZONTALLY } }),
  });
  const onReady = (s: Stage) => () => {
    stage = s;
    for (const fn of pending) fn();
    pending = [];
  };
  if (useFloor) {
    const scene = new FloorScene();
    floorScene = scene;
    scene.onPerson = (id) => select(id);
    scene.onDesk = (ws, owner, part, at) => {
      // The computer opens its owner's workstation (the chairman's: the chairman's desk); a chair (or a free desk) opens the menu.
      const o = owner ? occupants.get(owner) : undefined;
      const inChairman = floor?.rooms.find((r) => r.id === "chairman" && ws.chair.x >= r.x && ws.chair.y >= r.y && ws.chair.x < r.x + r.w && ws.chair.y < r.y + r.h);
      if (inChairman && part === "computer") void hq.open();
      else if (o && o.kind === "agent" && part === "computer") {
        drawer.openWorkbench(o.id);
        scene.focus(o.id);
      } else deskMenu.open(ws, owner, at);
    };
    const art: FloorArt = office.floorArt ? new AtlasArt(office.floorArt.atlas, office.floorArt.base) : new HabbArt();
    if (art.credit) {
      const credit = $<HTMLAnchorElement>("credit");
      credit.textContent = art.credit.text;
      credit.href = art.credit.url;
      credit.hidden = false;
    }
    game.scene.add("floor", scene, true, { floor: office.floor, art, insets: insets(), onReady: onReady(scene) });
    editor = new MapEditor(scene, ui, {
      save: (f) => settings.saveFloor(f),
      nameOf: (id) => occupants.get(id)?.name ?? id,
      closed: () => {
        $("edit-floor").setAttribute("aria-pressed", "false");
        ui.classList.remove("is-editing");
        scene.setInsets(insets());
      },
    });
  } else {
    const scene = new OfficeScene();
    game.scene.add("office", scene, true, { layout: office.layout, onReady: onReady(scene) });
  }
}

function handle(msg: ServerMessage) {
  switch (msg.type) {
    case "snapshot": {
      // Switching scene or art pack means a different world; the simplest correct thing is to start over.
      const art = msg.office.floorArt?.id ?? "builtin";
      if (started && (msg.office.scene !== started.scene || art !== started.art || (msg.office.scene === "pack" && msg.office.pack !== started.pack))) {
        location.reload();
        return;
      }
      panel.setOfficeName(msg.office.name);
      office = msg.office;
      occupants.clear();
      for (const o of msg.occupants) occupants.set(o.id, o);
      events = msg.events;
      floor = msg.office.floor;
      if (!started) {
        started = { scene: msg.office.scene, pack: msg.office.pack, art };
        initLanguage(msg.office.language);
        startGame(msg);
      } else {
        // While the map editor is open it shows its own draft.
        if (!editor?.isOpen) floorScene?.setFloor(msg.office.floor);
      }
      settings.refreshFloor();
      withStage((s) => s.setOccupants(sorted()));
      projects = new Map((msg.projects ?? []).map((p) => [p.id, p]));
      // First time on this office with no team yet: offer to start a company.
      wizard.maybeOpen(msg.occupants.some((o) => o.kind === "agent" && o.model));
      withStage(() => floorScene?.setOrg(msg.office.org));
      hq.changed();
      panel.setInbox(msg.inbox ?? 0);
      applyProjects();
      projectsList.changed();
      break;
    }
    case "costs":
      hq.changed();
      return;
    case "mcp":
      settings.mcpChanged();
      return;
    case "report":
    case "decision":
      hq.changed();
      drawer.inboxChanged();
      return;
    case "inbox":
      panel.setInbox(msg.count);
      drawer.inboxChanged();
      hq.changed();
      return;
    case "project":
      if (msg.project.status === "closed") projects.delete(msg.project.id);
      else projects.set(msg.project.id, msg.project);
      applyProjects();
      projectsList.changed();
      drawer.projectChanged(msg.project.id);
      return;
    case "occupant":
      occupants.set(msg.occupant.id, msg.occupant);
      withStage((s) => s.upsert(msg.occupant));
      drawer.refresh(msg.occupant);
      break;
    case "removed":
      occupants.delete(msg.id);
      withStage((s) => s.remove(msg.id));
      break;
    case "task":
      drawer.taskChanged(msg.task.occupantId);
      void results.taskChanged(msg.task.id, msg.task.status);
      return;
    case "handoff":
      floorScene?.handoff(msg);
      return;
    case "event":
      events = [msg.event, ...events].slice(0, 100);
      break;
  }
  render();
}

connect(handle, (up) => panel.setConnected(up));
