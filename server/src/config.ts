import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(repoRoot, "data"));
mkdirSync(dataDir, { recursive: true });

/**
 * Process-level configuration from the environment. Values that can also be changed in the
 * page (name, language, pack, timeouts) are only defaults here; see settings.ts.
 */
export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: intFromEnv("PORT", 19100),
  dataDir,
  webDir: path.resolve(process.env.WEB_DIR ?? path.join(repoRoot, "web/dist")),
  integrationsDir: path.join(repoRoot, "integrations"),
  /** Every folder under here with a layout.json is a selectable pack. */
  packsRoot: path.resolve(process.env.PACKS_ROOT ?? path.join(repoRoot, "packs")),
  defaults: {
    officeName: process.env.BARNACLE_NAME ?? "My Barnacle",
    language: process.env.BARNACLE_LANG ?? "en",
    packDir: path.resolve(process.env.PACK_DIR ?? path.join(repoRoot, "packs/base")),
    stateTtlSeconds: intFromEnv("STATE_TTL_SECONDS", 300),
    offlineAfterSeconds: intFromEnv("OFFLINE_AFTER_SECONDS", 1800),
  },
};

const secretFile = path.join(config.dataDir, "secret.json");

/** True when the token comes from BARNACLE_TOKEN and therefore cannot be rotated from the page. */
export const tokenFromEnv = Boolean(process.env.BARNACLE_TOKEN);

/**
 * The write token. There are no default credentials: a random token is generated on
 * first start and stored in DATA_DIR/secret.json, unless BARNACLE_TOKEN is set.
 */
export function loadToken(log: (msg: string) => void): string {
  const fromEnv = process.env.BARNACLE_TOKEN;
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error("BARNACLE_TOKEN must be at least 32 characters");
    return fromEnv;
  }
  if (existsSync(secretFile)) {
    const saved = JSON.parse(readFileSync(secretFile, "utf8")) as { token?: string };
    if (saved.token && saved.token.length >= 32) return saved.token;
  }
  const token = writeNewToken();
  log(`Generated a new office token (stored in ${secretFile}):\n\n    ${token}\n\nAgents need it to report state.`);
  return token;
}

/** Replaces the stored token with a fresh random one. */
export function writeNewToken(): string {
  const token = randomBytes(32).toString("hex");
  writeFileSync(secretFile, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  return token;
}
