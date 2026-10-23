import type { AgentTool } from "./ai.js";
import type { TaskRunner } from "./agents.js";
import { fits } from "./memory.js";
import { slugify } from "./skills.js";
import type { Change, Decision, Store, Task, TaskStep } from "./store.js";
import type { State } from "./states.js";

/**
 * Keeping agents in check, enforced by the office rather than asked for in the prompt:
 * - a policy per action (allow / ask you first / never); "ask" pauses the task in the "needs you" state
 *   until you approve or deny it in the inbox;
 * - your verdict on deliveries: accept, or send back with a reason (which the agent remembers) for a redo;
 * - a team experience library and skill changes that agents may only propose (after Clawith and Hermes,
 *   without the auto-writing: nothing enters the library or changes a skill until you approve it).
 */

export type Rule = "allow" | "ask" | "deny";

/** The actions the policy covers, and what they are by default. */
export const ACTIONS: Record<string, Rule> = {
  web_search: "allow",
  web_fetch: "allow",
  memory: "allow",
  memory_shared: "ask",
  colleagues: "allow",
  project_note: "allow",
};

const APPROVAL_WAIT_MS = 30 * 60_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Which policy action a tool call is (null: not governed). */
function actionOf(tool: string, input: Record<string, unknown>): string | null {
  if (tool === "memory") return input.target === "user" ? "memory_shared" : "memory";
  if (tool === "ask_colleague" || tool === "delegate") return "colleagues";
  return tool in ACTIONS ? tool : null;
}

/** What a tool call wants to do, in words for the inbox. */
function describe(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => String(input[k] ?? "");
  switch (tool) {
    case "web_search":
      return `Search the web: ${s("query")}`;
    case "web_fetch":
      return `Read a web page: ${s("url")}`;
    case "memory":
      return `${s("action")} ${input.target === "user" ? "in “About you” (shared)" : "in its own memory"}: ${s("content") || s("old_text")}`;
    case "ask_colleague":
      return `Ask ${s("colleague")}: ${s("question")}`;
    case "delegate":
      return `Hand ${s("colleague")} this work: ${s("task")}`;
    case "project_note":
      return `Update its project notes: ${s("text")}`;
    default:
      return `${tool}: ${JSON.stringify(input)}`;
  }
}

export const TEAM_KNOWLEDGE_RULES = [
  "# Team knowledge",
  "- Before work that touches this team's own way of doing things (its processes, products, earlier decisions), search_experience and read the entries that apply.",
  "- When you learned something the whole team should reuse (not a personal preference: those go in memory), propose_experience: the situation, the problem, what worked, and when it holds / signs it no longer does.",
  "- When you worked out a reusable procedure (several steps, recovering from errors, or after a correction), propose_skill (a new one, or a change to one of your skills).",
  "- Proposals wait for a human's approval; never assume they are accepted.",
].join("\n");

/** Something new that waits for a decision (the CEO may take it, if you delegated its category). */
export interface PendingItem {
  category: string;
  refType: Decision["refType"];
  refId: string;
  summary: string;
  /** Who asked (an agent), if anyone. */
  requester: string | null;
  /** More context for whoever decides. */
  detail: string;
}

/** Who decided, and on what grounds (the CEO cites earlier decisions). */
export interface DecisionMeta {
  by: Decision["by"];
  precedents?: number[];
}

export interface GovernanceDeps {
  store: Store;
  tasks: TaskRunner;
  policy: () => Record<string, Rule>;
  publish: (change: Change) => void;
  /** Tells every page how many things wait for you (a count only). */
  inbox: (count: number) => void;
}

/** Inside a running task: how to report a step and count time spent waiting. */
export interface GateContext {
  signal: AbortSignal;
  step: (kind: TaskStep["kind"], text: string, state: State) => void;
  waited: { ms: number; since: number };
}

export class Governance {
  private waiters = new Map<number, (approved: boolean, note: string) => void>();
  /** Rules for tools the policy table doesn't know (MCP servers' tools). */
  extraRule: ((tool: string, input: Record<string, unknown>) => { rule: Rule; summary: string } | null) | null = null;
  /** Set by the CEO: called when something new waits for a decision. */
  onPending: ((item: PendingItem) => void) | null = null;

