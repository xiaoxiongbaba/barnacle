import { reportModel } from "./costs.js";
import { chat } from "./ai.js";
import type { Handoff } from "./agents.js";
import { ACTIONS, type Governance, type PendingItem } from "./governance.js";
import { startOfDay } from "./schedule.js";
import type { Settings } from "./settings.js";
import type { Change, Decision, Report, Store } from "./store.js";

/**
 * The CEO: one of the agents, in the CEO office. It sums up the departments' reports into a company
 * report for the chairman, and decides — on the chairman's behalf — the kinds of things the chairman
 * delegated to it, the way the chairman decided them before (those decisions are its precedents).
 * Without a clear precedent, when a case differs, or when unsure, it hands the decision up. Every
 * decision is logged with its reason and precedents, and the chairman can overrule it.
 */

type Org = Settings["org"];

/** What can be delegated: each permission's approvals, experience drafts, skill proposals, scheduled deliveries. */
export const CATEGORIES = [...Object.keys(ACTIONS).map((a) => `approval:${a}`), "approval:budget", "approval:mcp", "experience", "skill", "delivery"];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const withoutThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
const LANGUAGE_NAMES: Record<Org["language"], string> = { "zh-Hant": "Traditional Chinese", en: "English", ja: "Japanese" };
const PRECEDENTS = 12;

/** The CEO's own words when it hands something up without asking the model, and for overruling. */
const NOTES: Record<Org["language"], { noPrecedent: string; failed: string; carriedOut: string; backToInbox: string }> = {
  "zh-Hant": { noPrecedent: "你還沒決定過這類事，沒有先例可依，交給你決定。", failed: "沒能做出判斷（{x}），交給你決定。", carriedOut: "已經執行，無法撤回；已記為你的先例", backToInbox: "已退回你的收件匣" },
  en: { noPrecedent: "No earlier decision of yours on this kind of thing to follow.", failed: "Couldn't decide ({x}).", carriedOut: "already carried out; recorded as your precedent", backToInbox: "back in your inbox" },
  ja: { noPrecedent: "この種類の判断の前例がないため、あなたに任せます。", failed: "判断できませんでした（{x}）。", carriedOut: "実行済みのため取り消せません。前例として記録しました", backToInbox: "受信箱に戻しました" },
};

const SECTIONS: Record<Org["language"], [string, string, string, string]> = {
  "zh-Hant": ["整體", "各部門重點", "我今天代你決定的事", "需要董事長決定"],
  en: ["Overall", "Departments", "What I decided for you today", "Needs the chairman"],
  ja: ["全体", "各部門のポイント", "今日代わりに決めたこと", "会長の判断が必要"],
};

export interface CeoDeps {
  store: Store;
  governance: Governance;
  org: () => Org;
  publish: (change: Change) => void;
  handoff: (h: Handoff) => void;
  /** Tells the pages a report or a decision was made (ids only). */
  notifyReport: (report: Report) => void;
  notifyDecision: (decision: Decision) => void;
  roomName: (id: string) => string;
  log: (message: string) => void;
}

export class Ceo {
  /** Someone's track record (see profiles.ts), to judge what they ask for. */
  profileLine: ((occupantId: string) => string) | null = null;
  /** A line on what the company spent in a period (see costs.ts). */
  spendLine: ((scope: string, since: string, until: string) => string | null) | null = null;
  /** Decisions are taken one at a time. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private deps: CeoDeps) {
    deps.governance.onPending = (item) => {
      this.queue = this.queue.then(() => this.consider(item)).catch((error: unknown) => deps.log(`CEO: ${(error as Error).message}`));
    };
  }

  private notes() {
    return NOTES[this.deps.org().language] ?? NOTES.en;
  }

  /** The CEO, if there is one that can think (an agent with a model). */
  private ceo(): string | null {
    const org = this.deps.org();
    const id = org.enabled ? org.ceo : null;
    return id && this.deps.store.exists(id) && this.deps.store.brain(id) ? id : null;
  }

