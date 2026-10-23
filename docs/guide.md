# Barnacle guide

Everything Barnacle does, in detail. For installing and a quick overview, see
the [README](../README.md).

- [Start a company](#start-a-company)
- [Report a state](#report-a-state)
- [Integrations](#integrations)
- [Settings](#settings)
- [Floor plan](#floor-plan)
- [AI models](#ai-models) — memory, working together, MCP tools, costs, files,
  projects, the organization, manager review and profiles, keeping agents in
  check, scheduled tasks
- [Environment variables](#environment-variables)
- [Art packs](#art-packs)

## Start a company

The first time you open an unlocked office with no agent that has a model, the
**Start a company** wizard opens (it is also in Settings → General): name the
company, pick a team template — content team, research team, e-commerce team or
personal assistants — and connect a model (one you set up, or a provider preset
plus an API key). Barnacle then creates the whole team: members with a job title,
soul, way of working and skills, each at a desk in the right room; department
managers; optionally a CEO; and the scheduled work (some of it as projects), with
an idea of how many scheduled runs a day that means. Names already in use get a
number; everything can be changed afterwards.

### Sharing a team

Settings → General → **Export team** downloads the current team as a
`.barnacle-team.json` file: each agent's name, job title, soul, way of working,
skills (in full), department, whether they manage it or are the CEO, and the
scheduled work. It never contains API keys, model providers, memory or
knowledge-base documents.

To use a team file, open **Start a company** and choose **Import from a file**.
The wizard shows who and what it would create and what won't come over as it is
(skills that are missing, departments this office doesn't have, scheduled work
for nobody); you then pick the model as for a template. Members whose names are
taken get a number, and @mentions in the scheduled work follow; a skill that
clashes with a different one of yours comes in under a new id, so nothing you
have is overwritten. Souls and skills are instructions your agents follow:
import teams only from people you trust.

## Report a state

The office token is generated on first start, printed once in the log and
stored in `data/secret.json` (or set your own with `BARNACLE_TOKEN`).

```bash
curl -X POST http://localhost:19100/api/occupants/me/status \
  -H "Authorization: Bearer $BARNACLE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"state":"writing","detail":"Sketching the lobby","name":"Me","kind":"human"}'
```

or, from a source checkout:

```bash
npm run state -- me writing "Sketching the lobby"
```

States: `idle`, `writing`, `researching`, `executing`, `syncing`, `waiting` (needs you), `error`, `offline`.

## Integrations

- [Claude Code](../integrations/claude-code/README.md) — hooks that report what Claude Code is doing
- Anything that can send an HTTP request — see the [state protocol](state-protocol.md)

## Settings

Click the gear in the top-right corner and enter the office token. From there you can:

- rename the office, pick the default language, the art pack and the idle/offline timeouts
- remove occupants
- copy ready-made snippets (curl, Claude Code hook + settings) that already contain this office's address and token
- rotate the token
- set a **view password** (Security): with it on, the page asks for it before
  showing anything, and the office's data and live updates need it (or the
  token). Viewers stay signed in for 30 days and can't change anything; you can
  change the password, turn it off, or sign every viewer out

The page is available in **English, 日本語 and 繁體中文**. Each viewer can switch
language in the top bar; the office default applies to viewers who have not chosen.

## Floor plan

You build the office yourself, like a map in a tile editor. Click **Edit floor**
(bottom-right of the office) to open the map editor:

- **Floor** and **Walls**: pick a style and paint tiles (brush, or a rectangle:
  floors fill it, walls draw its outline). Walls join up on their own; a wall two
  tiles thick shows its full face, one tile a low wall.
- **Furniture**: desks, computers, chairs, sofas, kitchen, plants, wall pictures…
  Click to place; red means it doesn't fit there. Chairs and sofas are where people sit.
- **Move** and **Eraser**: drag pieces around or remove them.
- **Rooms**: drag a rectangle to mark a room (a department). Rooms draw nothing; they
  decide who sits where and where people go.
- Right-drag or Space+drag pans, the wheel zooms, Ctrl+Z / Ctrl+Shift+Z undo and
  redo, Ctrl+S saves.

A new office comes furnished: research, writing, design and operations rooms with
six desks each, a meeting room, a lounge, reception and a server room.

**Desks.** Everyone has their own desk: an office chair with the desk and computer in
front of it. Newcomers get a free desk in the room that matches their job title (a
"Researcher" sits in Research) and keep it; a name plate shows whose desk it is.
Click a free desk in the office to give it to someone; click someone's chair for
their workstation, details or to move them (free desks light up; taking someone's
desk swaps the two); click a computer to open its owner's **workstation** — desk,
model, job title, soul and skills. Skills belong to the person, so moving desks
keeps them. In the map editor a moved chair keeps its owner; removing one gives its
owner another free desk.

A routing table decides where people walk for each state: by default they work at
their desk, rest in the lounge and run jobs in the server room; any room can
override the rules for its own people.

- Settings → **Floor plan**: floor size, default routing, rooms (rename, resize, delete).
- Settings → **Occupants**: choose which room each person belongs to.

Settings → General → Scene switches back to the classic single-picture packs.

## AI models

Give any occupant its own model and talk to it from the side panel. While it
thinks it walks to the library, while it replies it sits at the desks, and it
returns to the lounge when done.

1. Settings → **AI models** → *Add provider*. Presets: OpenAI, Anthropic,
   OpenRouter, DeepSeek, Google Gemini (OpenAI-compatible endpoint), Ollama,
   or any OpenAI-compatible URL (LM Studio, vLLM, …).
2. Settings → **Occupants** → *Assign model* on an occupant, or *New AI character*.
   Each occupant can use a different provider and model, with its own persona
   (system prompt) and reply length.
3. Click **Chat** next to the occupant in the side panel.

- API keys are encrypted at rest (AES-256-GCM, key in `DATA_DIR/master.key`) and
  never sent to the browser. Back up `master.key` together with the database.
- All model calls go from the server; chatting and configuring need the office token.
- Chat text is never published in the public state detail.
- Running in Docker and using Ollama on the host? Use `http://host.docker.internal:11434/v1`.

### Memory

Agents keep a layered memory (after Hermes Agent), shown under **Memory** in an
agent's panel:

- **Long-term memory**: the agent's own notes (2,200 characters) and *About you*,
  a profile of the people it works for that every agent shares (1,375 characters).
  Both go into every task's prompt, and the limits make agents curate rather
  than hoard. Agents save and tidy entries themselves with a `memory` tool.
  Entries you write or edit are locked: the agent follows them but can't change them.
- **Recall**: finished tasks and chats are indexed for full-text search (SQLite
  FTS5, trigram, so Chinese and Japanese work). Agents search it with a `recall`
  tool when a task refers to earlier work; you can search it from the panel too.
- **Skills**: know-how lives in the skill library (Settings → Skills).

### Working together

Agents know their colleagues (everyone with a model: name, job title, skills,
whether they're busy) and can hand work around while on a task:
`ask_colleague` for a quick question, `delegate` for a piece of work. The
request lands in the colleague's queue as a sub-task; the asker waits (an
hourglass over its head) and carries on with the answer. In the office the asker
walks over with papers, and the colleague brings the result back. Sub-tasks link
both ways in the panel. Requests can't go back to anyone already in the chain,
nest at most 3 deep, are limited to 4 per task and 8 minutes each, and are
cancelled with the task that asked.

### MCP tools

Settings → MCP tools connects outside tools over the
[Model Context Protocol](https://modelcontextprotocol.io) (with the official
TypeScript SDK, MIT): a local command (stdio) or a remote URL (Streamable
HTTP, falling back to the older HTTP+SSE). Templates fill in a shared folder,
GitHub, Notion and web fetching; everything stays editable.

- Choose who may use a server (every agent, or some members). Its tools show
  up to them as `mcp__<server>__<tool>`.
- Every call passes the office's rules: "ask me first" by default, adjustable
  per tool (allow / ask / never; tools set to never aren't offered at all). You
  can delegate "Use connected tools (MCP)" to the CEO.
- Environment variables and headers are encrypted at rest and never sent back
  to the page. Servers that drop are retried every minute.
- A local server runs on the machine the office runs on, with its permissions:
  add only servers you trust. In Docker, commands such as `uvx` must exist in
  the image.

### Costs and budgets

Every model call (tasks, chats, reports, the CEO's decisions, project planning
and summaries) is recorded with its tokens and an estimated cost, booked to the
member and to the department their desk is in. Task cards and the results page
show what a task cost (with the colleagues it asked); the chairman's office
shows today's and this month's spending against the budgets, the last 14 days,
and who / which department / which model spent it. Department and company
reports end with the period's spending.

- **Prices.** A built-in table covers common Claude, OpenAI, Gemini, DeepSeek
  and MiniMax models (USD per million tokens). Settings → Costs takes your own
  (they win; the longest matching name counts), e.g. `0` for local models. When
  a provider doesn't report tokens they are estimated from the text and marked
  as such. These are estimates; your provider's bill is what counts.
- **Budgets.** Daily and monthly limits for the company and each department.
  They are checked when a task starts and before each step. Over a limit, work
  either stops, or asks for approval in your inbox (the CEO can decide it if you
  delegate "Going over budget"); an approved task finishes.
- **Lighter model for routine work.** A member can have a second, cheaper model
  (same provider). Settings → Costs picks the work that uses it: scheduled
  tasks, quick questions between colleagues, reports and summaries, project
  turns.

### Files and the knowledge base

- **Attachments.** The 📎 button next to "Give task" attaches up to 10 files
  (PDF, Word, Excel, PowerPoint, text, images; 25 MB each). Their text goes
  into the task (long files are read on with `read_file`); images go to models
  that can see. Colleagues helping with the task can read them too.
- **Knowledge base.** Settings → Knowledge base takes the company's documents
  and each department's (a department is a work room). They are split into
  passages and indexed; agents look things up with `search_knowledge` /
  `read_knowledge` and cite the document. Members read the company's documents
  and their own department's; the CEO and the chairman read all. You can
  preview documents and try a search to see what agents will find.
- **Delivered files.** Agents save documents with `write_file`: Word (from
  Markdown), Excel and CSV (from CSV or a Markdown table), or Markdown. They are
  listed under "Delivered files" in the results page, the task card and the
  project, ready to download.

Files are kept in the database. PDF text is read with
[unpdf](https://github.com/unjs/unpdf) (MIT); Office files are read and written
without extra libraries. Scanned PDFs need OCR first.

### Projects

For work that needs several agents, open a project (sidebar → **Projects**):
give it a name, a description every member reads, and a first message that
assigns work with @mentions (click a name to insert one). One mention starts
that agent; several first go through a planner, one model call that writes a
shared plan and says who starts. From then on the work moves in the open: each
member's turn ends with a message in the thread, an @mention in it hands over
to the next member, and `@you` means they need your reply. Members keep their
own notes for the project, which everyone reads. While a project runs its
members sit in the meeting room and hand papers to each other. After each of
your messages a project gets at most 12 turns (4 per member), so nobody
ping-pongs forever.

### Organization (departments, managers, the chairman)

Optional (Settings → Organization). Every work room is a department; give it a
manager (one of its agents) or leave it without. At the report time (default
18:00 on weekdays, in your time zone) each manager writes the department's report
from what actually happened — finished, failed and open tasks, deliveries you
haven't checked, approvals waiting, projects that moved — with every item linked
([#12] opens the task); a department without a manager gets the same sections
counted by the office, without a model. The manager then walks the report to the
chairman's office. You are the chairman: click the computer on your desk in the
**chairman's office** for the chairman's desk — today across the company, a card
per department with its latest report, work you can hand to a department (its
manager splits it among the members), past reports, and everything that waits for
you. New offices have a chairman's office and a CEO office; existing ones can add
both from the Organization tab.

**The CEO** (optional: pick one of the agents) sits in the CEO office. Managers
hand their reports to it, and it writes a company report for you on top of them.
You can also let it decide, for you, the kinds of things you choose: each
permission's approvals, experience drafts, skill proposals, accepting scheduled
deliveries — each with a daily limit, and any category can be marked high risk
(always yours). The CEO decides only by your own earlier decisions on the same
kind of thing (every decision you make is kept as a precedent); with no
precedent, a different case or any doubt it hands the item to you with a note.
Its decisions, reasons and the precedents they followed are listed at your desk,
and you can overrule any of them: what can be undone is undone (an experience
entry, a skill change, an accepted delivery), and your decision becomes the new
precedent.

### Manager review and employee profiles

- **Manager checks first** (Settings → Organization, per department, once the
  department has a manager): when a member finishes a task, the manager reads it
  before it reaches you — what was asked, the delivery and the pages it read.
  Work that passes lands in your results with the manager's note on top; work
  with a real problem (not what was asked, incomplete, made-up facts or no
  sources, wrong language) goes straight back for a redo, and the reason goes
  into the member's memory. After two rounds sent back it comes to you anyway,
  with what is still wrong. The results page lists the earlier versions and why
  each was sent back. Scheduled deliveries go to the CEO only after the manager
  passes them.
- **Employee profiles**: open someone's workstation for their record over the
  last 90 days — acceptance and first-try rate, how often you and their manager
  sent work back and why, cost, average time, the skills they use and how that
  work was received, colleagues helped and project turns. The chairman's desk
  has the whole team in one table, lowest acceptance first, to see whose model
  or job to change. The CEO reads the requester's record when it decides for you.

### Keeping agents in check

- **Permissions** (Settings → Permissions): for each action — searching the web,
  reading pages, writing memory, changing the shared *About you*, asking
  colleagues, project notes — choose *Allow*, *Ask me* or *Never*. The office
  enforces it, not the prompt. *Ask me* pauses the agent in "needs you" until you
  approve or deny it (with a reason it reads) in the inbox; it waits up to 30
  minutes, which doesn't count against the task's time. By default only changes
  to *About you* ask first.
- **Inbox**: the "needs you" counter opens everything that waits for you:
  approvals, projects that asked you something, experience drafts and skill
  proposals.
- **Results** (📦 in the top bar, with a badge for what waits): every finished
  task in one place, with a toast when a new one is done. Read each in full with
  what was asked, how it was done and the pages it (and colleagues it asked)
  actually read, so you can check its sources; then accept it, send it back,
  copy it or download it as Markdown. Projects with a summary are listed too.
- **Reviews**: accept a delivery, or send it back with a reason. The reason goes
  into the agent's memory and it redoes the task (marked ↩) with its previous
  version and your reason.
- **Experience library** (Settings → Experience): lessons the team shares —
  situation, problem, what worked, and when it holds or stops holding. Agents can
  only propose drafts; you approve them. Agents search the library when a task
  touches the team's own ways of working.
- **Skill proposals**: agents never write skills themselves. They propose a new
  skill or a change; you approve it in the inbox (and a skill you edited by hand
  is flagged).

### Scheduled tasks

Under **Scheduled** in an agent's panel, have it do something on its own: every
day, on weekdays, on chosen days of the week, every few hours, or once. Times
follow your browser's time zone (so a server in UTC still fires at your 9:00).
When one comes due the agent gets the task and walks to its desk like for any
other; results land in its task list marked ⏰. A run is skipped if the last one
is still going, a schedule missed while the office was closed runs once when it
reopens, and *Run now* does one run without changing the times. Any finished
task can be turned into a schedule with *Schedule this*.

## Environment variables

Settings saved in the page take precedence over these defaults.

| Variable                | Default        | Meaning                                         |
| ----------------------- | -------------- | ----------------------------------------------- |
| `PORT`                  | `19100`        | HTTP port                                       |
| `HOST`                  | `0.0.0.0`      | Bind address                                    |
| `BARNACLE_NAME`         | `My Barnacle`  | Default office name                             |
| `BARNACLE_LANG`         | `en`           | Default language: `en`, `ja` or `zh-Hant`       |
| `BARNACLE_TOKEN`        | generated      | Write token, at least 32 characters (cannot be rotated from the page) |
| `DATA_DIR`              | `./data`       | SQLite database and generated secret            |
| `PACK_DIR`              | `packs/base`   | Default art pack                                |
| `STATE_TTL_SECONDS`     | `300`          | A working state with no updates falls back to idle |
| `OFFLINE_AFTER_SECONDS` | `1800`         | No updates at all → offline                     |

## Art packs

The default pack (`packs/base`) is drawn in code. A pack is a folder with a
`layout.json` (areas, which state goes where, background, character skins and
props that react to states) plus its images; choose one with `PACK_DIR`.

For local development you can borrow Star Office UI's art:

```bash
git clone https://github.com/ringhyacinth/Star-Office-UI /tmp/star-office
node scripts/import-star-office.mjs /tmp/star-office
PACK_DIR=$PWD/packs/local/star-office npm start
```

> That art is licensed for non-commercial learning and demonstration only, and the
> characters are LimeZu assets under their own terms. The script writes to
> `packs/local/`, which is git-ignored and excluded from Docker images. Never commit,
> publish or deploy it; it is a placeholder until original art exists.

### Floor art from LimeZu (your own licence)

The floor plan is drawn with the built-in pixel art by default. It can instead use sprite sheets from LimeZu's *Modern Interiors* and
*Modern Office* (bought separately). Unzip both into one folder with `interiors/`
and `office/` inside, then:

```bash
node scripts/import-limezu.mjs /path/to/that/folder
npm start
```

This writes `packs/local/limezu/` (sheets, 20 animated characters, `atlas.json`).
The server picks it up on start; choose it in Settings → General → Floor art. The
licence forbids redistributing the assets, so they stay in the git-ignored
`packs/local/`; the required credit line shows under the office.
