"""Free-slot finder and weekly study planner (v1 greedy heuristic, ARCHITECTURE.md §6)."""
from datetime import date, datetime, time, timedelta

from models import BLOCKING, Constraint, Course, Item, Milestone, Goal, db

DAY_START = time(7, 0)
DAY_END = time(22, 0)
BUFFER = timedelta(minutes=15)
BLOCK_MAX = timedelta(minutes=90)
BLOCK_MIN = timedelta(minutes=45)
MAX_BLOCKS_PER_COURSE_PER_DAY = 2


def _subtract(windows, busy_start, busy_end):
    out = []
    for s, e in windows:
        if busy_end <= s or busy_start >= e:
            out.append((s, e))
            continue
        if busy_start > s:
            out.append((s, busy_start))
        if busy_end < e:
            out.append((busy_end, e))
    return out


def busy_blocks(day: date):
    """(start, end, label) for constraints + timed items on a day."""
    blocks = []
    for c in Constraint.query.filter(Constraint.kind.in_(BLOCKING)).all():
        if day.weekday() in c.days():
            blocks.append((datetime.combine(day, c.start_time), datetime.combine(day, c.end_time), f"{c.label} {c.room}".strip()))
    start = datetime.combine(day, time.min)
    for it in Item.query.filter(Item.start >= start, Item.start < start + timedelta(days=1),
                                Item.status != "skipped").all():
        if it.end:
            blocks.append((it.start, it.end, it.title))
    return blocks


def free_slots(day: date, min_minutes: int = 30, extra_busy=()):
    windows = [(datetime.combine(day, DAY_START), datetime.combine(day, DAY_END))]
    for s, e, _ in list(busy_blocks(day)) + list(extra_busy):
        windows = _subtract(windows, s - BUFFER, e + BUFFER)
    now = datetime.now()
    if day == now.date():
        windows = _subtract(windows, datetime.combine(day, time.min), now)
    return [(s, e) for s, e in windows if (e - s) >= timedelta(minutes=min_minutes)]


def preferred_windows(day: date):
    out = []
    for c in Constraint.query.filter_by(kind="preferred_study").all():
        if day.weekday() in c.days():
            out.append((datetime.combine(day, c.start_time), datetime.combine(day, c.end_time)))
    return out


def study_hours(course_id: int, monday: date):
    start = datetime.combine(monday, time.min)
    items = Item.query.filter(Item.course_id == course_id, Item.kind.in_(("study", "class")),
                              Item.start >= start, Item.start < start + timedelta(days=7),
                              Item.status != "skipped").all()
    return sum(i.minutes for i in items if i.kind == "study") / 60


def _next_deadline_days(course: Course, today: date):
    dates = [i.due or (i.start.date() if i.start else None)
             for i in Item.query.filter_by(course_id=course.id, kind="deadline", status="todo").all()]
    dates += [m.due for m in Milestone.query.join(Goal).filter(Goal.course_id == course.id,
                                                                Milestone.done.is_(False)).all()]
    dates = [d for d in dates if d and d >= today]
    return (min(dates) - today).days if dates else None


def plan_week(monday: date, apply: bool = False):
    """Propose (or create) study blocks so each active course meets its weekly target."""
    today = date.today()
    days = [monday + timedelta(days=i) for i in range(7) if monday + timedelta(days=i) >= today]
    courses = Course.query.filter_by(active=True).all()

    deficit, urgency = {}, {}
    for c in courses:
        deficit[c.id] = max(0.0, c.weekly_target_hours - study_hours(c.id, monday))
        dd = _next_deadline_days(c, today)
        urgency[c.id] = deficit[c.id] * (1 + (1 / max(dd, 1) if dd is not None else 0))

    proposed, placed = [], []  # placed = (start, end, label) to block later picks
    per_day_count = {}
    order = sorted([c for c in courses if deficit[c.id] > 0], key=lambda c: -urgency[c.id])

    progress = True
    while progress and any(deficit[c.id] > 0 for c in order):
        progress = False
        for c in order:
            if deficit[c.id] <= 0:
                continue
            slot = _pick_slot(days, c.id, deficit[c.id], placed, per_day_count)
            if not slot:
                continue
            s, e = slot
            placed.append((s, e, c.code))
            per_day_count[(c.id, s.date())] = per_day_count.get((c.id, s.date()), 0) + 1
            deficit[c.id] -= (e - s).total_seconds() / 3600
            proposed.append({"course_id": c.id, "course_code": c.code, "title": f"Study: {c.code}",
                             "start": s.strftime("%Y-%m-%dT%H:%M"), "end": e.strftime("%Y-%m-%dT%H:%M")})
            progress = True

    if apply:
        for p in proposed:
            db.session.add(Item(kind="study", title=p["title"], course_id=p["course_id"],
                                start=datetime.fromisoformat(p["start"]), end=datetime.fromisoformat(p["end"]),
                                priority=2, source="scheduler", locked=False))
        db.session.commit()

    return {"monday": monday.isoformat(), "proposed": proposed, "applied": apply,
            "unmet_hours": {c.code: round(max(deficit[c.id], 0), 2) for c in courses if deficit[c.id] > 0.01}}


def _pick_slot(days, course_id, hours_left, placed, per_day_count):
    want = min(BLOCK_MAX, max(BLOCK_MIN, timedelta(hours=hours_left)))
    for prefer in (True, False):
        for d in days:
            if per_day_count.get((course_id, d), 0) >= MAX_BLOCKS_PER_COURSE_PER_DAY:
                continue
            for s, e in free_slots(d, int(BLOCK_MIN.total_seconds() // 60), extra_busy=placed):
                if prefer:
                    pw = [(max(s, ps), min(e, pe)) for ps, pe in preferred_windows(d)]
                    candidates = [(a, b) for a, b in pw if b - a >= BLOCK_MIN]
                else:
                    candidates = [(s, e)]
                for a, b in candidates:
                    end = min(b, a + want)
                    if end - a >= BLOCK_MIN:
                        return a, end
    return None
