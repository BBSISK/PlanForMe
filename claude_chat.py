"""In-app chat: one user message -> Claude tool-use loop -> reply + list of changes."""
import json
import os
from pathlib import Path

from models import ChatLog, db
import tools

MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5")
MAX_TURNS = 8

OWNER = os.environ.get("OWNER_NAME", "the user")
PROFILE_FILE = Path(__file__).parent / "data" / "profile.local.txt"  # gitignored "about me" for Claude


def _profile():
    if os.environ.get("OWNER_PROFILE"):
        return os.environ["OWNER_PROFILE"].strip()
    return PROFILE_FILE.read_text().strip() if PROFILE_FILE.exists() else ""


SYSTEM = """You are the planning assistant inside {owner}'s personal planner app (phone PWA).
You manage their daily and weekly plan.
{profile}

Now: {now} (Europe/Dublin). Today = {today}.
Date lookup, next 4 weeks (weekday = ISO date): {dates}
Fixed commitments (constraints): {constraints}
Academic calendar, next 60 days (no lectures on these dates): {calendar}
Active courses: {courses}

Rules:
- Never work out a weekday or date in your head: look it up in the date table above.
  "Friday" / "next Friday" = the first Friday after today. If the user gives a weekday and a date
  that don't match (e.g. "Friday 17th" when the 17th is a Saturday), ask which they meant before saving.
- Weeks start Monday.
- After saving, confirm using the `when` field the tool returns, word for word, so the day is never misreported.
- Times are local Europe/Dublin, format YYYY-MM-DDTHH:MM.
- To change something, find it first (list_items) and use update_item; don't delete+recreate.
- Never call delete_item unless {owner} has clearly confirmed that exact item.
- For plan_week, propose first (apply=false) and summarise; apply only when they say yes.
- Classes, labs, lectures -> kind "class"; assignment/exam dates -> "deadline"; revision -> "study".
- Things to remember or get done with no time slot ("remind me to...", "I need to...") -> add_todo, not create_item.
  To close one, find it with list_todos and call complete_todo, passing any detail they give as the comment.
- Lecture notes: "notes for CS210: ..." or anything said about what was covered in a lecture -> save_lecture_note
  (default today's lecture for that module; use append so existing notes are kept). "Give me my CS210 notes" ->
  compile_course_notes. Never invent lecture content: only save what {owner} says.
- Link items to a course_code whenever the course is obvious.
- Replies are read on a phone: one to three short lines, no headings. Confirm what changed with day + time.
"""


def run_chat(message, history=None):
    import anthropic  # imported lazily so the app runs without the key in dev

    client = anthropic.Anthropic()
    ctx = tools.context_snapshot()
    system = SYSTEM.format(owner=OWNER, profile=_profile(), now=ctx["now"], today=ctx["today"],
                           constraints=json.dumps(ctx["constraints"]), calendar=json.dumps(ctx["calendar"]),
                           dates="; ".join(ctx["dates"]), courses="; ".join(ctx["courses"]))
    messages = list(history or [])[-10:] + [{"role": "user", "content": message}]
    changes, calls = [], []

    for _ in range(MAX_TURNS):
        resp = client.messages.create(model=MODEL, max_tokens=1024, system=system,
                                      tools=tools.TOOLS, messages=messages)
        messages.append({"role": "assistant", "content": [b.model_dump() for b in resp.content]})
        if resp.stop_reason != "tool_use":
            break
        results = []
        for block in resp.content:
            if block.type != "tool_use":
                continue
            out, is_err = tools.execute(block.name, block.input)
            calls.append({"tool": block.name, "input": block.input, "error": is_err})
            if not is_err and (block.name in tools.WRITES or
                               (block.name == "plan_week" and block.input.get("apply"))):
                changes.append({"tool": block.name, "result": out})
            results.append({"type": "tool_result", "tool_use_id": block.id,
                            "content": json.dumps(out, default=str), "is_error": is_err})
        messages.append({"role": "user", "content": results})

    reply = "".join(b.text for b in resp.content if b.type == "text").strip() or "Done."
    db.session.add(ChatLog(role="user", content=message))
    db.session.add(ChatLog(role="assistant", content=reply, tool_calls=calls))
    db.session.commit()
    return {"reply": reply, "changes": changes}
