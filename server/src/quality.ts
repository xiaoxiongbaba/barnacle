import { chat } from "./ai.js";
import type { Handoff, TaskRunner } from "./agents.js";
import type { Governance } from "./governance.js";
import type { Department } from "./org.js";
import type { Settings } from "./settings.js";
import type { Change, Store, Task } from "./store.js";

/**
 * The department manager checks members' deliveries before they reach you (where you turned it on for
 * the department): work that passes lands in your results page with the manager's note; work that
 * doesn't is sent straight back for a redo, with the reason going into the member's memory. After two
 * rounds sent back it comes to you anyway, with what is still wrong, so nothing loops for ever.
 */

type Org = Settings["org"];
type Lang = Org["language"];

const MAX_ROUNDS = 2;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const withoutThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
const LANGUAGE_NAMES: Record<Lang, string> = { "zh-Hant": "Traditional Chinese", en: "English", ja: "Japanese" };

const WORDS: Record<Lang, { checking: string; passed: string; sentBack: string; gaveUp: string; failed: string }> = {
  en: { checking: "📋 Checking: {x}", passed: "📋 {m} checked it: {x}", sentBack: "↩ {m} sent it back: {x}", gaveUp: "📋 {m} passed it on after {n} rounds: {x}", failed: "📋 {m} couldn't check it ({x}); passed on." },
  ja: { checking: "📋 確認中：{x}", passed: "📋 {m} が確認済み：{x}", sentBack: "↩ {m} が差し戻し：{x}", gaveUp: "📋 {m} が {n} 回差し戻した後に上げました：{x}", failed: "📋 {m} は確認できませんでした（{x}）。そのまま上げます。" },
  "zh-Hant": { checking: "📋 初審：{x}", passed: "📋 {m} 初審通過：{x}", sentBack: "↩ {m} 退回重做：{x}", gaveUp: "📋 {m} 退回 {n} 次後交上去：{x}", failed: "📋 {m} 沒能初審（{x}），直接交上去。" },
};

interface Deps {
  store: Store;
  tasks: TaskRunner;
  governance: Governance;
  org: () => Org;
  /** The department someone's desk is in. */
  departmentOf: (occupantId: string) => Department | null;
  publish: (change: Change) => void;
  handoff: (h: Handoff) => void;
  log: (message: string) => void;
}

export class Quality {
  /** Checks are made one at a time per manager. */
  private queues = new Map<string, Promise<void>>();

  constructor(private deps: Deps) {
    const finished = deps.tasks.hooks.finished;
    deps.tasks.hooks.finished = (task) => {
      const manager = this.reviewer(task);
      if (manager) {
        const held = deps.store.setManagerReview(task.id, "pending", manager) ?? task;
        finished?.(held);
        this.enqueue(held, manager);
        return;
      }
      finished?.(task);
    };
  }

  /** Picks up checks the office was in the middle of when it stopped. */
  resume() {
    const rows = this.deps.store.sql.prepare("SELECT id FROM tasks WHERE manager_review = 'pending'").all() as { id: number }[];
    for (const r of rows) {
      const task = this.deps.store.task(Number(r.id));
      if (task?.managerId) this.enqueue(task, task.managerId);
    }
  }

  /** The manager who checks this delivery first, if any. */
  private reviewer(task: Task): string | null {
    const org = this.deps.org();
    if (!org.enabled || task.kind !== "task" || task.status !== "done" || task.review || task.managerReview) return null;
    const dept = this.deps.departmentOf(task.occupantId);
    if (!dept?.manager || !org.managerReview[dept.room.id] || dept.manager === task.occupantId) return null;
    return this.deps.store.brain(dept.manager) ? dept.manager : null;
  }

  private enqueue(task: Task, manager: string) {
    const prev = this.queues.get(manager) ?? Promise.resolve();
    const next = prev.then(() => this.check(task.id, manager)).catch((error: Error) => this.deps.log(`Manager check of #${task.id} failed: ${error.message}`));
    this.queues.set(manager, next);
  }

  /** The earlier rounds of this work the manager sent back, newest first. */
  private rounds(task: Task): Task[] {
    const out: Task[] = [];
    for (let t = task.redoOf === null ? undefined : this.deps.store.task(task.redoOf); t && out.length < 10; t = t.redoOf === null ? undefined : this.deps.store.task(t.redoOf)) {
      if (t.managerReview === "failed") out.push(t);
    }
    return out;
  }

  private note(task: Task, text: string) {
    const { store } = this.deps;
    const current = store.task(task.id) ?? task;
    return store.updateTask(task.id, { steps: [...current.steps, { kind: "note", text, at: new Date().toISOString() }] });
  }

