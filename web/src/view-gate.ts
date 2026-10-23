import { api, tokenStore } from "./auth";
import { t } from "./i18n";

/**
 * The view password: when the office has one, the page asks for it before showing anything (someone who
 * has the office token gets in without it). And its settings, in Settings → Security.
 */

type Guard = <T>(status: Element | null, fn: () => Promise<T>) => Promise<T | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function status(): Promise<{ required: boolean; ok: boolean }> {
  const res = await fetch("/api/view/status", { credentials: "same-origin" });
  return (await res.json()) as { required: boolean; ok: boolean };
}

let waiting: Promise<void> | null = null;

/** Resolves once this page may view the office: at once when it may, else after the password. */
export function ensureView(): Promise<void> {
  waiting ??= (async () => {
    let s = await status().catch(() => ({ required: false, ok: true }));
    if (s.ok) return;
    // The office token is enough: trade it for a viewer session (the live updates need the cookie).
    if (tokenStore.get()) {
      await api("POST", "/api/view/session").catch(() => {});
      s = await status().catch(() => s);
      if (s.ok) return;
    }
    await askPassword();
  })().finally(() => (waiting = null));
  return waiting;
}

function askPassword(): Promise<void> {
  return new Promise((resolve) => {
    const dialog = el("dialog", "settings view-gate");
    const form = el("form", "view-gate__form");
    const input = el("input");
    input.type = "password";
    input.autocomplete = "current-password";
    input.required = true;
    input.placeholder = t("view.password");
    const error = el("p", "status status--error");
    const submit = el("button", "primary", t("view.enter"));
    submit.type = "submit";
    form.append(el("h2", "", `🔒 ${t("view.title")}`), el("p", "help", t("view.intro")), input, submit, error);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.textContent = "";
      void fetch("/api/view/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: input.value }) })
        .then(async (res) => {
          if (res.ok) {
            dialog.close();
            dialog.remove();
            resolve();
            return;
          }
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          error.textContent = res.status === 429 ? t("view.tooMany") : res.status === 401 ? t("view.wrong") : (data.error ?? res.statusText);
          input.select();
        })
        .catch((err: Error) => (error.textContent = err.message))
        .finally(() => (submit.disabled = false));
    });
    // It can't be dismissed: there is nothing to see without it.
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

/** Settings → Security: turn the view password on or off, change it, sign every viewer out. */
export class ViewPasswordPanel {
  constructor(
    private root: HTMLElement,
    private guard: Guard,
  ) {}

  async render(note = "") {
    const cfg = await this.guard(null, () => api<{ enabled: boolean; hasPassword: boolean }>("GET", "/api/view/config"));
    if (!cfg) return;
    const state = el("p", "help", cfg.enabled ? `🔒 ${t("view.on")}` : `🔓 ${t("view.off")}`);
    const out = el("span", "status", note);
    out.setAttribute("role", "status");

    const pw = el("input");
    pw.type = "password";
    pw.autocomplete = "new-password";
    pw.minLength = 8;
    pw.placeholder = cfg.hasPassword ? t("view.newPassword") : t("view.password");
    const again = el("input");
    again.type = "password";
    again.autocomplete = "new-password";
    again.placeholder = t("view.again");

    const save = (body: { enabled?: boolean; password?: string }, done: string) =>
      void this.guard(out, () => api("PUT", "/api/view/config", body)).then((r) => r && this.render(done));

    const set = el("button", "primary small", cfg.enabled ? t("view.change") : t("view.turnOn"));
    set.type = "button";
    set.addEventListener("click", () => {
      if (pw.value.length < 8) return void (out.textContent = t("view.short"));
      if (pw.value !== again.value) return void (out.textContent = t("view.mismatch"));
      save({ password: pw.value, enabled: true }, cfg.enabled ? t("view.changed") : t("view.turnedOn"));
    });
    const buttons = el("div", "row");
    buttons.append(set);
    if (cfg.enabled) {
      const off = el("button", "small", t("view.turnOff"));
      off.type = "button";
      off.addEventListener("click", () => save({ enabled: false }, t("view.turnedOff")));
      const everyone = el("button", "small danger", t("view.signOutAll"));
      everyone.type = "button";
      everyone.addEventListener("click", () => void this.guard(out, () => api("POST", "/api/view/signout-all")).then((r) => r && this.render(t("view.signedOut"))));
      buttons.append(off, everyone);
    } else if (cfg.hasPassword) {
      const back = el("button", "small", t("view.turnOnAgain"));
      back.type = "button";
      back.addEventListener("click", () => save({ enabled: true }, t("view.turnedOn")));
      buttons.append(back);
    }
    buttons.append(out);
    const fields = el("div", "view-fields");
    fields.append(pw, again);
    this.root.replaceChildren(el("h3", "", t("view.settingsTitle")), el("p", "help", t("view.settingsHelp")), state, fields, buttons);
  }
}
