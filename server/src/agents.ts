import { runAgent, ProviderError, type AgentTool } from "./ai.js";
import type { State } from "./states.js";
import { TEAM_KNOWLEDGE_RULES, type GateContext } from "./governance.js";
import { applyMemory, MEMORY_RULES, MEMORY_SCHEMA, memoryPrompt } from "./memory.js";
import { taskText, type Change, type MemoryEntry, type Skill, type Store, type Task, type TaskStep } from "./store.js";
import { webFetch, webSearch } from "./web-tools.js";

/**
 * Agents with a soul and skills, OpenClaw style: the system prompt is built from the agent's job title,
 * SOUL.md (persona) and AGENTS.md (how it works), plus the list of its skills. Tasks run one at a time
 * per agent; each tool call shows up in the office as a state and a line in the activity feed. Agents
 * also have a layered memory (see memory.ts).
 *
 * They work as a team, after Clawith's agent-to-agent requests: an agent can ask a colleague a quick
 * question or delegate part of its task. The request becomes a sub-task in the colleague's queue; the
 * asking agent's tool call waits for it and carries on with the answer (no polling). Requests can't go
 * back to anyone already in the chain (which would deadlock their queues) and nest at most 3 deep.
 */

const MAX_STEPS = 16;
const ASK_STEPS = 6;
/** Working time per task; time spent waiting for colleagues doesn't count, up to HARD_TIMEOUT_MS. */
const TASK_TIMEOUT_MS = 10 * 60_000;
const HARD_TIMEOUT_MS = 45 * 60_000;
const MAX_RESULT = 20_000;
const MAX_DEPTH = 3;
const MAX_REQUESTS = 4;
const REQUEST_WAIT_MS = 8 * 60_000;
/** Working states are refreshed this often so the office doesn't time them out to idle. */
const HEARTBEAT_MS = 30_000;

type Lang = "en" | "ja" | "zh-Hant";

/** Words for the activity feed, in the office's language (the feed shows them as they are). */
const WORDS: Record<Lang, Record<"project" | "askTo" | "delegateTo" | "gotBack" | "noAnswer" | "askedBy" | "delegatedBy" | "scheduled" | "working" | "skill" | "search" | "fetch" | "memory" | "forget" | "recall" | "knowledge" | "readFile" | "file" | "mcp" | "done" | "failed", string>> = {
  en: { project: "📋 Project: {x}", askTo: "Asking {x}", delegateTo: "Handing to {x}", gotBack: "Got it back from {x}", noAnswer: "No answer from {x}", askedBy: "Question from {x}", delegatedBy: "Helping {x}", scheduled: "⏰ On schedule: {x}", working: "Working on: {x}", skill: "Using skill {x}", search: "Searching: {x}", fetch: "Reading {x}", memory: "Remembered: {x}", forget: "Tidied up memory", recall: "Looking back: {x}", knowledge: "Knowledge base: {x}", mcp: "Using {x}", readFile: "Reading attachment {x}", file: "Saving file {x}", done: "Done: {x}", failed: "Failed: {x}" },
  ja: { project: "📋 プロジェクト：{x}", askTo: "{x} に質問", delegateTo: "{x} に依頼", gotBack: "{x} から受け取り", noAnswer: "{x} から返事なし", askedBy: "{x} から質問", delegatedBy: "{x} を手伝い中", scheduled: "⏰ 定時タスク：{x}", working: "作業中：{x}", skill: "スキル「{x}」を使用", search: "検索：{x}", fetch: "{x} を閲覧", memory: "記憶：{x}", forget: "記憶を整理", recall: "振り返り：{x}", knowledge: "社内資料を検索：{x}", mcp: "{x} を使用", readFile: "添付 {x} を読む", file: "ファイル保存：{x}", done: "完了：{x}", failed: "失敗：{x}" },
  "zh-Hant": { project: "📋 項目：{x}", askTo: "請教 {x}", delegateTo: "請 {x} 幫忙", gotBack: "{x} 交回了結果", noAnswer: "{x} 沒有回覆", askedBy: "{x} 來問問題", delegatedBy: "幫 {x} 做事", scheduled: "⏰ 定時任務：{x}", working: "處理中：{x}", skill: "使用技能「{x}」", search: "搜尋：{x}", fetch: "閱讀 {x}", memory: "記住了：{x}", forget: "整理了記憶", recall: "翻記憶：{x}", knowledge: "查知識庫：{x}", mcp: "使用 {x}", readFile: "讀附件 {x}", file: "存檔：{x}", done: "完成：{x}", failed: "失敗：{x}" },
};