  constructor(private deps: GovernanceDeps) {
    deps.store.expireApprovals();
    deps.tasks.hooks.gate = (task, tool, input, ctx) => this.gate(task, tool, input, ctx);
    deps.tasks.hooks.extraTools = (task) => this.tools(task);
    // A finished scheduled task is a routine delivery to check.
    const finished = deps.tasks.hooks.finished;
    deps.tasks.hooks.finished = (task) => {
      finished?.(task);
      if (task.kind === "task" && task.scheduleId !== null && task.status === "done" && !task.review) {
        this.onPending?.({
          category: "delivery",
          refType: "task",
          refId: String(task.id),
          summary: task.title,
          requester: task.occupantId,
          detail: `Scheduled task: ${task.title}\n\nWhat was asked:\n${clip(task.prompt, 1500)}\n\nThe delivery:\n${clip(task.result, 4000)}`,
        });
      }
    };
  }

  rule(action: string): Rule {
    return this.deps.policy()[action] ?? ACTIONS[action] ?? "allow";
  }

  /** How many things wait for you. */
  count() {
    const { store } = this.deps;
    return (
      store.approvals("pending").length +
      store.projects().filter((p) => p.needsYou && p.status !== "closed").length +
      store.experiences("draft").length +
      store.skillProposals("pending").length
    );
  }

  changed() {
    this.deps.inbox(this.count());
  }

  /** Null lets the call run; otherwise the text the model reads instead of a result. */
  private async gate(task: Task, tool: string, input: Record<string, unknown>, ctx: GateContext): Promise<string | null> {
    let action = actionOf(tool, input);
    let rule: Rule;
    let summary: string;
    if (action) {
      rule = this.rule(action);
      summary = clip(describe(tool, input), 400);
    } else {
      const extra = this.extraRule?.(tool, input);
      if (!extra) return null;
      action = "mcp";
      rule = extra.rule;
      summary = clip(extra.summary, 400);
    }
    if (rule === "allow") return null;
    if (rule === "deny") return `Not allowed: the office doesn't let agents do this (${action}). Carry on without it and say so in your delivery if it matters.`;

    const result = await this.ask(task, action, summary, `${summary}\n\nThe task it is working on: ${task.title}\n${clip(task.prompt, 1200)}`, ctx);
    if (result.approved) {
      ctx.step("approval", `✅ ${summary}`, "researching");
      return null;
    }
    ctx.step("approval", `🚫 ${summary}`, "researching");
    if (result.how === "timeout") return "Nobody approved this in time; don't do it. Carry on without it and mention it in your delivery.";
    return `The human did not allow this${result.note ? ` (${result.note})` : ""}. Don't try it again; carry on without it.`;
  }

  /**
   * Asks for approval from inside a running task (in the inbox; the CEO may decide it) and waits.
   * Throws "stopped" when the task is stopped meanwhile.
   */
  async ask(task: Task, action: string, summary: string, detail: string, ctx: GateContext): Promise<{ approved: boolean; note: string; how: "decided" | "timeout" }> {
    const { store } = this.deps;
    const approval = store.addApproval({ taskId: task.id, occupantId: task.occupantId, action, summary });
    ctx.step("approval", summary, "waiting");
    this.changed();
    this.onPending?.({ category: `approval:${action}`, refType: "approval", refId: String(approval.id), summary, requester: task.occupantId, detail });
    let timer: NodeJS.Timeout | undefined;
    const decision = new Promise<{ approved: boolean; note: string; how: "decided" | "timeout" | "stopped" }>((resolve) => {
      this.waiters.set(approval.id, (approved, note) => resolve({ approved, note, how: "decided" }));
      timer = setTimeout(() => resolve({ approved: false, note: "", how: "timeout" }), APPROVAL_WAIT_MS);
      ctx.signal.addEventListener("abort", () => resolve({ approved: false, note: "", how: "stopped" }), { once: true });
    });
    ctx.waited.since = Date.now();
    const result = await decision;
    clearTimeout(timer);
    ctx.waited.ms += Date.now() - ctx.waited.since;
    ctx.waited.since = 0;
    this.waiters.delete(approval.id);
    if (result.how !== "decided") store.decideApproval(approval.id, "expired");
    this.changed();
    if (result.how === "stopped") throw new Error("stopped");
    return { approved: result.approved, note: result.note, how: result.how };
  }

