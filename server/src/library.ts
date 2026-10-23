import type { AgentTool } from "./ai.js";
import { chunk, markdownToDocx, mimeOf, readFile, rowsToXlsx, toRows } from "./files.js";
import type { Store, Task } from "./store.js";

/**
 * Files and the knowledge base. Files you attach to a task are read for the agent (text inline, images
 * shown to models that can see); documents in the knowledge base (the company's, or a department's) are
 * split into passages and indexed so agents search and cite them; and agents can deliver files (Word,
 * Excel, CSV, Markdown) that you download from the results page. Files live in the database.
 */

export type FilePurpose = "upload" | "task" | "output" | "kb";

export interface StoredFile {
  id: number;
  name: string;
  mime: string;
  size: number;
  purpose: FilePurpose;
  taskId: number | null;
  /** Who made it (an agent's delivery), or null for yours. */
  occupantId: string | null;
  /** Knowledge base: "company" or a room (department) id. */
  scope: string | null;
  image: boolean;
  chars: number;
  createdAt: string;
}

interface FileRow {
  id: number;
  name: string;
  mime: string;
  size: number;
  purpose: FilePurpose;
  task_id: number | null;
  occupant_id: string | null;
  scope: string | null;
  image: number;
  chars: number;
  created_at: string;
}

const toFile = (r: FileRow): StoredFile => ({
  id: Number(r.id),
  name: String(r.name),
  mime: String(r.mime),
  size: Number(r.size),
  purpose: r.purpose,
  taskId: r.task_id === null ? null : Number(r.task_id),
  occupantId: r.occupant_id === null ? null : String(r.occupant_id),
  scope: r.scope === null ? null : String(r.scope),
  image: !!r.image,
  chars: Number(r.chars),
  createdAt: String(r.created_at),
});

export interface KnowledgeHit {
  fileId: number;
  name: string;
  scope: string;
  part: number;
  parts: number;
  snippet: string;
}

