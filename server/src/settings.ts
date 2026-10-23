import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";

export const LANGUAGES = ["en", "ja", "zh-Hant"] as const;

/** Spending limits in US dollars (null: none). */
const limits = z.object({ daily: z.number().min(0).max(1_000_000).nullable().default(null), monthly: z.number().min(0).max(10_000_000).nullable().default(null) });

export const DEFAULT_COSTS = {
  prices: {},
  company: { daily: null, monthly: null },
  rooms: {},
  onExceed: "ask",
  light: { scheduled: true, ask: true, reports: true, project: false },
} as const;

/** Settings people can change in the page. Stored in SQLite; environment variables are the defaults. */
export const settingsSchema = z.object({
  officeName: z.string().trim().min(1).max(60),
  language: z.enum(LANGUAGES),
  pack: z.string().min(1).max(200),
  /** "floor": the room-based office; "pack": a single-picture art pack (classic). */
  scene: z.enum(["floor", "pack"]),
  /** The floor's art: "builtin" (procedural pixel art from Habblaud) or "pack" (an installed atlas pack, e.g. LimeZu). */
  floorArt: z.enum(["builtin", "pack"]).default("builtin"),
  stateTtlSeconds: z.number().int().min(30).max(86_400),
  offlineAfterSeconds: z.number().int().min(60).max(604_800),
  /** What agents may do on their own, per action (see governance.ts): allow, ask you first, or never. */
  toolPolicy: z.record(z.string().max(40), z.enum(["allow", "ask", "deny"])).default({}),
  /** The company: departments (work rooms) with managers who report daily to the chairman (see org.ts). */
  org: z
    .object({
      enabled: z.boolean().default(false),
      /** You: the person whose desk is in the chairman's office. */
      chairman: z.string().max(40).nullable().default(null),
      /** room id → manager (occupant id). */
      managers: z.record(z.string().max(40), z.string().max(40)).default({}),
      reportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("18:00"),
      /** 0 = Sunday … 6 = Saturday. */
      reportDays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
      timeZone: z.string().max(64).default("UTC"),
      /** The language reports are written in (the page's, when you saved). */
      language: z.enum(LANGUAGES).default("en"),
      /** When reports were last made (they cover the time since). */
      lastReportAt: z.string().nullable().default(null),
      /** The CEO: sums up the departments and decides, for you, what you delegated (see ceo.ts). */
      ceo: z.string().max(40).nullable().default(null),
      /** category → what the CEO may decide on its own, and how often a day. */
      delegation: z.record(z.string().max(60), z.object({ enabled: z.boolean(), dailyLimit: z.number().int().min(1).max(200).default(10) })).default({}),
      /** Categories that always come to you, whatever is delegated. */
      highRisk: z.array(z.string().max(60)).default([]),
    })
    .default({
      enabled: false,
      chairman: null,
      managers: {},
      reportTime: "18:00",
      reportDays: [1, 2, 3, 4, 5],
      timeZone: "UTC",
      language: "en",
      lastReportAt: null,
      ceo: null,
      delegation: {},
      highRisk: [],
    }),
  /** What models cost and what the company may spend (see costs.ts). */
  costs: z
    .object({
      /** Your prices, per million tokens in USD, by model name (or part of one); they win over the built-in table. */
      prices: z.record(z.string().trim().min(1).max(120), z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000) })).default({}),
      company: limits.default({ daily: null, monthly: null }),
      /** room id → the department's limits. */
      rooms: z.record(z.string().max(40), limits).default({}),
      /** Over a limit: ask you (or the CEO) before going on, or stop work. */
      onExceed: z.enum(["ask", "pause"]).default("ask"),
      /** Which work uses a member's lighter model (when they have one). */
      light: z
        .object({ scheduled: z.boolean().default(true), ask: z.boolean().default(true), reports: z.boolean().default(true), project: z.boolean().default(false) })
        .default({ scheduled: true, ask: true, reports: true, project: false }),
    })
    .default(structuredClone(DEFAULT_COSTS) as never),
});

export type Settings = z.infer<typeof settingsSchema>;

export interface PackInfo {
  id: string;
  name: string;
  /** Packs under packs/local hold borrowed art that must not be distributed. */
  local: boolean;
}

const CUSTOM_PACK = "custom";

/** Folders under packs/ (one level, plus packs/local/*) that contain a layout.json. */
export function discoverPacks(): PackInfo[] {
  const found: PackInfo[] = [];
  const scan = (dir: string, prefix: string, local: boolean) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (existsSync(path.join(full, "layout.json"))) {
        const layout = JSON.parse(readFileSync(path.join(full, "layout.json"), "utf8")) as { name?: string };
        found.push({ id: prefix + entry.name, name: layout.name ?? entry.name, local });
      }
    }
  };
  scan(config.packsRoot, "", false);
  scan(path.join(config.packsRoot, "local"), "local/", true);
  if (!isInsidePacksRoot(config.defaults.packDir)) found.push({ id: CUSTOM_PACK, name: "PACK_DIR", local: true });
  return found;
}

function isInsidePacksRoot(dir: string): boolean {
  const rel = path.relative(config.packsRoot, dir);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Folder and public URL of a pack id. Ids are validated against discoverPacks() before use. */
export function packLocation(id: string): { dir: string; assetBase: string } {
  if (id === CUSTOM_PACK) return { dir: config.defaults.packDir, assetBase: "/pack-custom/" };
  return { dir: path.join(config.packsRoot, ...id.split("/")), assetBase: `/packs/${id}/` };
}

export function defaultSettings(): Settings {
  const packDir = config.defaults.packDir;
  const pack = isInsidePacksRoot(packDir) ? path.relative(config.packsRoot, packDir).split(path.sep).join("/") : CUSTOM_PACK;
  const language = (LANGUAGES as readonly string[]).includes(config.defaults.language) ? config.defaults.language : "en";
  return {
    officeName: config.defaults.officeName,
    language: language as Settings["language"],
    pack,
    scene: "floor",
    floorArt: "builtin",
    stateTtlSeconds: config.defaults.stateTtlSeconds,
    offlineAfterSeconds: config.defaults.offlineAfterSeconds,
    toolPolicy: {},
    org: { enabled: false, chairman: null, managers: {}, reportTime: "18:00", reportDays: [1, 2, 3, 4, 5], timeZone: "UTC", language: "en", lastReportAt: null, ceo: null, delegation: {}, highRisk: [] },
    costs: structuredClone(DEFAULT_COSTS) as unknown as Settings["costs"],
  };
}

export function loadLayout(packId: string): object {
  const { dir, assetBase } = packLocation(packId);
  return { ...(JSON.parse(readFileSync(path.join(dir, "layout.json"), "utf8")) as object), assetBase };
}

export interface FloorArt {
  id: string;
  /** Public URL prefix for the pack's files. */
  base: string;
  atlas: unknown;
}

/** The first pack (local packs first) that ships an atlas.json for the floor scene, or null for procedural art. */
export function findFloorArt(): FloorArt | null {
  for (const [dir, prefix] of [
    [path.join(config.packsRoot, "local"), "local/"],
    [config.packsRoot, ""],
  ] as const) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name, "atlas.json");
      if (entry.isDirectory() && existsSync(file)) {
        const id = prefix + entry.name;
        return { id, base: `/packs/${id}/`, atlas: JSON.parse(readFileSync(file, "utf8")) as unknown };
      }
    }
  }
  return null;
}