  /** An answer to an approval request: yours, or the CEO's. */
  decide(id: number, approved: boolean, note: string, meta: DecisionMeta = { by: "chairman" }) {
    const { store } = this.deps;
    const a = store.approval(id);
    if (!a || a.status !== "pending") return a;
    const next = store.decideApproval(id, approved ? "approved" : "denied", note);
    this.log({ category: `approval:${a.action}`, refType: "approval", refId: String(id), summary: a.summary, decision: approved ? "approve" : "deny", reason: note }, meta);
    this.waiters.get(id)?.(approved, note);
    this.changed();
    return next;
  }

  /** Records a decision (yours are precedents for the CEO; the CEO's can be overruled). */
  log(d: Pick<Decision, "category" | "refType" | "refId" | "summary" | "decision" | "reason">, meta: DecisionMeta, extra: { undo?: Decision["undo"]; overrules?: number | null } = {}) {
    return this.deps.store.addDecision({ ...d, by: meta.by, precedents: meta.precedents ?? [], undo: extra.undo ?? null, overrules: extra.overrules ?? null });
  }

  /** Keeps an experience draft in the library, or not. */
  decideExperience(id: number, approve: boolean, meta: DecisionMeta = { by: "chairman" }, reason = "") {
    const { store } = this.deps;
    const e = store.experience(id);
    if (!e) return undefined;
    const next = store.updateExperience(id, { status: approve ? "approved" : "rejected" });
    if (e.status === "draft") this.log({ category: "experience", refType: "experience", refId: String(id), summary: e.title, decision: approve ? "approve" : "deny", reason }, meta);
    this.changed();
    return next;
  }

  /** Saves a proposed skill (giving a new one to whoever proposed it, if asked), or turns it down. */
  decideSkill(id: number, approve: boolean, assign = true, meta: DecisionMeta = { by: "chairman" }, reason = "") {
    const { store } = this.deps;
    const p = store.skillProposal(id);
    if (!p || p.status !== "pending") return false;
    let undo: Decision["undo"] = null;
    if (approve) {
      let skillId = p.skillId;
      const before = skillId ? store.skill(skillId) : undefined;
      if (!skillId) {
        const base = slugify(p.name);
        skillId = base;
        for (let n = 2; store.skill(skillId); n++) skillId = `${base}-${n}`;
      }
      undo = before ? { skillId, name: before.name, description: before.description, body: before.body } : { skillId, created: true, assignedTo: assign && !p.skillId ? p.proposedBy : null };
      store.saveSkill({ id: skillId, name: p.name, description: p.description, body: p.body });
      if (!p.skillId && assign) store.setAgentSkills(p.proposedBy, [...new Set([...store.agentSkills(p.proposedBy), skillId])]);
    }
    store.decideSkillProposal(p.id, approve ? "approved" : "rejected");
    this.log({ category: "skill", refType: "skill", refId: String(id), summary: `${p.skillId ? "Change" : "New skill"}: ${p.name}`, decision: approve ? "approve" : "deny", reason }, meta, { undo });
    this.changed();
    return true;
  }

  /**
   * Your verdict on a delivery. Sending it back writes your reason into the agent's memory (so it learns)
   * and gives it the task again with its previous delivery and your reason.
   */
  review(taskId: number, verdict: "accepted" | "rejected", note: string, meta: DecisionMeta = { by: "chairman" }): { task?: Task; redo?: Task; error?: string } {
    const { store, tasks } = this.deps;
    const task = store.task(taskId);
    if (!task) return { error: "no such task" };
    if (task.status !== "done") return { error: "only finished tasks can be reviewed" };
    const reviewed = store.reviewTask(taskId, verdict, note);
    if (reviewed) tasks.touch(reviewed);
    this.log({ category: "delivery", refType: "task", refId: String(taskId), summary: task.title, decision: verdict === "accepted" ? "approve" : "deny", reason: note }, meta);
    this.changed();
    if (verdict === "accepted") return { task: reviewed };
    const lesson = clip(`My manager sent back “${task.title}”: ${note || "not good enough"}`, 380);
    if (fits(store.memories(task.occupantId), "memory", lesson)) store.addMemory(task.occupantId, "memory", lesson, "agent");
    const prompt = [
      task.prompt,
      "",
      "---",
      "You delivered this before, and it was sent back.",
      `Reason: ${note || "(none given)"}`,
      "",
      "Your previous delivery:",
      clip(task.result, 8000),
      "",
      "Do it again, fixing what the reason says. Deliver the complete result, not only the changes.",
    ].join("\n");
    const redo = store.addTask(task.occupantId, clip(`↩ ${task.title.replace(/^↩ /, "")}`, 80), prompt, { redoOf: task.id, scheduleId: task.scheduleId });
    tasks.wake(redo);
    return { task: reviewed, redo };
  }

