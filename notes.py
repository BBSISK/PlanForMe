"""Lecture notes: a quick note per lecture that builds into a full set of semester notes per module.

A "lecture" is one timetabled session of a course on a date: back-to-back class slots for the same
course (e.g. a 2-hour lab booked as two 1-hour slots) are merged into one session. Sessions skip
bank holidays, study weeks and exams exactly like the timetable does (Constraint.active_on).

Routes live under /api/notes. Claude tools (get_lecture_notes, save_lecture_note,
compile_course_notes) share the same functions, so chat and taps behave identically.
"""
from datetime import date, datetime, time, timedelta

from flask import Blueprint, jsonify, request

from models import CalendarDay, Constraint, Course, LectureNote, db

LEAD_MINUTES = 5        # the front end opens the notes sheet this long before a lecture starts
FALLBACK_SPAN = 120     # days either side of today when a class has no term dates


class NoteError(Exception):
    pass


def _d(v):
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10]) if v else None


def _t(v):
    if not v:
        return None
    if isinstance(v, time):
        return v
    return time.fromisoformat(str(v)[:5])


def _course(code):
    if not code:
        raise NoteError("Which module? Give a course code like CS210")
    c = Course.query.filter(db.func.upper(Course.code) == str(code).strip().upper()).first()
    if not c:
        raise NoteError(f"Unknown course {code}. Known: {', '.join(x.code for x in Course.query.order_by(Course.code))}")
    return c


# ------------------------------------------------------------------ sessions from the timetable
class _Offs:
    """Calendar loaded once, so walking a whole semester doesn't hit the DB per day."""
    def __init__(self):
        self.rows = CalendarDay.query.all()

    def on(self, day):
        return [r for r in self.rows if r.start <= day <= r.end]


def _class_constraints(course_id=None):
    q = Constraint.query.filter(Constraint.kind == "class")
    if course_id:
        q = q.filter(Constraint.course_id == course_id)
    return q.order_by(Constraint.start_time).all()


def _is_lab(c):
    return "lab" in (c.note or "").lower()


def _merge(blocks):
    """[(start, end, room, constraint)] sorted by start -> merged back-to-back blocks of the same type.
    Two 1-hour lecture slots in a row stay one session but count as two lectures (slots=2)."""
    out = []
    for s, e, room, c in blocks:
        lab = _is_lab(c)
        if out and out[-1]["end"] == s and out[-1]["lab"] == lab:
            out[-1]["end"] = e
            out[-1]["slots"] += 1
            if room and room not in out[-1]["room"]:
                out[-1]["room"] = f"{out[-1]['room']} / {room}" if out[-1]["room"] else room
        else:
            out.append({"start": s, "end": e, "room": room or "", "note": c.note or "", "lab": lab, "slots": 1})
    return out


def _teaching_weeks(first, last, offs):
    """Monday -> teaching week number. A week with no lectures at all (study week, exams) isn't counted."""
    monday = first - timedelta(days=first.weekday())
    weeks, n = {}, 0
    while monday <= last:
        if not all(offs.on(monday + timedelta(days=i)) for i in range(5)):
            n += 1
            weeks[monday] = n
        monday += timedelta(days=7)
    return weeks


def _label_sessions(out, first, last, offs):
    """Adds number (running count), week, part ('Lecture 1', 'Lectures 1–2', 'Lab'), label and short."""
    weeks = _teaching_weeks(first, last, offs)
    per_week = {}
    for n, s in enumerate(out, 1):
        s["number"] = n
        monday = s["date"] - timedelta(days=s["date"].weekday())
        w = weeks.get(monday)
        s["week"] = w
        if s["lab"]:
            k = per_week.setdefault((monday, "lab"), [0])
            k[0] += 1
            s["part"], s["short_part"] = "Lab", "Lab"
        else:
            k = per_week.setdefault((monday, "lec"), [0])
            a = k[0] + 1
            k[0] += s["slots"]
            b = k[0]
            s["part"] = f"Lecture {a}" if a == b else f"Lectures {a}–{b}"
            s["short_part"] = f"L{a}" if a == b else f"L{a}–{b}"
        s["label"] = f"Week {w} · {s['part']}" if w else s["part"]
        s["short"] = f"W{w} {s['short_part']}" if w else s["short_part"]
    return out