  /** How many things of a category the CEO decided today (escalations don't count). */
  private usedToday(category: string) {
    const since = startOfDay(this.deps.org().timeZone).toISOString();
    return this.deps.store.decisions({ category, by: "ceo", since, limit: 500 }).filter((d) => d.decision !== "escalate").length;
  }

  /** Whether the CEO may decide this item, and if not, why. */
  private allowed(item: PendingItem): string | null {
    const org = this.deps.org();
    const ceo = this.ceo();
    if (!ceo) return "no CEO";
    const rule = org.delegation[item.category];
    if (!rule?.enabled) return "not delegated";
    if (org.highRisk.includes(item.category)) return "high risk";
    if (item.requester === ceo) return "its own request";
    if (this.usedToday(item.category) >= rule.dailyLimit) return "daily limit reached";
    return null;
  }

  private async consider(item: PendingItem) {
    if (this.allowed(item)) return;
    const { store, governance } = this.deps;
    const ceo = this.ceo()!;
    // Your decisions on this kind of thing are the precedents; without any, it is yours to decide.
    const precedents = store.decisions({ category: item.category, by: "chairman", limit: PRECEDENTS });
    const occupant = store.occupant(ceo);
    const idle = occupant?.state === "idle" || occupant?.state === "offline";
    if (idle) this.deps.publish(store.report(ceo, { state: "researching", detail: `⚖️ ${clip(item.summary, 60)}` }));
    let verdict: { decision: Decision["decision"]; reason: string; precedents: number[] };
    try {
      verdict = precedents.length ? await this.think(ceo, item, precedents) : { decision: "escalate", reason: this.notes().noPrecedent, precedents: [] };
    } catch (error) {
      verdict = { decision: "escalate", reason: this.notes().failed.replace("{x}", (error as Error).message), precedents: [] };
    } finally {
      if (idle) this.deps.publish(store.report(ceo, { state: "idle" }));
    }
    // The CEO only accepts routine deliveries; sending one back stays with you.
    if (item.category === "delivery" && verdict.decision === "deny") verdict = { ...verdict, decision: "escalate" };
    const meta = { by: "ceo" as const, precedents: verdict.precedents.filter((id) => precedents.some((p) => p.id === id)) };
    const approve = verdict.decision === "approve";
    let logged: Decision | undefined;
    if (verdict.decision === "escalate") {
      logged = governance.log({ category: item.category, refType: item.refType, refId: item.refId, summary: item.summary, decision: "escalate", reason: verdict.reason }, meta);
    } else if (item.refType === "approval") governance.decide(Number(item.refId), approve, verdict.reason, meta);
    else if (item.refType === "experience") governance.decideExperience(Number(item.refId), approve, meta, verdict.reason);
    else if (item.refType === "skill") governance.decideSkill(Number(item.refId), approve, true, meta, verdict.reason);
    else if (item.refType === "task") governance.review(Number(item.refId), "accepted", verdict.reason, meta);
    logged ??= store.decisions({ category: item.category, by: "ceo", limit: 1 })[0];
    if (logged) this.deps.notifyDecision(logged);
  }

