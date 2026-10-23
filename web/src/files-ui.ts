import { api, tokenStore, Unauthorized } from "./auth";
import { t } from "./i18n";

/** Files: attaching them to a task, downloading what agents delivered, and the knowledge base (Settings). */

export interface StoredFile {
  id: number;
  name: string;
  mime: string;
  size: number;
  purpose: "upload" | "task" | "output" | "kb";
  taskId: number | null;
  occupantId: string | null;
  scope: string | null;
  image: boolean;
  chars: number;
  createdAt: string;
}

type Guard = <T>(status: Element | null, fn: () => Promise<T>) => Promise<T | undefined>;

const MAX_MB = 25;
const ACCEPT = ".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.json,.html,.htm,.xml,.yaml,.yml,.log,.png,.jpg,.jpeg,.gif,.webp";
const DOC_ACCEPT = ACCEPT.replace(/,\.(png|jpe?g|gif|webp)/g, "");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function fileIcon(name: string) {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "🖼";
  if (ext === "pdf") return "📕";
  if (ext === "docx") return "📘";
  if (ext === "xlsx" || ext === "csv" || ext === "tsv") return "📗";
  if (ext === "pptx") return "📙";
  return "📄";
}

/** Uploads a file (as base64 JSON). */
export async function uploadFile(file: File, purpose: "upload" | "kb", scope?: string): Promise<StoredFile> {
  if (file.size > MAX_MB * 1024 * 1024) throw new Error(t("files.tooBig", { name: file.name, mb: String(MAX_MB) }));
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(file.name));
    reader.readAsDataURL(file);
  });
  return (await api<{ file: StoredFile }>("POST", "/api/files", { name: file.name, data, purpose, scope })).file;
}

