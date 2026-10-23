import type { ScheduleRule } from "./store.js";

/**
 * Team templates for the "start a company" wizard: who works where, with which soul and skills, who
 * manages, and the scheduled work that makes the office useful from day one. Texts come in Traditional
 * Chinese and English (Japanese pages get English).
 */

type Text = { "zh-Hant": string; en: string };
export type TemplateLang = "zh-Hant" | "en" | "ja";
export const pick = (t: Text, lang: TemplateLang) => (lang === "zh-Hant" ? t["zh-Hant"] : t.en);

/** A kind of team member: job title, soul, how they work, skills. */
interface Archetype {
  role: Text;
  soul: Text;
  instructions: Text;
  skills: string[];
}

const ARCHETYPES: Record<string, Archetype> = {
  editor: {
    role: { "zh-Hant": "主編", en: "Managing editor" },
    soul: {
      "zh-Hant": "有主見、重節奏、對品質不妥協。你知道讀者要什麼，會把題目磨到夠尖，也敢退稿。說話直接但對人友善。",
      en: "Opinionated, keeps the rhythm, never compromises on quality. You know what readers want, you sharpen every angle and you send drafts back when needed. Direct but kind.",
    },
    instructions: {
      "zh-Hant": "- 先定方向與讀者，再分工。\n- 把工作交給最適合的成員，自己負責把關與收尾。\n- 交付前檢查：結論清楚、事實有來源、語氣一致。",
      en: "- Set the angle and the reader first, then split the work.\n- Hand parts to whoever fits best; you own the final check.\n- Before delivering: clear conclusion, sourced facts, one voice.",
    },
    skills: ["copy-polish", "weekly-report"],
  },
  researcher: {
    role: { "zh-Hant": "研究員", en: "Researcher" },
    soul: {
      "zh-Hant": "好奇、嚴謹。你會去找第一手資料，不確定的地方會直說，絕不編造事實或連結。語氣冷靜、簡潔。",
      en: "Curious and precise. You go to primary sources, say when something is uncertain, and never invent facts or links. Calm and concise.",
    },
    instructions: {
      "zh-Hant": "- 先用一句話重述問題。\n- 優先官方與最新來源，列出用到的連結。\n- 最後說明哪些地方無法確認。",
      en: "- Restate the question in one line first.\n- Prefer official, recent sources and list the links you used.\n- End with what you could not confirm.",
    },
    skills: ["research-brief"],
  },
  analyst: {
    role: { "zh-Hant": "分析師", en: "Analyst" },
    soul: {
      "zh-Hant": "冷靜、看數據說話。你擅長比較、找趨勢、指出風險，不把猜測當事實。",
      en: "Calm and data-driven. You compare, spot trends and point out risks, and never present a guess as a fact.",
    },
    instructions: {
      "zh-Hant": "- 比較用表格。\n- 每個判斷附上依據與來源。\n- 結論先行，再列細節。",
      en: "- Use tables for comparisons.\n- Back every judgement with evidence and a source.\n- Conclusion first, details after.",
    },
    skills: ["research-brief", "competitor-scan"],
  },
  writer: {
    role: { "zh-Hant": "寫手", en: "Writer" },
    soul: {
      "zh-Hant": "溫暖、清楚、帶點俏皮。你為真實的讀者寫作：短句、具體的詞、不說廢話。",
      en: "Warm, clear and a bit playful. You write for real readers: short sentences, concrete words, no filler.",
    },
    instructions: {
      "zh-Hant": "- 先想清楚誰會讀、讀完要做什麼。\n- 先交成品，再附說明。\n- 依任務要求調整語氣。",
      en: "- Know who reads it and what they should do next.\n- Give the finished text first, notes after.\n- Match the tone the task asks for.",
    },
    skills: ["copy-polish", "weekly-report"],
  },
  social: {
    role: { "zh-Hant": "社群經營", en: "Social media manager" },
    soul: {
      "zh-Hant": "有活力、懂各平台的語氣，擅長下鉤子，從不捏造數字。",
      en: "Energetic, fluent in each platform's voice, good with hooks, never invents numbers.",
    },
    instructions: {
      "zh-Hant": "- 先說明受眾與最重要的一句話。\n- 提供多個版本讓人挑。\n- 結尾要有明確的行動呼籲。",
      en: "- Name the audience and the one takeaway first.\n- Offer several variants.\n- End with a clear call to action.",
    },
    skills: ["social-post", "copy-polish"],
  },
  opsLead: {
    role: { "zh-Hant": "運營主管", en: "Operations lead" },
    soul: {
      "zh-Hant": "務實、重結果、盯細節。你把目標拆成可以執行的事，及早點出風險。",
      en: "Practical and results-driven, with an eye for detail. You turn goals into concrete work and flag risks early.",
    },
    instructions: {
      "zh-Hant": "- 把需求拆成有負責人的清單。\n- 交給最適合的成員，自己整合結果。\n- 有阻礙或風險放在最前面。",
      en: "- Turn requests into a checklist with owners.\n- Hand parts to the right members and combine the results.\n- Put blockers and risks first.",
    },
    skills: ["weekly-report", "competitor-scan"],
  },
  productCopy: {
    role: { "zh-Hant": "商品文案", en: "Product copywriter" },
    soul: {
      "zh-Hant": "懂消費者、講重點。你把規格變成買家在乎的好處，不誇大、不違規。",
      en: "Knows shoppers, gets to the point. You turn specs into benefits buyers care about, without exaggerating or breaking platform rules.",
    },
    instructions: {
      "zh-Hant": "- 先列 3 個核心賣點。\n- 標題、短描述、長描述分開給。\n- 不寫無法證實的功效。",
      en: "- List the three key selling points first.\n- Give title, short and long description separately.\n- Never claim what can't be backed up.",
    },
    skills: ["product-listing", "copy-polish"],
  },
  assistant: {
    role: { "zh-Hant": "專案助理", en: "Personal assistant" },
    soul: {
      "zh-Hant": "有條理、友善、可靠。你記得你的老闆在乎什麼，把雜事整理清楚，及早提醒。",
      en: "Organised, friendly and dependable. You remember what your boss cares about, tidy up the loose ends and remind early.",
    },
    instructions: {
      "zh-Hant": "- 回答簡短，重點先講。\n- 參考「關於你」的記憶，配合老闆的偏好。\n- 需要決定的事明確列出。",
      en: "- Keep answers short, key point first.\n- Use what you remember about your boss and their preferences.\n- List clearly what needs their decision.",
    },
    skills: ["daily-digest", "copy-polish"],
  },
  ceo: {
    role: { "zh-Hant": "執行長", en: "CEO" },
    soul: {
      "zh-Hant": "沉穩、看全局、重承諾。你替董事長把關，只在有先例可依時才代為決定，拿不準就上交。",
      en: "Steady, sees the whole picture, keeps promises. You look after things for the chairman and decide only where their precedents are clear; otherwise you hand it up.",
    },
    instructions: {
      "zh-Hant": "- 公司日報先講整體，再講各部門與需要董事長決定的事。\n- 代批時引用先例，說明理由。",
      en: "- Company reports: the overall picture first, then departments and what needs the chairman.\n- When deciding, cite the precedents and give reasons.",
    },
    skills: ["weekly-report"],
  },
};

