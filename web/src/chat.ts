import { api, tokenStore, Unauthorized } from "./auth";
import { onLanguageChange, t } from "./i18n";
import type { SettingsDialog } from "./settings";
import type { Occupant } from "./types";

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

type StreamEvent = { type: "text"; text: string } | { type: "done" } | { type: "error"; message: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Chat with an occupant that has a model. Replies stream in; the server moves the character while it works. */
export class ChatDialog {
  private dialog = $<HTMLDialogElement>("chat");
  private log = $<HTMLOListElement>("chat-log");
  private input = $<HTMLTextAreaElement>("chat-input");
  private occupantId: string | null = null;
  private sending = false;

  constructor(
    private settings: SettingsDialog,
    private getOccupant: (id: string) => Occupant | undefined,
  ) {
    $("chat-close").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    $("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    this.input.addEventListener("keydown", (e) => {
      // Enter sends, Shift+Enter breaks the line; ignore Enter while an IME (Japanese/Chinese input) is composing.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    $("chat-clear").addEventListener("click", () => void this.clear());
    onLanguageChange(() => this.renderHeader());
  }

  async open(id: string) {
    try {
      await this.settings.ensureUnlocked();
    } catch {
      return;
    }
    this.occupantId = id;
    this.renderHeader();
    this.log.replaceChildren();
    $("chat-error").hidden = true;
    this.dialog.showModal();
    this.input.focus();
    try {
      const { messages } = await api<{ messages: StoredMessage[] }>("GET", `/api/occupants/${encodeURIComponent(id)}/messages`);
      if (messages.length === 0) this.renderEmpty();
      for (const m of messages) this.append(m.role, m.content);
    } catch (err) {
      this.showError(err);
    }
  }

  /** Keeps the header (and the chat button state) in sync when the occupant changes. */
  refresh() {
    if (this.dialog.open) this.renderHeader();
  }

  private renderHeader() {
    const o = this.occupantId ? this.getOccupant(this.occupantId) : undefined;
    if (!o) return;
    $("chat-title").textContent = t("chat.title", { name: o.name });
    $("chat-model").textContent = o.model ?? "";
  }

  private renderEmpty() {
    const o = this.occupantId ? this.getOccupant(this.occupantId) : undefined;
    const li = document.createElement("li");
    li.className = "chat-hint";
    li.textContent = t("chat.empty", { model: o?.model ?? "" });
    this.log.append(li);
  }

  private append(role: "user" | "assistant", text: string): HTMLElement {
    this.log.querySelector(".chat-hint")?.remove();
    const li = document.createElement("li");
    li.className = `chat-msg chat-msg--${role}`;
    li.textContent = text;
    this.log.append(li);
    this.log.scrollTop = this.log.scrollHeight;
    return li;
  }

  private showError(err: unknown) {
    const box = $("chat-error");
    box.textContent = err instanceof Unauthorized ? t("chat.locked") : t("common.failed", { error: (err as Error).message });
    box.hidden = false;
  }

  private async send() {
    const message = this.input.value.trim();
    const id = this.occupantId;
    if (!message || !id || this.sending) return;
    this.sending = true;
    $("chat-error").hidden = true;
    const button = $("chat-form").querySelector<HTMLButtonElement>("button")!;
    button.disabled = true;
    this.input.value = "";
    this.append("user", message);
    const reply = this.append("assistant", "…");
    reply.classList.add("chat-msg--pending");
    let text = "";
    try {
      const res = await fetch(`/api/occupants/${encodeURIComponent(id)}/chat`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenStore.get() ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (res.status === 401) throw new Unauthorized();
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string | string[] };
        throw new Error(Array.isArray(body.error) ? body.error.join("; ") : (body.error ?? res.statusText));
      }
      await this.readStream(res.body, (event) => {
        if (event.type === "text") {
          text += event.text;
          reply.textContent = text;
          reply.classList.remove("chat-msg--pending");
          this.log.scrollTop = this.log.scrollHeight;
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      });
      if (!text) reply.remove();
    } catch (err) {
      if (!text) reply.remove();
      this.showError(err);
    } finally {
      this.sending = false;
      button.disabled = false;
      this.input.focus();
    }
  }

  /** Parses server-sent events ("data: {...}\n\n"). */
  private async readStream(body: ReadableStream<Uint8Array>, onEvent: (e: StreamEvent) => void) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data:")) onEvent(JSON.parse(line.slice(5)) as StreamEvent);
        }
      }
    }
  }

  private async clear() {
    const id = this.occupantId;
    if (!id) return;
    try {
      await api("DELETE", `/api/occupants/${encodeURIComponent(id)}/messages`);
      this.log.replaceChildren();
      this.renderEmpty();
    } catch (err) {
      this.showError(err);
    }
  }
}