/** Downloads a file (the token goes in a header, so not a plain link). */
export async function downloadFile(f: Pick<StoredFile, "id" | "name">) {
  const res = await fetch(`/api/files/${f.id}/download`, { headers: { authorization: `Bearer ${tokenStore.get() ?? ""}` } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(res.statusText);
  const url = URL.createObjectURL(await res.blob());
  const a = el("a");
  a.href = url;
  a.download = f.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file as a chip: click downloads it; with `remove`, a × takes it off. */
export function fileChip(f: StoredFile, remove?: () => void) {
  const chip = el("span", "ui-file");
  const open = el("button", "ui-file__name", `${fileIcon(f.name)} ${f.name}`);
  open.type = "button";
  open.title = `${f.name} · ${fileSize(f.size)}`;
  open.addEventListener("click", () => void downloadFile(f).catch((err: Error) => alert(err.message)));
  chip.append(open, el("small", "ui-faint", fileSize(f.size)));
  if (remove) {
    const x = el("button", "ui-file__x", "×");
    x.type = "button";
    x.title = t("files.remove");
    x.addEventListener("click", remove);
    chip.append(x);
  }
  return chip;
}

/** Files picked for the next task: a 📎 button, the chips, and the ids to send. */
export class AttachPicker {
  files: StoredFile[] = [];
  busy = 0;
  error = "";

  constructor(private changed: () => void) {}

  get ids() {
    return this.files.map((f) => f.id);
  }

  clear() {
    this.files = [];
    this.error = "";
  }

  button() {
    const input = el("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ACCEPT;
    input.hidden = true;
    input.addEventListener("change", () => void this.add([...(input.files ?? [])]));
    const btn = el("button", "ui-btn ui-attach", this.busy ? `📎 ${t("files.uploading")}` : "📎");
    btn.type = "button";
    btn.title = t("files.attach");
    btn.disabled = this.busy > 0 || this.files.length >= 10;
    btn.addEventListener("click", () => input.click());
    const wrap = el("span");
    wrap.append(btn, input);
    return wrap;
  }

  chips() {
    const row = el("div", "ui-files");
    for (const f of this.files) {
      row.append(
        fileChip(f, () => {
          this.files = this.files.filter((x) => x.id !== f.id);
          void api("DELETE", `/api/files/${f.id}`).catch(() => {});
          this.changed();
        }),
      );
    }
    if (this.error) row.append(el("span", "ui-error ui-small", this.error));
    return row;
  }

  async add(list: File[]) {
    this.error = "";
    this.busy += list.length;
    this.changed();
    for (const file of list.slice(0, 10 - this.files.length)) {
      try {
        this.files.push(await uploadFile(file, "upload"));
      } catch (err) {
        this.error = err instanceof Unauthorized ? t("drawer.unlockToGive") : (err as Error).message;
      }
      this.busy--;
      this.changed();
    }
    this.busy = 0;
    this.changed();
  }
}

/** A task's files, fetched once per task state (redraws reuse them). */
const cache = new Map<string, Promise<{ attachments: StoredFile[]; outputs: StoredFile[] }>>();

/**
 * The files of a task: what you attached, and "📎 Delivered files" to download. Empty when there are none.
 * `key` changes when the task does (e.g. its status), to fetch again.
 */
export function taskFiles(taskId: number, key: string, opts: { attachments?: boolean } = {}) {
  const box = el("div", "ui-taskfiles");
  const k = `${taskId}:${key}`;
  if (!cache.has(k)) cache.set(k, api<{ attachments: StoredFile[]; outputs: StoredFile[] }>("GET", `/api/tasks/${taskId}/files`));
  void cache
    .get(k)!
    .then((res) => {
      if (opts.attachments !== false && res.attachments.length) {
        const row = el("div", "ui-files");
        row.append(el("span", "ui-faint ui-small", `${t("files.attached")}：`), ...res.attachments.map((f) => fileChip(f)));
        box.append(row);
      }
      if (res.outputs.length) box.append(outputList(res.outputs));
    })
    .catch(() => cache.delete(k));
  return box;
}

/** Files a project's turns delivered. */
export function projectFiles(projectId: number, key: string) {
  const box = el("div", "ui-taskfiles");
  const k = `p${projectId}:${key}`;
  if (!cache.has(k)) cache.set(k, api<{ outputs: StoredFile[] }>("GET", `/api/projects/${projectId}/files`).then((r) => ({ attachments: [], outputs: r.outputs })));
  void cache
    .get(k)!
    .then((res) => {
      if (res.outputs.length) box.append(outputList(res.outputs));
    })
    .catch(() => cache.delete(k));
  return box;
}

function outputList(files: StoredFile[]) {
  const sec = el("section", "ui-outputs");
  sec.append(el("h3", "ui-sec__title", `📎 ${t("files.delivered")}`));
  const ul = el("ul", "ui-outputs__list");
  for (const f of files) {
    const li = el("li", "ui-outputs__item");
    const btn = el("button", "ui-btn", `⬇ ${t("files.download")}`);
    btn.type = "button";
    btn.addEventListener("click", () => void downloadFile(f).catch((err: Error) => alert(err.message)));
    li.append(el("span", "ui-outputs__icon", fileIcon(f.name)), el("strong", "", f.name), el("small", "ui-faint", fileSize(f.size)), btn);
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

// ---------------------------------------------------------------- knowledge base (Settings)

interface Hit {
  fileId: number;
  name: string;
  scope: string;
  part: number;
  parts: number;
  snippet: string;
}

export class KnowledgeTab {
  private scope = "company";
  private query = "";
  private hits: Hit[] | null = null;
  private preview: { id: number; text: string } | null = null;

  constructor(
    private root: HTMLElement,
    private guard: Guard,
  ) {}

  async render(note = "") {
    const res = await this.guard(null, () => api<{ scopes: { id: string; name: string }[]; documents: StoredFile[] }>("GET", "/api/knowledge"));
    if (!res) return;
    const scopeName = (id: string) => (id === "company" ? t("kb.company") : (res.scopes.find((s) => s.id === id)?.name ?? id));
    if (!res.scopes.some((s) => s.id === this.scope)) this.scope = "company";

    // Upload to a scope.
    const select = el("select");
    for (const s of res.scopes) {
      const o = el("option", "", scopeName(s.id));
      o.value = s.id;
      o.selected = s.id === this.scope;
      select.append(o);
    }
    select.addEventListener("change", () => (this.scope = select.value));
    const input = el("input");
    input.type = "file";
    input.multiple = true;
    input.accept = DOC_ACCEPT;
    input.hidden = true;
    const status = el("p", "status");
    if (note) status.textContent = note;
    input.addEventListener("change", () => void this.upload([...(input.files ?? [])], status));
    const add = el("button", "primary small", `＋ ${t("kb.upload")}`);
    add.type = "button";
    add.addEventListener("click", () => input.click());
    const upload = el("div", "row kb-upload");
    upload.append(el("label", "", t("kb.to")), select, add, input);

    // Documents by scope.
    const groups = el("div", "kb-groups");
    for (const s of res.scopes) {
      const docs = res.documents.filter((d) => d.scope === s.id);
      if (!docs.length && s.id !== "company") continue;
      const g = el("section", "kb-group");
      g.append(el("h4", "", `${s.id === "company" ? "🏢" : "🚪"} ${scopeName(s.id)} · ${docs.length}`));
      if (!docs.length) g.append(el("p", "help", t("kb.none")));
      const ul = el("ul", "manage-list");
      for (const d of docs) {
        const li = el("li", "occupant-item");
        const row = el("div", "occupant-row");
        const info = el("div", "occupant-info");
        info.append(el("strong", "", `${fileIcon(d.name)} ${d.name}`), el("small", "help", `${fileSize(d.size)} · ${t("kb.chars", { n: d.chars.toLocaleString() })} · ${new Date(d.createdAt).toLocaleDateString()}`));
        const view = el("button", "small", this.preview?.id === d.id ? t("kb.hide") : t("kb.preview"));
        view.type = "button";
        view.addEventListener("click", () => void this.togglePreview(d.id));
        const dl = el("button", "small", "⬇");
        dl.type = "button";
        dl.title = t("files.download");
        dl.addEventListener("click", () => void downloadFile(d).catch((err: Error) => alert(err.message)));
        const del = el("button", "small danger", t("kb.delete"));
        del.type = "button";
        del.addEventListener("click", () => {
          if (!confirm(t("kb.confirmDelete", { name: d.name }))) return;
          void this.guard(status, () => api("DELETE", `/api/files/${d.id}`)).then(() => this.render());
        });
        row.append(info, view, dl, del);
        li.append(row);
        if (this.preview?.id === d.id) li.append(el("pre", "kb-preview", this.preview.text || "…"));
        ul.append(li);
      }
      g.append(ul);
      groups.append(g);
    }

    // Search as the agents do.
    const search = el("form", "row kb-search");
    const q = el("input");
    q.type = "search";
    q.placeholder = t("kb.searchPlaceholder");
    q.value = this.query;
    const go = el("button", "small", t("kb.search"));
    go.type = "submit";
    search.append(q, go);
    search.addEventListener("submit", (e) => {
      e.preventDefault();
      this.query = q.value.trim();
      void this.search();
    });
    const hits = el("ul", "kb-hits");
    if (this.hits) {
      if (!this.hits.length) hits.append(el("li", "help", t("kb.noHits")));
      for (const h of this.hits) {
        const li = el("li");
        li.append(el("strong", "", `${h.name}`), el("small", "help", ` · ${scopeName(h.scope)} · ${h.part}/${h.parts}`), el("p", "kb-snippet", h.snippet));
        hits.append(li);
      }
    }

    this.root.replaceChildren(el("p", "help", t("kb.intro")), upload, status, groups, el("h4", "", `🔍 ${t("kb.try")}`), search, hits);
  }

  private async upload(files: File[], status: HTMLElement) {
    const done: string[] = [];
    const failed: string[] = [];
    for (const f of files) {
      status.textContent = t("files.uploadingName", { name: f.name });
      try {
        await uploadFile(f, "kb", this.scope);
        done.push(f.name);
      } catch (err) {
        if (err instanceof Unauthorized) return void this.guard(status, () => Promise.reject(err));
        failed.push((err as Error).message);
      }
    }
    await this.render([done.length ? t("kb.added", { n: String(done.length) }) : "", ...failed].filter(Boolean).join(" · "));
  }

  private async togglePreview(id: number) {
    if (this.preview?.id === id) this.preview = null;
    else {
      const res = await this.guard(null, () => api<{ text: string }>("GET", `/api/files/${id}`));
      if (!res) return;
      this.preview = { id, text: res.text };
    }
    await this.render();
  }

  private async search() {
    if (!this.query) this.hits = null;
    else {
      const res = await this.guard(null, () => api<{ hits: Hit[] }>("GET", `/api/knowledge/search?q=${encodeURIComponent(this.query)}`));
      this.hits = res?.hits ?? [];
    }
    await this.render();
  }
}
