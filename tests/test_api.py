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
