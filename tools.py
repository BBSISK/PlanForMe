"""Claude tool layer. The chat endpoint and the MCP server both go through execute()."""
from datetime import date, datetime, time, timedelta

from models import Course, Goal, Item, Milestone, Constraint, db, KINDS
import scheduler

TOOLS = [
    {
        "name": "list_items",
        "description": "List planner items (events, tasks, study blocks, classes, deadlines) between two dates inclusive.",
        "input_schema": {"type": "object", "properties": {
            "from_date": {"type": "string", "description": "YYYY-MM-DD"},
            "to_date": {"type": "string", "description": "YYYY-MM-DD"},
            "kind": {"type": "string", "enum": list(KINDS)},
            "course_code": {"type": "string"}},
            "required": ["from_date", "to_date"]},
    },
    {
        "name": "create_item",
        "description": "Create a planner item. Timed items need start and end (YYYY-MM-DDTHH:MM, Europe/Dublin). "
                       "Untimed tasks/deadlines use due (YYYY-MM-DD).",
        "input_schema": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": list(KINDS)},
            "title": {"type": "string"},
            "start": {"type": "string"}, "end": {"type": "string"}, "due": {"type": "string"},
            "priority": {"type": "integer", "minimum": 1, "maximum": 4,
                         "description": "1 must-do, 2 important, 3 normal, 4 someday"},
            "course_code": {"type": "string"}, "notes": {"type": "string"}},
            "required": ["kind", "title"]},
    },
    {
        "name": "update_item",
        "description": "Change an existing item: move it, rename, re-prioritise, or set status done/skipped/todo. "
                       "Only pass fields that change.",
        "input_schema": {"type": "object", "properties": {
            "id": {"type": "integer"}, "title": {"type": "string"}, "kind": {"type": "string", "enum": list(KINDS)},
            "start": {"type": "string"}, "end": {"type": "string"}, "due": {"type": "string"},
            "priority": {"type": "integer"}, "status": {"type": "string", "enum": ["todo", "done", "skipped"]},
            "course_code": {"type": "string"}, "notes": {"type": "string"}},
            "required": ["id"]},
    },
    {
        "name": "delete_item",
        "description": "Delete an item. Only call after the user has explicitly confirmed the deletion.",
        "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]},
    },
    {
        "name": "find_free_slots",
        "description": "Free time windows on a date, after fixed commitments and existing items (15 min buffers).",
        "input_schema": {"type": "object", "properties": {
            "date": {"type": "string"}, "min_minutes": {"type": "integer", "default": 30}},
            "required": ["date"]},
    },
    {
        "name": "plan_week",
        "description": "Schedule study blocks so each active course meets its weekly hour target. "
                       "Use apply=false first to show a proposal; apply=true only when the user agrees.",
        "input_schema": {"type": "object", "properties": {
            "monday": {"type": "string", "description": "YYYY-MM-DD of the week's Monday"},
            "apply": {"type": "boolean", "default": False}},
            "required": ["monday"]},
    },
    {
        "name": "get_education_plan",
        "description": "Courses with weekly targets and hours scheduled this week, goals, and upcoming milestones.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_milestone",
        "description": "Add a milestone to a goal (creates the goal if goal_title is new).",
        "input_schema": {"type": "object", "properties": {
            "goal_title": {"type": "string"}, "title": {"type": "string"}, "due": {"type": "string"},
            "course_code": {"type": "string"}},
            "required": ["goal_title", "title"]},
    },
    {
        "name": "complete_milestone",
        "description": "Mark a milestone done.",
        "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]},
    },
]


class ToolError(Exception):
    pass


def _dt(v):
    return datetime.fromisoformat(v) if v else None


def _d(v):
    return date.fromisoformat(v[:10]) if v else None


def _course_id(code):
    if not code:
        return None
    c = Course.query.filter(db.func.upper(Course.code) == code.upper()).first()
    if not c:
        raise ToolError(f"Unknown course {code}. Known: {', '.join(x.code for x in Course.query.all())}")
    return c.id


def list_items(from_date, to_date, kind=None, course_code=None):
    f, t = _d(from_date), _d(to_date)
    start, end = datetime.combine(f, time.min), datetime.combine(t + timedelta(days=1), time.min)
    q = Item.query.filter(db.or_(db.and_(Item.start >= start, Item.start < end),
                                 db.and_(Item.start.is_(None), Item.due >= f, Item.due <= t)))
    if kind:
        q = q.filter(Item.kind == kind)
    if course_code:
        q = q.filter(Item.course_id == _course_id(course_code))
    items = q.all()
    items.sort(key=lambda i: (i.day() or f, i.start or datetime.combine(i.due or f, time.max), i.priority))
    return [i.to_dict() for i in items]


def create_item(kind, title, start=None, end=None, due=None, priority=3, course_code=None, notes="",
                source="claude"):
    if kind not in KINDS:
        raise ToolError(f"kind must be one of {KINDS}")
    s, e = _dt(start), _dt(end)
    if s and not e:
        e = s + timedelta(hours=1)
    if s and e and e <= s:
        raise ToolError("end must be after start")
    if not s and not due:
        due = date.today().isoformat()
    it = Item(kind=kind, title=title, start=s, end=e, due=_d(due), priority=priority or 3,
              course_id=_course_id(course_code), notes=notes or "", source=source)
    db.session.add(it)
    db.session.commit()
    return it.to_dict()


