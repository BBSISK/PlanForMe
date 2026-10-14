"""SQLAlchemy models. Times are naive local (Europe/Dublin) — see ARCHITECTURE.md §3."""
from datetime import datetime, date, time

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

KINDS = ("event", "task", "study", "class", "deadline")
STATUSES = ("todo", "done", "skipped")


class Course(db.Model):
    __tablename__ = "courses"
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(20), unique=True, nullable=False)
    name = db.Column(db.String(200), nullable=False)
    colour = db.Column(db.String(9), default="#4f6bed")
    weekly_target_hours = db.Column(db.Float, default=4.0)
    semester = db.Column(db.Integer, default=1)
    active = db.Column(db.Boolean, default=True)

    def to_dict(self):
        return {c: getattr(self, c) for c in
                ("id", "code", "name", "colour", "weekly_target_hours", "semester", "active")}


class Goal(db.Model):
    __tablename__ = "goals"
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    course_id = db.Column(db.Integer, db.ForeignKey("courses.id"))
    target_date = db.Column(db.Date)
    notes = db.Column(db.Text, default="")
    milestones = db.relationship("Milestone", backref="goal", cascade="all, delete-orphan",
                                 order_by="Milestone.due")

    def to_dict(self):
        return {"id": self.id, "title": self.title, "course_id": self.course_id,
                "target_date": _iso(self.target_date), "notes": self.notes,
                "milestones": [m.to_dict() for m in self.milestones]}


class Milestone(db.Model):
    __tablename__ = "milestones"
    id = db.Column(db.Integer, primary_key=True)
    goal_id = db.Column(db.Integer, db.ForeignKey("goals.id"), nullable=False)
    title = db.Column(db.String(200), nullable=False)
    due = db.Column(db.Date)
    done = db.Column(db.Boolean, default=False)

    def to_dict(self):
        return {"id": self.id, "goal_id": self.goal_id, "title": self.title,
                "due": _iso(self.due), "done": self.done}


class Constraint(db.Model):
    """Recurring weekly time. kind = class (timetabled lecture/lab) | busy (work, gym) | preferred_study."""
    __tablename__ = "constraints"
    id = db.Column(db.Integer, primary_key=True)
    label = db.Column(db.String(100), nullable=False)
    weekdays = db.Column(db.String(20), default="0,1,2,3,4")  # Mon=0
    start_time = db.Column(db.Time, nullable=False)
    end_time = db.Column(db.Time, nullable=False)
    kind = db.Column(db.String(20), default="busy")
    course_id = db.Column(db.Integer, db.ForeignKey("courses.id"))
    room = db.Column(db.String(60), default="")
    note = db.Column(db.String(200), default="")
    valid_from = db.Column(db.Date)   # e.g. first day of lectures; None = always
    valid_to = db.Column(db.Date)     # e.g. last day of lectures

    course = db.relationship("Course")

    def days(self):
        return {int(d) for d in self.weekdays.split(",") if d.strip() != ""}

    def active_on(self, day, offs=None):
        """Does this recurring block happen on `day`? Classes skip bank holidays, study weeks, exams."""
        if day.weekday() not in self.days():
            return False
        if (self.valid_from and day < self.valid_from) or (self.valid_to and day > self.valid_to):
            return False
        if self.kind == "class":
            offs = day_offs(day) if offs is None else offs
            if offs:
                return False
        return True

    def to_dict(self):
        return {"id": self.id, "label": self.label, "weekdays": sorted(self.days()),
                "start_time": self.start_time.strftime("%H:%M"),
                "end_time": self.end_time.strftime("%H:%M"), "kind": self.kind,
                "course_code": self.course.code if self.course else None,
                "colour": self.course.colour if self.course else None,
                "room": self.room or "", "note": self.note or "",
                "valid_from": _iso(self.valid_from), "valid_to": _iso(self.valid_to)}


BLOCKING = ("busy", "class")
CAL_KINDS = ("bank_holiday", "no_lectures", "exams")


class CalendarDay(db.Model):
    """Academic calendar and public holidays: a date or date range on which lectures don't run."""
    __tablename__ = "calendar"
    id = db.Column(db.Integer, primary_key=True)
    start = db.Column(db.Date, nullable=False)
    end = db.Column(db.Date, nullable=False)
    label = db.Column(db.String(120), nullable=False)
    kind = db.Column(db.String(20), default="no_lectures")  # bank_holiday | no_lectures | exams

    def to_dict(self):
        return {"id": self.id, "start": _iso(self.start), "end": _iso(self.end), "label": self.label, "kind": self.kind}


def day_offs(day):
    return CalendarDay.query.filter(CalendarDay.start <= day, CalendarDay.end >= day).order_by(CalendarDay.kind).all()


def active_constraints(day, kinds=None):
    offs = day_offs(day)
    q = Constraint.query
    if kinds:
        q = q.filter(Constraint.kind.in_(kinds))
    return [c for c in q.order_by(Constraint.start_time).all() if c.active_on(day, offs)]


class Item(db.Model):
    __tablename__ = "items"
    id = db.Column(db.Integer, primary_key=True)
    kind = db.Column(db.String(20), default="task")
    title = db.Column(db.String(300), nullable=False)
    notes = db.Column(db.Text, default="")
    start = db.Column(db.DateTime)          # timed items
    end = db.Column(db.DateTime)
    due = db.Column(db.Date)                # tasks/deadlines without a time slot
    all_day = db.Column(db.Boolean, default=False)
    priority = db.Column(db.Integer, default=3)  # 1 must · 2 important · 3 normal · 4 someday
    status = db.Column(db.String(10), default="todo")
    course_id = db.Column(db.Integer, db.ForeignKey("courses.id"))
    goal_id = db.Column(db.Integer, db.ForeignKey("goals.id"))
    rrule = db.Column(db.String(200))       # phase 1: expand recurrences
    source = db.Column(db.String(20), default="manual")  # manual · claude · scheduler · gcal
    locked = db.Column(db.Boolean, default=True)
    gcal_id = db.Column(db.String(200))
    created = db.Column(db.DateTime, default=datetime.now)
    updated = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)

    course = db.relationship("Course")

    @property
    def minutes(self):
        if self.start and self.end:
            return int((self.end - self.start).total_seconds() // 60)
        return 0

    def day(self):
        return self.start.date() if self.start else self.due

    def to_dict(self):
        return {
            "id": self.id, "kind": self.kind, "title": self.title, "notes": self.notes,
            "start": _iso(self.start), "end": _iso(self.end), "due": _iso(self.due),
            "all_day": self.all_day, "priority": self.priority, "status": self.status,
            "course_id": self.course_id,
            "course_code": self.course.code if self.course else None,
            "colour": self.course.colour if self.course else None,
            "goal_id": self.goal_id, "source": self.source, "locked": self.locked,
        }


class ChatLog(db.Model):
    __tablename__ = "chat_log"
    id = db.Column(db.Integer, primary_key=True)
    role = db.Column(db.String(20))
    content = db.Column(db.Text)
    tool_calls = db.Column(db.JSON)
    created = db.Column(db.DateTime, default=datetime.now)


def _iso(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%dT%H:%M")
    if isinstance(v, (date, time)):
        return v.isoformat()
    return v
