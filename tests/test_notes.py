from datetime import date, time, timedelta

import tools
from models import CalendarDay, Constraint, Course, db


def _setup(app):
    """A module with Mon 09-10 + Mon 10-11 (back to back = one lecture) and Wed 14-15, over 3 weeks."""
    with app.app_context():
        c = Course(code="CS999", name="Test Module", colour="#123456")
        db.session.add(c)
        db.session.flush()
        mon = date(2026, 9, 21)  # a Monday
        for wd, s, e, note in ((0, "09:00", "10:00", ""), (0, "10:00", "11:00", ""), (2, "14:00", "15:00", "lab")):
            db.session.add(Constraint(label="CS999", kind="class", course_id=c.id, weekdays=str(wd), room="R1", note=note,
                                      start_time=time.fromisoformat(s), end_time=time.fromisoformat(e),
                                      valid_from=mon, valid_to=mon + timedelta(days=18)))
        db.session.add(CalendarDay(start=date(2026, 9, 30), end=date(2026, 9, 30), label="Off", kind="no_lectures"))
        db.session.commit()


def test_sessions_merge_and_skip_days_off(app, client):
    _setup(app)
    data = client.get("/api/notes/CS999").json
    got = [(x["date"], x["start"], x["end"], x["number"]) for x in data["lectures"]]
    # Mon 09-11 merged; Wed 30 Sep is a day off; numbering runs across the semester
    assert got == [("2026-09-21", "09:00", "11:00", 1), ("2026-09-23", "14:00", "15:00", 2),
                   ("2026-09-28", "09:00", "11:00", 3), ("2026-10-05", "09:00", "11:00", 4),
                   ("2026-10-07", "14:00", "15:00", 5)]
    labels = [x["label"] for x in data["lectures"]]
    assert labels == ["Week 1 · Lectures 1–2", "Week 1 · Lab", "Week 2 · Lectures 1–2", "Week 3 · Lectures 1–2", "Week 3 · Lab"]


def test_save_note_and_compile(app, client):
    _setup(app)
    r = client.put("/api/notes/cs999/lecture", json={"date": "2026-09-21", "topic": "Big-O",
                                                     "body": "O(n log n) for merge sort", "follow_up": "Ask about amortised"})
    assert r.status_code == 200 and r.json["number"] == 1 and r.json["has_notes"]
    # a time inside the merged lecture maps to the same note; append keeps existing text
    r = client.put("/api/notes/CS999/lecture", json={"date": "2026-09-21", "start": "10:00", "append": "Master theorem"})
    assert r.json["note"]["body"] == "O(n log n) for merge sort\nMaster theorem"
    client.put("/api/notes/CS999/lecture", json={"date": "2026-09-28", "topic": "Recursion", "body": "Base case first"})
    md = client.get("/api/notes/CS999/compiled").json["markdown"]
    assert md.index("Week 1 · Lectures 1–2") < md.index("Week 2 · Lectures 1–2")
    assert "Ask about amortised (W1 L1–2, 21 Sep)" in md and "1. Big-O" in md and "Master theorem" in md
    assert "Week 1 · Lab · Wed 23 Sep" in md  # listed under lectures with no notes yet
    dl = client.get("/api/notes/CS999/compiled.md")
    assert dl.mimetype == "text/markdown" and "CS999-notes.md" in dl.headers["Content-Disposition"]


def test_extra_lecture_and_errors(app, client):
    _setup(app)
    r = client.put("/api/notes/CS999/lecture", json={"date": "2026-09-22", "topic": "Make-up"})
    assert r.status_code == 400 and "no lecture" in r.json["error"]
    r = client.put("/api/notes/CS999/lecture", json={"date": "2026-09-22", "start": "18:00", "topic": "Make-up"})
    assert r.status_code == 200 and r.json["in_timetable"] is False
    lst = client.get("/api/notes/CS999").json["lectures"]
    assert any(x["date"] == "2026-09-22" and x["number"] is None for x in lst)
    assert client.get("/api/notes/NOPE").status_code == 400


def test_lectures_on_day(app, client):
    _setup(app)
    day = client.get("/api/notes/today?date=2026-09-28").json
    mine = [x for x in day["lectures"] if x["course_code"] == "CS999"]
    assert day["lead_minutes"] == 5 and len(mine) == 1 and mine[0]["number"] == 3 and mine[0]["label"] == "Week 2 · Lectures 1–2" and mine[0]["start"] == "09:00"


def test_claude_tools(app):
    _setup(app)
    with app.app_context():
        out, err = tools.execute("save_lecture_note", {"course_code": "CS999", "date": "2026-09-23", "append": "Graphs intro"})
        assert not err and out["number"] == 2
        out, err = tools.execute("get_lecture_notes", {"course_code": "CS999", "date": "2026-09-23"})
        assert out["note"]["body"] == "Graphs intro"
        out, err = tools.execute("compile_course_notes", {"course_code": "CS999"})
        assert "Graphs intro" in out["markdown"]
        out, err = tools.execute("save_lecture_note", {"course_code": "XX1"})
        assert err and "Unknown course" in out["error"]
        assert "save_lecture_note" in tools.WRITES


def test_study_week_not_counted(app, client):
    _setup(app)
    with app.app_context():
        db.session.add(CalendarDay(start=date(2026, 9, 28), end=date(2026, 10, 2), label="Study week", kind="no_lectures"))
        db.session.commit()
    lst = client.get("/api/notes/CS999").json["lectures"]
    assert [(x["date"], x["week"]) for x in lst] == [("2026-09-21", 1), ("2026-09-23", 1), ("2026-10-05", 2), ("2026-10-07", 2)]


def test_image_upload_and_serve(app, client):
    import io
    _setup(app)
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 100
    r = client.post("/api/notes/images", data={"course": "CS999", "image": (io.BytesIO(png), "shot.png", "image/png")},
                    content_type="multipart/form-data")
    assert r.status_code == 200 and r.json["url"].startswith("/api/notes/img/")
    got = client.get(r.json["url"])
    assert got.status_code == 200 and got.data == png and got.mimetype == "image/png"
    bad = client.post("/api/notes/images", data={"image": (io.BytesIO(b"<svg/>"), "x.svg", "image/svg+xml")},
                      content_type="multipart/form-data")
    assert bad.status_code == 400
    assert client.get("/api/notes/img/9999").status_code == 404
