#!/usr/bin/env node
// Usage: npm run state -- <id> <state> [detail...]
//   e.g. npm run state -- me writing "Sketching the lobby"
// Token: BARNACLE_TOKEN, or data/secret.json next to this repo.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [id, state, ...rest] = process.argv.slice(2);
if (!id || !state) {
  console.error('Usage: npm run state -- <id> <state> [detail]\nStates: idle writing researching executing syncing waiting error offline');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.BARNACLE_TOKEN ?? JSON.parse(readFileSync(path.join(root, "data/secret.json"), "utf8")).token;
const base = process.env.BARNACLE_URL ?? "http://localhost:19100";

const res = await fetch(`${base}/api/occupants/${id}/status`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ state, detail: rest.join(" ") || undefined }),
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
