"""Seed the database on first run.

Reads data/seed.local.json (your real timetable, gitignored) if present,
otherwise data/seed.example.json (generic, committed). Edit the JSON, not this file.
"""
import json
import os
from datetime import date, time
from pathlib import Path

from models import db, Course, Constraint, Goal, Milestone

DATA = Path(__file__).parent / "data"


def load_seed():
    """Order: PLANNER_SEED_JSON env var (production) > data/seed.local.json > data/seed.example.json."""
    if os.environ.get("PLANNER_SEED_JSON") and os.environ.get("PLANNER_SEED") != "example":
        return json.loads(os.environ["PLANNER_SEED_JSON"])
    path = DATA / "seed.local.json"
    if os.environ.get("PLANNER_SEED") == "example" or not path.exists():
        path = DATA / "seed.example.json"
    return json.loads(path.read_text())


def _days(v):
    return ",".join(str(d) for d in v) if isinstance(v, list) else str(v)


def seed():
    data = load_seed()
    ids = {}
    for c in data["courses"]:
        course = Course(code=c["code"], name=c["name"], colour=c.get("colour", "#4f6bed"),
                        weekly_target_hours=c.get("weekly_target_hours", 2), semester=1, active=True)
        db.session.add(course)
        db.session.flush()
        ids[c["code"]] = course.id
    for t in data.get("timetable", []):
        db.session.add(Constraint(label=t["code"], room=t.get("room", ""), note=t.get("note", ""),
                                  weekdays=_days(t["weekday"]), start_time=time.fromisoformat(t["start"]),
                                  end_time=time.fromisoformat(t["end"]), kind="class", course_id=ids[t["code"]]))
    for kind, key in (("preferred_study", "study_windows"), ("busy", "busy")):
        for w in data.get(key, []):
            db.session.add(Constraint(label=w["label"], weekdays=_days(w["weekdays"]), kind=kind,
                                      start_time=time.fromisoformat(w["start"]), end_time=time.fromisoformat(w["end"])))
    for g in data.get("goals", []):
        goal = Goal(title=g["title"], target_date=date.fromisoformat(g["target_date"]) if g.get("target_date") else None)
        db.session.add(goal)
        db.session.flush()
        for m in g.get("milestones", []):
            db.session.add(Milestone(goal_id=goal.id, title=m["title"],
                                     due=date.fromisoformat(m["due"]) if m.get("due") else None))
    db.session.commit()