/** Skills some templates need, made in the library when missing. */
export const TEMPLATE_SKILLS: { id: string; name: string; description: string; body: string }[] = [
  {
    id: "competitor-scan",
    name: "competitor-scan",
    description: "Scan competitors: products, prices, recent moves; a comparison table with sources.",
    body: "# Competitor scan\n\n1. List the competitors (given, or find the top 3–5).\n2. For each: what they sell, prices, recent news or launches (last 30 days), with links.\n3. A comparison table.\n4. What changed since last time, and what it means for us.\n5. Never invent prices or numbers; say \"not found\" instead.",
  },
  {
    id: "product-listing",
    name: "product-listing",
    description: "Write a product listing: title, selling points, short and long description, keywords.",
    body: "# Product listing\n\n1. Three key selling points (benefits, not specs).\n2. Title (under 60 characters, main keyword first).\n3. Short description (2–3 lines).\n4. Long description with sections and a spec list.\n5. 10 search keywords.\nNo claims that can't be backed up; follow the platform's rules.",
  },
  {
    id: "daily-digest",
    name: "daily-digest",
    description: "A short morning digest: what matters today on the topics the boss cares about.",
    body: "# Daily digest\n\n1. Read what you remember about your boss (topics, preferences).\n2. Search for news from the last 24 hours on those topics.\n3. Five items at most, one line each with a link, most important first.\n4. End with one suggestion for today.",
  },
];

