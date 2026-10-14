"""To-do list: quick capture, close with optional comment, auto-archive closed items after a few days.

Routes live under /api/todos. Claude tools (list_todos, add_todo, update_todo, complete_todo,
reopen_todo, delete_todo) share the same functions, so chat and taps behave identically.
"""
import os
from datetime import date, datetime, timedelta

from flask import Blueprint, jsonify, request

from models import Todo, db

ARCHIVE_AFTER_DAYS = int(os.environ.get("TODO_ARCHIVE_DAYS", "3"))



class TodoError(Exception):
    pass


def _d(v):
    return date.fromisoformat(v[:10]) if v else None


def _get(id):
    t = db.session.get(Todo, int(id))
    if not t:
        raise TodoError(f"No to-do {id}")
    return t


def auto_archive():
    """Closed items move to the archive ARCHIVE_AFTER_DAYS after closing (lazy: runs on each list)."""
    cutoff = datetime.now() - timedelta(days=ARCHIVE_AFTER_DAYS)
    n = Todo.query.filter(Todo.status == "done", Todo.archived_at.is_(None), Todo.done_at <= cutoff) \
        .update({Todo.archived_at: datetime.now()}, synchronize_session=False)
    if n:
        db.session.commit()
    return n


def list_todos(view="open", due_by=None):
    """view: open | done | archived | all. due_by (YYYY-MM-DD) limits open items to those due on/before it."""
    auto_archive()
    q = Todo.query
    if view == "open":
        q = q.filter(Todo.status == "open")
        if due_by:
            q = q.filter(Todo.due.isnot(None), Todo.due <= _d(due_by))
    elif view == "done":
        q = q.filter(Todo.status == "done", Todo.archived_at.is_(None))
    elif view == "archived":
        q = q.filter(Todo.archived_at.isnot(None))
    todos = q.all()
    if view == "open":
        far = date.max
        todos.sort(key=lambda t: (t.priority, t.due or far, t.position, t.id))
    else:
        todos.sort(key=lambda t: t.archived_at or t.done_at or datetime.min, reverse=True)
    return [t.to_dict(ARCHIVE_AFTER_DAYS) for t in todos]


def counts():
    auto_archive()
    return {"open": Todo.query.filter_by(status="open").count(),
            "done": Todo.query.filter(Todo.status == "done", Todo.archived_at.is_(None)).count(),
            "archived": Todo.query.filter(Todo.archived_at.isnot(None)).count()}


def add_todo(title, due=None, priority=2, notes=""):
    title = (title or "").strip()
    if not title:
        raise TodoError("A to-do needs a title")
    top = db.session.query(db.func.max(Todo.position)).scalar() or 0
    t = Todo(title=title, due=_d(due), priority=1 if int(priority or 2) == 1 else 2, notes=notes or "",
             position=top + 1)
    db.session.add(t)
    db.session.commit()
    return t.to_dict(ARCHIVE_AFTER_DAYS)


def update_todo(id, title=None, due="__keep__", priority=None, notes=None):
    t = _get(id)
    if title is not None:
        if not title.strip():
            raise TodoError("A to-do needs a title")
        t.title = title.strip()
    if due != "__keep__":
        t.due = _d(due)
    if priority is not None:
        t.priority = 1 if int(priority) == 1 else 2
    if notes is not None:
        t.notes = notes
    db.session.commit()
    return t.to_dict(ARCHIVE_AFTER_DAYS)


def complete_todo(id, comment=None):
    t = _get(id)
    t.status = "done"
    t.done_at = t.done_at or datetime.now()
    if comment is not None:
        t.done_comment = comment.strip()
    t.archived_at = None
    db.session.commit()
    return t.to_dict(ARCHIVE_AFTER_DAYS)


def reopen_todo(id):
    t = _get(id)
    t.status, t.done_at, t.done_comment, t.archived_at = "open", None, "", None
    db.session.commit()
    return t.to_dict(ARCHIVE_AFTER_DAYS)


def archive_todo(id):
    t = _get(id)
    if t.status != "done":
        raise TodoError("Only closed to-dos can be archived")
    t.archived_at = datetime.now()
    db.session.commit()
    return t.to_dict(ARCHIVE_AFTER_DAYS)


def unarchive_todo(id):
    t = _get(id)
    t.archived_at = None
    if t.status == "done":
        t.done_at = datetime.now()  # restart the archive countdown
    db.session.commit()
    return t.to_dict(ARCHIVE_AFTER_DAYS)


def delete_todo(id):
    t = _get(id)
    d = t.to_dict(ARCHIVE_AFTER_DAYS)
    db.session.delete(t)
    db.session.commit()
    return {"deleted": d}


