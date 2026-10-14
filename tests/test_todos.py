from datetime import date, datetime, timedelta

import tools
from models import Todo, db


def test_todo_lifecycle(client):
    t = client.post("/api/todos", json={"title": "Book NCT", "due": date.today().isoformat(), "priority": 1}).json
    assert t["status"] == "open" and t["priority"] == 1
    lst = client.get("/api/todos?view=open").json
    assert lst["counts"]["open"] == 1 and lst["todos"][0]["title"] == "Book NCT"
    # close without, then add comment later: done_at is kept
    d1 = client.patch(f"/api/todos/{t['id']}", json={"action": "complete"}).json
    d2 = client.patch(f"/api/todos/{t['id']}", json={"action": "complete", "comment": "Booked for 3 Nov"}).json
    assert d1["done_at"] == d2["done_at"] and d2["done_comment"] == "Booked for 3 Nov" and d2["archives_on"]
    assert client.get("/api/todos?view=done").json["counts"]["done"] == 1
    # reopen clears it
    r = client.patch(f"/api/todos/{t['id']}", json={"action": "reopen"}).json
    assert r["status"] == "open" and r["done_comment"] == ""


def test_auto_archive_after_days(app, client):
    t = client.post("/api/todos", json={"title": "Old thing"}).json
    client.patch(f"/api/todos/{t['id']}", json={"action": "complete", "comment": "done"})
    with app.app_context():
        row = db.session.get(Todo, t["id"])
        row.done_at = datetime.now() - timedelta(days=4)
        db.session.commit()
    data = client.get("/api/todos?view=done").json
    assert data["todos"] == [] and data["counts"]["archived"] == 1
    arch = client.get("/api/todos?view=archived").json["todos"][0]
    assert arch["done_comment"] == "done"
    restored = client.patch(f"/api/todos/{t['id']}", json={"action": "unarchive"}).json
    assert restored["archived_at"] is None and restored["status"] == "done"


def test_delete_and_undo(client):
    t = client.post("/api/todos", json={"title": "Temp", "notes": "n"}).json
    gone = client.delete(f"/api/todos/{t['id']}").json["deleted"]
    assert client.get("/api/todos").json["counts"]["open"] == 0
    back = client.post("/api/todos", json={"restore": gone}).json
    assert back["title"] == "Temp" and back["notes"] == "n"


def test_due_by_filter_and_sort(client):
    today = date.today()
    client.post("/api/todos", json={"title": "later", "due": (today + timedelta(days=5)).isoformat()})
    client.post("/api/todos", json={"title": "flagged undated", "priority": 1})
    client.post("/api/todos", json={"title": "overdue", "due": (today - timedelta(days=1)).isoformat()})
    titles = [t["title"] for t in client.get("/api/todos?view=open").json["todos"]]
    assert titles == ["flagged undated", "overdue", "later"]
    due = [t["title"] for t in client.get(f"/api/todos?view=open&due_by={today.isoformat()}").json["todos"]]
    assert due == ["overdue"]


def test_empty_title_rejected(client):
    assert client.post("/api/todos", json={"title": "  "}).status_code == 400


def test_claude_tools(app):
    with app.app_context():
        out, err = tools.execute("add_todo", {"title": "Email lecturer"})
        assert not err
        out, err = tools.execute("complete_todo", {"id": out["id"], "comment": "Sent"})
        assert not err and out["done_comment"] == "Sent"
        out, err = tools.execute("complete_todo", {"id": 9999})
        assert err and "No to-do" in out["error"]
        assert {"add_todo", "complete_todo"} <= tools.WRITES
        assert any(t["name"] == "list_todos" for t in tools.TOOLS)
