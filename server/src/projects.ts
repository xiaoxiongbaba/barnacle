import { reportModel } from "./costs.js";
import { chat, type AgentTool } from "./ai.js";
import type { Handoff, TaskRunner } from "./agents.js";
import type { Project, ProjectMessage, ProjectPlan, Store, Task } from "./store.js";

/**
 * Projects, after Clawith's group threads: you write a goal and @mention agents. One mention starts that
 * agent; several first go through a planner (one model call, no tools, never doing the work) that writes
 * a plan everyone shares and says who starts. After that the work moves in the open: each member's turn
 * ends with a message in the thread, and an @mention in it hands over to the next member. Members keep
 * their own notes for the project, which everyone can read. Turns are ordinary tasks in each agent's
 * queue, so they show up in the office like any other work.
 */

/** Turns allowed after each message of yours, in total and per member, so nobody ping-pongs forever. */
const MAX_TURNS = 12;
const MAX_TURNS_EACH = 4;
const THREAD_IN_PROMPT = 24;
const MESSAGE_IN_PROMPT = 2500;
const NOTE_MAX = 2000;
const YOU = "you";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const withoutThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();

const GREETING = /^[\s@\p{L}\p{N}_-]*?(hi|hello|hey|你好|您好|哈囉|哈喽|嗨|早安|早上好|おはよう|こんにちは)[\s!！?？。.,，~～]*$/iu;

/** Clawith's planning rules, kept nearly word for word: they stop models inventing busywork. */
const PLANNER_PROMPT = `You are the planning step of a team of AI agents working in a shared project thread.
Return exactly one JSON object and no Markdown. Never do the work yourself.
Use only agent_id values from the candidates you are given.
Return exactly this schema:
{
  "mode": "advisory | enforced",
  "goal": "the collaboration goal",
  "plan": "the complete plan: roles, order, hand-overs, branches and when it is done",
  "entries": [{ "agent_id": "candidate id", "instruction": "what this agent does now" }]
}
Set mode to enforced only when the human explicitly set workflow constraints such as who does what, order, rounds, dependencies or completion conditions. Otherwise use advisory.
Use the simplest plan that does what the human actually asked. Don't invent analysis, synthesis, status reports, reviews or collaboration just because several agents were mentioned.
First silently rewrite the human's goal into clear directives in the order the agents were mentioned: for each, the exact agent, action, input, expected output in the thread, and who goes next. Build goal, plan and entries only from those directives.
An instruction after an @mentioned agent belongs to that agent until the next @mention, unless the human says otherwise. Never swap or move work by candidate order, name, role or perceived skill. "@A write a poem @B translate it" means A writes, hands the poem to B in the thread, and B translates; never the other way round.
When wording is vague, make the smallest literal reading explicit; never resolve doubt by moving work to another agent.
For a greeting or check-in, start the mentioned agents in parallel and have each reply briefly as itself; no hand-overs.
entries starts only the first agent, or the first agents that work in parallel. Later work proceeds by hand-overs in the thread.
Create a hand-over only when a different agent must reply for the task to go on, never from an agent to itself. Each agent writes its own reply and never does or claims another agent's part.
For every hand-over, the plan and the instruction must say which agent to @mention next, what concrete result to pass in the thread, and what that agent must reply with.
The plan must be complete enough for every later agent to read unchanged. Keep the human's explicit constraints; don't add rules of your own.`;

const SUMMARY_PROMPT = `You write the wrap-up of a team's project thread for the human who started it.
Use only what is in the thread; never add facts, links or results of your own.
Markdown: first one line saying what was achieved; then "## Deliverables": each final result, who made it, and the result itself (quote final versions in full when they are short, otherwise their key content); then "## Open points" only if something was left open or someone asked the human a question.
Skip drafts that were replaced by later versions. Be concise.
Write in the language of the human's messages.`;

export interface ProjectDeps {
  store: Store;
  tasks: TaskRunner;
  /** Tells every page a project changed: ids, status and who is in it (never the content). */
  notify: (project: Project, active: string[]) => void;
  handoff: (h: Handoff) => void;
  log: (message: string) => void;
  language: () => "en" | "ja" | "zh-Hant";
}

/** Task titles for hand-overs, in the office's language (the instruction itself stays in English for the model). */
const TAKE_OVER: Record<"en" | "ja" | "zh-Hant", string> = { en: "taking over from {x}", ja: "{x} から引き継ぎ", "zh-Hant": "接手 {x} 的交棒" };

