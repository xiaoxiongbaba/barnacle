import { z } from "zod";
import type { TaskRunner } from "./agents.js";
import type { Projects } from "./projects.js";
import type { Schedule, ScheduleRule, Store } from "./store.js";

/**
 * Scheduled tasks: "every weekday at 9:00", "every 4 hours", "once on Friday at 17:30". Times are kept in
 * the time zone the schedule was set up in (the browser's), so a server in UTC still fires at your 9:00.
 * When one comes due the agent simply gets the task, and walks to its desk like for any other. A run
 * is skipped if the previous one is still queued or running, so a slow agent doesn't pile up work.
 * A schedule can also start a project each time ("every Monday: @Researcher gathers, @Writer reports"):
 * a new project named after it and the date, so every run has its own thread.
 */

const TICK_MS = 20_000;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

export const ruleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("weekly"), time, days: z.array(z.number().int().min(0).max(6)).min(1).max(7) }),
  z.object({ type: z.literal("interval"), hours: z.number().int().min(1).max(168) }),
  z.object({ type: z.literal("once"), at: z.iso.datetime({ offset: true }) }),
]);

/** A time zone the runtime knows (e.g. "Asia/Taipei"). */
export function validTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of a moment in a time zone. */
function wall(date: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(date)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return parts;
}

/** How far ahead of UTC the zone's clock is at that moment, in ms. */
function offset(date: Date, tz: string) {
  const p = wall(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The moment the zone's clock shows this date and time (twice-checked around daylight-saving changes). */
function zoned(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offset(new Date(guess), tz);
  t = guess - offset(new Date(t), tz);
  return new Date(t);
}

/** Midnight today in a time zone. */
export function startOfDay(tz: string, now = new Date()): Date {
  const p = wall(now, tz);
  return zoned(p.year, p.month, p.day, 0, 0, tz);
}

/** Midnight on the 1st of this month in `tz`. */
export function startOfMonth(tz: string, now = new Date()): Date {
  const p = wall(now, tz);
  return zoned(p.year, p.month, 1, 0, 0, tz);
}

/** When the rule fires next after `after`, or null if never again. */
export function nextRun(rule: ScheduleRule, tz: string, after: Date): Date | null {
  if (rule.type === "once") {
    const at = new Date(rule.at);
    return at > after ? at : null;
  }
  if (rule.type === "interval") return new Date(after.getTime() + rule.hours * 3600_000);
  const [hh, mm] = rule.time.split(":").map(Number);
  const today = wall(after, tz);
  for (let i = 0; i <= 7; i++) {
    // Date.UTC normalises day overflow; the UTC weekday of that date is the zone's weekday for it.
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    if (!rule.days.includes(day.getUTCDay())) continue;
    const at = zoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
    if (at > after) return at;
  }
  return null;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  /** Set once projects exist (they are made after the scheduler). */
  projects: Projects | null = null;

  constructor(
    private store: Store,
    private tasks: TaskRunner,
  ) {}

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fires what is due. A schedule missed while the office was closed fires once, then carries on. */
  tick(now = new Date()) {
    for (const s of this.store.dueSchedules(now.toISOString())) void this.fire(s, now);
  }

  /** Gives the agent the task (or starts the project) now; also used by "Run now". Null if the last run is still going. */
  async fire(s: Schedule, now = new Date(), manual = false): Promise<{ taskId?: number; projectId?: number } | null> {
    const next = manual ? s.nextRunAt : (nextRun(s.rule, s.timeZone, now)?.toISOString() ?? null);
    // A one-off is done once it ran.
    const enabled = s.rule.type === "once" && !manual ? false : s.enabled;
    const previousTask = s.lastTaskId === null ? undefined : this.store.task(s.lastTaskId);
    const previousProject = s.lastProjectId === null ? undefined : this.store.project(s.lastProjectId);
    const busy = s.projectTitle
      ? previousProject && (previousProject.status === "active" || previousProject.status === "planning")
      : previousTask && (previousTask.status === "queued" || previousTask.status === "running");
    if (busy) {
      this.store.updateSchedule(s.id, { nextRunAt: next });
      return null;
    }
    this.store.updateSchedule(s.id, { lastRunAt: now.toISOString(), nextRunAt: next, enabled });
    if (s.projectTitle && this.projects) {
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: s.timeZone, month: "2-digit", day: "2-digit" }).format(now);
      const project = await this.projects.create(`${s.projectTitle} · ${date}`, s.projectBrief, s.prompt);
      this.store.updateSchedule(s.id, { lastProjectId: project.id });
      return { projectId: project.id };
    }
    const task = this.store.occupant(s.occupantId) ? this.tasks.add(s.occupantId, s.title, s.prompt, s.id) : null;
    if (task) this.store.updateSchedule(s.id, { lastTaskId: task.id });
    return task ? { taskId: task.id } : {};
  }
}