def _sessions_on(day, cons_by_course, offs):
    day_offs = offs.on(day)
    out = []
    for course_id, cons in cons_by_course.items():
        blocks = [(c.start_time, c.end_time, c.room, c) for c in cons if c.active_on(day, day_offs)]
        for b in _merge(sorted(blocks, key=lambda x: x[0])):
            out.append({"course_id": course_id, "date": day, **b})
    return out


def _span(cons):
    starts = [c.valid_from for c in cons if c.valid_from]
    ends = [c.valid_to for c in cons if c.valid_to]
    today = date.today()
    return (min(starts) if starts else today - timedelta(days=FALLBACK_SPAN),
            max(ends) if ends else today + timedelta(days=FALLBACK_SPAN))


def sessions(course, frm=None, to=None):
    """All lectures for a course in the semester (or a date range), numbered from 1."""
    cons = _class_constraints(course.id)
    if not cons:
        return []
    first, last = _span(cons)
    offs = _Offs()
    out, day = [], first
    while day <= last:
        out.extend(_sessions_on(day, {course.id: cons}, offs))
        day += timedelta(days=1)
    _label_sessions(out, first, last, offs)
    lo, hi = _d(frm) or date.min, _d(to) or date.max
    return [s for s in out if lo <= s["date"] <= hi]


def _key(course_id, day, start):
    return (course_id, day, start.strftime("%H:%M"))


def _session_dict(course, s, note):
    return {"course_code": course.code, "course_name": course.name, "colour": course.colour,
            "date": s["date"].isoformat(), "start": s["start"].strftime("%H:%M"),
            "end": s["end"].strftime("%H:%M") if s.get("end") else None, "room": s.get("room", ""),
            "number": s.get("number"), "in_timetable": s.get("in_timetable", True),
            "week": s.get("week"), "kind": "lab" if s.get("lab") else "lecture",
            "part": s.get("part") or "Extra lecture", "label": s.get("label") or "Extra lecture",
            "short": s.get("short") or "Extra",
            "note": note.to_dict() if note else None,
            "has_notes": bool(note and (note.topic or note.body or note.follow_up).strip())}


def course_lectures(course_code):
    """Every lecture this semester with its note, plus any ad-hoc notes not on the timetable."""
    course = _course(course_code)
    notes = {_key(n.course_id, n.date, n.start_time): n
             for n in LectureNote.query.filter_by(course_id=course.id)}
    out = []
    for s in sessions(course):
        out.append(_session_dict(course, s, notes.pop(_key(course.id, s["date"], s["start"]), None)))
    for n in notes.values():  # extra lectures / rescheduled ones
        out.append(_session_dict(course, {"date": n.date, "start": n.start_time, "end": n.end_time,
                                          "room": "", "number": None, "in_timetable": False}, n))
    out.sort(key=lambda x: (x["date"], x["start"]))
    today = date.today().isoformat()
    return {"course": course.to_dict(), "lectures": out,
            "counts": {"total": len(out), "held": sum(1 for x in out if x["date"] <= today),
                       "with_notes": sum(1 for x in out if x["has_notes"])}}


def lectures_on(day=None):
    """All lectures (every course) on a day, with their notes. The front end uses this to auto-open."""
    day = _d(day) or date.today()
    cons = _class_constraints()
    by_course = {}
    for c in cons:
        if c.course_id:
            by_course.setdefault(c.course_id, []).append(c)
    found = _sessions_on(day, by_course, _Offs())
    courses = {c.id: c for c in Course.query.all()}
    notes = {_key(n.course_id, n.date, n.start_time): n for n in LectureNote.query.filter_by(date=day)}
    out = []
    for s in found:
        course = courses[s["course_id"]]
        full = next((x for x in sessions(course, day, day) if x["start"] == s["start"]), None)
        if full:
            s = full
        out.append(_session_dict(course, s, notes.get(_key(course.id, day, s["start"]))))
    out.sort(key=lambda x: x["start"])
    return {"date": day.isoformat(), "lead_minutes": LEAD_MINUTES, "lectures": out}


