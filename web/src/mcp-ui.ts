import { api } from "./auth";
import { t } from "./i18n";
import type { Occupant } from "./types";

/** Settings → MCP: connect outside tools (calendars, Notion, GitHub, files…) and decide who may use them. */

type Rule = "allow" | "ask" | "deny";
type Guard = <T>(status: Element | null, fn: () => Promise<T>) => Promise<T | undefined>;

interface Server {
  id: number;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  members: string[] | null;
  rules: Record<string, Rule>;
  defaultRule: Rule;
  secretKeys: string[];
  state: { status: "off" | "connecting" | "ready" | "error"; error: string; tools: { name: string; description: string }[] };
}

interface Draft {
  id: number | null;
  name: string;
  transport: "stdio" | "http";
  command: string;
  /** One argument per line. */
  args: string;
  url: string;
  /** KEY=value lines; a key without a value keeps the saved one. */
  secrets: string;
  everyone: boolean;
  members: string[];
  defaultRule: Rule;
  rules: Record<string, Rule>;
  enabled: boolean;
}

/** Starting points; everything stays editable. */
const PRESETS: { id: string; draft: Partial<Draft> }[] = [
  { id: "filesystem", draft: { name: "Files", transport: "stdio", command: "npx", args: "-y\n@modelcontextprotocol/server-filesystem\n/path/to/shared/folder" } },
  { id: "github", draft: { name: "GitHub", transport: "http", url: "https://api.githubcopilot.com/mcp/", secrets: "Authorization=Bearer <your GitHub token>" } },
  { id: "notion", draft: { name: "Notion", transport: "stdio", command: "npx", args: "-y\n@notionhq/notion-mcp-server", secrets: "NOTION_TOKEN=<your integration token>" } },
  { id: "fetch", draft: { name: "Fetch", transport: "stdio", command: "uvx", args: "mcp-server-fetch" } },
];

const blank = (): Draft => ({ id: null, name: "", transport: "stdio", command: "", args: "", url: "", secrets: "", everyone: true, members: [], defaultRule: "ask", rules: {}, enabled: true });