/** Some models (MiniMax, DeepSeek R1, Qwen…) put their reasoning in <think> tags; it isn't part of the delivery. */
const withoutThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();

/** "Monday, 26 October 2026, 09:00 (Asia/Taipei)", for the prompt. */
function now(timeZone?: string) {
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const text = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date());
  return `${text} (${tz})`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A teammate as others see it. */
export interface Colleague {
  id: string;
  name: string;
  role: string;
  skills: string[];
  busy: boolean;
}

export interface AgentProfile {
  name: string;
  role: string;
  soul: string;
  instructions: string;
  extra: string;
  skills: Skill[];
  memory: MemoryEntry[];
  colleagues: Colleague[];
}

function teamPrompt(colleagues: Colleague[], canRequest: boolean, mode: "chat" | "task") {
  const list = colleagues
    .map((c) => `- ${c.name} (id: ${c.id})${c.role ? ` — ${c.role}` : ""}${c.skills.length ? `; skills: ${c.skills.join(", ")}` : ""}${mode === "task" ? (c.busy ? "; busy now (a request waits in their queue)" : "; free now") : ""}`)
    .join("\n");
  if (mode === "chat" || !canRequest) return `# Your colleagues\n${list}`;
  return [
    "# Your colleagues",
    "You work in a team. When part of your task clearly fits a colleague's role or skills better than yours, hand it to them:",
    "- ask_colleague: a quick question with a short answer.",
    "- delegate: a piece of work whose result you then use.",
    "Each call waits until they are done and gives you their answer. They can't see your task, chat or memory: give them everything they need (the goal, the inputs, what the result should look like).",
    `Do the work yourself when you can. Don't delegate just to have something reviewed or to split work for its own sake, and never hand over your whole task. At most ${MAX_REQUESTS} requests per task.`,
    list,
  ].join("\n");
}