def _find_session(course, day, start=None):
    todays = sessions(course, day, day)
    if start:
        st = _t(start)
        hit = next((s for s in todays if s["start"] == st), None)
        if hit:
            return hit
        hit = next((s for s in todays if s["start"] <= st < s["end"]), None)  # a time inside the lecture
        if hit:
            return hit
        return {"date": day, "start": st, "end": None, "room": "", "number": None, "in_timetable": False}
    if len(todays) == 1:
        return todays[0]
    if not todays:
        raise NoteError(f"{course.code} has no lecture on {day:%A %d %B}. Give a start time to add an extra one.")
    times = ", ".join(s["start"].strftime("%H:%M") for s in todays)
    raise NoteError(f"{course.code} has {len(todays)} lectures on {day:%A %d %B} ({times}). Which one?")


def get_lecture(course_code, date=None, start=None):
    course = _course(course_code)
    day = _d(date) or datetime.now().date()
    s = _find_session(course, day, start)
    note = LectureNote.query.filter_by(course_id=course.id, date=day, start_time=s["start"]).first()
    return _session_dict(course, s, note)


def save_note(course_code, date=None, start=None, topic=None, body=None, follow_up=None, append=None):
    """Create or update the note for one lecture. `append` adds a line to the body (handy from chat)."""
    course = _course(course_code)
    day = _d(date) or datetime.now().date()
    s = _find_session(course, day, start)
    note = LectureNote.query.filter_by(course_id=course.id, date=day, start_time=s["start"]).first()
    if not note:
        note = LectureNote(course_id=course.id, date=day, start_time=s["start"], end_time=s.get("end"),
                           topic="", body="", follow_up="")
        db.session.add(note)
    if topic is not None:
        note.topic = topic.strip()[:200]
    if body is not None:
        note.body = body
    if append:
        note.body = (note.body.rstrip() + "\n" if (note.body or "").strip() else "") + append.strip()
    if follow_up is not None:
        note.follow_up = follow_up
    db.session.commit()
    return _session_dict(course, s, note)


def delete_note(note_id):
    n = db.session.get(LectureNote, int(note_id))
    if not n:
        raise NoteError(f"No note {note_id}")
    d = n.to_dict()
    db.session.delete(n)
    db.session.commit()
    return {"deleted": d}


def compile_notes(course_code):
    """The whole semester's notes for a module as one Markdown document, lecture by lecture."""
    data = course_lectures(course_code)
    c = data["course"]
    done = [x for x in data["lectures"] if x["has_notes"]]
    lines = [f"# {c['code']} {c['name']}: semester notes", ""]
    lines.append(f"{len(done)} of {data['counts']['held']} lectures so far have notes. "
                 f"Compiled {datetime.now():%d %B %Y}.")
    follow = [(x, x["note"]["follow_up"].strip()) for x in done if x["note"]["follow_up"].strip()]
    if follow:
        lines += ["", "## To follow up", ""]
        for x, f in follow:
            for ln in f.splitlines():
                if ln.strip():
                    lines.append(f"- {ln.strip().lstrip('-• ').strip()} ({_label(x, short=True)})")
    topics = [x for x in done if x["note"]["topic"]]
    if topics:
        lines += ["", "## Topics covered", ""]
        lines += [f"{n}. {x['note']['topic']} ({_label(x, short=True)})" for n, x in enumerate(topics, 1)]
    for x in done:
        n = x["note"]
        lines += ["", f"## {_label(x)}" + (f": {n['topic']}" if n["topic"] else ""), ""]
        if n["body"].strip():
            lines.append(n["body"].strip())
        if n["follow_up"].strip():
            lines += ["", "**Follow up:** " + n["follow_up"].strip().replace("\n", "; ")]
    missing = [x for x in data["lectures"] if not x["has_notes"] and x["date"] <= date.today().isoformat()]
    if missing:
        lines += ["", "## Lectures with no notes yet", ""]
        lines += [f"- {_label(x)}" for x in missing]
    return {"course": c, "markdown": "\n".join(lines).strip() + "\n", "counts": data["counts"]}


