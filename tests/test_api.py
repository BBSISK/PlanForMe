from datetime import date, timedelta

import tools
from models import db, Item


def monday():
    t = date.today()
    return t - timedelta(days=t.weekday())


def test_create_move_complete(app, client):
    d = (date.today() + timedelta(days=2)).isoformat()
    r = client.post("/api/items", json={"kind": "class", "title": "CS101 lab", "start": f"{d}T19:00",
                                        "end": f"{d}T20:30", "course_code": "cs101"})
    assert r.status_code == 201, r.json
    item = r.json
    assert item["course_code"] == "CS101"
    # move keeps the 90 min duration
    r = client.patch(f"/api/items/{item['id']}", json={"start": f"{d}T18:00"})
    assert r.json["end"] == f"{d}T19:30"
    r = client.patch(f"/api/items/{item['id']}", json={"status": "done"})
    assert r.json["status"] == "done"


def test_bad_course_is_a_tool_error(app):
    with app.app_context():
        out, err = tools.execute("create_item", {"kind": "task", "title": "x", "course_code": "XX999"})
        assert err and "Unknown course" in out["error"]


def test_free_slots_respect_constraints(app):
    with app.app_context():
        nxt_wed = monday() + timedelta(days=9)
        slots = tools.find_free_slots(nxt_wed.isoformat())
        for s in slots:  # example seed: Wed CS102 lab 14:00-16:00 (+15 min buffers)
            assert not ("13:45" <= s["start"] < "16:15")
            assert s["end"] <= "13:45" or s["start"] >= "16:15"


def test_plan_week_meets_targets_without_overlap(app, client):
    nxt = (monday() + timedelta(days=7)).isoformat()
    r = client.post("/api/plan/week", json={"monday": nxt, "apply": True})
    plan = r.json
    assert plan["proposed"], plan
    with app.app_context():
        blocks = sorted(Item.query.filter_by(source="scheduler").all(), key=lambda i: i.start)
        for a, b in zip(blocks, blocks[1:]):
            assert a.end <= b.start, (a.to_dict(), b.to_dict())
    wk = client.get(f"/api/week/{nxt}").json
    for p in wk["progress"]:
        assert p["scheduled"] >= p["target"] - 0.01 or p["code"] in plan["unmet_hours"]


def test_day_view_shape(client):
    r = client.get(f"/api/day/{date.today().isoformat()}")
    assert r.status_code == 200
    assert set(r.json) >= {"items", "priorities", "free", "fixed", "overdue"}


def test_chat_without_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert "ANTHROPIC_API_KEY" in client.post("/api/chat", json={"message": "hi"}).json["reply"]


def test_bank_holiday_cancels_classes_not_other_commitments(app):
    from models import CalendarDay, Constraint, active_constraints
    from datetime import time as t_
    with app.app_context():
        wed = monday() + timedelta(days=9)
        db.session.add(Constraint(label="Volunteering", weekdays=str(wed.weekday()), kind="busy",
                                  start_time=t_(18), end_time=t_(20)))
        db.session.commit()
        before = {c.label for c in active_constraints(wed)}
        assert "CS102" in before and "Volunteering" in before
        db.session.add(CalendarDay(start=wed, end=wed, label="Test holiday", kind="bank_holiday"))
        db.session.commit()
        after = {c.label for c in active_constraints(wed)}
        assert "CS102" not in after and "Volunteering" in after
        assert any(s["start"] <= "14:00" and s["end"] >= "16:00" for s in tools.find_free_slots(wed.isoformat()))


def test_study_blocks_can_be_30_minutes(app):
    import scheduler
    assert scheduler.BLOCK_MIN == timedelta(minutes=30)


def test_term_only_commitment_skips_holidays(app):
    from models import CalendarDay, Constraint, active_constraints
    from datetime import time as t_
    with app.app_context():
        wed = monday() + timedelta(days=9)
        db.session.add(Constraint(label="Volunteering", weekdays=str(wed.weekday()), kind="busy", term_only=True,
                                  start_time=t_(18), end_time=t_(20)))
        db.session.add(Constraint(label="Gym", weekdays=str(wed.weekday()), kind="busy", start_time=t_(7), end_time=t_(8)))
        db.session.add(CalendarDay(start=wed, end=wed, label="Study week", kind="no_lectures"))
        db.session.commit()
        labels = {c.label for c in active_constraints(wed)}
        assert "Volunteering" not in labels and "Gym" in labels


def test_pwa_assets_are_versioned_per_deploy(app, client, monkeypatch):
    v = app.config["ASSET_VERSION"]
    assert v and len(v) == 10
    sw = client.get("/sw.js")
    assert sw.status_code == 200 and sw.headers["Cache-Control"] == "no-cache"
    body = sw.get_data(as_text=True)
    assert "__VERSION__" not in body and f'planner-{v}' in body and f"app.js?v={v}" in body
    page = client.get("/").get_data(as_text=True)
    assert f"app.js?v={v}" in page and f"app.css?v={v}" in page
    # Render's commit SHA wins when present
    monkeypatch.setenv("RENDER_GIT_COMMIT", "abcdef1234567890")
    from app import create_app
    a2 = create_app({"SQLALCHEMY_DATABASE_URI": app.config["SQLALCHEMY_DATABASE_URI"]})
    assert a2.config["ASSET_VERSION"] == "abcdef1234"


def test_item_reports_its_real_weekday(app):
    with app.app_context():
        out, err = tools.execute("create_item", {"kind": "event", "title": "Trip", "start": "2026-10-17T12:00",
                                                 "end": "2026-10-17T16:00"})
        assert not err and out["when"] == "Saturday 17 October 2026, 12:00–16:00"
        snap = tools.context_snapshot()
        assert len(snap["dates"]) == 28 and snap["dates"][0].endswith(date.today().isoformat())
