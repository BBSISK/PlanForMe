"""Phase 4 stub: expose the same tools to Claude (Cowork / claude.ai / Claude Code) over MCP.

Run locally:   pip install "mcp[cli]"  &&  python mcp_server.py
Add to Claude as a custom connector (streamable HTTP) once deployed behind API_TOKEN auth.
Every tool call goes through tools.execute(), so behaviour matches the in-app chat exactly.
"""
from mcp.server.fastmcp import FastMCP

from app import create_app
import tools

flask_app = create_app()
mcp = FastMCP("planner")


def _run(name, **args):
    with flask_app.app_context():
        out, _ = tools.execute(name, {k: v for k, v in args.items() if v is not None})
        return out


@mcp.tool()
def list_items(from_date: str, to_date: str, kind: str | None = None, course_code: str | None = None) -> list:
    """List planner items between two dates (YYYY-MM-DD, inclusive)."""
    return _run("list_items", from_date=from_date, to_date=to_date, kind=kind, course_code=course_code)


@mcp.tool()
def create_item(kind: str, title: str, start: str | None = None, end: str | None = None, due: str | None = None,
                priority: int = 3, course_code: str | None = None, notes: str = "") -> dict:
    """Create an event/task/study/class/deadline. Times YYYY-MM-DDTHH:MM Europe/Dublin."""
    return _run("create_item", kind=kind, title=title, start=start, end=end, due=due,
                priority=priority, course_code=course_code, notes=notes)


@mcp.tool()
def update_item(id: int, title: str | None = None, start: str | None = None, end: str | None = None,
                due: str | None = None, priority: int | None = None, status: str | None = None) -> dict:
    """Move, rename, re-prioritise or complete an item."""
    return _run("update_item", id=id, title=title, start=start, end=end, due=due, priority=priority, status=status)


@mcp.tool()
def find_free_slots(date: str, min_minutes: int = 30) -> list:
    """Free windows on a date after fixed commitments and existing items."""
    return _run("find_free_slots", date=date, min_minutes=min_minutes)


@mcp.tool()
def plan_week(monday: str, apply: bool = False) -> dict:
    """Propose (apply=False) or add (apply=True) study blocks to meet weekly module targets."""
    return _run("plan_week", monday=monday, apply=apply)


@mcp.tool()
def get_education_plan() -> dict:
    """Modules, weekly targets, hours this week, goals, milestones and upcoming deadlines."""
    return _run("get_education_plan")


if __name__ == "__main__":
    mcp.run()