def _label(x, short=False):
    d = _d(x["date"])
    if short:
        return f"{x.get('short') or 'Extra'}, {d.day} {d:%b}"
    return f"{x.get('label') or 'Extra lecture'} · {d:%a} {d.day} {d:%b} {x['start']}"


# ------------------------------------------------------------------ routes
def _run(fn, *a, **kw):
    try:
        return jsonify(fn(*a, **kw)), 200
    except (NoteError, ValueError, TypeError) as e:
        db.session.rollback()
        return jsonify(error=str(e)), 400


def register(app, login_required):
    bp = Blueprint("notes", __name__)

    @bp.get("/api/notes/today")
    @login_required
    def notes_today():
        return _run(lectures_on, request.args.get("date"))

    @bp.get("/api/notes/<code>")
    @login_required
    def notes_course(code):
        return _run(course_lectures, code)

    @bp.get("/api/notes/<code>/lecture")
    @login_required
    def notes_lecture(code):
        return _run(get_lecture, code, request.args.get("date"), request.args.get("start"))

    @bp.put("/api/notes/<code>/lecture")
    @login_required
    def notes_save(code):
        b = request.get_json(force=True) or {}
        return _run(save_note, code, b.get("date"), b.get("start"), b.get("topic"), b.get("body"),
                    b.get("follow_up"), b.get("append"))

    @bp.delete("/api/notes/id/<int:nid>")
    @login_required
    def notes_delete(nid):
        return _run(delete_note, nid)

    @bp.get("/api/notes/<code>/compiled")
    @login_required
    def notes_compiled(code):
        return _run(compile_notes, code)

    @bp.get("/api/notes/<code>/compiled.md")
    @login_required
    def notes_compiled_md(code):
        try:
            out = compile_notes(code)
        except NoteError as e:
            return jsonify(error=str(e)), 400
        resp = app.response_class(out["markdown"], mimetype="text/markdown")
        resp.headers["Content-Disposition"] = f'attachment; filename="{out["course"]["code"]}-notes.md"'
        return resp

    app.register_blueprint(bp)


# ------------------------------------------------------------------ Claude tools
TOOLS = [
    {"name": "get_lecture_notes",
     "description": "Lecture notes for a module. With a date, returns that day's lecture and its note; "
                    "without a date, lists every lecture this semester with its note (number, date, topic).",
     "input_schema": {"type": "object", "properties": {
         "course_code": {"type": "string"}, "date": {"type": "string", "description": "YYYY-MM-DD"},
         "start": {"type": "string", "description": "HH:MM, only if the module has two lectures that day"}},
         "required": ["course_code"]}},
    {"name": "save_lecture_note",
     "description": "Write notes against one lecture (a module's timetabled session on a date; default today). "
                    "Use append to add a line without replacing what's there; body replaces the whole note. "
                    "For an extra lecture not on the timetable, pass its start time.",
     "input_schema": {"type": "object", "properties": {
         "course_code": {"type": "string"}, "date": {"type": "string", "description": "YYYY-MM-DD, default today"},
         "start": {"type": "string", "description": "HH:MM"}, "topic": {"type": "string"},
         "body": {"type": "string"}, "append": {"type": "string"},
         "follow_up": {"type": "string", "description": "questions to ask or things to revise"}},
         "required": ["course_code"]}},
    {"name": "compile_course_notes",
     "description": "The full semester's notes for a module as one Markdown document (topics, follow-ups, every lecture).",
     "input_schema": {"type": "object", "properties": {"course_code": {"type": "string"}},
                      "required": ["course_code"]}},
]


def _get_tool(course_code, date=None, start=None):
    return get_lecture(course_code, date, start) if date else course_lectures(course_code)


FUNCS = {"get_lecture_notes": _get_tool, "save_lecture_note": save_note, "compile_course_notes": compile_notes}
WRITES = {"save_lecture_note"}
ERRORS = (NoteError,)
