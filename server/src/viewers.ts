import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { sign } from "./crypto.js";
import type { Store } from "./store.js";

/**
 * A password to view the office. When it is on, everything that shows the office — the API's reads and
 * the live updates — needs either the office token or a viewer session: a signed, HttpOnly cookie that
 * entering the password gives for 30 days. Viewers can watch, never change anything (that still needs
 * the token). The password is kept as a salted scrypt hash; changing it, or "sign out everyone", ends
 * every viewer session. Wrong passwords are slowed down per address.
 */

const COOKIE = "barnacle_view";
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
/** Reachable without a session: the health check and signing in. */
const OPEN = ["/api/health", "/api/view/"];

interface Viewing {
  enabled: boolean;
  /** scrypt(password, salt), base64. */
  hash: string | null;
  salt: string | null;
  /** Bumped to sign everyone out. */
  generation: number;
}

const OFF: Viewing = { enabled: false, hash: null, salt: null, generation: 1 };

interface Deps {
  store: Store;
  hasToken: (req: FastifyRequest) => boolean;
  requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** Live updates go to signed-in viewers only: close them when everyone is signed out. */
  dropViewers: () => void;
}

const hashOf = (password: string, salt: string) => scryptSync(password, salt, 32).toString("base64");

function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const passwordBody = z.object({ password: z.string().min(1).max(200) });
const configBody = z.object({
  enabled: z.boolean().optional(),
  /** A new password (8 characters at least). */
  password: z.string().min(8).max(200).optional(),
});

export class Viewers {
  private failures = new Map<string, { n: number; since: number }>();

  constructor(private deps: Deps) {}

  private viewing(): Viewing {
    const saved = this.deps.store.settings().viewing as Partial<Viewing> | undefined;
    return { ...OFF, ...(saved ?? {}) };
  }

  private save(v: Viewing) {
    this.deps.store.saveSettings({ viewing: v });
  }

  /** Whether viewing needs a password now. */
  required() {
    const v = this.viewing();
    return v.enabled && !!v.hash;
  }

  /** The cookie's signature covers its expiry, the sign-out generation and the password itself. */
  private signature(expires: number, v: Viewing) {
    return sign(`view:${expires}:${v.generation}:${v.hash}`);
  }

  private session(req: FastifyRequest): boolean {
    const raw = cookies(req)[COOKIE];
    if (!raw) return false;
    const [exp, gen, mac] = raw.split(".");
    const v = this.viewing();
    const expires = Number(exp);
    if (!expires || expires < Date.now() || Number(gen) !== v.generation || !mac) return false;
    const want = Buffer.from(this.signature(expires, v));
    const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** May this request see the office? */
  allowed(req: FastifyRequest) {
    return !this.required() || this.deps.hasToken(req) || this.session(req);
  }

  private setCookie(req: FastifyRequest, reply: FastifyReply) {
    const v = this.viewing();
    const expires = Date.now() + SESSION_DAYS * 86_400_000;
    const secure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
    reply.header(
      "set-cookie",
      `${COOKIE}=${expires}.${v.generation}.${this.signature(expires, v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure ? "; Secure" : ""}`,
    );
  }

  register(app: FastifyInstance) {
    const { requireToken } = this.deps;

    // The gate: reads of the office and the live updates need a session (or the token) when it's on.
    app.addHook("onRequest", async (req, reply) => {
      const path = req.url.split("?")[0];
      const guarded = path === "/ws" || (path.startsWith("/api/") && !OPEN.some((p) => path === p || path.startsWith(p)));
      if (guarded && !this.allowed(req)) return reply.code(401).send({ error: "This office needs a password to view.", view: true });
    });

    /** Whether the page must ask for the password. */
    app.get("/api/view/status", async (req) => ({ required: this.required(), ok: this.allowed(req) }));

    app.post("/api/view/login", async (req, reply) => {
      const ip = req.ip;
      const f = this.failures.get(ip);
      if (f && Date.now() - f.since < FAILURE_WINDOW_MS && f.n >= MAX_FAILURES) {
        return reply.code(429).send({ error: "Too many wrong passwords; try again in a few minutes." });
      }
      const body = passwordBody.safeParse(req.body);
      const v = this.viewing();
      if (!body.success || !v.hash || !v.salt) return reply.code(400).send({ error: "no password" });
      const want = Buffer.from(v.hash, "base64");
      const got = Buffer.from(hashOf(body.data.password, v.salt), "base64");
      if (want.length !== got.length || !timingSafeEqual(want, got)) {
        const n = f && Date.now() - f.since < FAILURE_WINDOW_MS ? f.n + 1 : 1;
        this.failures.set(ip, { n, since: n === 1 ? Date.now() : (f?.since ?? Date.now()) });
        return reply.code(401).send({ error: "Wrong password." });
      }
      this.failures.delete(ip);
      this.setCookie(req, reply);
      return { ok: true };
    });

    /** Someone with the office token gets a viewer session too (the live updates need one). */
    app.post("/api/view/session", { preHandler: requireToken }, async (req, reply) => {
      if (this.required()) this.setCookie(req, reply);
      return { ok: true };
    });

    app.post("/api/view/logout", async (_req, reply) => {
      reply.header("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return { ok: true };
    });

    /** For Settings → Security (never the hash). */
    app.get("/api/view/config", { preHandler: requireToken }, async () => {
      const v = this.viewing();
      return { enabled: v.enabled, hasPassword: !!v.hash };
    });

    app.put("/api/view/config", { preHandler: requireToken }, async (req, reply) => {
      const body = configBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      const v = this.viewing();
      const next: Viewing = { ...v };
      if (body.data.password) {
        next.salt = randomBytes(16).toString("base64");
        next.hash = hashOf(body.data.password, next.salt);
      }
      if (body.data.enabled !== undefined) next.enabled = body.data.enabled;
      if (next.enabled && !next.hash) return reply.code(400).send({ error: "Set a password first." });
      this.save(next);
      // A new password ends every viewer session (its hash is part of their signature); you keep yours.
      if (next.enabled) this.setCookie(req, reply);
      // Open live connections reconnect through the gate (yours comes back with the cookie set above).
      if (next.enabled && (body.data.password || !v.enabled)) this.deps.dropViewers();
      return { enabled: next.enabled, hasPassword: !!next.hash };
    });

    /** Ends every viewer session (you stay signed in). */
    app.post("/api/view/signout-all", { preHandler: requireToken }, async (req, reply) => {
      const v = this.viewing();
      this.save({ ...v, generation: v.generation + 1 });
      if (this.required()) this.setCookie(req, reply);
      this.deps.dropViewers();
      return { ok: true };
    });
  }
}
