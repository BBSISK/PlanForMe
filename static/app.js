/* Planner front end. Talks to the Flask API; when window.PLANNER_DEMO is set it uses an in-memory mock. */
(() => {
  "use strict";
  const DEMO = !!window.PLANNER_DEMO;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- dates (local, naive)
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isoDT = (d) => `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parseD = (s) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
  const parseDT = (s) => { const d = parseD(s); if (s.length > 10) { const [h, mi] = s.slice(11, 16).split(":").map(Number); d.setHours(h, mi); } return d; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const hm = (s) => (s ? s.slice(11, 16) : "");
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const fmtLong = (d) => d.toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" });
  const fmtShort = (d) => d.toLocaleDateString("en-IE", { day: "numeric", month: "short" });
  const daysUntil = (s) => Math.round((parseD(s) - parseD(iso(new Date()))) / 864e5);

  const DAY_START = 7, DAY_END = 22;
  const OFF_TEXT = { bank_holiday: "Bank holiday · no lectures", no_lectures: "No lectures", exams: "Exams · no lectures" };

  // ---------------------------------------------------------------- state
  const state = { view: "day", cursor: new Date(), courses: [], history: [], proposal: null };
  try { const v = localStorage.getItem("planner.view"); if (v) state.view = v; } catch (e) { /* storage off */ }

  // ---------------------------------------------------------------- api
  async function api(method, path, body) {
    if (DEMO) return Demo.handle(method, path, body);
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.href = "/login"; return; }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  // ---------------------------------------------------------------- render: shared
  const view = $("#view");
  function setHeader(title, sub) { $("#title").textContent = title; $("#subtitle").textContent = sub; }

  async function render() {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === state.view)));
    $(".nav-arrows").hidden = !(state.view === "day" || state.view === "week");
    todaysLectures.stale = true;
    try { localStorage.setItem("planner.view", state.view); } catch (e) { /* ignore */ }
    if (!state.courses.length) state.courses = await api("GET", "/api/courses");
    if (state.view === "day") return renderDay();
    if (state.view === "week") return renderWeek();
    if (state.view === "todo") return renderTodo();
    if (state.view === "notes") return renderNotes();
    return renderPlan();
  }

  const badge = DEMO ? `<span class="demo-badge">demo data</span>` : "";

  function itemMeta(i) {
    const bits = [];
    if (i.start) bits.push(`${hm(i.start)}–${hm(i.end)}`);
    else if (i.due) { const n = daysUntil(i.due); bits.push(n === 0 ? "due today" : n < 0 ? `${-n}d overdue` : `due ${fmtShort(parseD(i.due))}`); }
    if (i.course_code) bits.push(i.course_code);
    return bits.join(" · ");
  }

  // ---------------------------------------------------------------- day
  async function renderDay() {
    const d = state.cursor, key = iso(d);
    const isToday = key === iso(new Date());
    setHeader(isToday ? "Today" : DAYS[(d.getDay() + 6) % 7] + " " + fmtShort(d), fmtLong(d));
    const [data, todoData] = await Promise.all([api("GET", `/api/day/${key}`),
      api("GET", `/api/todos?view=open&active_on=${key}`)]);
    const timed = data.items.filter((i) => i.start);
    const untimed = [...data.overdue, ...data.items.filter((i) => !i.start)];

    const prio = data.priorities.length ? data.priorities.map((i, n) => `
      <li class="prio ${i.status === "done" ? "is-done" : ""}">
        <span class="rank">${n + 1}</span>
        <button class="t" data-edit="${i.id}" style="border:0;background:none;padding:0;text-align:left">
          <strong>${esc(i.title)}</strong><span>${esc(itemMeta(i))}</span></button>
        <button class="check ${i.status === "done" ? "done" : ""}" data-toggle="${i.id}" aria-label="Mark done">✓</button>
      </li>`).join("") : `<li class="empty">Nothing urgent. Add a task or ask Claude to plan the day.</li>`;

    const offBanner = (data.off || []).length ? `<section class="off-banner">${data.off.map((o) =>
      `<div class="off off-${o.kind}"><b>${esc(o.label)}</b><span>${OFF_TEXT[o.kind] || ""}</span></div>`).join("")}</section>` : "";
    view.innerHTML = `${offBanner}
      <section><h2>Top 3 ${badge}</h2><ol class="prio-list">${prio}</ol></section>
      <section><h2>Timeline</h2>${timeline(timed, data.fixed, isToday, key)}</section>
      ${todoData ? `<section><h2>To-do <button class="link" data-goto="todo">${todoData.counts.open} open ›</button></h2>${
        todoData.todos.length ? `<ul class="rows todo-list">${todoData.todos.map((t) => todoRow(t, key)).join("")}</ul>` : `<div class="empty">No open to-dos.</div>`}</section>` : ""}
      <section><h2>Tasks & deadlines</h2>${rows(untimed)}</section>
      <section><h2>Free time</h2><div class="free-chips">${
        data.free.length ? data.free.map((f) => `<span>${f.start}–${f.end} · ${f.minutes}m</span>`).join("") : `<div class="empty">No gaps left today.</div>`
      }</div></section>`;
  }

  function timeline(items, fixed, isToday, key) {
    const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour")) || 44;
    const top = (t) => ((t.getHours() + t.getMinutes() / 60) - DAY_START) * H;
    let hours = "";
    for (let h = DAY_START; h < DAY_END; h++) hours += `<div class="tl-hour"><span class="tl-label">${pad(h)}:00</span></div>`;
    const fx = fixed.map((c) => {
      const s = parseDT(`${key}T${c.start_time}`), e = parseDT(`${key}T${c.end_time}`);
      const h = Math.max(top(e) - top(s), 16);
      if (c.kind === "class") return `<button class="tl-block class timetabled" data-lcode="${esc(c.course_code || c.label)}" data-ldate="${key}" data-lstart="${c.start_time}"
        aria-label="Notes for ${esc(c.label)} at ${c.start_time}" style="--c:${c.colour || "var(--accent)"};top:${top(s)}px;height:${h}px">
        <b>${esc(c.label)}${c.room ? " · " + esc(c.room) : ""}<span class="pen">✎ notes</span></b>${h > 30 ? `<small>${c.start_time}–${c.end_time}${c.note ? " · " + esc(c.note) : ""}</small>` : ""}</button>`;
      return `<div class="tl-block fixed" style="top:${top(s)}px;height:${h}px"><b>${esc(c.label)}</b></div>`;
    }).join("");
    const bl = items.map((i) => {
      const s = parseDT(i.start), e = parseDT(i.end || i.start);
      const h = Math.max(top(e) - top(s), 22);
      return `<button class="tl-block ${i.kind}" data-edit="${i.id}" style="--c:${i.colour || "var(--accent)"};top:${top(s)}px;height:${h}px">
        <b>${esc(i.title)}</b>${h > 30 ? `<small>${hm(i.start)}–${hm(i.end)}${i.course_code ? " · " + i.course_code : ""}</small>` : ""}</button>`;
    }).join("");
    const now = new Date();
    const nowLine = isToday && now.getHours() >= DAY_START && now.getHours() < DAY_END ? `<div class="tl-now" style="top:${top(now)}px"></div>` : "";
    return `<div class="timeline"><div class="tl-grid">${hours}${fx}${bl}${nowLine}</div></div>`;
  }

  function rows(list) {
    if (!list.length) return `<div class="empty">No tasks for this day.</div>`;
    return `<ul class="rows">${list.map((i) => `
      <li class="row ${i.status === "done" ? "is-done" : ""}">
        <button class="check ${i.status === "done" ? "done" : ""}" data-toggle="${i.id}" aria-label="Mark done">✓</button>
        <button class="t" data-edit="${i.id}"><strong>${esc(i.title)}</strong><span>${esc(itemMeta(i))}</span></button>
        <span class="chip ${i.due && daysUntil(i.due) < 0 ? "overdue" : ""}" style="--c:${i.colour || "var(--accent)"}">${i.kind}</span>
      </li>`).join("")}</ul>`;
  }

  // ---------------------------------------------------------------- week
  async function renderWeek() {
    const mon = mondayOf(state.cursor);
    setHeader(`Week of ${fmtShort(mon)}`, `${fmtShort(mon)} – ${fmtShort(addDays(mon, 6))}`);
    const data = await api("GET", `/api/week/${iso(mon)}`);
    const prop = state.proposal && state.proposal.monday === iso(mon) ? state.proposal.proposed : [];

    const progress = data.progress.map((p) => {
      const extra = prop.filter((x) => x.course_code === p.code).reduce((a, x) => a + (parseDT(x.end) - parseDT(x.start)) / 36e5, 0);
      const pct = Math.min(100, ((p.scheduled + extra) / (p.target || 1)) * 100);
      return `<div class="prog-row" style="--c:${p.colour}"><code>${p.code}</code><div class="bar"><i style="width:${pct}%"></i></div>
        <span class="n">${(p.scheduled + extra).toFixed(1)}/${p.target}h</span></div>`;
    }).join("");

    const span = DAY_END - DAY_START;
    const pos = (s, e) => { const a = Math.max(0, (s.getHours() + s.getMinutes() / 60 - DAY_START) / span * 100);
      const b = Math.min(100, (e.getHours() + e.getMinutes() / 60 - DAY_START) / span * 100); return `left:${a}%;width:${Math.max(b - a, 0.8)}%`; };

    let days = "";
    for (let n = 0; n < 7; n++) {
      const d = addDays(mon, n), key = iso(d);
      const its = data.items.filter((i) => (i.start || i.due || "").slice(0, 10) === key);
      const pp = prop.filter((x) => x.start.slice(0, 10) === key);
      const dayInfo = (data.days && data.days[key]) || { fixed: data.constraints.filter((c) => c.weekdays.includes(n)), off: [] };
      const dayCons = dayInfo.fixed;
      const offChip = dayInfo.off.length ? `<span class="off-chip off-${dayInfo.off[0].kind}">${esc(dayInfo.off[0].label)}</span>` : "";
      const fx = dayCons.filter((c) => c.kind === "busy" || c.kind === "class")
        .map((c) => `<i class="${c.kind === "class" ? "cl" : "fx"}" style="--c:${c.colour || "var(--accent)"};${pos(parseDT(key + "T" + c.start_time), parseDT(key + "T" + c.end_time))}"></i>`).join("");
      const classes = dayCons.filter((c) => c.kind === "class").sort((a, b) => a.start_time.localeCompare(b.start_time));
      const classLine = classes.length ? `<div class="class-line">${classes.map((c) => `<span class="chip" style="--c:${c.colour}">${c.start_time.slice(0, 2)} ${esc(c.label)}</span>`).join("")}</div>` : "";
      const strip = its.filter((i) => i.start).map((i) => `<i style="--c:${i.colour || "var(--accent)"};${pos(parseDT(i.start), parseDT(i.end || i.start))}"></i>`).join("")
        + pp.map((x) => `<i class="pp" style="--c:${courseColour(x.course_code)};${pos(parseDT(x.start), parseDT(x.end))}"></i>`).join("");
      const list = its.map((i) => `<li data-edit="${i.id}" class="${i.status === "done" ? "is-done" : ""}"><span class="dot" style="--c:${i.colour || "var(--accent)"}"></span>
          <time>${i.start ? hm(i.start) : "—"}</time><span>${esc(i.title)}</span></li>`).join("")
        + pp.map((x) => `<li class="pp"><span class="dot" style="--c:${courseColour(x.course_code)}"></span><time>${hm(x.start)}</time><span>${esc(x.title)} (proposed)</span></li>`).join("");
      days += `<div class="wday ${key === iso(new Date()) ? "today" : ""}">
        <div class="wday-head"><b>${DAYS[n]} ${d.getDate()} ${offChip}</b><span>${classes.length ? classes.length + " class" + (classes.length > 1 ? "es · " : " · ") : ""}${its.length} item${its.length === 1 ? "" : "s"}</span></div>
        <div><div class="strip">${fx}${strip}</div><div class="strip-scale"><span>07</span><span>12</span><span>17</span><span>22</span></div></div>
        ${classLine}
        ${list ? `<ul>${list}</ul>` : ""}</div>`;
    }

    const proposalBox = state.proposal && state.proposal.monday === iso(mon) ? `
      <div class="proposal">
        <div>${prop.length ? `${prop.length} study blocks proposed (dashed below).` : "No free time found for more study."}
          ${Object.keys(state.proposal.unmet_hours || {}).length ? `<br>Still short: ${Object.entries(state.proposal.unmet_hours).map(([k, v]) => `${k} ${v}h`).join(", ")}` : ""}</div>
        <div class="btn-row">${prop.length ? `<button class="btn primary" id="apply-plan">Add to week</button>` : ""}<button class="btn" id="discard-plan">Discard</button></div>
      </div>` : "";

    view.innerHTML = `
      <section><h2>Study hours vs target ${badge}</h2><div class="progress">${progress}</div></section>
      <section><div class="btn-row"><button class="btn primary" id="plan-week">Plan my study</button></div>${proposalBox}</section>
      <section><h2>Days</h2><div class="week-days">${days}</div></section>`;
  }

  const courseColour = (code) => (state.courses.find((c) => c.code === code) || {}).colour || "var(--accent)";

  // ---------------------------------------------------------------- plan
  async function renderPlan() {
    setHeader("Education plan", "Modules, timetable and goals");
    const [plan, cons] = await Promise.all([api("GET", "/api/plan"), api("GET", "/api/constraints")]);
    const courses = plan.courses.map((c) => `
      <div class="course" style="--c:${c.colour}">
        <div class="nm"><code>${c.code}</code><div>${esc(c.name)} · ${c.hours_this_week}h planned this week</div></div>
        <div class="stepper"><button data-target="${c.id}" data-delta="-0.5" aria-label="Less">−</button>${c.weekly_target_hours}h<button data-target="${c.id}" data-delta="0.5" aria-label="More">+</button></div>
        <div class="bar"><i style="width:${Math.min(100, c.hours_this_week / (c.weekly_target_hours || 1) * 100)}%"></i></div>
      </div>`).join("");
    const goals = plan.goals.map((g) => `
      <div class="goal"><h3>${esc(g.title)}${g.target_date ? `<small>by ${fmtShort(parseD(g.target_date))}</small>` : ""}</h3>
        ${g.milestones.map((m) => `<div class="ms ${m.done ? "is-done" : ""}"><button class="check ${m.done ? "done" : ""}" data-ms="${m.id}" data-done="${m.done}" aria-label="Toggle milestone">✓</button>
          <strong style="font-weight:500">${esc(m.title)}</strong><time>${m.due ? fmtShort(parseD(m.due)) : ""}</time></div>`).join("") || `<div class="empty">No milestones yet.</div>`}
      </div>`).join("");
    const tt = [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const cl = cons.filter((c) => c.kind === "class" && c.weekdays.includes(d)).sort((a, b) => a.start_time.localeCompare(b.start_time));
      if (!cl.length) return "";
      return `<div class="tt-day"><b>${DAYS[d]}</b><div>${cl.map((c) => `<div class="tt-row ${c.note.startsWith("CHECK") ? "check-me" : ""}" style="--c:${c.colour}">
        <time>${c.start_time}–${c.end_time}</time><code>${esc(c.label)}</code><span>${esc(c.room)}${c.note ? ` · ${esc(c.note)}` : ""}</span></div>`).join("")}</div></div>`;
    }).join("");
    const fixed = cons.filter((c) => c.kind !== "class").map((c) => `<div><span>${esc(c.label)}${c.kind === "preferred_study" ? " (study window)" : ""}${c.term_only ? " (term time)" : ""}</span>
      <span>${c.weekdays.map((w) => DAYS[w]).join(" ")} · ${c.start_time}–${c.end_time}</span></div>`).join("");

    view.innerHTML = `
      <section><h2>Modules · weekly study target ${badge}</h2><div style="display:grid;gap:8px">${courses}</div></section>
      <section><h2>Deadlines · next 4 weeks</h2>${rows(plan.deadlines_next_4_weeks)}</section>
      <section><h2>Goals & milestones</h2><div style="display:grid;gap:8px">${goals}</div></section>
      <section><h2>Key dates</h2>${(plan.calendar || []).length ? `<div class="fixed-list">${plan.calendar.map((c) =>
        `<div><span>${esc(c.label)}</span><span>${fmtShort(parseD(c.start))}${c.end !== c.start ? " – " + fmtShort(parseD(c.end)) : ""}</span></div>`).join("")}</div>` : `<div class="empty">No calendar dates added.</div>`}</section>
      <section><h2>Timetable</h2><div class="tt">${tt || `<div class="empty">No classes yet.</div>`}</div></section>
      <section><h2>Study windows & other fixed time</h2><div class="fixed-list">${fixed}</div></section>`;
  }

  // ---------------------------------------------------------------- to-do list
  const TODO_VIEWS = [["open", "Open"], ["done", "Done"], ["archived", "Archive"]];
  const PRIO = { 1: "High", 2: "Medium", 3: "Low", 4: "None" };
  const dayGap = (from, to) => Math.round((parseD(to) - parseD(from)) / 864e5);
  // Days open (since start) and days to closure (until due), measured from `onDay` (defaults to today)
  function todoTiming(t, onDay) {
    const ref = onDay || iso(new Date());
    const start = t.start_date || (t.created || ref).slice(0, 10);
    const bits = [];
    const opened = dayGap(start, ref);
    bits.push(opened < 0 ? `<span class="tm">Starts ${fmtShort(parseD(start))}</span>` : `<span class="tm">Open ${opened === 0 ? "today" : opened + "d"}</span>`);
    if (t.due) {
      const left = dayGap(ref, t.due);
      const cls = left < 0 ? "overdue" : left === 0 ? "today" : left <= 2 ? "soon" : "";
      const txt = left < 0 ? `${-left}d overdue` : left === 0 ? "Due today" : `Due in ${left}d`;
      bits.push(`<span class="tm due ${cls}" title="Due ${fmtShort(parseD(t.due))}">${txt}</span>`);
    } else bits.push(`<span class="tm muted">No due date</span>`);
    return bits.join("");
  }
  function todoRow(t, onDay) {
    if (t.status === "open") return `
      <li class="row todo prio-${t.priority || 4}">
        <button class="check" data-tdone="${t.id}" aria-label="Close “${esc(t.title)}”"></button>
        <button class="t" data-tedit="${t.id}"><strong>${esc(t.title)}</strong>
          <span class="tmeta">${(t.priority || 4) < 4 ? `<span class="pchip">${PRIO[t.priority]}</span>` : ""}${todoTiming(t, onDay)}</span>${
          t.notes ? `<span class="tnote">${esc(t.notes.slice(0, 80))}</span>` : ""}</button>
      </li>`;
    const closed = t.done_at ? fmtShort(parseD(t.done_at)) : "";
    const meta = t.archived_at ? `Closed ${closed} · archived ${fmtShort(parseD(t.archived_at))}`
      : `Closed ${closed}${t.archives_on ? ` · archives ${fmtShort(parseD(t.archives_on))}` : ""}`;
    return `
      <li class="row todo is-done">
        <button class="check done" data-treopen="${t.id}" aria-label="Reopen “${esc(t.title)}”">✓</button>
        <div class="t"><strong>${esc(t.title)}</strong><span>${meta}</span>${t.done_comment ? `<em class="comment">“${esc(t.done_comment)}”</em>` : ""}</div>
        <div class="todo-actions">${t.archived_at
          ? `<button class="mini" data-tunarch="${t.id}">Restore</button><button class="mini danger" data-tdel="${t.id}">Delete</button>`
          : `<button class="mini" data-tcomment="${t.id}">${t.done_comment ? "Edit note" : "Comment"}</button><button class="mini" data-tarch="${t.id}">Archive</button>`}</div>
      </li>`;
  }

  async function renderTodo() {
    const v = state.todoView || "open";
    const data = await api("GET", `/api/todos?view=${v}`);
    state.todos = data.todos;
    setHeader("To-do", `${data.counts.open} open · closed items archive after ${data.archive_after_days} days`);
    const seg = TODO_VIEWS.map(([k, l]) => `<button data-tview="${k}" aria-pressed="${k === v}">${l} <b>${data.counts[k]}</b></button>`).join("");
    const empty = { open: "All clear. Add something above, or tell Claude “remind me to…”.", done: "Nothing closed in the last few days.", archived: "The archive is empty." }[v];
    view.innerHTML = `
      <section>
        <form class="todo-add" id="todo-add" autocomplete="off">
          <input id="todo-new" placeholder="Add a to-do…" aria-label="New to-do" maxlength="300">
          <div class="todo-add-row">
            <label class="todo-due">Start <input type="date" id="todo-start" value="${iso(new Date())}" aria-label="Start date"></label>
            <label class="todo-due">Due <input type="date" id="todo-due" aria-label="Due date (optional)"></label>
          </div>
          <div class="todo-add-row">
            <div class="prio-pick" role="radiogroup" aria-label="Priority">${[1, 2, 3, 4].map((p) =>
              `<label class="prio-${p}"><input type="radio" name="todo-prio" value="${p}" ${p === 4 ? "checked" : ""}>${PRIO[p]}</label>`).join("")}</div>
            <button class="btn primary" type="submit">Add</button>
          </div>
        </form>
      </section>
      <div class="seg" role="tablist">${seg}</div>
      <section>${data.todos.length ? `<ul class="rows todo-list">${data.todos.map((t) => todoRow(t)).join("")}</ul>` : `<div class="empty">${empty}</div>`}</section>`;
    $("#todo-add").addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = $("#todo-new").value.trim(); if (!title) return $("#todo-new").focus();
      try {
        await api("POST", "/api/todos", { title, start_date: $("#todo-start").value || null, due: $("#todo-due").value || null,
          priority: Number((document.querySelector("input[name=todo-prio]:checked") || {}).value || 4) });
      } catch (err) { return snack(err.message); }
      state.todoView = "open"; await render(); $("#todo-new").focus();
    });
  }

  async function findTodo(id) {
    const hit = (state.todos || []).find((t) => t.id === id);
    if (hit) return hit;
    for (const v of ["open", "done", "archived"]) {
      const d = await api("GET", `/api/todos?view=${v}`); const t = d.todos.find((x) => x.id === id); if (t) return t;
    }
  }

  async function todoClick(e) {
    const t = e.target.closest("[data-tdone],[data-treopen],[data-tedit],[data-tcomment],[data-tarch],[data-tunarch],[data-tdel],[data-tview],[data-goto]");
    if (!t) return false;
    const id = Number(t.dataset.tdone || t.dataset.treopen || t.dataset.tedit || t.dataset.tcomment || t.dataset.tarch || t.dataset.tunarch || t.dataset.tdel);
    if (t.dataset.goto) { state.view = t.dataset.goto; state.todoView = "open"; await render(); return true; }
    if (t.dataset.tview) { state.todoView = t.dataset.tview; await render(); return true; }
    if (t.dataset.tdone) {
      const done = await api("PATCH", `/api/todos/${id}`, { action: "complete" });
      await render();
      snack(`Closed “${done.title}”`, [
        ["Add comment", () => openCommentSheet(done)],
        ["Undo", async () => { await api("PATCH", `/api/todos/${id}`, { action: "reopen" }); render(); }],
      ]);
      return true;
    }
    if (t.dataset.treopen) { await api("PATCH", `/api/todos/${id}`, { action: "reopen" }); await render(); snack("Reopened"); return true; }
    if (t.dataset.tarch) { await api("PATCH", `/api/todos/${id}`, { action: "archive" }); await render(); return true; }
    if (t.dataset.tunarch) { await api("PATCH", `/api/todos/${id}`, { action: "unarchive" }); await render(); snack("Restored to Done"); return true; }
    if (t.dataset.tcomment) { openCommentSheet(await findTodo(id)); return true; }
    if (t.dataset.tdel) { await deleteTodo(id); return true; }
    if (t.dataset.tedit) { openTodoSheet(await findTodo(id)); return true; }
    return false;
  }

  async function deleteTodo(id) {
    const res = await api("DELETE", `/api/todos/${id}`);
    closeSheet(); await render();
    snack(`Deleted “${res.deleted.title}”`, [["Undo", async () => { await api("POST", "/api/todos", { restore: res.deleted }); render(); }]]);
  }

  function openCommentSheet(t) {
    sheet.innerHTML = `<form class="sheet" id="comment-form">
      <h3>Closing note</h3>
      <div class="sheet-sub">${esc(t.title)}</div>
      <label class="field">What happened? (optional)<textarea id="f-comment" rows="3" maxlength="2000">${esc(t.done_comment || "")}</textarea></label>
      <div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div>
    </form>`;
    sheet.hidden = false; $("#f-comment").focus();
    $("#comment-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      await api("PATCH", `/api/todos/${t.id}`, { action: "complete", comment: $("#f-comment").value });
      closeSheet(); render();
    });
  }

  function openTodoSheet(t) {
    sheet.innerHTML = `<form class="sheet" id="todo-form">
      <h3>Edit to-do</h3>
      <label class="field">Title<input id="ft-title" required maxlength="300" value="${esc(t.title)}"></label>
      <div class="grid2">
        <label class="field">Start<input type="date" id="ft-start" value="${t.start_date || ""}"></label>
        <label class="field">Due<input type="date" id="ft-due" value="${t.due || ""}"></label>
      </div>
      <label class="field">Priority<select id="ft-priority">${[1, 2, 3, 4].map((p) =>
        `<option value="${p}" ${(t.priority || 4) === p ? "selected" : ""}>${PRIO[p]}</option>`).join("")}</select></label>
      <label class="field">Notes<textarea id="ft-notes" rows="3">${esc(t.notes || "")}</textarea></label>
      <div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button>
        <button class="btn" type="button" id="ft-close">Close with note…</button><button class="btn danger" type="button" id="ft-del">Delete</button></div>
    </form>`;
    sheet.hidden = false; $("#ft-title").focus();
    $("#todo-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("PATCH", `/api/todos/${t.id}`, { title: $("#ft-title").value, start_date: $("#ft-start").value || null,
          due: $("#ft-due").value || null, priority: Number($("#ft-priority").value), notes: $("#ft-notes").value });
      } catch (err) { return snack(err.message); }
      closeSheet(); render();
    });
    $("#ft-close").onclick = () => openCommentSheet(t);
    $("#ft-del").onclick = () => deleteTodo(t.id);
  }

  // ---------------------------------------------------------------- lecture notes
  const lecKey = (l) => `${l.course_code}|${l.date}|${l.start}`;
  const nowHM = () => { const n = new Date(); return `${pad(n.getHours())}:${pad(n.getMinutes())}`; };
  const fmtLecDay = (s) => parseD(s).toLocaleDateString("en-IE", { weekday: "short", day: "numeric", month: "short" });
  const lecTitle = (l) => `${l.course_code} · ${l.label || (l.number ? "Lecture " + l.number : "Extra lecture")}`;
  const lecShort = (l) => l.short || (l.number ? "L" + l.number : "+");

  async function renderNotes() {
    const courses = state.courses.filter((c) => c.active !== false);
    if (!state.notesCourse || !courses.find((c) => c.code === state.notesCourse)) {
      try { state.notesCourse = localStorage.getItem("planner.notesCourse"); } catch (e) { /* ignore */ }
      if (!courses.find((c) => c.code === state.notesCourse)) state.notesCourse = (courses[0] || {}).code;
    }
    const code = state.notesCourse, mode = state.notesMode || "lectures";
    try { localStorage.setItem("planner.notesCourse", code); } catch (e) { /* ignore */ }
    const course = courses.find((c) => c.code === code) || {};
    setHeader("Lecture notes", course.name ? `${code} ${course.name}` : "Notes for each lecture, by module");
    const pick = `<div class="course-pick" role="tablist">${courses.map((c) =>
      `<button data-ncourse="${esc(c.code)}" aria-pressed="${c.code === code}" style="--c:${c.colour}">${esc(c.code)}</button>`).join("")}</div>`;
    const seg = `<div class="seg"><button data-nmode="lectures" aria-pressed="${mode === "lectures"}">Lectures</button>
      <button data-nmode="topics" aria-pressed="${mode === "topics"}">Topics</button>
      <button data-nmode="compiled" aria-pressed="${mode === "compiled"}">Semester</button></div>`;
    if (!code) { view.innerHTML = `<div class="empty">No modules yet.</div>`; return; }

    if (mode === "compiled") {
      const data = await api("GET", `/api/notes/${encodeURIComponent(code)}/compiled`);
      state.compiled = data;
      view.innerHTML = `<section>${pick}</section>${seg}
        <section><h2>${data.counts.with_notes} of ${data.counts.held} lectures noted
          <span class="btn-row"><button class="link" id="n-copy">Copy</button><button class="link" id="n-dl">Download .md</button></span></h2>
          <article class="compiled">${mdToHtml(data.markdown)}</article></section>`;
      return;
    }
    const data = await api("GET", `/api/notes/${encodeURIComponent(code)}`);
    state.lectures = data.lectures;
    if (mode === "topics") {
      view.innerHTML = `<section>${pick}</section>${seg}
        <section><input class="topic-search" id="n-search" type="search" placeholder="Search ${esc(code)} notes…" value="${esc(state.topicQuery || "")}" aria-label="Search notes"></section>
        <div id="topic-list"></div>`;
      renderTopicList();
      $("#n-search").addEventListener("input", (e) => { state.topicQuery = e.target.value; renderTopicList(); });
      return;
    }
    const today = iso(new Date()), hmNow = nowHM();
    const held = data.lectures.filter((l) => l.date < today || (l.date === today && l.start <= addMin(hmNow, 60)));
    const upcoming = data.lectures.filter((l) => !held.includes(l)).slice(0, 3);
    const row = (l) => {
      const isNow = l.date === today && addMin(l.start, -30) <= hmNow && hmNow < (l.end || "23:59");
      const future = !held.includes(l);
      const n = l.note || {};
      const sub = n.topic ? esc(n.topic) : (n.body ? esc(n.body.split("\n")[0].slice(0, 70)) : (future ? "Upcoming" : "No notes yet"));
      return `<li><button class="lec ${l.has_notes ? "has" : ""} ${isNow ? "now" : ""} ${future ? "future" : ""}" data-lec="${esc(lecKey(l))}">
        <span class="num">${esc(lecShort(l))}</span>
        <span class="t"><strong>${fmtLecDay(l.date)} · ${l.start}${l.end ? "–" + l.end : ""}${l.room ? " · " + esc(l.room) : ""}</strong><span>${sub}</span></span>
        <span class="state">${isNow ? "now" : l.has_notes ? "noted" : future ? "soon" : "empty"}</span></button></li>`;
    };
    view.innerHTML = `<section>${pick}</section>${seg}
      <section><h2>${data.counts.with_notes} of ${data.counts.held} held lectures have notes
        <button class="link" data-nmode="compiled">Semester notes ›</button></h2>
        ${held.length ? `<ul class="lec-list">${held.slice().reverse().map(row).join("")}</ul>` : `<div class="empty">No lectures held yet.</div>`}</section>
      ${upcoming.length ? `<section><h2>Coming up</h2><ul class="lec-list">${upcoming.map(row).join("")}</ul></section>` : ""}
      <section><div class="btn-row"><button class="btn primary" id="n-past">+ Add notes to a past lecture</button>
        <button class="btn" id="n-extra">+ Extra lecture</button></div></section>`;
  }

  // Topics: every noted lecture grouped by topic ("Week 4 Lecture 1 - Linked lists" groups under "Linked lists")
  const topicName = (t) => String(t || "").replace(/^\s*(?:w(?:ee)?k\s*\d+\s*[,·/-]?\s*)?(?:lec(?:ture)?|l)\s*\d+\s*[-–—:·]?\s*/i, "")
    .replace(/^\s*w(?:ee)?k\s*\d+\s*[-–—:·]\s*/i, "").trim();
  function topicGroups(list, query) {
    const q = (query || "").trim().toLowerCase();
    const noted = list.filter((l) => l.has_notes && (!q || [l.note.topic, l.note.body, l.note.follow_up].join("\n").toLowerCase().includes(q)));
    const groups = new Map();
    for (const l of noted) {
      const name = topicName(l.note.topic) || "No topic";
      const k = name.toLowerCase();
      if (!groups.has(k)) groups.set(k, { name, items: [] });
      groups.get(k).items.push(l);
    }
    return [...groups.values()];
  }
  function renderTopicList() {
    const el = $("#topic-list"); if (!el) return;
    const groups = topicGroups(state.lectures || [], state.topicQuery);
    state.readerList = groups.flatMap((g) => g.items);
    if (!groups.length) { el.innerHTML = `<div class="empty">${state.topicQuery ? "No notes match that search." : "No notes yet. Add some from the Lectures list."}</div>`; return; }
    const q = (state.topicQuery || "").trim().toLowerCase();
    const snippet = (l) => {
      const text = [l.note.body, l.note.follow_up].join("\n").replace(/\s+/g, " ").trim();
      if (!q) return esc(text.slice(0, 110));
      const i = text.toLowerCase().indexOf(q); if (i < 0) return esc(text.slice(0, 110));
      const a = Math.max(0, i - 40);
      return (a ? "…" : "") + esc(text.slice(a, i)) + `<mark>${esc(text.slice(i, i + q.length))}</mark>` + esc(text.slice(i + q.length, i + q.length + 70));
    };
    el.innerHTML = groups.map((g) => `<section class="topic-group"><h2>${esc(g.name)} <span class="notes-stat">${g.items.length} entr${g.items.length === 1 ? "y" : "ies"}</span></h2>
      <ul class="lec-list">${g.items.map((l) => `<li><button class="lec has" data-read="${esc(lecKey(l))}">
        <span class="num">${esc(lecShort(l))}</span>
        <span class="t"><strong>${fmtLecDay(l.date)} · ${l.start}${l.note.topic && topicName(l.note.topic) !== l.note.topic ? " · " + esc(l.note.topic) : ""}</strong><span>${snippet(l)}</span></span>
        <span class="state">read</span></button></li>`).join("")}</ul></section>`).join("");
  }

  // Read one entry, with ‹ › to step through the entries in the current list
  function openNoteReader(k) {
    const list = state.readerList && state.readerList.some((x) => lecKey(x) === k) ? state.readerList : (state.lectures || []).filter((x) => x.has_notes);
    const i = list.findIndex((x) => lecKey(x) === k); const l = list[i]; if (!l) return;
    const n = l.note;
    sheet.innerHTML = `<div class="sheet reader" style="--c:${l.colour}">
      <div class="reader-nav"><button class="icon-btn" data-rstep="${i - 1}" ${i > 0 ? "" : "disabled"} aria-label="Previous entry">‹</button>
        <span class="notes-stat">${i + 1} of ${list.length}</span>
        <button class="icon-btn" data-rstep="${i + 1}" ${i < list.length - 1 ? "" : "disabled"} aria-label="Next entry">›</button></div>
      <h3>${esc(n.topic || lecTitle(l))}</h3>
      <div class="sheet-sub">${esc(lecTitle(l))} · ${fmtLong(parseD(l.date))} · ${l.start}${l.end ? "–" + l.end : ""}${l.room ? " · " + esc(l.room) : ""}</div>
      ${n.body ? `<div class="reader-body">${esc(n.body)}</div>` : ""}
      ${n.follow_up ? `<div class="reader-follow"><b>Follow up</b><div>${esc(n.follow_up)}</div></div>` : ""}
      <div class="btn-row"><button class="btn primary" type="button" id="r-edit">Edit</button><button class="btn" type="button" data-close>Close</button></div>
    </div>`;
    sheet.hidden = false;
    sheet.querySelectorAll("[data-rstep]").forEach((b) => { b.onclick = () => openNoteReader(lecKey(list[Number(b.dataset.rstep)])); });
    $("#r-edit").onclick = () => openLectureSheet(l.course_code, l.date, l.start);
  }

  // Pick any held lecture (newest first) to back-fill notes
  function openPastPicker() {
    const today = iso(new Date());
    const held = (state.lectures || []).filter((l) => l.date <= today).slice().reverse();
    if (!held.length) return snack("No lectures held yet for this module.");
    const firstEmpty = [...held].reverse().find((l) => !l.has_notes) || held[0];  // oldest gap first
    sheet.innerHTML = `<form class="sheet" id="past-form">
      <h3>Add notes to a past lecture · ${esc(state.notesCourse)}</h3>
      <div class="sheet-sub">${held.filter((l) => !l.has_notes).length} of ${held.length} held lectures have no notes yet.</div>
      <label class="field">Lecture<select id="fp-lec">${held.map((l) => `<option value="${esc(lecKey(l))}" ${l === firstEmpty ? "selected" : ""}>${
        esc(l.label || lecShort(l))} · ${fmtLecDay(l.date)} ${l.start}${l.has_notes ? " · " + (l.note.topic || "has notes").slice(0, 40) : " · empty"}</option>`).join("")}</select></label>
      <div class="btn-row"><button class="btn primary" type="submit">Open notes</button><button class="btn" type="button" data-close>Cancel</button></div>
    </form>`;
    sheet.hidden = false;
    $("#past-form").addEventListener("submit", (e) => { e.preventDefault(); const [c, d, st] = $("#fp-lec").value.split("|"); openLectureSheet(c, d, st); });
  }
  const addMin = (h, m) => { const [a, b] = h.split(":").map(Number); const t = Math.max(0, Math.min(1439, a * 60 + b + m)); return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };

  // tiny Markdown renderer for the compiled notes (headings, lists, bold; everything escaped first)
  function mdToHtml(md) {
    const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    let html = "", list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    let para = [];
    const flush = () => { if (para.length) { html += `<p>${para.map(inline).join("\n")}</p>`; para = []; } };
    for (const line of md.split("\n")) {
      let m;
      if ((m = line.match(/^(#{1,2}) (.*)/))) { flush(); close(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
      else if ((m = line.match(/^- (.*)/))) { flush(); if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^\d+\. (.*)/))) { flush(); if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
      else if (!line.trim()) { flush(); close(); }
      else { close(); para.push(line); }
    }
    flush(); close();
    return html;
  }

  async function notesClick(e) {
    const t = e.target.closest("[data-ncourse],[data-nmode],[data-lec],[data-read],[data-lcode],#n-copy,#n-dl,#n-extra,#n-past");
    if (!t) return false;
    if (t.dataset.ncourse) { state.notesCourse = t.dataset.ncourse; await render(); return true; }
    if (t.dataset.nmode) { state.notesMode = t.dataset.nmode; await render(); return true; }
    if (t.dataset.lec) {
      const l = (state.lectures || []).find((x) => lecKey(x) === t.dataset.lec);
      if (l && l.has_notes && !(l.date === iso(new Date()))) { state.readerList = null; openNoteReader(t.dataset.lec); return true; }
      const [c, d, s] = t.dataset.lec.split("|"); openLectureSheet(c, d, s); return true;
    }
    if (t.dataset.read) { openNoteReader(t.dataset.read); return true; }
    if (t.id === "n-past") { openPastPicker(); return true; }
    if (t.dataset.lcode) { openLectureSheet(t.dataset.lcode, t.dataset.ldate, t.dataset.lstart); return true; }
    if (t.id === "n-copy") {
      try { await navigator.clipboard.writeText(state.compiled.markdown); snack("Copied the semester notes"); } catch (err) { snack("Couldn't copy here"); }
      return true;
    }
    if (t.id === "n-dl") {
      const url = URL.createObjectURL(new Blob([state.compiled.markdown], { type: "text/markdown" }));
      const a = document.createElement("a"); a.href = url; a.download = `${state.compiled.course.code}-notes.md`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
    if (t.id === "n-extra") { openExtraLectureSheet(); return true; }
    return false;
  }

  function openExtraLectureSheet() {
    const code = state.notesCourse;
    sheet.innerHTML = `<form class="sheet" id="extra-form">
      <h3>Extra lecture · ${esc(code)}</h3>
      <div class="sheet-sub">For a make-up or rescheduled lecture that isn't on the timetable.</div>
      <div class="grid2"><label class="field">Date<input type="date" id="fx-date" value="${iso(new Date())}" required></label>
        <label class="field">Start<input type="time" id="fx-start" value="${nowHM().slice(0, 3)}00" required></label></div>
      <div class="btn-row"><button class="btn primary" type="submit">Open notes</button><button class="btn" type="button" data-close>Cancel</button></div>
      <div id="fx-err"></div></form>`;
    sheet.hidden = false;
    $("#extra-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("PUT", `/api/notes/${encodeURIComponent(code)}/lecture`, { date: $("#fx-date").value, start: $("#fx-start").value });
        openLectureSheet(code, $("#fx-date").value, $("#fx-start").value);
      } catch (err) { $("#fx-err").innerHTML = `<div class="confirm">${esc(err.message)}</div>`; }
    });
  }

  // Notes sheet for one lecture. Autosaves as you type; keeps a local draft until the server has it.
  let noteTimer = null;
  const draftKey = (k) => `planner.notedraft.${k}`;
  async function openLectureSheet(code, day, start, auto = false) {
    let l;
    try { l = await api("GET", `/api/notes/${encodeURIComponent(code)}/lecture?date=${day}${start ? "&start=" + start : ""}`); }
    catch (err) { return snack(err.message); }
    const k = lecKey(l), n = l.note || { topic: "", body: "", follow_up: "" };
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(draftKey(k)) || "null"); } catch (e) { /* ignore */ }
    const v = draft || n;
    const prev = (state.lectures || []).filter((x) => x.course_code === l.course_code && x.has_notes && (x.date + x.start) < (l.date + l.start)).pop();
    sheet.innerHTML = `<form class="sheet" id="lec-form" style="--c:${l.colour}">
      <h3>${esc(lecTitle(l))}${auto ? ` <span class="chip" style="--c:${l.colour}">starting soon</span>` : ""}</h3>
      <div class="sheet-sub">${esc(l.course_name)} · ${fmtLong(parseD(l.date))} · ${l.start}${l.end ? "–" + l.end : ""}${l.room ? " · " + esc(l.room) : ""}</div>
      ${prev && prev.note.topic ? `<div class="sheet-sub">Last time: ${esc(prev.note.topic)}</div>` : ""}
      <label class="field">Topic<input id="fl-topic" maxlength="200" placeholder="What's this lecture about?" value="${esc(v.topic)}"></label>
      <label class="field">Notes<textarea id="fl-body" class="notes-body" placeholder="Key points, definitions, examples…">${esc(v.body)}</textarea></label>
      <label class="field">Follow up<textarea id="fl-follow" rows="2" placeholder="Questions to ask, things to revise">${esc(v.follow_up)}</textarea></label>
      <div class="btn-row" style="align-items:center"><button class="btn primary" type="submit">Done</button>
        <span class="save-state" id="fl-state">${draft ? "Unsaved draft restored" : n.updated ? "Saved" : ""}</span></div>
    </form>`;
    sheet.hidden = false;
    state.openLecture = k;
    if (!auto) $("#fl-body").focus();
    const save = async () => {
      clearTimeout(noteTimer);
      const body = { date: l.date, start: l.start, topic: $("#fl-topic").value, body: $("#fl-body").value, follow_up: $("#fl-follow").value };
      const st = $("#fl-state"); if (!st) return true;
      try {
        await api("PUT", `/api/notes/${encodeURIComponent(l.course_code)}/lecture`, body);
        try { localStorage.removeItem(draftKey(k)); } catch (e) { /* ignore */ }
        st.textContent = `Saved ${nowHM()}`; st.classList.remove("err"); return true;
      } catch (err) { st.textContent = "Not saved (offline?) · kept on this device"; st.classList.add("err"); return false; }
    };
    $("#lec-form").addEventListener("input", () => {
      const body = { topic: $("#fl-topic").value, body: $("#fl-body").value, follow_up: $("#fl-follow").value };
      try { localStorage.setItem(draftKey(k), JSON.stringify(body)); } catch (e) { /* ignore */ }
      $("#fl-state").textContent = "Typing…"; clearTimeout(noteTimer); noteTimer = setTimeout(save, 1200);
    });
    $("#fl-body").addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || e.shiftKey) return;
      e.preventDefault(); const ta = e.target, a = ta.selectionStart;
      ta.setRangeText("  ", a, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    $("#lec-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (await save()) { closeSheet(); if (state.view === "notes") render(); }
    });
    if (draft) save();
  }

  // Open the notes sheet by itself LEAD minutes before each lecture (while the app is open or comes back).
  const AUTO_KEY = "planner.autoopened";
  let todaysLectures = { date: null, lectures: [], lead_minutes: 5 };
  async function lectureWatch() {
    if (DEMO && !window.PLANNER_SEED) return;
    const today = iso(new Date());
    try {
      if (todaysLectures.date !== today || todaysLectures.stale) todaysLectures = await api("GET", "/api/notes/today");
    } catch (e) { return; }
    const hmNow = nowHM();
    let opened = {};
    try { opened = JSON.parse(localStorage.getItem(AUTO_KEY) || "{}"); } catch (e) { /* ignore */ }
    for (const k of Object.keys(opened)) if (!k.includes(`|${today}|`)) delete opened[k];
    const due = todaysLectures.lectures.find((l) => addMin(l.start, -todaysLectures.lead_minutes) <= hmNow && hmNow < (l.end || addMin(l.start, 60)) && !opened[lecKey(l)]);
    if (!due || !sheet.hidden || document.visibilityState !== "visible") return;
    opened[lecKey(due)] = true;
    try { localStorage.setItem(AUTO_KEY, JSON.stringify(opened)); } catch (e) { /* ignore */ }
    openLectureSheet(due.course_code, due.date, due.start, true);
  }
  setInterval(lectureWatch, 20000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { todaysLectures.stale = true; lectureWatch(); } });

  // Deep links (from the calendar reminder): /?notes=CS210 opens that module's current or latest lecture;
  // /?notes=CS210&date=2026-10-19&start=09:00 opens one lecture exactly.
  async function openFromLink() {
    const q = new URLSearchParams(location.search);
    const code = q.get("notes"); if (!code) return;
    history.replaceState(null, "", location.pathname);
    state.view = "notes"; state.notesCourse = code.toUpperCase(); state.notesMode = "lectures";
    await render();
    if (q.get("date")) return openLectureSheet(state.notesCourse, q.get("date"), q.get("start"));
    const today = iso(new Date()), hmNow = nowHM(), list = state.lectures || [];
    const pick = list.find((l) => l.date === today && addMin(l.start, -60) <= hmNow && hmNow < addMin(l.end || l.start, 60))
      || list.filter((l) => l.date < today || (l.date === today && l.start <= hmNow)).pop()
      || list.find((l) => l.date >= today);
    if (pick) openLectureSheet(pick.course_code, pick.date, pick.start, pick.date === today);
  }

  // snackbar: short message with optional actions (Undo, Add comment)
  let snackTimer = null;
  function snack(text, actions = [], ms = 7000) {
    const el = $("#snack");
    el.innerHTML = `<span>${esc(text)}</span>${actions.map(([l], i) => `<button data-snack="${i}">${esc(l)}</button>`).join("")}`;
    el.hidden = false;
    el.onclick = async (e) => {
      const b = e.target.closest("button[data-snack]"); if (!b) return;
      el.hidden = true; clearTimeout(snackTimer); await actions[Number(b.dataset.snack)][1]();
    };
    clearTimeout(snackTimer); snackTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- item sheet
  const sheet = $("#sheet");
  const KINDS = ["task", "event", "class", "study", "deadline"];
  function openSheet(item) {
    const isNew = !item.id;
    const day = (item.start || item.due || iso(state.cursor)).slice(0, 10);
    sheet.innerHTML = `<form class="sheet" id="item-form">
      <h3>${isNew ? "New item" : "Edit item"}</h3>
      <div class="kinds">${KINDS.map((k) => `<label><input type="radio" name="kind" value="${k}" ${item.kind === k ? "checked" : ""}>${k}</label>`).join("")}</div>
      <label class="field">Title<input id="f-title" name="title" required value="${esc(item.title || "")}"></label>
      <div class="grid2">
        <label class="field">Date<input id="f-date" type="date" name="date" value="${day}"></label>
        <label class="field">Module<select id="f-course" name="course_code"><option value="">—</option>
          ${state.courses.map((c) => `<option ${item.course_code === c.code ? "selected" : ""}>${c.code}</option>`).join("")}</select></label>
      </div>
      <div class="grid2">
        <label class="field">Start<input id="f-start" type="time" name="start" value="${hm(item.start)}"></label>
        <label class="field">End<input id="f-end" type="time" name="end" value="${hm(item.end)}"></label>
      </div>
      <label class="field">Priority<select id="f-priority" name="priority">
        ${[[1, "1 · must do"], [2, "2 · important"], [3, "3 · normal"], [4, "4 · someday"]].map(([v, l]) => `<option value="${v}" ${(item.priority || 3) === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field">Notes<textarea id="f-notes" name="notes" rows="2">${esc(item.notes || "")}</textarea></label>
      <div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button>
        ${isNew ? "" : `<button class="btn danger" type="button" id="del">Delete</button>`}</div>
      <div id="confirm-slot"></div>
    </form>`;
    sheet.hidden = false;
    $("#f-title").focus();
    $("#item-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const body = { kind: f.get("kind") || "task", title: f.get("title"), priority: Number(f.get("priority")),
        course_code: f.get("course_code") || null, notes: f.get("notes") };
      if (f.get("start")) { body.start = `${f.get("date")}T${f.get("start")}`; if (f.get("end")) body.end = `${f.get("date")}T${f.get("end")}`; }
      else { body.due = f.get("date"); body.start = null; }
      try {
        if (isNew) await api("POST", "/api/items", body); else await api("PATCH", `/api/items/${item.id}`, body);
        closeSheet(); render();
      } catch (e) { $("#confirm-slot").innerHTML = `<div class="confirm">${esc(e.message)}</div>`; }
    });
    const del = $("#del");
    if (del) del.addEventListener("click", () => {
      $("#confirm-slot").innerHTML = `<div class="confirm">Delete “${esc(item.title)}”?<div class="btn-row"><button class="btn danger" type="button" id="del-yes">Delete</button><button class="btn" type="button" id="del-no">Keep</button></div></div>`;
      $("#del-yes").onclick = async () => { await api("DELETE", `/api/items/${item.id}`); closeSheet(); render(); };
      $("#del-no").onclick = () => { $("#confirm-slot").innerHTML = ""; };
    });
  }
  function closeSheet() { sheet.hidden = true; sheet.innerHTML = ""; }
  sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("[data-close]")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });

  // ---------------------------------------------------------------- events
  let lastItems = new Map();
  const _api = api;
  async function findItem(id) {
    const all = await _api("GET", `/api/items?from=${iso(addDays(state.cursor, -60))}&to=${iso(addDays(state.cursor, 90))}`);
    return all.find((i) => i.id === id);
  }

  view.addEventListener("click", async (e) => {
    if (await todoClick(e)) return;
    if (await notesClick(e)) return;
    const t = e.target.closest("[data-toggle],[data-edit],[data-target],[data-ms],#plan-week,#apply-plan,#discard-plan");
    if (!t) return;
    if (t.dataset.toggle) {
      const it = await findItem(Number(t.dataset.toggle));
      await api("PATCH", `/api/items/${it.id}`, { status: it.status === "done" ? "todo" : "done" });
      return render();
    }
    if (t.dataset.edit) return openSheet(await findItem(Number(t.dataset.edit)));
    if (t.dataset.target) {
      const c = state.courses.find((x) => x.id === Number(t.dataset.target));
      c.weekly_target_hours = Math.max(0, c.weekly_target_hours + Number(t.dataset.delta));
      await api("PATCH", `/api/courses/${c.id}`, { weekly_target_hours: c.weekly_target_hours });
      return render();
    }
    if (t.dataset.ms) { await api("PATCH", `/api/milestones/${t.dataset.ms}`, { done: t.dataset.done !== "true" }); return render(); }
    if (t.id === "plan-week") { state.proposal = await api("POST", "/api/plan/week", { monday: iso(mondayOf(state.cursor)), apply: false }); return render(); }
    if (t.id === "apply-plan") { await api("POST", "/api/plan/week", { monday: state.proposal.monday, apply: true }); state.proposal = null; return render(); }
    if (t.id === "discard-plan") { state.proposal = null; return render(); }
  });

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]"); if (!b) return;
    state.view = b.dataset.view; render();
  });
  $("#prev").onclick = () => { state.cursor = addDays(state.cursor, state.view === "week" ? -7 : -1); render(); };
  $("#next").onclick = () => { state.cursor = addDays(state.cursor, state.view === "week" ? 7 : 1); render(); };
  $("#today-btn").onclick = () => { state.cursor = new Date(); render(); };
  $("#add-btn").onclick = () => openSheet({ kind: "task" });

  // ---------------------------------------------------------------- chat
  const log = $("#chat-log");
  const dock = $(".dock"), chatBar = $("#chat-bar");
  const CHAT_H = "planner.chatHeight", CHAT_HIDDEN = "planner.chatHidden";
  const clampH = (h) => Math.max(70, Math.min(Math.round(innerHeight * 0.7), h));
  function setChatH(h) { document.documentElement.style.setProperty("--chat-h", `${clampH(h)}px`); }
  function setChatHidden(on) {
    dock.classList.toggle("chat-hidden", on);
    $("#chat-toggle").textContent = on ? "Show chat" : "Hide";
    $("#chat-toggle").setAttribute("aria-expanded", String(!on));
    try { localStorage.setItem(CHAT_HIDDEN, on ? "1" : ""); } catch (e) { /* ignore */ }
  }
  function updateChatBar() {
    const n = log.children.length;
    chatBar.hidden = n === 0;
    $("#chat-count").textContent = n ? `${Math.ceil(n / 2)} message${n > 2 ? "s" : ""}` : "";
    $("#suggest").hidden = n > 0;  // suggestions only while the chat is empty
  }
  try { const h = Number(localStorage.getItem(CHAT_H)); if (h) setChatH(h); if (localStorage.getItem(CHAT_HIDDEN)) setChatHidden(true); } catch (e) { /* ignore */ }
  // drag the grip up/down to resize the conversation
  $("#chat-grip").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = log.getBoundingClientRect().height || 140;
    if (dock.classList.contains("chat-hidden")) setChatHidden(false);
    const move = (ev) => setChatH(h0 + (y0 - ev.clientY));
    const up = () => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up);
      try { localStorage.setItem(CHAT_H, String(Math.round(log.getBoundingClientRect().height))); } catch (err) { /* ignore */ }
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
  $("#chat-grip").addEventListener("keydown", (e) => {  // keyboard: arrow keys resize
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault(); setChatH(log.getBoundingClientRect().height + (e.key === "ArrowUp" ? 40 : -40));
  });
  $("#chat-toggle").onclick = () => setChatHidden(!dock.classList.contains("chat-hidden"));
  $("#chat-clear").onclick = () => { log.innerHTML = ""; state.history = []; updateChatBar(); };
  // the page keeps clear of the dock whatever its height
  if ("ResizeObserver" in window) new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", `${dock.offsetHeight}px`)).observe(dock);
  function bubble(cls, html) {
    const d = document.createElement("div"); d.className = `msg ${cls}`; d.innerHTML = html; log.appendChild(d);
    if (cls === "me" && dock.classList.contains("chat-hidden")) setChatHidden(false);
    updateChatBar(); log.scrollTop = log.scrollHeight; return d;
  }
  async function send(text) {
    if (!text.trim()) return;
    bubble("me", esc(text));
    const pending = bubble("ai", "…");
    try {
      const res = await api("POST", "/api/chat", { message: text, history: state.history });
      const changed = (res.changes || []).map((c) => c.result || {}).find((r) => r.start || r.due);
      const jumpDay = changed ? (changed.start || changed.due).slice(0, 10) : null;
      const chg = res.changes && res.changes.length ? `<span class="chg">${res.changes.length} change${res.changes.length > 1 ? "s" : ""} saved${
        jumpDay ? ` · <button class="jump" data-day="${jumpDay}">Show ${esc(DAYS[(parseD(jumpDay).getDay() + 6) % 7])} ${fmtShort(parseD(jumpDay))}</button>` : ""}</span>` : "";
      pending.innerHTML = esc(res.reply).replace(/\n/g, "<br>") + chg;
      state.history.push({ role: "user", content: text }, { role: "assistant", content: res.reply });
      state.history = state.history.slice(-10);
      if (res.proposal) state.proposal = res.proposal;
      render();
    } catch (e) { pending.textContent = `Couldn't reach Claude: ${e.message}`; }
  }
  $("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); const i = $("#chat-input"); send(i.value); i.value = ""; });
  log.addEventListener("click", (e) => {
    const b = e.target.closest("button.jump"); if (!b) return;
    state.cursor = parseD(b.dataset.day); state.view = "day"; render();
  });
  $("#suggest").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) send(b.textContent); });

  // ---------------------------------------------------------------- demo backend
  const Demo = !DEMO ? null : (() => {
    const today = parseD(iso(new Date()));
    const at = (n, h, m = 0) => { const d = addDays(today, n); d.setHours(h, m); return isoDT(d); };
    const SEED = window.PLANNER_SEED;
    const courses = SEED.courses.map((c, n) => ({ id: n + 1, active: true, ...c }));
    const codeId = (code) => (courses.find((c) => c.code === code) || {}).id ?? null;
    const colourOf = (code) => (courses.find((c) => c.code === code) || {}).colour || null;
    let cn = 1;
    const constraints = [
      ...SEED.timetable.map((t) => ({ id: cn++, label: t.code, weekdays: [t.weekday], start_time: t.start, end_time: t.end, kind: "class",
        course_code: t.code, colour: colourOf(t.code), room: t.room || "", note: t.note || "" })),
      ...(SEED.study_windows || []).map((w) => ({ id: cn++, label: w.label, weekdays: w.weekdays, start_time: w.start, end_time: w.end, kind: "preferred_study", room: "", note: "" })),
      ...(SEED.busy || []).map((w) => ({ id: cn++, label: w.label, weekdays: w.weekdays, start_time: w.start, end_time: w.end, kind: "busy",
        room: w.room || "", note: "", term_only: !!w.term_only, valid_from: w.valid_from || null, valid_to: w.valid_to || null })),
    ];
    const CAL = SEED.calendar || [], TERM = SEED.term || {};
    const offsOn = (key) => CAL.filter((c) => c.start <= key && (c.end || c.start) >= key).map((c) => ({ ...c, end: c.end || c.start }));
    const activeOn = (c, key) => {
      const wd = (parseD(key).getDay() + 6) % 7;
      if (!c.weekdays.includes(wd)) return false;
      if (c.kind === "class" && ((TERM.start && key < TERM.start) || (TERM.end && key > TERM.end))) return false;
      if ((c.valid_from && key < c.valid_from) || (c.valid_to && key > c.valid_to)) return false;
      if ((c.kind === "class" || c.term_only) && offsOn(key).length) return false;
      return true;
    };
    let mn = 1;
    const goals = (SEED.goals || []).map((g, n) => ({ id: n + 1, title: g.title, target_date: g.target_date,
      milestones: (g.milestones || []).map((m) => ({ id: mn++, goal_id: n + 1, title: m.title, due: m.due, done: false })) }));
    let nextId = 100;
    // example items so the demo isn't empty (marked as examples in the UI badge)
    const ex = SEED.courses.map((c) => c.code);
    const items = [
      { id: 1, kind: "deadline", title: `${ex[1] || ex[0]} assignment 1 (example)`, due: iso(addDays(today, 9)), course_id: codeId(ex[1] || ex[0]), priority: 1 },
      { id: 2, kind: "task", title: "Read lecture notes (example)", due: iso(today), course_id: codeId(ex[0]), priority: 1 },
      { id: 3, kind: "study", title: `Study: ${ex[0]} (example)`, start: at(1, 20, 0), end: at(1, 21, 30), course_id: codeId(ex[0]), priority: 2 },
      { id: 4, kind: "task", title: "Book NCT (example)", due: iso(addDays(today, -2)), priority: 3 },
      { id: 5, kind: "deadline", title: `${ex[2] || ex[0]} problem sheet (example)`, due: iso(addDays(today, 4)), course_id: codeId(ex[2] || ex[0]), priority: 2 },
      { id: 6, kind: "event", title: "Gym (example)", start: at(2, 19, 0), end: at(2, 20, 0), priority: 3 },
    ].map((i) => ({ status: "todo", notes: "", start: null, end: null, due: null, course_id: null, ...i }));

    const dto = (i) => { const c = courses.find((x) => x.id === i.course_id); return { ...i, course_code: c ? c.code : null, colour: c ? c.colour : null }; };
    const dayOf = (i) => (i.start || i.due || "").slice(0, 10);
    const inRange = (i, f, t) => dayOf(i) >= f && dayOf(i) <= t;
    const sorted = (arr) => arr.sort((a, b) => (dayOf(a) + (a.start || "~")).localeCompare(dayOf(b) + (b.start || "~")) || a.priority - b.priority);
    const listItems = (f, t) => sorted(items.filter((i) => inRange(i, f, t))).map(dto);
    const cid = (code) => (code ? (courses.find((c) => c.code.toLowerCase() === String(code).toLowerCase()) || {}).id ?? null : null);

    function busy(key, extra = []) {
      const wd = (parseD(key).getDay() + 6) % 7;
      const b = constraints.filter((c) => (c.kind === "busy" || c.kind === "class") && activeOn(c, key)).map((c) => [parseDT(`${key}T${c.start_time}`), parseDT(`${key}T${c.end_time}`)]);
      items.filter((i) => i.start && dayOf(i) === key && i.status !== "skipped").forEach((i) => b.push([parseDT(i.start), parseDT(i.end)]));
      extra.filter((x) => x.start.slice(0, 10) === key).forEach((x) => b.push([parseDT(x.start), parseDT(x.end)]));
      return b;
    }
    function free(key, minM = 30, extra = []) {
      let w = [[parseDT(`${key}T07:00`), parseDT(`${key}T22:00`)]];
      const buf = 15 * 6e4;
      for (const [s0, e0] of busy(key, extra)) {
        const s = new Date(+s0 - buf), e = new Date(+e0 + buf), out = [];
        for (const [a, b] of w) { if (e <= a || s >= b) { out.push([a, b]); continue; } if (s > a) out.push([a, s]); if (e < b) out.push([e, b]); }
        w = out;
      }
      if (key === iso(new Date())) { const now = new Date(); w = w.map(([a, b]) => [a < now ? now : a, b]).filter(([a, b]) => b > a); }
      return w.filter(([a, b]) => (b - a) / 6e4 >= minM);
    }
    const studyHours = (courseId, monKey) => items.filter((i) => i.course_id === courseId && i.kind === "study" && i.start && i.status !== "skipped"
      && i.start >= monKey && i.start < iso(addDays(parseD(monKey), 7))).reduce((a, i) => a + (parseDT(i.end) - parseDT(i.start)) / 36e5, 0);

    function planWeek(monKey, apply) {
      const placed = [], deficit = {}, perDay = {};
      courses.forEach((c) => { deficit[c.id] = Math.max(0, c.weekly_target_hours - studyHours(c.id, monKey)); });
      const order = courses.filter((c) => deficit[c.id] > 0).sort((a, b) => deficit[b.id] - deficit[a.id]);
      const days = [...Array(7)].map((_, n) => iso(addDays(parseD(monKey), n))).filter((k) => k >= iso(new Date()));
      let progress = true;
      while (progress) {
        progress = false;
        for (const c of order) {
          if (deficit[c.id] <= 0) continue;
          const want = Math.min(90, Math.max(30, deficit[c.id] * 60));
          let slot = null;
          for (const prefer of [true, false]) {
            for (const k of days) {
              if ((perDay[c.id + k] || 0) >= 2 || slot) continue;
              const wd = (parseD(k).getDay() + 6) % 7;
              const pw = constraints.filter((x) => x.kind === "preferred_study" && activeOn(x, k)).map((x) => [parseDT(`${k}T${x.start_time}`), parseDT(`${k}T${x.end_time}`)]);
              for (const [a, b] of free(k, 30, placed)) {
                const cands = prefer ? pw.map(([p, q]) => [a > p ? a : p, b < q ? b : q]).filter(([x, y]) => (y - x) / 6e4 >= 30) : [[a, b]];
                if (cands.length) { const [x, y] = cands[0]; slot = [x, new Date(Math.min(+y, +x + want * 6e4))]; break; }
              }
            }
            if (slot) break;
          }
          if (!slot) continue;
          placed.push({ course_code: c.code, course_id: c.id, title: `Study: ${c.code}`, start: isoDT(slot[0]), end: isoDT(slot[1]) });
          perDay[c.id + isoDT(slot[0]).slice(0, 10)] = (perDay[c.id + isoDT(slot[0]).slice(0, 10)] || 0) + 1;
          deficit[c.id] -= (slot[1] - slot[0]) / 36e5;
          progress = true;
        }
      }
      if (apply) placed.forEach((p) => items.push({ id: nextId++, kind: "study", title: p.title, start: p.start, end: p.end, due: null, course_id: p.course_id, priority: 2, status: "todo", notes: "" }));
      const unmet = {}; courses.forEach((c) => { if (deficit[c.id] > 0.01) unmet[c.code] = Math.round(deficit[c.id] * 100) / 100; });
      return { monday: monKey, proposed: placed, applied: !!apply, unmet_hours: unmet };
    }

    function create(b) {
      const it = { id: nextId++, kind: b.kind || "task", title: b.title, start: b.start || null, end: b.end || null, due: b.start ? null : (b.due || iso(new Date())),
        course_id: cid(b.course_code), priority: b.priority || 3, status: "todo", notes: b.notes || "" };
      if (it.start && !it.end) it.end = isoDT(new Date(+parseDT(it.start) + 36e5));
      items.push(it); return dto(it);
    }
    function update(id, b) {
      const it = items.find((i) => i.id === id); if (!it) throw new Error("not found");
      if ("start" in b) { if (b.start) { const dur = it.start && it.end ? parseDT(it.end) - parseDT(it.start) : 36e5; it.start = b.start; it.end = b.end || isoDT(new Date(+parseDT(b.start) + dur)); it.due = null; } else { it.start = it.end = null; } }
      if ("due" in b && b.due) it.due = b.due;
      if ("course_code" in b) it.course_id = cid(b.course_code);
      ["title", "priority", "status", "notes", "kind"].forEach((k) => { if (b[k] != null) it[k] = b[k]; });
      return dto(it);
    }

    // tiny rule-based stand-in for Claude so the demo chat does something
    const WD = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
    function resolveDay(word) {
      const w = word.toLowerCase();
      if (/^(today|tonight)/.test(w)) return new Date();
      if (/^tom/.test(w)) return addDays(new Date(), 1);
      const n = WD[w.slice(0, 3)]; if (n == null) return null;
      const t = new Date(); let diff = (n - ((t.getDay() + 6) % 7) + 7) % 7; if (diff === 0) diff = 7; return addDays(t, diff);
    }
    const toH = (h, m, ap) => { h = Number(h); m = Number(m || 0); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; if (!ap && h < 8) h += 12; return [h, m]; };
    const DAYRX = "(today|tonight|tomorrow|mon\\w*|tue\\w*|wed\\w*|thu\\w*|fri\\w*|sat\\w*|sun\\w*)";
    const TRX = "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?";
    let lastProposal = null;

    function chat(msg) {
      const m = msg.trim(), low = m.toLowerCase();
      if (/^(yes|apply|ok|go ahead|do it)/.test(low) && lastProposal) {
        const r = planWeek(lastProposal.monday, true); lastProposal = null;
        return { reply: `Added ${r.proposed.length} study blocks to this week.`, changes: r.proposed.map((p) => ({ tool: "create_item", result: p })), proposal: null };
      }
      if (/plan/.test(low) && /(study|week)/.test(low)) {
        const r = planWeek(iso(mondayOf(new Date())), false); lastProposal = r;
        const lines = r.proposed.slice(0, 4).map((p) => `${DAYS[(parseD(p.start).getDay() + 6) % 7]} ${hm(p.start)} ${p.course_code}`).join(", ");
        return { reply: r.proposed.length ? `I'd add ${r.proposed.length} blocks: ${lines}${r.proposed.length > 4 ? "…" : ""}. Shown dashed on Week. Say "yes" to add them.` : "No room left for more study this week.", changes: [], proposal: r };
      }
      if (/(due|deadline)/.test(low)) {
        const ds = items.filter((i) => (i.kind === "deadline" || i.due) && i.status === "todo" && i.due && daysUntil(i.due) <= 14 && daysUntil(i.due) >= 0).sort((a, b) => a.due.localeCompare(b.due));
        return { reply: ds.length ? ds.map((i) => `${fmtShort(parseD(i.due))}: ${i.title}`).join("\n") : "Nothing due in the next two weeks.", changes: [] };
      }
      let r = low.match(new RegExp(`move (.+?) to ${DAYRX}(?:\\s+(?:at\\s+)?${TRX})?`));
      if (r) {
        const q = r[1].replace(/(tonight'?s?|today'?s?|my|the)\s*/g, "").trim();
        const it = items.find((i) => i.start && i.title.toLowerCase().includes(q) && (!/tonight|today/.test(r[1]) || dayOf(i) === iso(new Date())))
          || items.find((i) => i.start && i.title.toLowerCase().includes(q.split(" ")[0]));
        const d = resolveDay(r[2]);
        if (!it || !d) return { reply: `I couldn't find "${q}" with a time on it.`, changes: [] };
        const [h, mi] = r[3] ? toH(r[3], r[4], r[5]) : [Number(it.start.slice(11, 13)), Number(it.start.slice(14, 16))];
        d.setHours(h, mi, 0, 0);
        const out = update(it.id, { start: isoDT(d) });
        return { reply: `Moved "${out.title}" to ${fmtLong(d)} at ${hm(out.start)}.`, changes: [{ tool: "update_item", result: out }] };
      }
      r = m.match(new RegExp(`^(?:add\\s+)?(.+?)\\s+${DAYRX}\\s+(?:at\\s+)?${TRX}(?:\\s*[-–to]+\\s*${TRX})?\\s*$`, "i"));
      if (r) {
        const d = resolveDay(r[2]); const [h, mi] = toH(r[3], r[4], (r[5] || r[8] || "").toLowerCase() || undefined);
        d.setHours(h, mi, 0, 0);
        let end = new Date(+d + 36e5);
        if (r[6]) { const [h2, m2] = toH(r[6], r[7], (r[8] || "").toLowerCase() || undefined); end = new Date(d); end.setHours(h2, m2); }
        const title = r[1].trim(); const code = (title.match(/cs\s?\d{3}/i) || [""])[0].replace(/\s/, "").toUpperCase();
        const kind = /lab|lecture|tutorial|class/i.test(title) ? "class" : /study|revise|revision/i.test(title) ? "study" : "event";
        const out = create({ kind, title: title[0].toUpperCase() + title.slice(1), start: isoDT(d), end: isoDT(end), course_code: code || null });
        return { reply: `Added ${out.kind} "${out.title}" on ${fmtLong(d)}, ${hm(out.start)}–${hm(out.end)}.`, changes: [{ tool: "create_item", result: out }] };
      }
      return { reply: "This demo understands: \"add <thing> <day> <time>\", \"move <item> to <day> <time>\", \"plan my study\" and \"what's due\". The real app sends every message to Claude.", changes: [] };
    }

    let todoId = 100;
    const nowIso = () => isoDT(new Date());
    const todos = [
      { id: 1, title: "Email CS210 lecturer about assignment 1 (example)", due: iso(today), priority: 1, start_date: iso(addDays(today, -3)) },
      { id: 2, title: "Book NCT (example)", due: iso(addDays(today, -2)), priority: 2, start_date: iso(addDays(today, -9)) },
      { id: 3, title: "Buy USB-C hub for lab (example)", due: null, priority: 3, start_date: iso(addDays(today, -1)) },
      { id: 4, title: "Print CityWise worksheets (example)", due: iso(addDays(today, 5)), priority: 4, start_date: iso(addDays(today, 2)) },
      { id: 5, title: "Renew library books (example)", status: "done", done_at: isoDT(addDays(today, -1)), done_comment: "Renewed online until 5 Nov" },
    ].map((t) => ({ notes: "", position: t.id, status: "open", done_at: null, done_comment: "", archived_at: null, created: nowIso(), priority: 4, due: null, start_date: iso(today), ...t }));
    const tdict = (t) => ({ ...t, archives_on: t.status === "done" && !t.archived_at && t.done_at ? iso(addDays(parseD(t.done_at), 3)) : null });
    function demoTodos(method, p, q, b) {
      const m = p.match(/^\/api\/todos\/(\d+)$/); const t = m && todos.find((x) => x.id === Number(m[1]));
      if (method === "GET") {
        const v = q.get("view") || "open", dueBy = q.get("due_by"), activeOn = q.get("active_on");
        let list = todos.filter((x) => v === "open" ? x.status === "open" : v === "done" ? x.status === "done" && !x.archived_at : !!x.archived_at);
        if (v === "open" && dueBy) list = list.filter((x) => x.due && x.due <= dueBy);
        if (v === "open" && activeOn) list = list.filter((x) => !x.start_date || x.start_date <= activeOn);
        list.sort((a, c) => v === "open" ? (a.priority - c.priority) || String(a.due || "9").localeCompare(String(c.due || "9")) : String(c.done_at).localeCompare(String(a.done_at)));
        return { todos: list.map(tdict), archive_after_days: 3, counts: {
          open: todos.filter((x) => x.status === "open").length, done: todos.filter((x) => x.status === "done" && !x.archived_at).length,
          archived: todos.filter((x) => x.archived_at).length } };
      }
      if (method === "POST") {
        const n = b.restore ? { ...b.restore } : { title: b.title, due: b.due || null, priority: [1, 2, 3, 4].includes(b.priority) ? b.priority : 4, notes: b.notes || "", start_date: b.start_date || iso(today),
          status: "open", done_at: null, done_comment: "", archived_at: null, created: nowIso() };
        n.id = todoId++; todos.push(n); return tdict(n);
      }
      if (method === "DELETE") { todos.splice(todos.indexOf(t), 1); return { deleted: tdict(t) }; }
      if (method === "PATCH") {
        if (b.action === "complete") { t.status = "done"; t.done_at = t.done_at || nowIso(); if (b.comment != null) t.done_comment = b.comment; t.archived_at = null; }
        else if (b.action === "reopen") Object.assign(t, { status: "open", done_at: null, done_comment: "", archived_at: null });
        else if (b.action === "archive") t.archived_at = nowIso();
        else if (b.action === "unarchive") { t.archived_at = null; t.done_at = nowIso(); }
        else ["title", "due", "priority", "notes", "start_date"].forEach((k) => { if (k in b) t[k] = b[k]; });
        return tdict(t);
      }
    }

    // lecture notes (demo): sessions from the timetable, merged when back to back, numbered from term start
    const lnotes = {};
    const nCourse = (code) => courses.find((c) => c.code.toLowerCase() === String(code).toLowerCase());
    function sessionsOn(key, code) {
      const out = [];
      for (const c of courses) {
        if (code && c.code !== code) continue;
        const bl = constraints.filter((x) => x.kind === "class" && x.course_code === c.code && activeOn(x, key)).sort((a, b) => a.start_time.localeCompare(b.start_time));
        for (const x of bl) {
          const last = out[out.length - 1];
          if (last && last.course_code === c.code && last.end === x.start_time) last.end = x.end_time;
          else out.push({ course_code: c.code, course_name: c.name, colour: c.colour, date: key, start: x.start_time, end: x.end_time, room: x.room || "", in_timetable: true });
        }
      }
      return out;
    }
    function allSessions(code) {
      const out = []; let d = parseD(TERM.start || iso(addDays(today, -28))); const end = parseD(TERM.end || iso(addDays(today, 60)));
      while (d <= end) { out.push(...sessionsOn(iso(d), code)); d = addDays(d, 1); }
      out.forEach((s, n) => { s.number = n + 1; });
      return out;
    }
    const withNote = (s) => { const n = lnotes[`${s.course_code}|${s.date}|${s.start}`] || null;
      return { ...s, note: n, has_notes: !!(n && (n.topic + n.body + n.follow_up).trim()) }; };
    function demoNotes(method, p, q, b) {
      if (p === "/api/notes/today") { const key = q.get("date") || iso(new Date());
        return { date: key, lead_minutes: 5, lectures: sessionsOn(key).map((s) => withNote({ ...s, number: (allSessions(s.course_code).find((x) => x.date === key && x.start === s.start) || {}).number })) }; }
      const m = p.match(/^\/api\/notes\/([^/]+)(\/lecture|\/compiled)?$/); const c = m && nCourse(decodeURIComponent(m[1]));
      if (!c) throw new Error("Unknown course");
      const list = allSessions(c.code).map(withNote);
      const find = (d, st) => list.find((x) => x.date === d && (!st || x.start === st || (x.start <= st && st < x.end)))
        || { course_code: c.code, course_name: c.name, colour: c.colour, date: d, start: st, end: null, room: "", number: null, in_timetable: false, note: null, has_notes: false };
      const counts = { total: list.length, held: list.filter((x) => x.date <= iso(new Date())).length, with_notes: list.filter((x) => x.has_notes).length };
      if (!m[2]) return { course: c, lectures: list, counts };
      if (m[2] === "/lecture" && method === "GET") return find(q.get("date"), q.get("start"));
      if (m[2] === "/lecture") { const s = find(b.date, b.start); const k = `${c.code}|${s.date}|${s.start}`;
        const n = lnotes[k] || { topic: "", body: "", follow_up: "" };
        ["topic", "body", "follow_up"].forEach((f) => { if (b[f] != null) n[f] = b[f]; }); n.updated = nowIso(); lnotes[k] = n; return withNote(s); }
      const done = list.filter((x) => x.has_notes);
      const md = [`# ${c.code} ${c.name}: semester notes`, "", `${done.length} of ${counts.held} lectures so far have notes.`,
        ...done.flatMap((x) => ["", `## Lecture ${x.number} · ${x.date} ${x.start}${x.note.topic ? ": " + x.note.topic : ""}`, "", x.note.body])].join("\n");
      return { course: c, markdown: md, counts };
    }

    function handle(method, path, body) {
      const [p] = path.split("?"); const q = new URLSearchParams(path.split("?")[1] || "");
      let m;
      const ok = (x) => Promise.resolve(JSON.parse(JSON.stringify(x)));
      try {
        if (p.startsWith("/api/todos")) return ok(demoTodos(method, p, q, body));
        if (p.startsWith("/api/notes")) return ok(demoNotes(method, p, q, body));
        if (method === "GET" && p === "/api/courses") return ok(courses);
        if (method === "GET" && p === "/api/constraints") return ok(constraints);
        if (method === "GET" && p === "/api/items") return ok(listItems(q.get("from"), q.get("to")));
        if (method === "GET" && (m = p.match(/^\/api\/day\/(.+)$/))) {
          const key = m[1], its = listItems(key, key), isToday = key === iso(new Date());
          const overdue = isToday ? items.filter((i) => i.status === "todo" && !i.start && i.due && i.due < key && ["task", "deadline"].includes(i.kind)).map(dto) : [];
          const wd = (parseD(key).getDay() + 6) % 7;
          const todo = [...its, ...overdue].filter((i) => i.status === "todo" && ["task", "deadline", "study"].includes(i.kind));
          const priorities = todo.sort((a, b) => a.priority - b.priority || String(a.start || "99").localeCompare(String(b.start || "99"))).slice(0, 3);
          return ok({ date: key, items: its, overdue, fixed: constraints.filter((c) => (c.kind === "busy" || c.kind === "class") && activeOn(c, key)).sort((a, b) => a.start_time.localeCompare(b.start_time)), off: offsOn(key), priorities,
            free: free(key).map(([a, b]) => ({ start: hm(isoDT(a)), end: hm(isoDT(b)), minutes: Math.round((b - a) / 6e4) })) });
        }
        if (method === "GET" && (m = p.match(/^\/api\/week\/(.+)$/))) {
          const mon = iso(mondayOf(parseD(m[1])));
          const days = {};
          for (let n = 0; n < 7; n++) { const k = iso(addDays(parseD(mon), n));
            days[k] = { fixed: constraints.filter((c) => (c.kind === "busy" || c.kind === "class") && activeOn(c, k)), off: offsOn(k) }; }
          return ok({ monday: mon, items: listItems(mon, iso(addDays(parseD(mon), 6))), constraints, days,
            progress: courses.map((c) => ({ code: c.code, colour: c.colour, target: c.weekly_target_hours, scheduled: Math.round(studyHours(c.id, mon) * 100) / 100 })) });
        }
        if (method === "GET" && p === "/api/plan") {
          const mon = iso(mondayOf(new Date())), t = iso(new Date()), t28 = iso(addDays(new Date(), 28));
          return ok({ week_of: mon, courses: courses.map((c) => ({ ...c, hours_this_week: Math.round(studyHours(c.id, mon) * 100) / 100 })), goals,
            upcoming_milestones: goals.flatMap((g) => g.milestones).filter((x) => !x.done),
            deadlines_next_4_weeks: listItems(t, t28).filter((i) => i.kind === "deadline"),
            calendar: CAL.filter((c) => (c.end || c.start) >= t).slice(0, 12).map((c) => ({ ...c, end: c.end || c.start })) });
        }
        if (method === "POST" && p === "/api/items") return ok(create(body));
        if (method === "PATCH" && (m = p.match(/^\/api\/items\/(\d+)$/))) return ok(update(Number(m[1]), body));
        if (method === "DELETE" && (m = p.match(/^\/api\/items\/(\d+)$/))) { const i = items.findIndex((x) => x.id === Number(m[1])); items.splice(i, 1); return ok({ deleted: true }); }
        if (method === "PATCH" && (m = p.match(/^\/api\/courses\/(\d+)$/))) { const c = courses.find((x) => x.id === Number(m[1])); Object.assign(c, body); return ok(c); }
        if (method === "PATCH" && (m = p.match(/^\/api\/milestones\/(\d+)$/))) { const x = goals.flatMap((g) => g.milestones).find((y) => y.id === Number(m[1])); Object.assign(x, body); return ok(x); }
        if (method === "POST" && p === "/api/plan/week") return ok(planWeek(body.monday, body.apply));
        if (method === "POST" && p === "/api/chat") return new Promise((res) => setTimeout(() => res(chat(body.message)), 350));
      } catch (e) { return Promise.reject(e); }
      return Promise.reject(new Error(`demo: no route ${method} ${p}`));
    }
    return { handle };
  })();

  const boot = new URLSearchParams(location.search).get("notes") ? openFromLink() : render();
  Promise.resolve(boot).then(lectureWatch).catch((e) => { view.innerHTML = `<div class="confirm">Couldn't load: ${esc(e.message)}</div>`; });
})();