  /** Tools every task gets: the experience library, and proposing skills. */
  private tools(task: Task): AgentTool[] {
    const { store } = this.deps;
    const text = (input: Record<string, unknown>, k: string, n: number) => String(input[k] ?? "").trim().slice(0, n);
    return [
      {
        name: "search_experience",
        description: "Search the team's experience library (approved lessons). Returns titles and when each applies; read the relevant ones with read_experience.",
        schema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
        run: async (input) => {
          const hits = store.searchExperiences(text(input, "keyword", 200));
          return hits.length ? hits.map((e) => `#${e.id} ${e.title}\nApplies: ${clip(e.applicability, 300)}`).join("\n\n") : "Nothing in the library matches.";
        },
      },
      {
        name: "read_experience",
        description: "Read one entry of the team's experience library in full.",
        schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
        run: async (input) => {
          const e = store.experience(Number(input.id));
          return e && e.status === "approved" ? `# ${e.title}\n\n${e.body}\n\n## When it applies / when it no longer does\n${e.applicability}` : "No such entry.";
        },
      },
      {
        name: "propose_experience",
        description: "Propose a lesson for the team's experience library. It is a draft until a human approves it.",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string", description: "Markdown: ## Situation / ## Problem / ## What worked (or whatever fits)" },
            applicability: { type: "string", description: "When this holds, and the signs that it no longer does (required)" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["title", "body", "applicability"],
        },
        run: async (input) => {
          const title = text(input, "title", 120);
          const body = text(input, "body", 8000);
          const applicability = text(input, "applicability", 1000);
          if (!title || !body || !applicability) return "title, body and applicability are all required.";
          const tags = Array.isArray(input.tags) ? input.tags.map((x) => String(x).slice(0, 30)).slice(0, 5) : [];
          const e = store.addExperience({ title, body, applicability, tags, status: "draft", proposedBy: task.occupantId, taskId: task.id });
          this.changed();
          this.onPending?.({
            category: "experience",
            refType: "experience",
            refId: String(e.id),
            summary: title,
            requester: task.occupantId,
            detail: `Proposed lesson: ${title}\n\n${clip(body, 3000)}\n\nWhen it applies: ${applicability}`,
          });
          return "Proposed. A human will review it; it is not in the library yet.";
        },
      },
      {
        name: "propose_skill",
        description: "Propose a new skill (a reusable procedure), or a change to one of your skills (give its name). A human approves it before it is saved.",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string", description: "One line: what it does and when to use it" },
            body: { type: "string", description: "The instructions (Markdown)" },
            reason: { type: "string", description: "Why: what you learned that makes this worth keeping" },
          },
          required: ["name", "description", "body", "reason"],
        },
        run: async (input) => {
          const name = text(input, "name", 60);
          const body = text(input, "body", 60_000);
          if (!name || !body) return "name and body are required.";
          const existing = store.skills().find((s) => s.name.toLowerCase() === name.toLowerCase() || s.id === name);
          const proposal = store.addSkillProposal({
            skillId: existing?.id ?? null,
            name: existing?.name ?? name,
            description: text(input, "description", 500),
            body,
            reason: text(input, "reason", 1000),
            proposedBy: task.occupantId,
            taskId: task.id,
          });
          this.changed();
          this.onPending?.({
            category: "skill",
            refType: "skill",
            refId: String(proposal.id),
            summary: `${existing ? "Change" : "New skill"}: ${existing?.name ?? name}`,
            requester: task.occupantId,
            detail: `${existing ? `Change to the skill “${existing.name}”${existing.editedByYou ? " (the chairman edited it by hand)" : ""}` : "A new skill"}: ${name}\nWhy: ${text(input, "reason", 1000)}\n\n${clip(body, 4000)}${existing ? `\n\nThe current version:\n${clip(existing.body, 3000)}` : ""}`,
          });
          return `Proposed ${existing ? `a change to “${existing.name}”` : "a new skill"}. A human will review it.`;
        },
      },
    ];
  }
}
