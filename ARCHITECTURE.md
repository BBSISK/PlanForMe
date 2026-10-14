# Planner — Architecture (v0.1 scaffold)

A personal daily/weekly planner that Claude can drive. Single user, phone-first PWA,
Flask backend on Render, Postgres (Neon or Render) in production, SQLite locally.

## 1. Goals

| # | Goal | How |
|---|------|-----|
| G1 | See today and this week at a glance on the phone | PWA: **Today**, **Week**, **Plan** tabs; installable, offline read cache |
| G2 | Add/update events by talking | In-app chat bar → Claude (tool calling) → same API the UI uses |
| G3 | Combine college + teaching + life | Every item has a `kind` and optional `course`; fixed commitments are `constraints` |
| G4 | Education plan built in | `courses` with weekly study targets, `goals` with `milestones`; Plan tab shows progress |
| G5 | Auto-schedule study | `scheduler.plan_week()` drops study blocks into free slots, most urgent course first |
| G6 | Claude outside the app can use it too | Same tool layer exposed via an MCP server (`mcp_server.py`) + bearer token |

## 2. Shape

```
 Phone (PWA)                     Flask app (Render)                         Data
 ┌──────────────┐   fetch /api  ┌──────────────────────────┐              ┌───────────┐
 │ Today / Week │ ────────────► │ api.py  (REST, JSON)     │──┐           │ Postgres  │
 │ Plan / Chat  │               │                          │  ├─ tools.py ─► models.py │
 │ sw.js cache  │ ── /api/chat ─► claude_chat.py (loop) ───┘  │  scheduler│ (SQLAlchemy)
 └──────────────┘               │      ▲ Anthropic API      │  │           └───────────┘
                                │ mcp_server.py ◄── Claude (Cowork / claude.ai / Code)
                                └──────────────────────────┘
```

**Key rule:** `tools.py` is the single gateway for writes that Claude makes. The chat endpoint and
the MCP server both call `tools.execute(name, args)`, so behaviour is identical whichever Claude is talking.

## 3. Data model

| Table | Purpose | Key fields |
|-------|---------|-----------|
| `items` | Anything on the planner | `kind` (event · task · study · class · deadline), `title`, `start`, `end`, `due`, `all_day`, `priority` 1–4, `status` (todo · done · skipped), `course_id`, `goal_id`, `rrule`, `source` (manual · claude · scheduler · gcal), `locked` |
| `courses` | College modules | `code` (CS210), `name`, `colour`, `weekly_target_hours`, `semester`, `active` |
| `goals` | Education plan goals | `title`, `course_id?`, `target_date`, `notes` |
| `milestones` | Steps toward a goal | `goal_id`, `title`, `due`, `done` |
| `constraints` | Recurring fixed time (teaching, commute, sleep, gym) | `label`, `weekdays` ("0,1,2,3,4"), `start_time`, `end_time`, `kind` (busy · preferred_study) |
| `chat_log` | Audit of what Claude changed | `role`, `content`, `tool_calls` JSON, `created` |

Times are stored as **naive local time (Europe/Dublin)** — single user, single timezone, and it
keeps the UI and Claude prompts simple. Revisit if Google Calendar sync lands (store UTC + tz then).

`priority`: 1 = must today, 2 = important, 3 = normal, 4 = someday.
`locked`: scheduler never moves it (true for anything you or Claude placed deliberately).

## 4. API (all JSON, session cookie or `Authorization: Bearer <API_TOKEN>`)

```
GET    /api/items?from=YYYY-MM-DD&to=YYYY-MM-DD    list (expands constraints as virtual 'busy' blocks with ?include_constraints=1)
POST   /api/items                                 create
PATCH  /api/items/<id>                            partial update (drag, tick, edit)
DELETE /api/items/<id>
GET    /api/day/<date>                            items + free slots + top priorities
GET    /api/week/<monday>                         7 days + study hours vs targets
GET/POST/PATCH  /api/courses, /api/goals, /api/milestones, /api/constraints
POST   /api/plan/week   {monday, dry_run}         run scheduler; dry_run returns proposal only
POST   /api/chat        {message, history}        Claude turn → {reply, changes[]}
```

## 5. Claude tools (tools.py)

| Tool | What it does |
|------|-------------|
| `list_items` | items in a date range (optionally by course/kind) |
| `create_item` | add event/task/study/deadline |
| `update_item` | move, rename, re-prioritise, mark done |
| `delete_item` | remove (Claude must confirm first in prompt rules) |
| `find_free_slots` | free windows on a date ≥ N minutes, respecting constraints |
| `plan_week` | propose or apply study blocks for a week |
| `get_education_plan` | courses, targets, hours logged, goals, upcoming milestones |
| `add_milestone` / `complete_milestone` | maintain the education plan |

System prompt gives Claude: today's date/time (Dublin), the week's constraints, active courses,
and rules: resolve relative dates ("Thursday", "next week"), never delete without confirmation,
prefer `update_item` over delete+create, keep replies to one or two lines on phone.

## 6. Scheduler (v1 heuristic)

1. Build each day's free windows: day window (default 07:00–22:00) − constraints − existing timed items.
2. For each active course: `deficit = weekly_target_hours − hours already scheduled/done that week`.
3. Urgency score = deficit × (1 + 1/days_to_next_deadline_or_milestone).
4. Greedily place 60–90 min blocks for the most urgent course into the earliest `preferred_study`
   window, else earliest free window; max 2 blocks/course/day, 15-min buffer; repeat until deficits
   are met or no space. Output is a proposal; the UI/Claude applies it.

Later: weighting by energy (mornings for hard modules), spaced repetition for revision, exam-mode.

## 7. PWA

- `manifest.webmanifest` (standalone, theme colour, 192/512 icons, maskable).
- `sw.js`: app shell cache-first; `/api/*` GET network-first with cache fallback (offline read);
  writes go to an IndexedDB outbox when offline (phase 2).
- iOS: add `apple-touch-icon` + `apple-mobile-web-app-capable`; install via Share → Add to Home Screen.
- Push reminders (phase 3): Web Push works on iOS 16.4+ for installed PWAs.

## 8. Security

- Single user: `APP_PASSWORD` login → signed session cookie (30 days).
- `API_TOKEN` bearer for MCP / scripts. `ANTHROPIC_API_KEY` only server-side.
- Chat changes are logged to `chat_log` with the tool calls, so anything Claude did is traceable.

## 9. Roadmap

| Phase | Scope |
|------|-------|
| **0 — this scaffold** | Models, REST, tools, chat loop, scheduler v1, PWA shell with Today/Week/Plan/Chat, seed data |
| 1 | Deploy to Render + Neon; drag-to-move on Week view; recurring items (rrule) expansion; edit sheets |
| 2 | Google Calendar two-way sync for `event`/`class`; offline write outbox |
| 3 | Web Push reminders; morning brief ("today's 3 priorities"); Sunday weekly-review chat flow |
| 4 | MCP server live so Cowork/claude.ai can plan from anywhere; Moodle/assignment import |

## 10. Open questions

1. Timetable: done — recurring `class` constraints loaded from `data/seed.local.json` (gitignored).
2. Weekly self-study hour target per module (placeholders 1.5–3h).
3. Any other fixed weekly time (work, commute, gym) → `busy` entries in the seed file.
4. Google Calendar: which calendar(s) to sync, and is it the source of truth for non-college events?