/** The system prompt for chatting or working. */
export function systemPrompt(p: AgentProfile, office: string, mode: "chat" | "task", opts: { timeZone?: string; canRequest?: boolean } = {}) {
  const timeZone = opts.timeZone;
  const parts = [
    `You are ${p.name}${p.role ? `, the ${p.role}` : ""}, an AI teammate in the pixel-art office "${office}".`,
    `It is now ${now(timeZone)}.`,
    p.soul.trim() && `# Soul\n${p.soul.trim()}`,
    p.instructions.trim() && `# How you work\n${p.instructions.trim()}`,
    p.extra.trim(),
  ];
  if (p.skills.length) {
    const list = p.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    parts.push(
      mode === "task"
        ? `# Skills\nWhen a task matches one of your skills, call read_skill with its name first and follow its instructions.\n${list}`
        : `# Skills\nYou are skilled at:\n${list}`,
    );
  }
  if (p.colleagues.length) parts.push(teamPrompt(p.colleagues, opts.canRequest ?? false, mode));
  parts.push(memoryPrompt(p.memory));
  if (mode === "task") {
    parts.push(MEMORY_RULES, TEAM_KNOWLEDGE_RULES);
    parts.push(
      [
        "# Working on a task",
        "- Work on your own until the task is done; don't ask questions back, make reasonable assumptions and state them.",
        "- Use web_search and web_fetch for facts you aren't sure about, recent events and anything that needs a source. Never invent facts or links.",
        "- For anything about your own company (its products, prices, policies, customers, past material), search_knowledge first and cite the documents you use as [document name].",
        "- When the task asks for a document, a spreadsheet or a file, also save it with write_file (docx, xlsx, csv or md).",
        "- Your final message is your delivery: complete, well structured (Markdown), ready to use.",
        "- Write in the language the task is written in.",
      ].join("\n"),
    );
  } else {
    parts.push(
      "Reply in the language the user writes in. You can't change your memory in a chat; if the user wants you to remember something, tell them to add it under Memory in your panel, or to give it to you as a task.",
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Someone walks over to a colleague: with a question, with work, or bringing the result back. */
export interface Handoff {
  from: string;
  to: string;
  /** pass: a hand-over in a project thread (nobody waits for it). */
  kind: "ask" | "delegate" | "return" | "pass";
}

export interface TaskDeps {
  store: Store;
  /** Tells every page someone hands something to someone (names only, never the content). */
  handoff?: (h: Handoff) => void;
  publish: (change: Change) => void;
  /** Tells every page a task changed (only ids and status; the content needs the token). */
  notify: (task: Task) => void;
  officeName: () => string;
  language: () => Lang;
}

/** Runs agents' tasks: one at a time per agent, in the order given. */
export class TaskRunner {
  private running = new Map<string, { task: number; controller: AbortController }>();
  /** Requests being waited for: sub-task id → who is waiting. */
  private waiters = new Map<number, (task: Task) => void>();
  /** Lets projects shape their turns: the prompt at run time, extra tools, and what happens when one ends. */
  hooks: {
    prompt?: (task: Task) => string | null;
    tools?: (task: Task) => AgentTool[];
    finished?: (task: Task) => void;
    /** Tools every task gets (the experience library, proposing skills, files); `step` shows a line in the feed. */
    extraTools?: (task: Task, step: (text: string) => void, signal: AbortSignal) => AgentTool[];
    /**
     * The budget: null lets work go on; otherwise why it can't (over budget and not approved). Asked when a
     * task starts (it fails) and before each tool call (the agent is told to finish).
     */
    budget?: (task: Task, ctx: GateContext, starting: boolean) => Promise<string | null>;
    /** The model for this task: the member's lighter model for routine work, if they have one. */
    model?: (task: Task, brain: { model: string; lightModel?: string | null }) => string;
    /** What comes with a task: text added to its prompt and images (attached files). */
    prepare?: (task: Task) => { note: string; images: { mime: string; data: string }[] };
    /** Checks a tool call against the office's policy before it runs: null runs it, a string replaces its result. */
    gate?: (task: Task, tool: string, input: Record<string, unknown>, ctx: GateContext) => Promise<string | null>;
  } = {};

  constructor(private deps: TaskDeps) {
    deps.store.failInterrupted("The office restarted while this task was running.");
  }

  /** Picks up tasks left in the queue (after a restart); requests whose asker is gone are dropped. */
  resume() {
    const { store } = this.deps;
    // The tasks that asked were running, so the restart failed them: nobody waits for these any more.
    for (const t of store.queuedTasks()) {
      if (t.parentTaskId !== null) store.updateTask(t.id, { status: "cancelled", error: "The colleague who asked stopped waiting.", finishedAt: new Date().toISOString() });
    }
    for (const t of store.queuedTasks()) this.next(t.occupantId);
  }

  /** Agents with a model, other than this one. */
  colleagues(occupantId: string): Colleague[] {
    const { store } = this.deps;
    const skills = new Map(store.skills().map((s) => [s.id, s.name]));
    return store
      .list()
      .filter((o) => o.kind === "agent" && o.id !== occupantId && store.brain(o.id))
      .map((o) => ({
        id: o.id,
        name: o.name,
        role: store.soul(o.id).role,
        skills: store.agentSkills(o.id).flatMap((id) => skills.get(id) ?? []),
        busy: this.running.has(o.id),
      }));
  }

  profile(occupantId: string): AgentProfile | null {
    const { store } = this.deps;
    const occupant = store.occupant(occupantId);
    if (!occupant) return null;
    const soul = store.soul(occupantId);
    const ids = new Set(store.agentSkills(occupantId));
    return {
      name: occupant.name,
      role: soul.role,
      soul: soul.soul,
      instructions: soul.instructions,
      extra: store.brain(occupantId)?.systemPrompt ?? "",
      skills: store.skills().filter((s) => ids.has(s.id)),
      memory: store.memories(occupantId),
      colleagues: this.colleagues(occupantId),
    };
  }

  add(occupantId: string, title: string, prompt: string, scheduleId: number | null = null): Task {
    const task = this.deps.store.addTask(occupantId, title, prompt, { scheduleId });
    this.deps.notify(task);
    this.next(occupantId);
    return task;
  }

  /** Tells the pages a task changed outside a run (e.g. you reviewed it). */
  touch(task: Task) {
    this.deps.notify(task);
  }

  /** A task stored elsewhere (a project turn): tell the pages and start it if its agent is free. */
  wake(task: Task) {
    this.deps.notify(task);
    this.next(task.occupantId);
  }

  /** Cancels a task and the requests it is waiting for. */
  cancel(id: number, reason = ""): Task | undefined {
    const { store } = this.deps;
    const task = store.task(id);
    if (!task || (task.status !== "queued" && task.status !== "running")) return task;
    const run = this.running.get(task.occupantId);
    if (run?.task === id) run.controller.abort();
    const next = store.updateTask(id, { status: "cancelled", error: reason, finishedAt: new Date().toISOString() });
    if (next) {
      this.deps.notify(next);
      this.settle(next);
    }
    for (const child of store.childTasks(id)) this.cancel(child.id, "The colleague who asked stopped waiting.");
    return next;
  }

  /** A task ended: whoever waits for it carries on. */
  private settle(task: Task) {
    this.hooks.finished?.(task);
    const waiter = this.waiters.get(task.id);
    if (!waiter) return;
    this.waiters.delete(task.id);
    waiter(task);
  }

  /** The agents in a task's chain of requests, from the task itself up to the one you gave. */
  private chain(task: Task): string[] {
    const ids = [task.occupantId];
    for (let t: Task | undefined = task; t?.parentTaskId != null; ) {
      t = this.deps.store.task(t.parentTaskId);
      if (t) ids.push(t.occupantId);
    }
    return ids;
  }

  /**
   * Asks a colleague (or delegates to one) from inside a running task, and waits for the answer.
   * Returns what the model should read: the answer, or why there is none.
   */
  private async request(
    parent: Task,
    input: { colleague: string; text: string; context: string; kind: "ask" | "delegate" },
    ctx: { signal: AbortSignal; step: (kind: TaskStep["kind"], text: string, state: State, ref?: TaskStep["ref"]) => void; say: (key: keyof (typeof WORDS)["en"], x: string) => string; count: { n: number }; waited: { ms: number; since: number } },
  ): Promise<string> {
    const { store } = this.deps;
    const wanted = input.colleague.trim().toLowerCase();
    const team = this.colleagues(parent.occupantId);
    const target = team.find((c) => c.id === wanted) ?? team.find((c) => c.name.toLowerCase() === wanted) ?? team.find((c) => c.role.toLowerCase() === wanted);
    if (!target) return `No colleague called "${input.colleague}". Your colleagues: ${team.map((c) => `${c.name} (${c.id})`).join(", ") || "none"}.`;
    if (!input.text.trim()) return input.kind === "ask" ? "Give the question." : "Describe the work to hand over.";
    if (this.chain(parent).includes(target.id)) return `${target.name} is already part of this request chain (they are waiting on this work); do it yourself.`;
    if (ctx.count.n >= MAX_REQUESTS) return `You have used all ${MAX_REQUESTS} requests for this task; finish it yourself.`;
    ctx.count.n++;

    const me = store.occupant(parent.occupantId);
    const myName = me?.name ?? parent.occupantId;
    const myRole = store.soul(parent.occupantId).role;
    const from = `${myName}${myRole ? ` (${myRole})` : ""}`;
    const prompt =
      input.kind === "ask"
        ? `Your colleague ${from} has a quick question:\n\n${input.text.trim()}${input.context.trim() ? `\n\nContext:\n${input.context.trim()}` : ""}\n\nAnswer briefly and directly (a few sentences or a short list). Use tools only if you really need to.`
        : `Your colleague ${from} asks you to do this, as part of their task "${parent.title}":\n\n${input.text.trim()}${input.context.trim() ? `\n\nContext from ${myName}:\n${input.context.trim()}` : ""}\n\nDeliver a complete result; ${myName} will use it in their own work.`;
    const title = clip(input.text.trim().split("\n")[0], 60);
    const child = store.addTask(target.id, title, prompt, { kind: input.kind, parentTaskId: parent.id, requestedBy: parent.occupantId, depth: parent.depth + 1 });
    this.deps.notify(child);
    ctx.step(input.kind === "ask" ? "ask" : "delegate", ctx.say(input.kind === "ask" ? "askTo" : "delegateTo", `${target.name}：${title}`), "researching", { occupantId: target.id, taskId: child.id });
    this.deps.handoff?.({ from: parent.occupantId, to: target.id, kind: input.kind });

    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<Task | "timeout" | "stopped">((resolve) => {
      this.waiters.set(child.id, resolve);
      timer = setTimeout(() => resolve("timeout"), REQUEST_WAIT_MS);
      ctx.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
    ctx.waited.since = Date.now();
    this.next(target.id);
    const outcome = await done;
    clearTimeout(timer);
    ctx.waited.ms += Date.now() - ctx.waited.since;
    ctx.waited.since = 0;
    this.waiters.delete(child.id);

    if (outcome === "stopped") {
      this.cancel(child.id, "The colleague who asked stopped waiting.");
      throw new Error("stopped");
    }
    if (outcome === "timeout") {
      this.cancel(child.id, "Took too long; the colleague who asked moved on.");
      ctx.step("handback", ctx.say("noAnswer", target.name), "researching", { occupantId: target.id, taskId: child.id });
      return `${target.name} didn't finish within ${REQUEST_WAIT_MS / 60_000} minutes; carry on without it.`;
    }
    if (outcome.status !== "done") {
      ctx.step("handback", ctx.say("noAnswer", target.name), "researching", { occupantId: target.id, taskId: child.id });
      return `${target.name} couldn't do it (${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}). Carry on without it.`;
    }
    ctx.step("handback", ctx.say("gotBack", target.name), "researching", { occupantId: target.id, taskId: child.id });
    this.deps.handoff?.({ from: target.id, to: parent.occupantId, kind: "return" });
    return `${target.name}'s answer:\n\n${clip(outcome.result, 12_000)}`;
  }

  private next(occupantId: string) {
    if (this.running.has(occupantId)) return;
    const task = this.deps.store.queuedTasks().find((t) => t.occupantId === occupantId);
    if (task) void this.run(task);
  }

  private async run(task: Task) {
    const { store, publish, notify } = this.deps;
    const words = WORDS[this.deps.language()] ?? WORDS.en;
    const say = (key: keyof typeof words, x: string) => words[key].replace("{x}", clip(x, 60));
    const controller = new AbortController();
    this.running.set(task.occupantId, { task: task.id, controller });
    const started = Date.now();
    const waited = { ms: 0, since: 0 };
    const requests = { n: 0 };
    let shown: { state: State; detail: string } = { state: "writing", detail: "" };
    let beat = Date.now();
    // Times out on working time (not time spent waiting for colleagues), and keeps the state fresh.
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      const waiting = waited.ms + (waited.since ? Date.now() - waited.since : 0);
      if (elapsed - waiting > TASK_TIMEOUT_MS || elapsed > HARD_TIMEOUT_MS) controller.abort();
      if (Date.now() - beat >= HEARTBEAT_MS) {
        beat = Date.now();
        publish(store.report(task.occupantId, shown));
      }
    }, 5000);
    const steps: TaskStep[] = [];
    const step = (kind: TaskStep["kind"], text: string, state: State, ref?: TaskStep["ref"], url?: string, skill?: string) => {
      steps.push({ kind, text, at: new Date().toISOString(), ...(ref ? { ref } : {}), ...(url ? { url } : {}), ...(skill ? { skill } : {}) });
      const t = store.updateTask(task.id, { steps });
      if (t) notify(t);
      shown = { state, detail: text };
      beat = Date.now();
      publish(store.report(task.occupantId, shown));
    };

    let current = store.updateTask(task.id, { status: "running", startedAt: new Date().toISOString() });
    if (current) notify(current);
    try {
      const brain = store.brain(task.occupantId);
      const provider = brain && store.providerConfig(brain.providerId);
      const profile = this.profile(task.occupantId);
      if (!brain || !provider || !profile) throw new ProviderError("This agent has no model yet. Give it one in Settings → Members.");
      const schedule = task.scheduleId === null ? undefined : store.schedule(task.scheduleId);
      const asker = task.requestedBy ? (store.occupant(task.requestedBy)?.name ?? task.requestedBy) : "";
      const parentRef = task.parentTaskId !== null && task.requestedBy ? { occupantId: task.requestedBy, taskId: task.parentTaskId } : undefined;
      if (task.kind === "ask") step("think", say("askedBy", `${asker}：${task.title}`), "writing", parentRef);
      else if (task.kind === "delegate") step("think", say("delegatedBy", `${asker}：${task.title}`), "writing", parentRef);
      else if (task.kind === "project") step("think", say("project", task.title), "writing");
      else step("think", say(schedule ? "scheduled" : "working", task.title), "writing");
      const canRequest = task.depth < MAX_DEPTH && profile.colleagues.length > 0;
      const budget = this.hooks.budget;
      if (budget) {
        const stop = await budget(task, { signal: controller.signal, step, waited }, true);
        if (stop) throw new ProviderError(stop);
      }

      const tools: AgentTool[] = [
        {
          name: "read_skill",
          description: "Read the full instructions of one of your skills (by its name) before using it.",
          schema: { type: "object", properties: { name: { type: "string", description: "The skill's name" } }, required: ["name"] },
          run: async (input) => {
            const name = String(input.name ?? "");
            const skill = profile.skills.find((s) => s.name === name || s.id === name);
            return skill ? skill.body : `No skill called "${name}". Your skills: ${profile.skills.map((s) => s.name).join(", ") || "none"}.`;
          },
        },
        {
          name: "web_search",
          description: "Search the web. Returns titles, links and snippets; open the useful ones with web_fetch.",
          schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          run: async (input) => {
            const results = await webSearch(String(input.query ?? ""), controller.signal);
            return results.length ? results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n") : "No results.";
          },
        },
        {
          name: "web_fetch",
          description: "Read a web page (http/https) as plain text.",
          schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          run: (input) => webFetch(String(input.url ?? ""), controller.signal),
        },
        {
          name: "memory",
          description: "Save, update or remove an entry in your long-term memory (it is loaded into every future task).",
          schema: MEMORY_SCHEMA,
          run: async (input) => {
            const { reply, changed } = applyMemory(store, task.occupantId, input);
            if (changed) step("memory", say("memory", changed), "writing");
            else if (reply.startsWith("Removed")) step("memory", say("forget", ""), "writing");
            return reply;
          },
        },
        {
          name: "recall",
          description: "Search your past tasks and chats (full text) and get excerpts with dates; then open a past task in full with task_id.",
          schema: {
            type: "object",
            properties: { query: { type: "string", description: "Words to look for" }, task_id: { type: "number", description: "Open this past task in full (from a search hit)" } },
          },
          run: async (input) => {
            if (input.task_id !== undefined) {
              const past = store.task(Number(input.task_id));
              if (!past || past.occupantId !== task.occupantId || past.status !== "done") return "No such finished task of yours.";
              return clip(taskText(past), 8000);
            }
            const hits = store.recall(task.occupantId, String(input.query ?? ""));
            return hits.length ? hits.map((h) => `[${h.kind} #${h.ref}, ${h.at.slice(0, 10)}] ${h.snippet}`).join("\n\n") : "Nothing found.";
          },
        },
      ];
      if (task.kind === "project") tools.push(...(this.hooks.tools?.(task) ?? []));
      tools.push(...(this.hooks.extraTools?.(task, (x) => step("search", say("knowledge", x), "researching"), controller.signal) ?? []));
      if (canRequest) {
        const colleague = { type: "string", description: "The colleague's id or name" };
        const context = { type: "string", description: "Anything they need to know: background, inputs, constraints, the form of the answer" };
        const ctx = { signal: controller.signal, step, say, count: requests, waited };
        tools.push(
          {
            name: "ask_colleague",
            description: "Ask a colleague a quick question and wait for their short answer.",
            schema: { type: "object", properties: { colleague, question: { type: "string" }, context }, required: ["colleague", "question"] },
            run: (input) => this.request(task, { colleague: String(input.colleague ?? ""), text: String(input.question ?? ""), context: String(input.context ?? ""), kind: "ask" }, ctx),
          },
          {
            name: "delegate",
            description: "Hand a piece of work to a colleague and wait for their result, then carry on with it.",
            schema: { type: "object", properties: { colleague, task: { type: "string", description: "What to do, self-contained" }, context }, required: ["colleague", "task"] },
            run: (input) => this.request(task, { colleague: String(input.colleague ?? ""), text: String(input.task ?? ""), context: String(input.context ?? ""), kind: "delegate" }, ctx),
          },
        );
      }

      // Every call passes the office's policy first (some wait for your approval).
      const gate = this.hooks.gate;
      const gated: AgentTool[] = tools.map((tool) => ({
        ...tool,
        run: async (input) => {
          const ctx = { signal: controller.signal, step, waited };
          const stop = (budget && (await budget(task, ctx, false))) || (gate && (await gate(task, tool.name, input, ctx)));
          return stop || tool.run(input);
        },
      }));
      const attached = this.hooks.prepare?.(task) ?? { note: "", images: [] };
      const result = await runAgent(provider, {
        model: this.hooks.model?.(task, brain) ?? brain.model,
        tag: { occupantId: task.occupantId, taskId: task.id, kind: "task" },
        system: systemPrompt(profile, this.deps.officeName(), "task", { timeZone: schedule?.timeZone, canRequest }),
        prompt: ((task.kind === "project" ? this.hooks.prompt?.(task) : null) ?? task.prompt) + attached.note,
        images: attached.images,
        maxTokens: Math.max(brain.maxTokens, 2048),
        tools: gated,
        maxSteps: task.kind === "ask" ? ASK_STEPS : MAX_STEPS,
        nearEnd: "Two tool rounds left. If you learned something worth remembering (a preference, a correction, a lesson), save it with memory now; then finish.",
        signal: controller.signal,
        onTool: (name, input) => {
          if (name === "recall") step("recall", say("recall", input.task_id !== undefined ? `#${String(input.task_id)}` : String(input.query ?? "")), "researching");
          else if (name.startsWith("mcp__")) step("mcp", say("mcp", name.replace(/^mcp__/, "").replace("__", " → ")), "researching");
          else if (name === "write_file") step("file", say("file", String(input.name ?? "")), "writing");
          else if (name === "read_file") step("fetch", say("readFile", `#${String(input.file_id ?? "")}`), "researching");
          else if (name === "read_skill") {
            const skill = profile.skills.find((s) => s.name === input.name || s.id === input.name);
            step("skill", say("skill", String(input.name ?? "")), "researching", undefined, undefined, skill?.id);
          }
          else if (name === "web_search") step("search", say("search", String(input.query ?? "")), "researching");
          else if (name === "web_fetch") {
            let host = String(input.url ?? "");
            try {
              host = new URL(host).hostname;
            } catch {
              // Shown as given.
            }
            step("fetch", say("fetch", host), "researching", undefined, String(input.url ?? "").slice(0, 500));
          }
        },
      });
      if (store.task(task.id)?.status === "cancelled") return;
      current = store.updateTask(task.id, { status: "done", result: clip(withoutThinking(result) || "(no answer)", MAX_RESULT), finishedAt: new Date().toISOString() });
      if (current) {
        notify(current);
        store.index(task.occupantId, "task", task.id, taskText(current), current.finishedAt ?? new Date().toISOString());
        this.settle(current);
      }
      publish(store.report(task.occupantId, { state: "idle", detail: say("done", task.title) }));
    } catch (error) {
      if (store.task(task.id)?.status === "cancelled") {
        publish(store.report(task.occupantId, { state: "idle" }));
        return;
      }
      const message = controller.signal.aborted ? "The task took too long and was stopped." : error instanceof Error ? error.message : "Unexpected error.";
      current = store.updateTask(task.id, { status: "failed", error: message.slice(0, 500), finishedAt: new Date().toISOString() });
      if (current) {
        notify(current);
        this.settle(current);
      }
      for (const child of store.childTasks(task.id)) this.cancel(child.id, "The colleague who asked stopped waiting.");
      publish(store.report(task.occupantId, { state: "error", detail: say("failed", task.title) }));
    } finally {
      clearInterval(timer);
      this.running.delete(task.occupantId);
      this.next(task.occupantId);
    }
  }
}
