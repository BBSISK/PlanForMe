"""Planner — Flask app factory, auth, pages and REST API."""
import os
import secrets
from datetime import date, datetime, time, timedelta
from functools import wraps

from werkzeug.middleware.proxy_fix import ProxyFix

from flask import (Flask, jsonify, redirect, render_template, request, send_from_directory,
                   session, url_for, abort)

from models import db, Item, Course, Goal, Milestone, Constraint, BLOCKING
import scheduler
import tools


def create_app(test_config=None):
    app = Flask(__name__)
    db_url = os.environ.get("DATABASE_URL", "sqlite:///planner.db")
    for prefix in ("postgres://", "postgresql://"):  # use the psycopg 3 driver from requirements.txt
        if db_url.startswith(prefix):
            db_url = "postgresql+psycopg://" + db_url[len(prefix):]
    app.config.update(
        SQLALCHEMY_DATABASE_URI=db_url,
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True, "pool_recycle": 280},  # Neon suspends idle computes
        SECRET_KEY=os.environ.get("SECRET_KEY", "dev-only-change-me"),
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("FLASK_ENV") == "production",
        APP_PASSWORD=os.environ.get("APP_PASSWORD", ""),
        API_TOKEN=os.environ.get("API_TOKEN", ""),
    )
    if test_config:
        app.config.update(test_config)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # Render terminates HTTPS
    db.init_app(app)
    with app.app_context():
        db.create_all()
        if not Course.query.first():
            from seed import seed
            seed()
        db.engine.dispose()  # gunicorn --preload: don't share connections across forked workers

    register_routes(app)
    return app


# ---------------------------------------------------------------- auth
def _authed():
    from flask import current_app as app
    if not app.config["APP_PASSWORD"]:
        return True  # no password set = local dev
    if session.get("ok"):
        return True
    token = app.config["API_TOKEN"]
    auth = request.headers.get("Authorization", "")
    return bool(token) and secrets.compare_digest(auth, f"Bearer {token}")


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if _authed():
            return fn(*a, **kw)
        if request.path.startswith("/api/"):
            return jsonify(error="unauthorised"), 401
        return redirect(url_for("login"))
    return wrapper


def _parse_date(v, default=None):
    try:
        return date.fromisoformat(v) if v else default
    except ValueError:
        abort(400, f"bad date {v}")