def update_item(id, **fields):
    it = db.session.get(Item, id)
    if not it:
        raise ToolError(f"No item {id}")
    if "start" in fields and not fields["start"]:  # explicit null -> make it an untimed task
        fields.pop("start")
        fields.pop("end", None)
        it.start = it.end = None
        it.due = it.due or date.today()
    if "start" in fields and fields["start"]:
        new_start = _dt(fields.pop("start"))
        dur = (it.end - it.start) if (it.start and it.end) else timedelta(hours=1)
        it.start = new_start
        if not fields.get("end"):
            it.end = new_start + dur  # moving keeps the duration
    if fields.get("end"):
        it.end = _dt(fields.pop("end"))
    if "due" in fields:
        it.due = _d(fields.pop("due"))
    if "course_code" in fields:
        it.course_id = _course_id(fields.pop("course_code"))
    if fields.get("kind") and fields["kind"] not in KINDS:
        raise ToolError(f"kind must be one of {KINDS}")
    for k in ("kind", "title", "priority", "status", "notes"):
        if k in fields and fields[k] is not None:
            setattr(it, k, fields[k])
    it.locked = True
    db.session.commit()
    return it.to_dict()


def delete_item(id):
    it = db.session.get(Item, id)
    if not it:
        raise ToolError(f"No item {id}")
    d = it.to_dict()
    db.session.delete(it)
    db.session.commit()
    return {"deleted": d}


def find_free_slots(date, min_minutes=30):
    day = _d(date)
    return [{"start": s.strftime("%H:%M"), "end": e.strftime("%H:%M"),
             "minutes": int((e - s).total_seconds() // 60)}
            for s, e in scheduler.free_slots(day, min_minutes)]


def plan_week(monday, apply=False):
    return scheduler.plan_week(_d(monday), apply=apply)


def get_education_plan():
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    courses = []
    for c in Course.query.filter_by(active=True).order_by(Course.code).all():
        d = c.to_dict()
        d["hours_this_week"] = round(scheduler.study_hours(c.id, monday), 2)
        courses.append(d)
    goals = [g.to_dict() for g in Goal.query.order_by(Goal.target_date).all()]
    upcoming = [m.to_dict() for m in Milestone.query.filter(Milestone.done.is_(False))
                .order_by(Milestone.due).limit(10).all()]
    deadlines = list_items(today.isoformat(), (today + timedelta(days=28)).isoformat(), kind="deadline")
    from models import CalendarDay
    cal = [c.to_dict() for c in CalendarDay.query.filter(CalendarDay.end >= today).order_by(CalendarDay.start).limit(12)]
    return {"week_of": monday.isoformat(), "courses": courses, "goals": goals,
            "upcoming_milestones": upcoming, "deadlines_next_4_weeks": deadlines, "calendar": cal}


def add_milestone(goal_title, title, due=None, course_code=None):
    g = Goal.query.filter(db.func.lower(Goal.title) == goal_title.lower()).first()
    if not g:
        g = Goal(title=goal_title, course_id=_course_id(course_code))
        db.session.add(g)
        db.session.flush()
    m = Milestone(goal_id=g.id, title=title, due=_d(due))
    db.session.add(m)
    db.session.commit()
    return m.to_dict()


def complete_milestone(id):
    m = db.session.get(Milestone, id)
    if not m:
        raise ToolError(f"No milestone {id}")
    m.done = True
    db.session.commit()
    return m.to_dict()


REGISTRY = {f.__name__: f for f in (list_items, create_item, update_item, delete_item, find_free_slots,
                                     plan_week, get_education_plan, add_milestone, complete_milestone)}
WRITES = {"create_item", "update_item", "delete_item", "add_milestone", "complete_milestone"}

import todos as _todos  # noqa: E402  (to-do list tools share the same gateway)
TOOLS += _todos.TOOLS
REGISTRY.update(_todos.FUNCS)
WRITES |= _todos.WRITES


def execute(name, args):
    """Run a tool. Returns (result_dict, is_error)."""
    fn = REGISTRY.get(name)
    if not fn:
        return {"error": f"unknown tool {name}"}, True
    try:
        return fn(**args), False
    except (ToolError, ValueError, TypeError, _todos.TodoError) as e:
        db.session.rollback()
        return {"error": str(e)}, True


def context_snapshot():
    """Compact context for Claude's system prompt."""
    now = datetime.now()
    cons = [{k: v for k, v in c.to_dict().items()
             if k in ("label", "room", "weekdays", "start_time", "end_time", "kind", "valid_from", "valid_to")}
            for c in Constraint.query.all()]
    courses = [f"{c.code} ({c.name}, target {c.weekly_target_hours}h/wk)"
               for c in Course.query.filter_by(active=True).order_by(Course.code)]
    from models import CalendarDay
    today = now.date()
    cal = [c.to_dict() for c in CalendarDay.query.filter(CalendarDay.end >= today,
                                                          CalendarDay.start <= today + timedelta(days=60))
           .order_by(CalendarDay.start)]
    dates = [f"{d:%a} {d.day} {d:%b} = {d.isoformat()}" for d in (today + timedelta(days=n) for n in range(28))]
    return {"now": now.strftime("%A %d %B %Y, %H:%M"), "today": today.isoformat(),
            "constraints": cons, "courses": courses, "calendar": cal, "dates": dates}