  private async check(taskId: number, manager: string) {
    const { store, governance, tasks } = this.deps;
    const task = store.task(taskId);
    if (!task || task.managerReview !== "pending") return;
    const lang = this.deps.org().language;
    const w = WORDS[lang] ?? WORDS.en;
    const name = store.occupant(manager)?.name ?? manager;
    const say = (text: string, x: string, n = "") => text.replace("{m}", name).replace("{x}", clip(x, 120)).replace("{n}", n);
    const earlier = this.rounds(task);

    const idle = ["idle", "offline"].includes(store.occupant(manager)?.state ?? "");
    if (idle) this.deps.publish(store.report(manager, { state: "writing", detail: clip(w.checking.replace("{x}", task.title), 80) }));
    this.deps.handoff({ from: task.occupantId, to: manager, kind: "pass" });

    let verdict: { pass: boolean; note: string };
    try {
      verdict = await this.ask(task, manager, earlier, lang);
    } catch (error) {
      const next = store.setManagerReview(task.id, "passed", manager, say(w.failed, (error as Error).message));
      this.finish(next, say(w.failed, (error as Error).message), idle, manager);
      return;
    }

    if (verdict.pass || earlier.length >= MAX_ROUNDS) {
      const text = verdict.pass ? say(w.passed, verdict.note) : say(w.gaveUp, verdict.note, String(earlier.length));
      const next = store.setManagerReview(task.id, "passed", manager, verdict.pass ? verdict.note : text);
      this.finish(next, text, idle, manager);
      return;
    }
    const text = say(w.sentBack, verdict.note);
    store.setManagerReview(task.id, "failed", manager, verdict.note);
    const sent = this.note(task, text);
    if (sent) tasks.touch(sent);
    if (idle) this.deps.publish(store.report(manager, { state: "idle" }));
    this.deps.handoff({ from: manager, to: task.occupantId, kind: "return" });
    governance.redo(store.task(task.id)!, verdict.note, `${name} (my manager) sent back “${task.title}”: ${verdict.note}`);
  }

  /** Passed: the work goes up to you (and to the CEO, for routine deliveries). */
  private finish(task: Task | undefined, text: string, idle: boolean, manager: string) {
    if (!task) return;
    const next = this.note(task, text) ?? task;
    if (idle) this.deps.publish(this.deps.store.report(manager, { state: "idle" }));
    this.deps.tasks.touch(next);
    this.deps.governance.offerDelivery(next);
  }

  private async ask(task: Task, manager: string, earlier: Task[], lang: Lang): Promise<{ pass: boolean; note: string }> {
    const { store } = this.deps;
    const brain = store.brain(manager);
    const provider = brain && store.providerConfig(brain.providerId);
    if (!brain || !provider) throw new Error("no model");
    const dept = this.deps.departmentOf(task.occupantId);
    const member = store.occupant(task.occupantId)?.name ?? task.occupantId;
    const role = store.soul(manager).role;
    const sources = task.steps.filter((s) => s.url).map((s) => s.url!);
    const system = [
      `You are ${store.occupant(manager)?.name ?? manager}${role ? `, ${role},` : ""} the manager of the ${dept?.room.name ?? ""} department. Before a member's work reaches the chairman, you check it.`,
      'Reply with one JSON object and nothing else: {"verdict": "pass" | "redo", "note": "one or two sentences"}.',
      "Send it back (redo) only for a real problem: it doesn't do what was asked, it is clearly incomplete, it states facts or links that look made up or gives no source where one is needed, it is in the wrong language, or its form is unusable. Don't send work back for matters of taste.",
      "For a pass, the note tells the chairman in a sentence what to look at. For a redo, the note tells the member exactly what to fix.",
      `Write the note in ${LANGUAGE_NAMES[lang] ?? "English"}.`,
    ].join("\n");
    const input = [
      `Member: ${member}${store.soul(task.occupantId).role ? ` (${store.soul(task.occupantId).role})` : ""}`,
      `Task: ${task.title}`,
      `What was asked:\n${clip(task.prompt.split("\n---\n")[0], 4000)}`,
      earlier.length ? `You sent earlier versions back ${earlier.length} time(s):\n${earlier.map((t) => `- ${t.managerNote}`).join("\n")}` : "",
      `Pages it read: ${sources.length ? sources.slice(0, 15).join(", ") : "none"}`,
      `The delivery:\n${clip(task.result, 10_000)}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const raw = withoutThinking(
      await chat(provider, {
        model: brain.model,
        tag: { occupantId: manager, taskId: task.id, kind: "review" },
        system,
        maxTokens: Math.max(brain.maxTokens, 1024),
        messages: [{ role: "user", content: input }],
        signal: AbortSignal.timeout(120_000),
        onText: () => {},
      }),
    );
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const data = JSON.parse(json) as { verdict?: string; note?: string };
    return { pass: data.verdict !== "redo", note: clip(String(data.note ?? "").trim() || "—", 400) };
  }
}