/** Someone mentioned in a text, and where. */
interface Mention {
  id: string;
  at: number;
}

export class Projects {
  constructor(private deps: ProjectDeps) {
    const { tasks } = deps;
    tasks.hooks.prompt = (task) => this.turnPrompt(task);
    tasks.hooks.tools = (task) => this.turnTools(task);
    tasks.hooks.finished = (task) => {
      if (task.kind === "project" && task.projectId !== null) this.turnEnded(task);
    };
    // Turns that were running when the office stopped have failed; settle the projects they were in.
    for (const p of deps.store.projects()) if (p.status === "active" || p.status === "planning") this.refresh(p.id);
  }

  /** Agents that can take part: everyone with a model. */
  private candidates() {
    const { store } = this.deps;
    return store
      .list()
      .filter((o) => o.kind === "agent" && store.brain(o.id))
      .map((o) => ({ id: o.id, name: o.name, role: store.soul(o.id).role }));
  }

  /** @mentions of agents (by name or id, longest names first so "Mock AB" beats "Mock A"), in order; "@you" too. */
  mentions(text: string, exclude?: string): Mention[] {
    const lower = text.toLowerCase();
    const found: Mention[] = [];
    const names = this.candidates()
      .flatMap((c) => [
        { id: c.id, key: c.name.toLowerCase() },
        { id: c.id, key: c.id },
      ])
      .sort((a, b) => b.key.length - a.key.length);
    const taken: [number, number][] = [];
    for (const { id, key } of names) {
      for (let at = lower.indexOf(`@${key}`); at >= 0; at = lower.indexOf(`@${key}`, at + 1)) {
        const end = at + key.length + 1;
        const after = lower[end];
        if (after && /[\p{L}\p{N}_-]/u.test(after) && /^[\p{L}\p{N}_-]+$/u.test(key)) continue;
        if (taken.some(([a, b]) => at < b && a < end)) continue;
        taken.push([at, end]);
        if (id !== exclude) found.push({ id, at });
      }
    }
    for (let at = lower.indexOf("@you"); at >= 0; at = lower.indexOf("@you", at + 1)) found.push({ id: YOU, at });
    found.sort((a, b) => a.at - b.at);
    return found.filter((m, i) => found.findIndex((x) => x.id === m.id) === i);
  }

  /** Starts a project with your first message. */
  async create(title: string, brief: string, message: string): Promise<Project> {
    const project = this.deps.store.addProject(title, brief);
    await this.post(project.id, message);
    return this.deps.store.project(project.id)!;
  }

  /** Your message in a project; mentions start turns (one directly, several through the planner). */
  async post(projectId: number, text: string): Promise<ProjectMessage | undefined> {
    const { store } = this.deps;
    const project = store.project(projectId);
    if (!project) return undefined;
    const message = store.addProjectMessage(projectId, YOU, "message", text);
    const targets = this.mentions(text).filter((m) => m.id !== YOU);
    store.updateProject(projectId, { needsYou: false, status: project.status === "closed" ? "idle" : project.status });
    if (!targets.length) {
      this.refresh(projectId);
      return message;
    }
    this.join(projectId, targets.map((t) => t.id));
    if (targets.length === 1) {
      this.turn(projectId, targets[0].id, text, YOU);
      return message;
    }
    if (GREETING.test(text.replace(/@\S+/g, " "))) {
      for (const t of targets) this.turn(projectId, t.id, "Reply briefly as yourself to the greeting.", YOU);
      return message;
    }
    store.updateProject(projectId, { status: "planning" });
    this.refresh(projectId);
    void this.plan(projectId, text, targets.map((t) => t.id)).catch((error: unknown) => {
      // Without a plan, start only the first mentioned member; the message itself says who goes next.
      this.deps.log(`Project ${projectId} planning failed: ${(error as Error).message}`);
      store.updateProject(projectId, { status: "active" });
      store.addProjectMessage(projectId, "office", "system", `The planner couldn't make a plan (${(error as Error).message}); starting with the first member mentioned.`);
      this.turn(projectId, targets[0].id, `${text}\n\nDo your own part of this, then hand over to the next member as the message says (end with @Name).`, YOU);
    });
    return message;
  }