def register_routes(app):

    @app.route("/login", methods=["GET", "POST"])
    def login():
        err = None
        if request.method == "POST":
            if secrets.compare_digest(request.form.get("password", ""), app.config["APP_PASSWORD"]):
                session.permanent = True
                session["ok"] = True
                return redirect("/")
            err = "Wrong password"
        return render_template("login.html", error=err)

    @app.route("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.route("/")
    @login_required
    def index():
        return render_template("index.html")

    # service worker must be served from root scope
    @app.route("/sw.js")
    def sw():
        resp = send_from_directory(app.static_folder, "sw.js")
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Service-Worker-Allowed"] = "/"
        return resp

    @app.route("/manifest.webmanifest")
    def manifest():
        return send_from_directory(app.static_folder, "manifest.webmanifest",
                                   mimetype="application/manifest+json")

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    # ------------------------------------------------------------ items
    @app.get("/api/items")
    @login_required
    def items_list():
        today = date.today()
        f = _parse_date(request.args.get("from"), today)
        t = _parse_date(request.args.get("to"), f + timedelta(days=6))
        return jsonify(tools.list_items(f.isoformat(), t.isoformat(),
                                        kind=request.args.get("kind"),
                                        course_code=request.args.get("course")))

    @app.post("/api/items")
    @login_required
    def items_create():
        body = request.get_json(force=True)
        out, err = tools.execute("create_item", {**body, "source": "manual"})
        return jsonify(out), (400 if err else 201)

    @app.patch("/api/items/<int:item_id>")
    @login_required
    def items_update(item_id):
        out, err = tools.execute("update_item", {"id": item_id, **request.get_json(force=True)})
        return jsonify(out), (400 if err else 200)

    @app.delete("/api/items/<int:item_id>")
    @login_required
    def items_delete(item_id):
        out, err = tools.execute("delete_item", {"id": item_id})
        return jsonify(out), (404 if err else 200)

    # ------------------------------------------------------------ views
    @app.get("/api/day/<d>")
    @login_required
    def day_view(d):
        day = _parse_date(d)
        items = tools.list_items(day.isoformat(), day.isoformat())
        overdue = [i.to_dict() for i in Item.query.filter(
            Item.status == "todo", Item.kind.in_(("task", "deadline")), Item.start.is_(None),
            Item.due < day).order_by(Item.due).limit(10)] if day == date.today() else []
        fixed = [c.to_dict() for c in Constraint.query.filter(Constraint.kind.in_(BLOCKING)).order_by(Constraint.start_time) if day.weekday() in c.days()]
        todo = [i for i in items + overdue if i["status"] == "todo" and i["kind"] in ("task", "deadline", "study")]
        priorities = sorted(todo, key=lambda i: (i["priority"], i["start"] or "99"))[:3]
        return jsonify(date=day.isoformat(), items=items, overdue=overdue, fixed=fixed,
                       priorities=priorities, free=tools.find_free_slots(day.isoformat()))

    @app.get("/api/week/<d>")
    @login_required
    def week_view(d):
        day = _parse_date(d)
        monday = day - timedelta(days=day.weekday())
        items = tools.list_items(monday.isoformat(), (monday + timedelta(days=6)).isoformat())
        progress = [{"code": c.code, "colour": c.colour, "target": c.weekly_target_hours,
                     "scheduled": round(scheduler.study_hours(c.id, monday), 2)}
                    for c in Course.query.filter_by(active=True).order_by(Course.code)]
        cons = [c.to_dict() for c in Constraint.query.all()]
        return jsonify(monday=monday.isoformat(), items=items, progress=progress, constraints=cons)

    @app.post("/api/plan/week")
    @login_required
    def plan_week():
        body = request.get_json(force=True) or {}
        monday = _parse_date(body.get("monday"), date.today() - timedelta(days=date.today().weekday()))
        return jsonify(scheduler.plan_week(monday, apply=bool(body.get("apply"))))

    @app.get("/api/plan")
    @login_required
    def education_plan():
        return jsonify(tools.get_education_plan())

    # ------------------------------------------------------------ reference data
    simple = {"courses": Course, "goals": Goal, "milestones": Milestone, "constraints": Constraint}

    @app.get("/api/<any(courses, goals, milestones, constraints):kind>")
    @login_required
    def ref_list(kind):
        return jsonify([o.to_dict() for o in simple[kind].query.all()])

    @app.post("/api/<any(courses, goals, milestones, constraints):kind>")
    @login_required
    def ref_create(kind):
        body = request.get_json(force=True)
        obj = simple[kind]()
        _assign(obj, body)
        db.session.add(obj)
        db.session.commit()
        return jsonify(obj.to_dict()), 201

    @app.patch("/api/<any(courses, goals, milestones, constraints):kind>/<int:oid>")
    @login_required
    def ref_update(kind, oid):
        obj = db.get_or_404(simple[kind], oid)
        _assign(obj, request.get_json(force=True))
        db.session.commit()
        return jsonify(obj.to_dict())

    # ------------------------------------------------------------ chat
    @app.post("/api/chat")
    @login_required
    def chat():
        body = request.get_json(force=True)
        msg = (body.get("message") or "").strip()
        if not msg:
            return jsonify(error="empty message"), 400
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return jsonify(reply="Chat is off: set ANTHROPIC_API_KEY on the server.", changes=[])
        from claude_chat import run_chat
        return jsonify(run_chat(msg, body.get("history")))


def _assign(obj, body):
    for k, v in body.items():
        if k == "id" or not hasattr(obj, k):
            continue
        col = obj.__table__.columns.get(k)
        if col is not None and v is not None:
            py = col.type.python_type
            if py is date:
                v = date.fromisoformat(v)
            elif py is time:
                v = time.fromisoformat(v)
            elif py is str and isinstance(v, list):
                v = ",".join(str(x) for x in v)
        setattr(obj, k, v)


if __name__ == "__main__":
    create_app().run(debug=True, port=5000)