def restore_todo(data):
    """Undo a delete: re-create from the dict delete_todo returned."""
    t = Todo(title=data["title"], notes=data.get("notes", ""), due=_d(data.get("due")),
             priority=data.get("priority", 2), position=data.get("position", 0),
             status=data.get("status", "open"), done_comment=data.get("done_comment", ""),
             done_at=datetime.fromisoformat(data["done_at"]) if data.get("done_at") else None,
             archived_at=datetime.fromisoformat(data["archived_at"]) if data.get("archived_at") else None,
             created=datetime.fromisoformat(data["created"]) if data.get("created") else datetime.now())
    db.session.add(t)
    db.session.commit()
    return t.to_dict(ARCHIVE_AFTER_DAYS)


# ------------------------------------------------------------------ routes
def _run(fn, *a, **kw):
    try:
        return jsonify(fn(*a, **kw)), 200
    except (TodoError, ValueError, TypeError) as e:
        db.session.rollback()
        return jsonify(error=str(e)), 400


def register(app, login_required):
    bp = Blueprint("todos", __name__)  # one per app instance

    @bp.get("/api/todos")
    @login_required
    def todos_list():
        return _run(lambda: {"todos": list_todos(request.args.get("view", "open"), request.args.get("due_by")),
                             "counts": counts(), "archive_after_days": ARCHIVE_AFTER_DAYS})

    @bp.post("/api/todos")
    @login_required
    def todos_add():
        b = request.get_json(force=True) or {}
        if b.get("restore"):
            return _run(restore_todo, b["restore"])
        return _run(add_todo, b.get("title"), b.get("due"), b.get("priority", 2), b.get("notes", ""))

    @bp.patch("/api/todos/<int:tid>")
    @login_required
    def todos_update(tid):
        b = request.get_json(force=True) or {}
        action = b.pop("action", None)
        if action == "complete":
            return _run(complete_todo, tid, b.get("comment"))
        if action == "reopen":
            return _run(reopen_todo, tid)
        if action == "archive":
            return _run(archive_todo, tid)
        if action == "unarchive":
            return _run(unarchive_todo, tid)
        kw = {k: b[k] for k in ("title", "priority", "notes") if k in b}
        if "due" in b:
            kw["due"] = b["due"]
        return _run(update_todo, tid, **kw)

    @bp.delete("/api/todos/<int:tid>")
    @login_required
    def todos_delete(tid):
        return _run(delete_todo, tid)

    app.register_blueprint(bp)


# ------------------------------------------------------------------ Claude tools
TOOLS = [
    {"name": "list_todos",
     "description": "List to-dos. view: open (default) | done | archived. due_by limits open to-dos to those due on or before a date.",
     "input_schema": {"type": "object", "properties": {
         "view": {"type": "string", "enum": ["open", "done", "archived"]}, "due_by": {"type": "string"}}}},
    {"name": "add_todo",
     "description": "Add a to-do: something to remember or get done with no set time slot. Use create_item instead for anything at a specific time.",
     "input_schema": {"type": "object", "properties": {
         "title": {"type": "string"}, "due": {"type": "string", "description": "optional YYYY-MM-DD"},
         "priority": {"type": "integer", "enum": [1, 2], "description": "1 = flagged/high, 2 = normal"},
         "notes": {"type": "string"}}, "required": ["title"]}},
    {"name": "update_todo",
     "description": "Change a to-do's title, due date (null to clear), priority or notes.",
     "input_schema": {"type": "object", "properties": {
         "id": {"type": "integer"}, "title": {"type": "string"}, "due": {"type": ["string", "null"]},
         "priority": {"type": "integer", "enum": [1, 2]}, "notes": {"type": "string"}}, "required": ["id"]}},
    {"name": "complete_todo",
     "description": "Close a to-do, optionally with a closing comment (e.g. what was done).",
     "input_schema": {"type": "object", "properties": {
         "id": {"type": "integer"}, "comment": {"type": "string"}}, "required": ["id"]}},
    {"name": "reopen_todo", "description": "Reopen a closed or archived to-do.",
     "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]}},
    {"name": "delete_todo", "description": "Delete a to-do permanently. Only after the user has confirmed.",
     "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]}},
]

FUNCS = {"list_todos": list_todos, "add_todo": add_todo, "update_todo": update_todo,
         "complete_todo": complete_todo, "reopen_todo": reopen_todo, "delete_todo": delete_todo}
WRITES = {"add_todo", "update_todo", "complete_todo", "reopen_todo", "delete_todo"}
ERRORS = (TodoError,)