  /** One model call that arranges the work; falls back to starting everyone mentioned. */
  private async plan(projectId: number, goal: string, ids: string[]) {
    const { store } = this.deps;
    const candidates = this.candidates().filter((c) => ids.includes(c.id));
    // The planner thinks with the first mentioned agent's model.
    const brain = store.brain(ids[0]);
    const provider = brain && store.providerConfig(brain.providerId);
    if (!brain || !provider) throw new Error("no model to plan with");
    const project = store.project(projectId)!;
    const input = JSON.stringify({
      user_goal: goal,
      project_brief: project.brief,
      candidates: candidates.map((c) => ({ agent_id: c.id, name: c.name, role: c.role })),
    });
    let plan: ProjectPlan | null = null;
    let previous = "";
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      const raw = await chat(provider, {
        model: brain.model,
        tag: { occupantId: ids[0], kind: "planner" },
        system: PLANNER_PROMPT,
        maxTokens: Math.max(brain.maxTokens, 2048),
        messages: [{ role: "user", content: previous ? `${input}\n\nYour previous output was invalid (${previous}). Return corrected JSON only.` : input }],
        signal: AbortSignal.timeout(120_000),
        onText: () => {},
      });
      const parsed = parsePlan(withoutThinking(raw), candidates.map((c) => c.id));
      if (typeof parsed === "string") previous = parsed;
      else plan = parsed;
    }
    if (!plan) throw new Error(previous || "no plan");
    store.updateProject(projectId, { plan, status: "active" });
    const names = new Map(candidates.map((c) => [c.id, c.name]));
    const first = plan.entries.map((e) => `@${names.get(e.agentId) ?? e.agentId}: ${e.instruction}`).join("\n");
    store.addProjectMessage(projectId, "planner", "plan", `${plan.plan}\n\n${first}`);
    for (const e of plan.entries) this.turn(projectId, e.agentId, e.instruction, YOU);
  }

  private join(projectId: number, ids: string[]) {
    const p = this.deps.store.project(projectId);
    if (!p) return;
    const members = [...new Set([...p.members, ...ids])];
    if (members.length !== p.members.length) this.deps.store.updateProject(projectId, { members });
  }

  /** Turns taken since your last message, overall and by one member. */
  private turnsSinceYou(projectId: number, occupantId?: string) {
    const { store } = this.deps;
    const lastYou = store
      .projectMessages(projectId)
      .filter((m) => m.author === YOU)
      .at(-1);
    return store.projectTasks(projectId).filter((t) => (!lastYou || t.createdAt >= lastYou.at) && (!occupantId || t.occupantId === occupantId)).length;
  }

  /** Queues a member's turn (unless the limits say stop). */
  private turn(projectId: number, occupantId: string, instruction: string, from: string, label = instruction.split("\n")[0]): Task | null {
    const { store, tasks } = this.deps;
    const project = store.project(projectId);
    if (!project || !store.brain(occupantId)) return null;
    if (this.turnsSinceYou(projectId) >= MAX_TURNS || this.turnsSinceYou(projectId, occupantId) >= MAX_TURNS_EACH) {
      store.addProjectMessage(projectId, "office", "system", `Turn limit reached (${MAX_TURNS} turns, ${MAX_TURNS_EACH} each, after your last message); the hand-over to ${store.occupant(occupantId)?.name ?? occupantId} was not started.`);
      return null;
    }
    this.join(projectId, [occupantId]);
    const task = store.addTask(occupantId, clip(`${project.title}：${label}`, 80), instruction, { kind: "project", projectId });
    if (from !== YOU && from !== occupantId) this.deps.handoff({ from, to: occupantId, kind: "pass" });
    store.updateProject(projectId, { status: project.status === "planning" ? "planning" : "active" });
    // TaskRunner.add would make a new task; this one is already stored, so just wake the queue.
    tasks.wake(task);
    this.refresh(projectId);
    return task;
  }

  /** The thread and plan, as the member reads them when its turn starts. */
  private turnPrompt(task: Task): string | null {
    const { store } = this.deps;
    const project = task.projectId === null ? undefined : store.project(task.projectId);
    if (!project) return null;
    const name = (id: string) => (id === YOU ? "You (the human)" : id === "planner" ? "Planner" : id === "office" ? "Office" : id === "summary" ? "Summary" : (store.occupant(id)?.name ?? id));
    const members = project.members.map((id) => {
      const o = store.occupant(id);
      const role = store.soul(id).role;
      return `- ${o?.name ?? id} (id: ${id})${role ? ` — ${role}` : ""}${id === task.occupantId ? " ← you" : ""}`;
    });
    const notes = Object.entries(store.projectNotes(project.id))
      .filter(([, text]) => text.trim())
      .map(([id, text]) => `### ${name(id)}\n${text}`);
    const thread = store.projectMessages(project.id);
    const shown = thread.slice(-THREAD_IN_PROMPT);
    const lines = shown.map((m) => `[${m.at.slice(0, 16).replace("T", " ")}] ${name(m.author)}${m.kind === "plan" ? " (plan)" : ""}:\n${clip(m.text, MESSAGE_IN_PROMPT)}`);
    return [
      `# Project: ${project.title}`,
      project.brief.trim() && `## About the project (from the human)\n${project.brief.trim()}`,
      project.plan && `## Plan (${project.plan.mode}${project.plan.mode === "enforced" ? ": follow it exactly" : ""})\nGoal: ${project.plan.goal}\n\n${project.plan.plan}`,
      `## Members\n${members.join("\n")}`,
      notes.length && `## Members' notes\n${notes.join("\n\n")}`,
      `## Thread${thread.length > shown.length ? ` (last ${shown.length} of ${thread.length} messages)` : ""}\n${lines.join("\n\n")}`,
      `## Your turn\n${task.prompt}`,
      [
        "## How the thread works",
        "- Your final message is posted to the thread as you. Put your actual result in it (others only see the thread).",
        "- Do your own part only; never do or claim another member's part.",
        "- To hand over, end your message with @Name and exactly what they should do with your result. Hand over only when the plan or the work needs another member; never @ yourself.",
        "- If what was asked is done, say so briefly and mention no one. If you need the human's decision or information, end with @you and your question.",
        "- Use project_note to keep your own notes for this project (decisions, open points); every member reads them.",
      ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private turnTools(task: Task): AgentTool[] {
    const { store } = this.deps;
    const projectId = task.projectId;
    if (projectId === null) return [];
    return [
      {
        name: "project_note",
        description: "Replace your own notes for this project (decisions, open points, where things are). Every member reads them.",
        schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        run: async (input) => {
          const text = String(input.text ?? "").trim();
          if ([...text].length > NOTE_MAX) return `Too long: keep notes under ${NOTE_MAX} characters.`;
          store.saveProjectNote(projectId, task.occupantId, text);
          return "Notes saved.";
        },
      },
    ];
  }

  /** A turn ended: its message goes in the thread, and mentions in it hand over. */
  private turnEnded(task: Task) {
    const { store } = this.deps;
    const projectId = task.projectId!;
    const project = store.project(projectId);
    if (!project) return;
    if (task.status === "done") {
      const text = task.result.trim() || "(no message)";
      store.addProjectMessage(projectId, task.occupantId, "message", text, task.id);
      if (project.status !== "closed") {
        const next = this.mentions(text, task.occupantId);
        if (next.some((m) => m.id === YOU)) store.updateProject(projectId, { needsYou: true });
        const author = store.occupant(task.occupantId)?.name ?? task.occupantId;
        for (const m of next) {
          if (m.id !== YOU) {
            const label = (TAKE_OVER[this.deps.language()] ?? TAKE_OVER.en).replace("{x}", author);
            this.turn(projectId, m.id, `${author} handed over to you in the thread (their last message). Do what they ask of you.`, task.occupantId, label);
          }
        }
      }
    } else if (task.status === "failed") {
      store.addProjectMessage(projectId, "office", "system", `${store.occupant(task.occupantId)?.name ?? task.occupantId} couldn't finish: ${task.error || "unknown error"}`, task.id);
    }
    this.refresh(projectId);
  }

  /** Recomputes a project's status from its turns and tells the pages. */
  refresh(projectId: number) {
    const { store } = this.deps;
    let project = store.project(projectId);
    if (!project) return;
    const open = store.projectTasks(projectId).filter((t) => t.status === "queued" || t.status === "running");
    if (project.status !== "closed" && project.status !== "planning") {
      const status = open.length ? "active" : "idle";
      if (status !== project.status) {
        const wasActive = project.status === "active";
        project = store.updateProject(projectId, { status }) ?? project;
        if (wasActive && status === "idle") void this.summarize(projectId);
      }
    }
    this.deps.notify(project, [...new Set(open.map((t) => t.occupantId))]);
  }

  private summarizing = new Set<number>();

  /**
   * Sums up what the latest round delivered (since your last message), once, when at least two members
   * took part: posted in the thread, kept on the project, and added to each member's searchable past work.
   */
  async summarize(projectId: number) {
    const { store } = this.deps;
    const project = store.project(projectId);
    if (!project || this.summarizing.has(projectId)) return;
    const thread = store.projectMessages(projectId);
    const start = thread.findLastIndex((m) => m.author === YOU);
    const round = thread.slice(Math.max(0, start));
    if (round.some((m) => m.kind === "summary")) return;
    const speakers = new Set(round.filter((m) => m.kind === "message" && m.author !== YOU).map((m) => m.author));
    if (speakers.size < 2) return;
    // Thinks with the model of whoever spoke last.
    const last = [...round].reverse().find((m) => speakers.has(m.author));
    const brain = last && store.brain(last.author);
    const provider = brain && store.providerConfig(brain.providerId);
    if (!brain || !provider) return;
    this.summarizing.add(projectId);
    try {
      const name = (id: string) => (id === YOU ? "Human" : id === "planner" ? "Planner" : (store.occupant(id)?.name ?? id));
      const text = round.map((m) => `${name(m.author)}${m.kind === "plan" ? " (plan)" : ""}:\n${clip(m.text, 6000)}`).join("\n\n---\n\n");
      const raw = await chat(provider, {
        model: reportModel(brain),
        tag: { occupantId: last.author, kind: "summary" },
        system: SUMMARY_PROMPT,
        maxTokens: Math.max(brain.maxTokens, 2048),
        messages: [{ role: "user", content: `# Project: ${project.title}\n${project.brief}\n\n# Thread\n\n${text}` }],
        signal: AbortSignal.timeout(120_000),
        onText: () => {},
      });
      const summary = withoutThinking(raw);
      if (!summary) return;
      const message = store.addProjectMessage(projectId, "summary", "summary", summary);
      store.updateProject(projectId, { summary });
      // Each member finds it again with recall, pointing at their own last turn in the project.
      const turns = store.projectTasks(projectId);
      for (const id of speakers) {
        const turn = turns.filter((t) => t.occupantId === id && t.status === "done").at(-1);
        if (turn) store.index(id, "task", turn.id, `Project summary: ${project.title}\n${summary}`, message.at);
      }
    } catch (error) {
      this.deps.log(`Project ${projectId} summary failed: ${(error as Error).message}`);
    } finally {
      this.summarizing.delete(projectId);
      this.refresh(projectId);
    }
  }

  /** Stops every turn still waiting or running. */
  stop(projectId: number) {
    for (const t of this.deps.store.projectTasks(projectId)) {
      if (t.status === "queued" || t.status === "running") this.deps.tasks.cancel(t.id, "The project was stopped.");
    }
    if (this.deps.store.project(projectId)?.status === "planning") this.deps.store.updateProject(projectId, { status: "idle" });
    this.refresh(projectId);
  }

  /** Members busy with a project's turns right now (for the office: they sit in the meeting room). */
  active(projectId: number) {
    return [...new Set(this.deps.store.projectTasks(projectId).filter((t) => t.status === "queued" || t.status === "running").map((t) => t.occupantId))];
  }
}

/** Checks the planner's JSON: a plan, or why it is unusable. */
export function parsePlan(raw: string, candidates: string[]): ProjectPlan | string {
  const json = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json.slice(json.indexOf("{"), json.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    return "not valid JSON";
  }
  const goal = typeof data.goal === "string" ? data.goal.trim() : "";
  const plan = typeof data.plan === "string" ? data.plan.trim() : "";
  if (!goal || !plan) return "goal and plan are required";
  if (!Array.isArray(data.entries) || !data.entries.length || data.entries.length > 20) return "entries must list 1 to 20 agents";
  const entries: ProjectPlan["entries"] = [];
  for (const e of data.entries as Record<string, unknown>[]) {
    const agentId = String(e?.agent_id ?? "");
    const instruction = String(e?.instruction ?? "").trim();
    if (!candidates.includes(agentId)) return `unknown agent_id ${agentId}`;
    if (!instruction) return "every entry needs an instruction";
    if (!entries.some((x) => x.agentId === agentId)) entries.push({ agentId, instruction: clip(instruction, 4000) });
  }
  return { mode: data.mode === "enforced" ? "enforced" : "advisory", goal: clip(goal, 2000), plan: clip(plan, 12_000), entries };
}
