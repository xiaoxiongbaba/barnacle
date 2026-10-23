import type { Store, Task } from "./store.js";

/**
 * Employee profiles: how someone's work has gone, from the record — deliveries you accepted or sent back
 * (and why), what their manager sent back, what they cost, how long work takes, and which skills and
 * kinds of work go well. For you to adjust their model or job, and for the CEO to judge by.
 */

const DAY = 86_400_000;

export interface Tally {
  key: string;
  name: string;
  done: number;
  accepted: number;
  rejected: number;
}

export interface Profile {
  id: string;
  name: string;
  role: string;
  model: string | null;
  lightModel: string | null;
  room: string | null;
  days: number;
  done: number;
  failed: number;
  open: number;
  accepted: number;
  rejected: number;
  /** Accepted / (accepted + sent back by you), or null with nothing reviewed. */
  acceptance: number | null;
  /** Of the accepted, the share accepted the first time (no redo). */
  firstTry: number | null;
  managerPassed: number;
  managerSentBack: number;
  /** Colleagues' requests answered and project turns taken. */
  helped: number;
  projectTurns: number;
  avgMinutes: number | null;
  cost: number;
  costPerTask: number | null;
  skills: Tally[];
  kinds: Tally[];
  reasons: { taskId: number; title: string; by: "you" | "manager"; note: string; at: string }[];
}

interface Deps {
  store: Store;
  /** What someone spent on models since a time (USD). */
  spent: (occupantId: string, since: Date) => number;
  roomOf: (occupantId: string) => string | null;
}

export class Profiles {
  constructor(private deps: Deps) {}

  profile(id: string, days = 90): Profile | null {
    const { store } = this.deps;
    const occupant = store.occupant(id);
    if (!occupant) return null;
    const since = new Date(Date.now() - days * DAY);
    const all = store.tasks(id, 2000).filter((t) => t.createdAt >= since.toISOString());
    const own = all.filter((t) => t.kind === "task");
    const done = own.filter((t) => t.status === "done");
    // Work the manager sent back was redone; it counts once, as the version that reached you.
    const delivered = done.filter((t) => t.managerReview !== "failed");
    const accepted = delivered.filter((t) => t.review === "accepted");
    const rejected = delivered.filter((t) => t.review === "rejected");
    const minutes = done.filter((t) => t.startedAt && t.finishedAt).map((t) => (Date.parse(t.finishedAt!) - Date.parse(t.startedAt!)) / 60_000);
    const skills = store.skills();
    const skillName = (key: string) => skills.find((s) => s.id === key)?.name ?? key;

    const tally = (key: string, name: string, list: Task[]): Tally => ({
      key,
      name,
      done: list.filter((t) => t.status === "done" && t.managerReview !== "failed").length,
      accepted: list.filter((t) => t.review === "accepted").length,
      rejected: list.filter((t) => t.review === "rejected").length,
    });
    const bySkill = new Map<string, Task[]>();
    for (const t of own) for (const s of new Set(t.steps.filter((x) => x.kind === "skill" && x.skill).map((x) => x.skill!))) bySkill.set(s, [...(bySkill.get(s) ?? []), t]);
    const helping = all.filter((t) => (t.kind === "ask" || t.kind === "delegate") && t.status === "done");
    const turns = all.filter((t) => t.kind === "project" && t.status === "done");

    const reasons = [
      ...own.filter((t) => t.review === "rejected").map((t) => ({ taskId: t.id, title: t.title, by: "you" as const, note: t.reviewNote, at: t.finishedAt ?? t.createdAt })),
      ...own.filter((t) => t.managerReview === "failed").map((t) => ({ taskId: t.id, title: t.title, by: "manager" as const, note: t.managerNote, at: t.finishedAt ?? t.createdAt })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 8);

    const brain = store.brain(id);
    const cost = this.deps.spent(id, since);
    const reviewed = accepted.length + rejected.length;
    return {
      id,
      name: occupant.name,
      role: store.soul(id).role,
      model: brain?.model ?? null,
      lightModel: brain?.lightModel ?? null,
      room: this.deps.roomOf(id),
      days,
      done: delivered.length,
      failed: own.filter((t) => t.status === "failed").length,
      open: own.filter((t) => t.status === "queued" || t.status === "running").length,
      accepted: accepted.length,
      rejected: rejected.length,
      acceptance: reviewed ? accepted.length / reviewed : null,
      firstTry: accepted.length ? accepted.filter((t) => t.redoOf === null).length / accepted.length : null,
      managerPassed: own.filter((t) => t.managerReview === "passed").length,
      managerSentBack: own.filter((t) => t.managerReview === "failed").length,
      helped: helping.length,
      projectTurns: turns.length,
      avgMinutes: minutes.length ? minutes.reduce((a, b) => a + b, 0) / minutes.length : null,
      cost,
      costPerTask: done.length + helping.length + turns.length ? cost / (done.length + helping.length + turns.length) : null,
      skills: [...bySkill]
        .map(([key, list]) => tally(key, skillName(key), list))
        .sort((a, b) => b.accepted - a.accepted || b.done - a.done)
        .slice(0, 8),
      kinds: [
        tally("oneoff", "", own.filter((t) => t.scheduleId === null)),
        tally("scheduled", "", own.filter((t) => t.scheduleId !== null)),
        { key: "helping", name: "", done: helping.length, accepted: 0, rejected: 0 },
        { key: "project", name: "", done: turns.length, accepted: 0, rejected: 0 },
      ].filter((k) => k.done),
      reasons,
    };
  }

  /** Everyone with a model. */
  all(days = 90): Profile[] {
    const { store } = this.deps;
    return store
      .list()
      .filter((o) => o.kind === "agent" && store.brain(o.id))
      .map((o) => this.profile(o.id, days)!)
      .filter(Boolean);
  }

  /** One paragraph for the CEO, about whoever asks for something. */
  summary(id: string): string {
    const p = this.profile(id);
    if (!p) return "";
    const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
    const reasons = p.reasons.slice(0, 3).map((r) => `"${r.note}" (${r.by === "you" ? "chairman" : "manager"})`).join("; ");
    return [
      `Track record of ${p.name} over ${p.days} days: ${p.done} deliveries, ${p.accepted} accepted and ${p.rejected} sent back by the chairman (acceptance ${pct(p.acceptance)}, first try ${pct(p.firstTry)})`,
      p.managerSentBack ? `, ${p.managerSentBack} sent back by their manager` : "",
      `; ${p.failed} failed.`,
      reasons ? ` Recent reasons: ${reasons}.` : "",
    ].join("");
  }
}