const fromServer = (s: Server): Draft => ({
  id: s.id,
  name: s.name,
  transport: s.transport,
  command: s.command,
  args: s.args.join("\n"),
  url: s.url,
  secrets: s.secretKeys.map((k) => `${k}=`).join("\n"),
  everyone: s.members === null,
  members: s.members ?? [],
  defaultRule: s.defaultRule,
  rules: { ...s.rules },
  enabled: s.enabled,
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ruleSelect(value: Rule, onChange: (r: Rule) => void) {
  const select = el("select");
  for (const r of ["allow", "ask", "deny"] as const) select.append(new Option(t(`policy.${r}`), r, false, r === value));
  select.addEventListener("change", () => onChange(select.value as Rule));
  return select;
}

export class McpTab {
  private draft: Draft | null = null;
  private servers: Server[] = [];

  constructor(
    private root: HTMLElement,
    private guard: Guard,
    private occupants: () => Occupant[],
  ) {}

  /** A server changed state (connected, failed): redraw unless you are editing. */
  changed() {
    if (!this.root.hidden && !this.draft) void this.render();
  }

  async render(note = "") {
    const res = await this.guard(null, () => api<{ servers: Server[] }>("GET", "/api/mcp"));
    if (!res) return;
    this.servers = res.servers;
    const status = el("p", "status", note);
    const list = el("ul", "manage-list");
    for (const s of res.servers) list.append(this.item(s, status));
    const add = el("button", "primary small", `＋ ${t("mcp.add")}`);
    add.type = "button";
    add.addEventListener("click", () => {
      this.draft = blank();
      void this.render();
    });
    this.root.replaceChildren(
      el("p", "help", t("mcp.intro")),
      res.servers.length ? list : el("p", "help", t("mcp.none")),
      ...(this.draft ? [this.form(this.draft, status)] : [add]),
      status,
      el("p", "help", t("mcp.security")),
    );
  }

  private item(s: Server, status: HTMLElement) {
    const li = el("li", "occupant-item mcp-item");
    const row = el("div", "occupant-row");
    const info = el("div", "occupant-info");
    const dot = { ready: "🟢", connecting: "🟡", error: "🔴", off: "⚪" }[s.enabled ? s.state.status : "off"];
    const who = s.members === null ? t("mcp.everyone") : s.members.map((id) => this.occupants().find((o) => o.id === id)?.name ?? id).join("、") || t("mcp.nobody");
    info.append(
      el("strong", "", `${dot} ${s.name}`),
      el("small", "help", `${t(`mcp.status.${s.enabled ? s.state.status : "off"}`)} · ${s.transport === "stdio" ? `${s.command} ${s.args.join(" ")}` : s.url}`),
      el("small", "help", `${t("mcp.who")}：${who}`),
    );
    if (s.state.error) info.append(el("small", "status status--error", s.state.error));
    const edit = el("button", "small", t("mcp.edit"));
    edit.type = "button";
    edit.addEventListener("click", () => {
      this.draft = fromServer(s);
      void this.render();
    });
    const again = el("button", "small", t("mcp.reconnect"));
    again.type = "button";
    again.addEventListener("click", () => void this.guard(status, () => api("POST", `/api/mcp/${s.id}/reconnect`)).then(() => this.render()));
    row.append(info, again, edit);
    li.append(row);

    // Its tools, each with its rule (saved at once).
    if (s.state.tools.length) {
      const tools = el("details", "mcp-tools");
      tools.append(el("summary", "", t("mcp.tools", { n: String(s.state.tools.length) })));
      const table = el("table", "cost-table");
      for (const tool of s.state.tools) {
        const tr = el("tr");
        const name = el("td");
        name.append(el("strong", "", tool.name), el("div", "help", tool.description.slice(0, 160)));
        const pick = el("td");
        pick.append(
          ruleSelect(s.rules[tool.name] ?? s.defaultRule, (r) => {
            const d = fromServer(s);
            d.rules[tool.name] = r;
            void this.save(d, status, false);
          }),
        );
        tr.append(name, pick);
        table.append(tr);
      }
      tools.append(table);
      li.append(tools);
    }
    return li;
  }

  private form(d: Draft, status: HTMLElement) {
    const box = el("div", "mcp-form");
    const field = (label: string, input: HTMLElement, help?: string) => {
      const l = el("label");
      l.append(el("span", "", label), input);
      if (help) l.append(el("small", "help", help));
      return l;
    };
    const text = (value: string, set: (v: string) => void, placeholder = "", rows = 0) => {
      const input = rows ? el("textarea") : el("input");
      if (input instanceof HTMLTextAreaElement) input.rows = rows;
      input.value = value;
      input.placeholder = placeholder;
      input.addEventListener("input", () => set(input.value));
      return input;
    };

    if (d.id === null) {
      const presets = el("div", "row mcp-presets");
      presets.append(el("span", "help", t("mcp.presets")));
      for (const p of PRESETS) {
        const b = el("button", "small", t(`mcp.preset.${p.id}`));
        b.type = "button";
        b.addEventListener("click", () => {
          this.draft = { ...blank(), ...p.draft };
          void this.render();
        });
        presets.append(b);
      }
      box.append(presets);
    }

    const transport = el("select");
    transport.append(new Option(t("mcp.stdio"), "stdio", false, d.transport === "stdio"), new Option(t("mcp.http"), "http", false, d.transport === "http"));
    transport.addEventListener("change", () => {
      d.transport = transport.value as Draft["transport"];
      void this.render();
    });
    box.append(field(t("mcp.name"), text(d.name, (v) => (d.name = v), "Calendar")), field(t("mcp.transport"), transport));
    if (d.transport === "stdio") {
      box.append(
        field(t("mcp.command"), text(d.command, (v) => (d.command = v), "npx")),
        field(t("mcp.args"), text(d.args, (v) => (d.args = v), "-y\n@modelcontextprotocol/server-filesystem\n/data", 3), t("mcp.argsHelp")),
        field(t("mcp.env"), text(d.secrets, (v) => (d.secrets = v), "API_KEY=…", 3), t("mcp.secretHelp")),
      );
    } else {
      box.append(field(t("mcp.url"), text(d.url, (v) => (d.url = v), "https://…/mcp")), field(t("mcp.headers"), text(d.secrets, (v) => (d.secrets = v), "Authorization=Bearer …", 3), t("mcp.secretHelp")));
    }

    // Who may use it.
    const who = el("fieldset", "mcp-who");
    who.append(el("legend", "", t("mcp.who")));
    const all = el("label", "check");
    const allBox = el("input");
    allBox.type = "checkbox";
    allBox.checked = d.everyone;
    allBox.addEventListener("change", () => {
      d.everyone = allBox.checked;
      void this.render();
    });
    all.append(allBox, el("span", "", t("mcp.everyone")));
    who.append(all);
    if (!d.everyone) {
      for (const o of this.occupants().filter((x) => x.kind === "agent" && x.model)) {
        const l = el("label", "check");
        const c = el("input");
        c.type = "checkbox";
        c.checked = d.members.includes(o.id);
        c.addEventListener("change", () => (d.members = c.checked ? [...d.members, o.id] : d.members.filter((x) => x !== o.id)));
        l.append(c, el("span", "", o.name));
        who.append(l);
      }
    }
    box.append(who, field(t("mcp.defaultRule"), ruleSelect(d.defaultRule, (r) => (d.defaultRule = r)), t("mcp.defaultRuleHelp")));

    const enabled = el("label", "check");
    const on = el("input");
    on.type = "checkbox";
    on.checked = d.enabled;
    on.addEventListener("change", () => (d.enabled = on.checked));
    enabled.append(on, el("span", "", t("mcp.enabled")));
    box.append(enabled);

    const actions = el("div", "row");
    const save = el("button", "primary small", t("mcp.save"));
    save.type = "button";
    save.addEventListener("click", () => void this.save(d, status, true));
    const cancel = el("button", "small", t("mcp.cancel"));
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      this.draft = null;
      void this.render();
    });
    actions.append(save, cancel);
    if (d.id !== null) {
      const id = d.id;
      const del = el("button", "small danger", t("mcp.delete"));
      del.type = "button";
      del.addEventListener("click", () => {
        if (!confirm(t("mcp.confirmDelete", { name: d.name }))) return;
        void this.guard(status, () => api("DELETE", `/api/mcp/${id}`)).then(() => {
          this.draft = null;
          void this.render();
        });
      });
      actions.append(del);
    }
    box.append(actions);
    return box;
  }

  private async save(d: Draft, status: HTMLElement, closing: boolean) {
    const secrets = d.secrets
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.search(/[=:]/);
        return i < 0 ? { key: line, value: "" } : { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
      })
      .filter((s) => s.key);
    const body = {
      name: d.name.trim(),
      transport: d.transport,
      command: d.command.trim(),
      args: d.args.split("\n").map((a) => a.trim()).filter(Boolean),
      url: d.url.trim(),
      secrets,
      enabled: d.enabled,
      members: d.everyone ? null : d.members,
      rules: d.rules,
      defaultRule: d.defaultRule,
    };
    const res = await this.guard(status, () => (d.id === null ? api("POST", "/api/mcp", body) : api("PUT", `/api/mcp/${d.id}`, body)));
    if (!res) return;
    if (closing) this.draft = null;
    await this.render(closing ? t("mcp.saved") : "");
  }
}
