import type { MemoryEntry, MemoryTarget, Store } from "./store.js";

/**
 * Layered memory, after Hermes Agent: a small long-term memory that goes into every prompt (the agent's
 * own notes, plus a profile of the people it works for that the whole office shares), full-text recall
 * over past tasks and chats when needed, and skills for know-how. The always-loaded part is kept tight
 * on purpose so agents curate instead of hoard. Unlike Hermes, entries you wrote or edited are locked:
 * an agent can read them but never rewrite them.
 */

export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1375 };
export const ENTRY_MAX = 400;

const length = (entries: MemoryEntry[], target: MemoryTarget) => entries.filter((e) => e.target === target).reduce((n, e) => n + [...e.text].length, 0);

export function usage(entries: MemoryEntry[]) {
  return { memory: length(entries, "memory"), user: length(entries, "user") };
}

/** Whether `text` fits, given the entries (leaving out the one being replaced). */
export function fits(entries: MemoryEntry[], target: MemoryTarget, text: string, replacing?: number) {
  const rest = entries.filter((e) => e.id !== replacing);
  return length(rest, target) + [...text].length <= MEMORY_LIMITS[target];
}

/** The snapshot that goes into the system prompt. */
export function memoryPrompt(entries: MemoryEntry[]): string {
  const list = (target: MemoryTarget) =>
    entries
      .filter((e) => e.target === target)
      .map((e) => `- ${e.text}${e.source === "you" ? " (written by your manager)" : ""}`)
      .join("\n");
  const u = usage(entries);
  const mine = list("memory");
  const user = list("user");
  return [
    `# Your long-term memory (${u.memory}/${MEMORY_LIMITS.memory} characters)`,
    mine || "(empty)",
    "",
    `# About the people you work for, shared by the whole office (${u.user}/${MEMORY_LIMITS.user} characters)`,
    user || "(empty)",
  ].join("\n");
}

export const MEMORY_RULES = [
  "# Using your memory",
  "- Your memory above was loaded when this task started. Save something with the memory tool only when it will matter in future tasks: the user's preferences and corrections, facts about them and their projects, lessons from mistakes or from what worked. Don't save task details, results or anything you can look up again.",
  "- Facts about the user go in target \"user\" (every teammate reads them); your own notes in \"memory\".",
  "- One short fact per entry. When memory is nearly full, merge or remove old entries (replace / remove) before adding.",
  "- Entries marked \"written by your manager\" are fixed: follow them, never try to change them.",
  "- recall searches your past tasks and chats; use it when the task refers to earlier work (\"like last time\", \"the report from Monday\"). One or two searches are usually enough; then open the useful hit in full with task_id.",
].join("\n");

/** The memory tool's input. */
export interface MemoryInput {
  action?: unknown;
  target?: unknown;
  content?: unknown;
  old_text?: unknown;
}

export const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["add", "replace", "remove"] },
    target: { type: "string", enum: ["memory", "user"], description: "memory: your own notes; user: facts about the people you work for (shared)" },
    content: { type: "string", description: "The entry to add, or the new text for replace" },
    old_text: { type: "string", description: "For replace/remove: a unique part of the existing entry" },
  },
  required: ["action", "target"],
};

/** Runs the memory tool for an agent; the reply tells the model what happened (errors included). */
export function applyMemory(store: Store, occupantId: string, input: MemoryInput): { reply: string; changed?: string } {
  const action = String(input.action ?? "");
  const target: MemoryTarget = input.target === "user" ? "user" : "memory";
  const content = String(input.content ?? "").replace(/\s+/g, " ").trim();
  const oldText = String(input.old_text ?? "").trim();
  const entries = store.memories(occupantId);
  const status = () => {
    const u = usage(store.memories(occupantId));
    return `Now ${u[target]}/${MEMORY_LIMITS[target]} characters in ${target}.`;
  };
  const find = (): MemoryEntry | string => {
    if (!oldText) return "Give old_text: a unique part of the entry to change.";
    const hits = entries.filter((e) => e.target === target && e.text.includes(oldText));
    if (!hits.length) return `No ${target} entry contains "${oldText}".`;
    if (hits.length > 1) return `"${oldText}" matches ${hits.length} entries; give a longer part.`;
    if (hits[0].source === "you") return "That entry was written by your manager and is fixed; leave it as it is.";
    return hits[0];
  };

  if (action === "add") {
    if (!content) return { reply: "Nothing to add: content is empty." };
    if ([...content].length > ENTRY_MAX) return { reply: `Too long: keep an entry under ${ENTRY_MAX} characters.` };
    if (entries.some((e) => e.target === target && e.text === content)) return { reply: "Already in memory." };
    if (!fits(entries, target, content)) return { reply: `Memory is full (${usage(entries)[target]}/${MEMORY_LIMITS[target]}). Merge or remove old ${target} entries first, then add.` };
    store.addMemory(occupantId, target, content, "agent");
    return { reply: `Saved. ${status()}`, changed: content };
  }
  if (action === "replace") {
    const hit = find();
    if (typeof hit === "string") return { reply: hit };
    if (!content) return { reply: "Give content: the new text for the entry." };
    if ([...content].length > ENTRY_MAX) return { reply: `Too long: keep an entry under ${ENTRY_MAX} characters.` };
    if (!fits(entries, target, content, hit.id)) return { reply: `That won't fit (${usage(entries)[target]}/${MEMORY_LIMITS[target]}). Shorten it or remove something.` };
    store.updateMemory(hit.id, content, "agent");
    return { reply: `Updated. ${status()}`, changed: content };
  }
  if (action === "remove") {
    const hit = find();
    if (typeof hit === "string") return { reply: hit };
    store.removeMemory(hit.id);
    return { reply: `Removed. ${status()}` };
  }
  return { reply: 'action must be "add", "replace" or "remove".' };
}
