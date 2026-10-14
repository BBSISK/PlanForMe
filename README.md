# PlanForMe

Phone-first daily/weekly planner that Claude can drive. Flask + SQLAlchemy backend, vanilla-JS PWA front end,
Claude tool-calling for "add / move / plan" by chat. See **ARCHITECTURE.md** for the design and roadmap.

## Run locally (Mac)

```bash
cd "PlanForMe"
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # add ANTHROPIC_API_KEY to enable chat
cp data/seed.example.json data/seed.local.json   # then put your own timetable in it
export $(grep -v '^#' .env | xargs)
python app.py                 # http://localhost:5000  (seeds demo modules on first run)
python -m pytest -q           # 7 tests
```

No `APP_PASSWORD` set = no login (local dev only).

## Try the UI without a server

Open `dist/planner_demo_standalone.html` in a browser. It runs the real front end against an in-memory
mock with a small rule-based chat ("add gym sat 10am", "move CS144 to fri 8pm", "plan my study", "what's due").
Rebuild after front-end edits: `python build_demo.py`.

## Deploy (Render)

1. Push to GitHub, then New → Blueprint on Render (uses `render.yaml`).
2. Set `APP_PASSWORD`, `ANTHROPIC_API_KEY`, `DATABASE_URL` (Neon or Render Postgres).
3. On the phone: open the site → Share → **Add to Home Screen** (iOS) / **Install app** (Android).

## Layout

| File | Role |
|------|------|
| `app.py` | Flask factory, login, pages, REST API |
| `models.py` | Item, Course, Goal, Milestone, Constraint, ChatLog |
| `tools.py` | Claude tool schemas + `execute()` (single gateway for Claude writes) |
| `claude_chat.py` | Tool-use loop for `/api/chat` |
| `scheduler.py` | Free slots + weekly study planner |
| `mcp_server.py` | Phase-4 stub: same tools for Claude in Cowork/claude.ai |
| `seed.py` | Loads `data/seed.local.json` (your timetable, **gitignored**) or falls back to `data/seed.example.json` |
| `static/` | `app.js`, `app.css`, `sw.js`, manifest, icons |

**Note on Google Drive:** keep `.venv/` and `planner.db` out of Drive sync if it gets slow
(or move the working copy to `~/GIT` and treat Drive as backup; GitHub is the real source of truth).

## Public repo, private data

The repo holds code only. Never committed (see `.gitignore`):
`.env` (passwords, API keys), `data/*.local.json` (your timetable), `*.db` (your planner data), `dist/` (demo builds embed the seed).
In production your data lives in Postgres and secrets live in Render's environment variables.