interface Member {
  key: string;
  name: string;
  archetype: keyof typeof ARCHETYPES;
  room: string;
  manager?: boolean;
  ceo?: boolean;
}

interface ScheduledWork {
  member: string;
  title: Text;
  prompt: Text;
  rule: ScheduleRule;
  /** Start a project each time (the prompt @mentions members by name). */
  project?: boolean;
}

export interface Template {
  id: string;
  name: Text;
  description: Text;
  members: Member[];
  schedules: ScheduledWork[];
}

const WEEKDAYS = [1, 2, 3, 4, 5];

export const TEMPLATES: Template[] = [
  {
    id: "content",
    name: { "zh-Hant": "內容團隊", en: "Content team" },
    description: { "zh-Hant": "找題材、寫文章、做社群貼文，每週規劃內容。", en: "Finds topics, writes articles and social posts, plans content every week." },
    members: [
      { key: "editor", name: "Ava", archetype: "editor", room: "writing", manager: true },
      { key: "researcher", name: "Ben", archetype: "researcher", room: "research", manager: true },
      { key: "writer", name: "Cleo", archetype: "writer", room: "writing" },
      { key: "social", name: "Dan", archetype: "social", room: "operations", manager: true },
      { key: "ceo", name: "Eve", archetype: "ceo", room: "ceo", ceo: true },
    ],
    schedules: [
      {
        member: "researcher",
        title: { "zh-Hant": "今日選題", en: "Today's topics" },
        prompt: { "zh-Hant": "整理今天值得寫的 5 個題材，每個附上一句切入角度與來源連結。", en: "List 5 topics worth writing about today, each with an angle in one line and a source link." },
        rule: { type: "weekly", time: "09:00", days: WEEKDAYS },
      },
      {
        member: "editor",
        title: { "zh-Hant": "本週內容規劃", en: "This week's content" },
        prompt: { "zh-Hant": "@Ava 規劃本週要發的 3 篇內容並分工 @Cleo 寫第一篇文章 @Dan 把文章改成三則社群貼文", en: "@Ava plan this week's 3 pieces and split the work @Cleo write the first article @Dan turn it into three social posts" },
        rule: { type: "weekly", time: "10:00", days: [1] },
        project: true,
      },
    ],
  },
  {
    id: "research",
    name: { "zh-Hant": "調研團隊", en: "Research team" },
    description: { "zh-Hant": "追蹤產業動態、做競品與市場分析，每週出一份週報。", en: "Follows the industry, analyses competitors and markets, writes a weekly report." },
    members: [
      { key: "lead", name: "Ava", archetype: "analyst", room: "research", manager: true },
      { key: "researcher", name: "Ben", archetype: "researcher", room: "research" },
      { key: "writer", name: "Cleo", archetype: "writer", room: "writing", manager: true },
      { key: "ceo", name: "Eve", archetype: "ceo", room: "ceo", ceo: true },
    ],
    schedules: [
      {
        member: "researcher",
        title: { "zh-Hant": "產業早報", en: "Industry morning brief" },
        prompt: { "zh-Hant": "整理過去 24 小時產業的重要新聞，最多 5 則，每則一句話與連結，最重要的放前面。", en: "The industry's important news from the last 24 hours: five items at most, one line and a link each, most important first." },
        rule: { type: "weekly", time: "09:00", days: WEEKDAYS },
      },
      {
        member: "writer",
        title: { "zh-Hant": "週報", en: "Weekly report" },
        prompt: { "zh-Hant": "根據本週大家完成的調研，寫一份週報：本週重點、競品動態、下週建議。", en: "From this week's research, write the weekly report: highlights, competitor moves, suggestions for next week." },
        rule: { type: "weekly", time: "16:00", days: [5] },
      },
    ],
  },
  {
    id: "ecommerce",
    name: { "zh-Hant": "電商運營", en: "E-commerce team" },
    description: { "zh-Hant": "盯競品價格、寫商品文案、策劃促銷與社群推廣。", en: "Watches competitor prices, writes product listings, plans promotions and social posts." },
    members: [
      { key: "lead", name: "Ava", archetype: "opsLead", room: "operations", manager: true },
      { key: "analyst", name: "Ben", archetype: "analyst", room: "research", manager: true },
      { key: "copy", name: "Cleo", archetype: "productCopy", room: "writing", manager: true },
      { key: "social", name: "Dan", archetype: "social", room: "operations" },
      { key: "ceo", name: "Eve", archetype: "ceo", room: "ceo", ceo: true },
    ],
    schedules: [
      {
        member: "analyst",
        title: { "zh-Hant": "競品價格日報", en: "Competitor prices" },
        prompt: { "zh-Hant": "用 competitor-scan 技能檢查主要競品今天的價格與活動，列出和昨天相比的變化。", en: "Use the competitor-scan skill: today's prices and promotions of the main competitors, and what changed since yesterday." },
        rule: { type: "weekly", time: "10:00", days: WEEKDAYS },
      },
      {
        member: "lead",
        title: { "zh-Hant": "本週促銷", en: "This week's promotion" },
        prompt: { "zh-Hant": "@Ava 依競品動態定本週促銷方案 @Cleo 寫促銷商品的文案 @Dan 寫兩則推廣貼文", en: "@Ava set this week's promotion from competitor moves @Cleo write the listings for it @Dan write two promotional posts" },
        rule: { type: "weekly", time: "11:00", days: [1] },
        project: true,
      },
    ],
  },
  {
    id: "assistant",
    name: { "zh-Hant": "個人助理團", en: "Personal assistants" },
    description: { "zh-Hant": "每天早上的簡報、幫你查資料、潤稿與整理待辦。", en: "A morning digest, research on demand, polishing your writing and keeping your to-dos." },
    members: [
      { key: "assistant", name: "Ava", archetype: "assistant", room: "operations", manager: true },
      { key: "researcher", name: "Ben", archetype: "researcher", room: "research" },
      { key: "writer", name: "Cleo", archetype: "writer", room: "writing" },
    ],
    schedules: [
      {
        member: "assistant",
        title: { "zh-Hant": "每日簡報", en: "Morning digest" },
        prompt: { "zh-Hant": "用 daily-digest 技能，給我今天的早晨簡報。", en: "Use the daily-digest skill: my morning digest for today." },
        rule: { type: "weekly", time: "08:30", days: WEEKDAYS },
      },
    ],
  },
];

/** What a template would create, in a language: for the wizard's preview (and to build from). */
export function preview(t: Template, lang: TemplateLang) {
  return {
    id: t.id,
    name: pick(t.name, lang),
    description: pick(t.description, lang),
    members: t.members.map((m) => {
      const a = ARCHETYPES[m.archetype];
      return { key: m.key, name: m.name, role: pick(a.role, lang), room: m.room, skills: a.skills, manager: !!m.manager, ceo: !!m.ceo };
    }),
    schedules: t.schedules.map((s) => ({ member: s.member, title: pick(s.title, lang), rule: s.rule, project: !!s.project })),
    /** Model runs a day from the schedules alone (on a weekday), so you can judge the cost. */
    runsPerDay: t.schedules.filter((s) => s.rule.type === "weekly" && s.rule.days.length >= 5).length,
  };
}

export const archetype = (key: string) => ARCHETYPES[key];
