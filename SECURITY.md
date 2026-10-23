# Security

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them
privately through GitHub: the repository's **Security** tab → **Report a
vulnerability**. Include what you found, how to reproduce it and what it lets
an attacker do. You should get an answer within a week.

Barnacle is an early prototype (v0.1); fixes land on the main branch.

## How Barnacle is meant to be run

Barnacle is self-hosted software for one team. Keep these in mind when you
deploy it:

- **Viewing needs no login yet.** In v0.1 anyone who can reach the port can
  watch the office (the page, `GET` requests and the WebSocket). Changing
  anything needs the office token. Keep it on your LAN, or behind a VPN or a
  reverse proxy with authentication.
- **The office token** is generated on first start and stored in
  `DATA_DIR/secret.json` (or set with `BARNACLE_TOKEN`). Treat it like a
  password; rotate it in Settings → Security.
- **API keys and MCP secrets** are encrypted at rest (AES-256-GCM) with
  `DATA_DIR/master.key` and are never sent to the browser. Anyone who has both
  the database and `master.key` can decrypt them: protect and back up the whole
  data folder, and never commit it.
- **Agents act on your behalf.** They call model providers, search and read the
  web, and use the MCP servers you connect. A local MCP server (a command) runs
  on the host with the permissions of the Barnacle process: add only servers you
  trust. Use Settings → Permissions and the per-tool MCP rules to make risky
  actions wait for your approval.
- **Budgets** (Settings → Costs) limit how much agents can spend on models.