  /** One model call: approve, deny or escalate, with a reason and the precedents it followed. */
  private async think(ceo: string, item: PendingItem, precedents: Decision[]) {
    const { store } = this.deps;
    const org = this.deps.org();
    const brain = store.brain(ceo)!;
    const provider = store.providerConfig(brain.providerId);
    if (!provider) throw new Error("the CEO's provider is gone");
    const requester = item.requester ? `${store.occupant(item.requester)?.name ?? item.requester}${store.soul(item.requester).role ? ` (${store.soul(item.requester).role})` : ""}` : "nobody in particular";
    const lessons = store.searchExperiences(item.summary, 3);
    const input = [
      `Category: ${item.category}`,
      `Asked by: ${requester}`,
      item.requester && this.profileLine ? this.profileLine(item.requester) : "",
      `What waits for a decision:\n${clip(item.detail, 6000)}`,
      `The chairman's earlier decisions on this kind of thing (your precedents, newest first):\n${precedents.map((p) => `#${p.id} ${p.decision.toUpperCase()}${p.overrules ? " (overruling the CEO)" : ""}: ${p.summary}${p.reason ? ` — reason: ${p.reason}` : ""}`).join("\n")}`,
      lessons.length ? `From the team's experience library:\n${lessons.map((e) => `- ${e.title}: ${clip(e.applicability, 200)}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const system = [
      `You are ${store.occupant(ceo)?.name ?? ceo}, the CEO. The chairman has let you decide this kind of thing on their behalf. Decide the way the chairman would, following their precedents.`,
      'Reply with one JSON object and nothing else: {"decision": "approve" | "deny" | "escalate", "reason": "one or two sentences", "precedents": [ids of the precedents you followed]}.',
      "Escalate (hand it to the chairman) when no precedent clearly covers this case, when it differs in a way that matters, when it is risky or can't be undone, or when you are unsure. Never approve what a matching precedent denied.",
      `Write the reason in ${LANGUAGE_NAMES[org.language] ?? "English"}.`,
    ].join("\n");
    const raw = withoutThinking(
      await chat(provider, {
        model: brain.model,
        tag: { occupantId: ceo, kind: "ceo" },
        system,
        maxTokens: Math.max(brain.maxTokens, 1024),
        messages: [{ role: "user", content: input }],
        signal: AbortSignal.timeout(120_000),
        onText: () => {},
      }),
    );
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const data = JSON.parse(json) as { decision?: string; reason?: string; precedents?: unknown };
    const decision = data.decision === "approve" || data.decision === "deny" ? data.decision : "escalate";
    return {
      decision: decision as Decision["decision"],
      reason: clip(String(data.reason ?? "").trim() || "(no reason given)", 600),
      precedents: Array.isArray(data.precedents) ? data.precedents.map(Number).filter(Number.isFinite) : [],
    };
  }

  /**
   * You overrule a decision of the CEO's: what can be undone is undone, and your decision becomes a
   * precedent. Returns what happened, for the page.
   */
  overrule(id: number, note: string): { ok: boolean; undone: boolean; message: string } {
    const { store, governance } = this.deps;
    const d = store.decision(id);
    if (!d || d.by !== "ceo" || d.decision === "escalate") return { ok: false, undone: false, message: "Only the CEO's approvals and denials can be overruled." };
    if (d.overruledBy) return { ok: false, undone: false, message: "Already overruled." };
    const opposite = d.decision === "approve" ? "deny" : "approve";
    let undone = false;
    let message = "";
    if (d.refType === "experience") {
      store.updateExperience(Number(d.refId), { status: opposite === "approve" ? "approved" : "rejected" });
      undone = true;
    } else if (d.refType === "skill") {
      const undo = d.undo as { skillId?: string; created?: boolean; assignedTo?: string | null; name?: string; description?: string; body?: string } | null;
      if (d.decision === "approve" && undo?.skillId) {
        if (undo.created) store.removeSkill(undo.skillId);
        else if (undo.body !== undefined) store.saveSkill({ id: undo.skillId, name: undo.name ?? undo.skillId, description: undo.description ?? "", body: undo.body });
        undone = true;
      } else {
        // Turned down by the CEO: back to the inbox, for you to approve.
        store.reopenSkillProposal(Number(d.refId));
        undone = true;
        message = this.notes().backToInbox;
      }
    } else if (d.refType === "task") {
      // An accepted delivery goes back to "to check".
      store.clearReview(Number(d.refId));
      undone = true;
    } else {
      message = this.notes().carriedOut;
    }
    governance.log({ category: d.category, refType: d.refType, refId: d.refId, summary: d.summary, decision: opposite, reason: note }, { by: "chairman" }, { overrules: d.id });
    governance.changed();
    return { ok: true, undone, message };
  }

  /** Per category: what you delegated, and how you decided so far (the ground for delegating more). */
  categories() {
    const { store } = this.deps;
    const org = this.deps.org();
    return CATEGORIES.map((key) => {
      const mine = store.decisions({ category: key, by: "chairman", limit: 200 });
      let streak = 0;
      for (const d of mine) {
        if (d.decision !== "approve") break;
        streak++;
      }
      return {
        key,
        delegated: org.delegation[key]?.enabled ?? false,
        dailyLimit: org.delegation[key]?.dailyLimit ?? 10,
        highRisk: org.highRisk.includes(key),
        decided: mine.length,
        approved: mine.filter((d) => d.decision === "approve").length,
        streak,
        usedToday: this.usedToday(key),
      };
    });
  }

  /** The company report: the departments' reports and the CEO's day, for the chairman. */
  async companyReport(departments: Report[], since: string, until: string): Promise<Report | null> {
    const ceo = this.ceo();
    if (!ceo || !departments.length) return null;
    const { store } = this.deps;
    const org = this.deps.org();
    const brain = store.brain(ceo)!;
    const provider = store.providerConfig(brain.providerId);
    if (!provider) return null;
    const name = (id: string) => store.occupant(id)?.name ?? id;
    const decided = store.decisions({ by: "ceo", since, limit: 100 });
    const pending = store.approvals("pending");
    const [overall, depts, mine, chairman] = SECTIONS[org.language] ?? SECTIONS.en;
    const spend = this.spendLine?.("company", since, until);
    const input = [
      `Period: ${since} to ${until}`,
      `Model spending (whole company): ${spend ?? "none"}`,
      ...departments.map((r) => `### Department ${this.deps.roomName(r.roomId)}${r.author ? ` (by ${name(r.author)})` : " (counted by the office)"}\n${clip(r.content, 4000)}`),
      `What you decided for the chairman in this period:\n${decided.map((d) => `- ${d.decision.toUpperCase()}: ${d.summary} — ${d.reason}`).join("\n") || "nothing"}`,
      `Still waiting for the chairman: ${pending.length} approvals; ${store.deliveries({ status: "pending", limit: 500 }).length} deliveries to check; ${store.projects().filter((p) => p.needsYou).length} projects asking them something.`,
    ].join("\n\n");
    const system = [
      `You are ${name(ceo)}, the CEO. Write the company report for the chairman from the department reports and your own decisions below.`,
      "Use only what you are given; never invent progress or numbers. Keep the [#id] and [project #id] references so the chairman can open them.",
      `Use exactly these Markdown sections: "## ${overall}" (two or three sentences), "## ${depts}" (a line or two per department), "## ${mine}", "## ${chairman}" (what only the chairman can decide, most important first).`,
      `Write in ${LANGUAGE_NAMES[org.language] ?? "English"}. Be brief.`,
    ].join("\n");
    const idle = ["idle", "offline"].includes(store.occupant(ceo)?.state ?? "");
    if (idle) this.deps.publish(store.report(ceo, { state: "writing", detail: "📊 公司日報" }));
    try {
      const content = withoutThinking(
        await chat(provider, {
          model: reportModel(brain),
          tag: { occupantId: ceo, kind: "report" },
          system,
          maxTokens: Math.max(brain.maxTokens, 2048),
          messages: [{ role: "user", content: input }],
          signal: AbortSignal.timeout(180_000),
          onText: () => {},
        }),
      );
      if (!content) return null;
      const report = store.addReport({ roomId: "company", author: ceo, periodStart: since, periodEnd: until, content: spend ? `${content.trim()}\n\n${spend}` : content, facts: { departments: departments.map((r) => r.id), decisions: decided.map((d) => d.id) } });
      if (org.chairman && store.exists(org.chairman)) this.deps.handoff({ from: ceo, to: org.chairman, kind: "pass" });
      this.deps.notifyReport(report);
      return report;
    } catch (error) {
      this.deps.log(`Company report failed: ${(error as Error).message}`);
      return null;
    } finally {
      if (idle) this.deps.publish(store.report(ceo, { state: "idle" }));
    }
  }
}
