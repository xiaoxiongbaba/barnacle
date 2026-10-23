# Claude Code → Barnacle

Shows Claude Code in your office: it walks to the desks while editing, to the
library while reading or searching, to the server room while running commands,
and back to the lounge when it is done.

The hook sends only generic details ("Editing parser.ts", "Reading code"),
never command lines or file contents. It times out after 1.5 s and always
exits 0, so it cannot slow down or break Claude Code.

## Setup

1. Make sure Barnacle is running and note the office token (printed in the log
   on first start, or in `data/secret.json`).
2. Add the hooks to `~/.claude/settings.json` (all projects) or
   `.claude/settings.json` (one project). Replace the path and token:

```json
{
  "env": {
    "BARNACLE_URL": "http://localhost:19100",
    "BARNACLE_TOKEN": "<your office token>"
  },
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/barnacle/integrations/claude-code/barnacle-hook.mjs", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/barnacle/integrations/claude-code/barnacle-hook.mjs", "timeout": 5 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/barnacle/integrations/claude-code/barnacle-hook.mjs", "timeout": 5 }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node /path/to/barnacle/integrations/claude-code/barnacle-hook.mjs", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/barnacle/integrations/claude-code/barnacle-hook.mjs", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/barnacle/integrations/claude-code/barnacle-hook.mjs", "timeout": 5 }] }]
  }
}
```

Several Claude Code sessions? Give each its own `BARNACLE_AGENT_ID` and
`BARNACLE_AGENT_NAME` (for example per project) and they show up as separate
characters.

## Event → state

| Hook event         | State         | Detail                          |
| ------------------ | ------------- | ------------------------------- |
| `SessionStart`     | `idle`        | Ready                           |
| `UserPromptSubmit` | `researching` | Thinking about the request      |
| `PreToolUse` Edit / Write | `writing` | Editing `<file name>`        |
| `PreToolUse` Bash  | `executing`   | The command's short description |
| `PreToolUse` Read / Grep / Glob | `researching` | Reading code       |
| `PreToolUse` WebSearch / WebFetch | `researching` | Searching the web |
| `PreToolUse` other | `executing`   | Using `<tool>`                  |
| `Notification`     | `idle`        | Waiting for you                 |
| `Stop`             | `idle`        | Done, waiting for you           |
| `SessionEnd`       | `offline`     |                                 |
