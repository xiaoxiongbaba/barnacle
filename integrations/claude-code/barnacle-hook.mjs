#!/usr/bin/env node
// Claude Code hook → Barnacle state. Reads the hook event from stdin and reports a state.
// It never blocks Claude Code: every failure is swallowed and the script always exits 0.
//
// Env:
//   BARNACLE_URL        default http://localhost:19100
//   BARNACLE_TOKEN      the office token (or BARNACLE_TOKEN_FILE pointing at data/secret.json)
//   BARNACLE_AGENT_ID   default claude-code
//   BARNACLE_AGENT_NAME default Claude Code

import { readFileSync } from "node:fs";
import path from "node:path";

const base = process.env.BARNACLE_URL ?? "http://localhost:19100";
const id = process.env.BARNACLE_AGENT_ID ?? "claude-code";
const name = process.env.BARNACLE_AGENT_NAME ?? "Claude Code";

function token() {
  if (process.env.BARNACLE_TOKEN) return process.env.BARNACLE_TOKEN;
  if (process.env.BARNACLE_TOKEN_FILE) return JSON.parse(readFileSync(process.env.BARNACLE_TOKEN_FILE, "utf8")).token;
  return undefined;
}

/** Maps a hook event to a state. Details stay generic: no command lines, no file contents. */
function toState(e) {
  const tool = e.tool_name ?? "";
  const input = e.tool_input ?? {};
  switch (e.hook_event_name) {
    case "SessionStart":
      return { state: "idle", detail: "Ready" };
    case "UserPromptSubmit":
      return { state: "researching", detail: "Thinking about the request" };
    case "Stop":
      return { state: "idle", detail: "Done, waiting for you" };
    case "Notification":
      return { state: "idle", detail: "Waiting for you" };
    case "SessionEnd":
      return { state: "offline", detail: "" };
    case "PreToolUse":
      if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
        const file = input.file_path ?? input.notebook_path;
        return { state: "writing", detail: file ? `Editing ${path.basename(file)}` : "Editing files" };
      }
      if (tool === "Bash") return { state: "executing", detail: input.description ? String(input.description) : "Running a command" };
      if (["Read", "Grep", "Glob"].includes(tool)) return { state: "researching", detail: "Reading code" };
      if (["WebSearch", "WebFetch"].includes(tool)) return { state: "researching", detail: "Searching the web" };
      if (["Task", "Agent"].includes(tool)) return { state: "executing", detail: "Working with a subagent" };
      if (tool === "TodoWrite") return { state: "researching", detail: "Planning" };
      if (tool.startsWith("mcp__")) return { state: "executing", detail: `Using ${tool.split("__")[1] ?? "MCP"} tools` };
      return { state: "executing", detail: tool ? `Using ${tool}` : "Working" };
    default:
      return null;
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const report = toState(JSON.parse(raw || "{}"));
  const t = token();
  if (!report || !t) return;
  await fetch(`${base}/api/occupants/${id}/status`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({ ...report, name, kind: "agent" }),
    signal: AbortSignal.timeout(1500),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
