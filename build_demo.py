"""Build dist/planner_demo.html: the real front end with an in-memory demo backend (for the Artifact preview)."""
import json
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent))
from seed import load_seed

root = Path(__file__).parent
css = (root / "static/app.css").read_text()
js = (root / "static/app.js").read_text()
shell = (root / "templates/_shell.html").read_text()
fonts = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600'
         '&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">')
page = f"""<title>PlanForMe</title>
<meta name="claude:viewport-fit-sides" content="cover">
{fonts}
<style>{css}</style>
{shell}
<script>window.PLANNER_DEMO = true; window.PLANNER_SEED = {json.dumps(load_seed())};</script>
<script>{js}</script>
"""
out = root / "dist/planner_demo.html"
out.parent.mkdir(exist_ok=True)
out.write_text(page)
# standalone copy with a full document skeleton, for opening locally in a browser
(root / "dist/planner_demo_standalone.html").write_text(
    '<!doctype html><html lang="en-IE"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>'
    + page + "</body></html>")
print(out, len(page))
