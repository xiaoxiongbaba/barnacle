import type { Skill, Store } from "./store.js";

/**
 * Skills are SKILL.md files, as in OpenClaw and Anthropic's Agent Skills: a front matter with `name` and
 * `description`, then the instructions. An agent's system prompt lists only names and descriptions; the
 * agent reads a skill's body (the read_skill tool) when a task calls for it.
 */

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `skill-${Date.now().toString(36)}`;

/** Reads a SKILL.md. Without front matter, the first heading is the name and the first paragraph the description. */
export function parseSkillMd(text: string): { name: string; description: string; body: string } | null {
  const src = text.replace(/\r\n/g, "\n").trim();
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (fm) {
    const meta: Record<string, string> = {};
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    if (!meta.name) return null;
    return { name: meta.name, description: meta.description ?? "", body: fm[2].trim() };
  }
  const heading = /^#\s+(.+)$/m.exec(src);
  if (!heading) return null;
  const rest = src.slice(heading.index + heading[0].length).trim();
  return { name: heading[1].trim(), description: rest.split(/\n\s*\n/)[0]?.trim().slice(0, 300) ?? "", body: rest };
}

export function toSkillMd(s: Pick<Skill, "name" | "description" | "body">) {
  return `---\nname: ${s.name}\ndescription: ${s.description.replace(/\n/g, " ")}\n---\n\n${s.body.trim()}\n`;
}

/** A few skills to start with, so a new office can put agents to work right away. */
const BUILT_IN: { id: string; name: string; description: string; body: string }[] = [
  {
    id: "research-brief",
    name: "research-brief",
    description: "Research a topic on the web and write a short, sourced brief. Use for any “find out / look into / compare” task.",
    body: `# Research brief

1. Restate the question in one line. If it is vague, pick the most useful reading and say so.
2. Run 2–4 web searches with different angles (official sources, recent news, comparisons).
3. Open the 3–5 most relevant pages and read them; prefer primary sources over blogs.
4. Write the brief:
   - **Answer** — 2–3 sentences that answer the question directly.
   - **Key points** — 3–6 bullets, each with the source in brackets.
   - **Open questions** — what you could not confirm.
   - **Sources** — the links you actually used.
5. Never invent facts or links. If sources disagree, say which says what.`,
  },
  {
    id: "weekly-report",
    name: "weekly-report",
    description: "Turn notes or a list of done/ongoing work into a clear weekly report for a team or a boss.",
    body: `# Weekly report

Write a report with these sections, in this order:

1. **Highlights** — the 1–3 results that matter most, with numbers when there are any.
2. **Done** — finished work, one line each, starting with a verb.
3. **In progress** — what is moving, and what "done" will look like.
4. **Blockers / needs** — what you need from others, and from whom.
5. **Next week** — 3–5 concrete goals.

Keep it under 300 words. No filler ("this week we worked hard on…"). If information is missing, leave a clear [TODO].`,
  },
  {
    id: "copy-polish",
    name: "copy-polish",
    description: "Rewrite or polish a piece of text: clearer, shorter, right tone for its readers. Use for edits, rewrites and translations.",
    body: `# Copy polish

1. Work out who reads this and what they should do after reading. Keep the author's meaning.
2. Cut filler, passive voice and repetition; put the main point first.
3. Match the requested tone (default: friendly and direct). For translations, write naturally in the target language rather than word for word.
4. Return the polished text first, then (only if useful) a short list of the main changes.`,
  },
  {
    id: "social-post",
    name: "social-post",
    description: "Write social media posts (X/Twitter, LinkedIn, Xiaohongshu, Weibo…) about a product, a launch or an idea.",
    body: `# Social post

1. Ask yourself: which platform, who is the audience, what is the one takeaway? If the task doesn't say, choose and state it.
2. Write 3 variants with different hooks (a question, a bold claim, a short story).
3. Respect the platform: X ≤ 280 characters; LinkedIn short paragraphs; Xiaohongshu a catchy title, emoji and hashtags.
4. End each with a clear call to action. No invented numbers or quotes.`,
  },
];

/** Adds the built-in skills the first time the office starts (never overwrites the user's edits). */
export function seedSkills(store: Store) {
  if (store.skills().length > 0) return;
  for (const s of BUILT_IN) store.saveSkill(s);
}