const COLUMNS = "id, name, mime, size, purpose, task_id, occupant_id, scope, image, chars, created_at";
/** Attached text shown in the task itself; the rest is read with read_file. */
const INLINE = 6000;
const PAGE = 12_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUTS = 8;
const FORMATS = ["md", "docx", "xlsx", "csv"] as const;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A safe file name with the right extension. */
function fileName(name: string, ext: string) {
  const base = name.replace(/\.[a-z0-9]+$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "delivery";
  return `${base}.${ext}`;
}

/** FTS5 query for the words of a search (trigram: words of 3+ characters match inside text). */
function terms(query: string) {
  return query
    .split(/[\s,，。、;；:：!?！？"'“”「」()（）]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export class Library {
  constructor(private store: Store) {
    store.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        purpose TEXT NOT NULL,
        task_id INTEGER,
        occupant_id TEXT,
        scope TEXT,
        image INTEGER NOT NULL DEFAULT 0,
        chars INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        data BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_by_task ON files (task_id);
      CREATE INDEX IF NOT EXISTS files_by_scope ON files (purpose, scope);
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks USING fts5(text, file_id UNINDEXED, part UNINDEXED, scope UNINDEXED, tokenize = 'trigram');
    `);
    // Uploads never attached to a task (the page was closed before sending) don't stay around.
    store.sql.prepare("DELETE FROM files WHERE purpose = 'upload' AND created_at < ?").run(new Date(Date.now() - 86_400_000).toISOString());
  }

  /** Stores a file you upload: for a task (attach it when sending) or for the knowledge base. Throws if it can't be read. */
  async add(name: string, data: Buffer, opts: { purpose: "upload" | "kb"; scope?: string }): Promise<StoredFile> {
    const { text, image } = await readFile(name, data);
    if (opts.purpose === "kb" && image) throw new Error("the knowledge base takes documents (PDF, Word, Excel, PowerPoint, text), not images");
    if (opts.purpose === "kb" && !text.trim()) throw new Error("no text found in this file (a scanned PDF needs OCR first)");
    const id = this.insert({ name, data, purpose: opts.purpose, scope: opts.purpose === "kb" ? (opts.scope ?? "company") : null, text, image });
    if (opts.purpose === "kb") this.index(id, text, opts.scope ?? "company");
    return this.file(id)!;
  }

  private insert(f: { name: string; data: Buffer; purpose: FilePurpose; text: string; image: boolean; scope?: string | null; taskId?: number | null; occupantId?: string | null }) {
    const res = this.store.sql
      .prepare("INSERT INTO files (name, mime, size, purpose, task_id, occupant_id, scope, image, chars, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(f.name, mimeOf(f.name), f.data.length, f.purpose, f.taskId ?? null, f.occupantId ?? null, f.scope ?? null, f.image ? 1 : 0, f.text.length, f.text, f.data, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  private index(id: number, text: string, scope: string) {
    const insert = this.store.sql.prepare("INSERT INTO kb_chunks (text, file_id, part, scope) VALUES (?, ?, ?, ?)");
    chunk(text).forEach((c, i) => insert.run(c, id, i + 1, scope));
  }

  file(id: number): StoredFile | undefined {
    const r = this.store.sql.prepare(`SELECT ${COLUMNS} FROM files WHERE id = ?`).get(id) as unknown as FileRow | undefined;
    return r && toFile(r);
  }

  data(id: number): Buffer | undefined {
    const r = this.store.sql.prepare("SELECT data FROM files WHERE id = ?").get(id) as { data: Uint8Array } | undefined;
    return r && Buffer.from(r.data);
  }

  text(id: number): string {
    return String((this.store.sql.prepare("SELECT text FROM files WHERE id = ?").get(id) as { text: string } | undefined)?.text ?? "");
  }

  /** Attaches uploads to a task (only uploads not attached yet). */
  attach(taskId: number, ids: number[]) {
    const update = this.store.sql.prepare("UPDATE files SET purpose = 'task', task_id = ? WHERE id = ? AND purpose = 'upload'");
    for (const id of ids) update.run(taskId, id);
  }

  /** A task's attachments or deliveries. */
  forTask(taskId: number, purpose: "task" | "output"): StoredFile[] {
    const rows = this.store.sql.prepare(`SELECT ${COLUMNS} FROM files WHERE task_id = ? AND purpose = ? ORDER BY id`).all(taskId, purpose) as unknown as FileRow[];
    return rows.map(toFile);
  }

  /** Files a task delivered, with those of the colleagues it asked. */
  outputs(task: Task, depth = 0): StoredFile[] {
    const own = this.forTask(task.id, "output");
    if (depth >= 3) return own;
    return [...own, ...this.store.childTasks(task.id).flatMap((c) => this.outputs(c, depth + 1))];
  }

  /** Documents in the knowledge base, of one scope or all. */
  documents(scope?: string): StoredFile[] {
    const rows = (
      scope
        ? this.store.sql.prepare(`SELECT ${COLUMNS} FROM files WHERE purpose = 'kb' AND scope = ? ORDER BY name`).all(scope)
        : this.store.sql.prepare(`SELECT ${COLUMNS} FROM files WHERE purpose = 'kb' ORDER BY scope, name`).all()
    ) as unknown as FileRow[];
    return rows.map(toFile);
  }

  remove(id: number) {
    this.store.sql.prepare("DELETE FROM kb_chunks WHERE file_id = ?").run(id);
    return this.store.sql.prepare("DELETE FROM files WHERE id = ?").run(id).changes > 0;
  }

  private parts(id: number) {
    return Number((this.store.sql.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE file_id = ?").get(id) as { n: number }).n);
  }

  /** Passages matching a search, in the given scopes (company and departments). */
  search(query: string, scopes: string[], limit = 6): KnowledgeHit[] {
    const words = terms(query);
    if (!words.length || !scopes.length) return [];
    const inScope = `scope IN (${scopes.map(() => "?").join(", ")})`;
    type Row = { file_id: number; part: number; scope: string; snippet: string };
    let rows: Row[];
    const long = words.filter((t) => [...t].length >= 3);
    if (long.length) {
      rows = this.store.sql
        .prepare(`SELECT file_id, part, scope, snippet(kb_chunks, 0, '«', '»', '…', 48) AS snippet FROM kb_chunks WHERE kb_chunks MATCH ? AND ${inScope} ORDER BY rank LIMIT ?`)
        .all(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR "), ...scopes, limit) as unknown as Row[];
    } else {
      rows = (
        this.store.sql
          .prepare(`SELECT file_id, part, scope, text FROM kb_chunks WHERE ${inScope} AND (${words.map(() => "text LIKE ?").join(" OR ")}) LIMIT ?`)
          .all(...scopes, ...words.map((t) => `%${t}%`), limit) as unknown as (Row & { text: string })[]
      ).map((r) => {
        const i = Math.max(0, r.text.indexOf(words.find((t) => r.text.includes(t)) ?? ""));
        return { ...r, snippet: `…${r.text.slice(Math.max(0, i - 80), i + 160)}…` };
      });
    }
    return rows.map((r) => ({
      fileId: Number(r.file_id),
      name: this.file(Number(r.file_id))?.name ?? "?",
      scope: String(r.scope),
      part: Number(r.part),
      parts: this.parts(Number(r.file_id)),
      snippet: String(r.snippet).replace(/\s+/g, " "),
    }));
  }

  /** One passage of a document (1-based). */
  passage(id: number, part: number): string | undefined {
    const r = this.store.sql.prepare("SELECT text FROM kb_chunks WHERE file_id = ? AND part = ?").get(id, part) as { text: string } | undefined;
    return r?.text;
  }

  /** The tasks whose attachments a task may read: itself, the work it redoes, and the tasks that asked it. */
  private related(task: Task): number[] {
    const ids = [task.id];
    for (let t: Task | undefined = task, n = 0; t && n < 6; n++) {
      const up: number | null = t.redoOf ?? t.parentTaskId;
      if (up === null) break;
      ids.push(up);
      t = this.store.task(up);
    }
    return ids;
  }

  /** What the agent gets with a task: the attached files' text (clipped) and the images. */
  prepare(task: Task): { note: string; images: { mime: string; data: string }[] } {
    const files = this.forTask(task.redoOf ?? task.id, "task").concat(task.redoOf ? this.forTask(task.id, "task") : []);
    // Helping a colleague: their task's files can be read on request.
    const theirs = task.parentTaskId === null ? [] : this.related(task).slice(1).flatMap((id) => this.forTask(id, "task"));
    const listed = theirs.length ? `\n\n# Files of the task you are helping with\n${theirs.map((f) => `- ${f.name} (file #${f.id}${f.image ? ", image" : ""})`).join("\n")}\nRead them with read_file if you need them.` : "";
    if (!files.length) return { note: listed, images: [] };
    const images: { mime: string; data: string }[] = [];
    const parts = files.map((f) => {
      if (f.image) {
        if (images.length < MAX_IMAGES && f.size <= MAX_IMAGE_BYTES) images.push({ mime: f.mime, data: this.data(f.id)!.toString("base64") });
        return `## ${f.name} (file #${f.id}, image)\nThe image is attached to this message.`;
      }
      const text = this.text(f.id);
      const more = text.length > INLINE ? `\n…(${text.length - INLINE} more characters: read the rest with read_file, file_id ${f.id}, offset ${INLINE})` : "";
      return `## ${f.name} (file #${f.id}, ${kb(f.size)})\n${text.slice(0, INLINE)}${more}`;
    });
    return { note: `\n\n# Attached files\n${parts.join("\n\n")}${listed}`, images };
  }

  /** Tools every task gets: reading attachments, the knowledge base, and delivering files. */
  tools(task: Task, scopes: string[], step: (text: string) => void): AgentTool[] {
    const outputs = () => this.forTask(task.id, "output").length;
    return [
      {
        name: "read_file",
        description: "Read a file attached to your task (or to the task you are helping with), from an offset in characters.",
        schema: { type: "object", properties: { file_id: { type: "number" }, offset: { type: "number", description: "Start at this character (default 0)" } }, required: ["file_id"] },
        run: async (input) => {
          const f = this.file(Number(input.file_id));
          if (!f || f.purpose !== "task" || f.taskId === null || !this.related(task).includes(f.taskId)) return "No such file attached to this task.";
          if (f.image) return "That file is an image; it was attached to the task message.";
          const text = this.text(f.id);
          const offset = Math.max(0, Math.floor(Number(input.offset ?? 0)) || 0);
          const page = text.slice(offset, offset + PAGE);
          const rest = text.length - offset - page.length;
          return `${f.name} (characters ${offset}–${offset + page.length} of ${text.length})\n\n${page}${rest > 0 ? `\n\n…(${rest} more: read_file with offset ${offset + page.length})` : ""}`;
        },
      },
      {
        name: "search_knowledge",
        description:
          "Search the company's knowledge base (the company's documents and your department's): products, policies, prices, past material. Returns passages with their document and part; read one in full with read_knowledge.",
        schema: { type: "object", properties: { query: { type: "string", description: "Words to look for" } }, required: ["query"] },
        run: async (input) => {
          const query = String(input.query ?? "").trim().slice(0, 200);
          step(query);
          const hits = this.search(query, scopes);
          if (!hits.length) return this.documents().some((d) => d.scope && scopes.includes(d.scope)) ? "Nothing in the knowledge base matches; try other words." : "The knowledge base is empty.";
          return hits.map((h) => `[doc #${h.fileId} "${h.name}", part ${h.part}/${h.parts}] ${h.snippet}`).join("\n\n");
        },
      },
      {
        name: "read_knowledge",
        description: "Read one part of a knowledge-base document (from a search hit). Cite what you use as [document name].",
        schema: { type: "object", properties: { doc_id: { type: "number" }, part: { type: "number", description: "Part number (default 1)" } }, required: ["doc_id"] },
        run: async (input) => {
          const f = this.file(Number(input.doc_id));
          if (!f || f.purpose !== "kb" || !f.scope || !scopes.includes(f.scope)) return "No such document in your knowledge base.";
          const parts = this.parts(f.id);
          const part = Math.min(Math.max(1, Math.floor(Number(input.part ?? 1)) || 1), parts);
          return `"${f.name}", part ${part} of ${parts}\n\n${this.passage(f.id, part) ?? ""}`;
        },
      },
      {
        name: "write_file",
        description:
          "Save a file as part of your delivery, for the person to download: a Word document (docx, from Markdown), an Excel sheet (xlsx, from CSV or a Markdown table), CSV, or Markdown. Use it when the task asks for a document, a spreadsheet or a file; still give a summary in your final answer.",
        schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name without extension" },
            format: { type: "string", enum: [...FORMATS] },
            content: { type: "string", description: "Markdown for md/docx; CSV or a Markdown table for xlsx/csv" },
          },
          required: ["name", "format", "content"],
        },
        run: async (input) => {
          const format = FORMATS.find((f) => f === input.format);
          const content = String(input.content ?? "");
          if (!format) return `format must be one of ${FORMATS.join(", ")}.`;
          if (!content.trim()) return "The content is empty.";
          if (outputs() >= MAX_OUTPUTS) return `You have saved ${MAX_OUTPUTS} files for this task already.`;
          const name = fileName(String(input.name ?? ""), format);
          let data: Buffer;
          let text = content;
          if (format === "docx") data = markdownToDocx(content);
          else if (format === "xlsx" || format === "csv") {
            const rows = toRows(content);
            if (!rows.length) return "No rows found: give CSV lines or a Markdown table.";
            text = rows.map((r) => r.join(", ")).join("\n");
            data = format === "xlsx" ? rowsToXlsx(rows, name.replace(/\.xlsx$/, "")) : Buffer.from(`﻿${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}`);
          } else data = Buffer.from(content);
          const id = this.insert({ name, data, purpose: "output", text, image: false, taskId: task.id, occupantId: task.occupantId });
          return `Saved ${name} (file #${id}, ${kb(data.length)}). It is listed with your delivery for download.`;
        },
      },
    ];
  }
}
