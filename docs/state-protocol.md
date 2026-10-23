# Barnacle state protocol — draft v0.1

> Status: **draft**. Field names and endpoints may change before v1.

A Barnacle is a self-hosted pixel office. People and AI agents report what they
are doing; the office turns each report into a character walking to an area.
This document defines how anything reports state to a Barnacle, and what the
office pushes to browsers.

Later, a Barnacle can attach to **Whale** (the shared building). That link is
out of scope for v0.1; the address format below is reserved for it.

## Addresses

Every occupant has an id that is unique inside its Barnacle:

- id: `^[a-z0-9][a-z0-9_-]{0,39}$`, e.g. `claude-code`, `me`, `ci-runner`
- full address (reserved for Whale): `<id>@<barnacle-host>`, e.g. `claude-code@desk.example.com`

## States

| State         | Meaning                              | Default area |
| ------------- | ------------------------------------ | ------------ |
| `idle`        | Waiting, between tasks               | lounge       |
| `writing`     | Writing code or documents            | desks        |
| `researching` | Reading, searching, thinking         | library      |
| `executing`   | Running commands, builds, tasks      | server room  |
| `syncing`     | Pushing, deploying, syncing data     | server room  |
| `waiting`     | Needs you: a permission or a question | own room (raises a hand) |
| `error`       | Something failed, debugging          | bug corner   |
| `offline`     | Not present                          | door (faded) |

The first six match Star Office UI, so its users can migrate without changes.
Area mapping lives in the layout, not in code, so mod packs can remap it.

### Automatic transitions

- A working state (`writing`, `researching`, `executing`, `syncing`, `waiting`, `error`)
  with no new report for `STATE_TTL_SECONDS` (default 300) falls back to `idle`.
- Any occupant with no report for `OFFLINE_AFTER_SECONDS` (default 1800)
  becomes `offline`.

## Authentication

Writes need the office token: `Authorization: Bearer <token>`.

- On first start the Barnacle generates a random 256-bit token, stores it in
  `DATA_DIR/secret.json` and prints it once to the log.
- `BARNACLE_TOKEN` overrides it (minimum 32 characters).
- Reads (`GET`, WebSocket) are open to whoever can reach the port. A viewing
  password is planned; until then, do not expose the port to the internet.

There are no default credentials, and the Barnacle opens no outbound
connections in v0.1.

## REST API

All bodies are JSON. Base path: `/api`.

### `POST /api/occupants/:id/status` (token)

```json
{ "state": "writing", "detail": "Refactoring the parser", "name": "Claude Code", "kind": "agent" }
```

| Field    | Required | Notes                                                       |
| -------- | -------- | ----------------------------------------------------------- |
| `state`  | yes      | One of the states above                                     |
| `detail` | no       | ≤ 140 chars after sanitizing; secrets are masked (see below) |
| `name`   | no       | Display name, ≤ 40 chars; defaults to the id                |
| `kind`   | no       | `agent` (default) or `human`                                |

Creates the occupant if it does not exist. Returns the occupant.

### `DELETE /api/occupants/:id` (token)

Removes an occupant and its history.

### `GET /api/occupants`

```json
{ "occupants": [ { "id": "claude-code", "name": "Claude Code", "kind": "agent",
  "state": "writing", "detail": "Refactoring the parser",
  "updatedAt": "2026-10-22T06:00:00.000Z" } ] }
```

### `GET /api/events?limit=50`

Most recent state changes, newest first (`limit` ≤ 200). Used for the work log.

### `GET /api/office`

Office name, default language, active pack id, protocol version, the list of states and the active layout.

### `GET /api/health`

`{ "ok": true }`

### Settings (token)

Used by the settings page; any client with the token may call them.

| Endpoint                 | Meaning                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `GET /api/auth`          | `200` if the token is valid, plus `tokenFromEnv`               |
| `GET /api/settings`      | Current settings, available packs, `tokenFromEnv`              |
| `PUT /api/settings`      | `{ officeName, language, pack, stateTtlSeconds, offlineAfterSeconds }`; broadcasts a new `snapshot` |
| `POST /api/token/rotate` | Issues a new token and invalidates the old one (`409` when set by `BARNACLE_TOKEN`) |

`language` is one of `en`, `ja`, `zh-Hant`. `pack` must be an id from `GET /api/settings`.

## WebSocket: `/ws`

Server → client only in v0.1. Every message is one JSON object:

| `type`     | Payload                                   | When                      |
| ---------- | ----------------------------------------- | ------------------------- |
| `snapshot` | `office`, `occupants`, `events`           | Right after connecting    |
| `occupant` | `occupant`                                | An occupant changed       |
| `removed`  | `id`                                      | An occupant was deleted   |
| `event`    | `event` (`id`, `occupantId`, `state`, `detail`, `at`) | A state change was logged |

Clients reconnect with backoff and rely on the next `snapshot`.

## Detail sanitizing

Before storing or broadcasting, `detail` is trimmed to 140 characters and
anything that looks like a secret is replaced with `[redacted]`:

- API-key shapes (`sk-…`, `ghp_…`, `xox…-…`, `AKIA…`)
- Bearer tokens and `key=value` pairs whose key contains `token`, `secret`, `password` or `key`
- Long hex/base64 runs (≥ 32 chars)
- Private IPv4 addresses and absolute home paths

Integrations should still avoid sending command lines or file contents.
