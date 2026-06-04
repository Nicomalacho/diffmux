// pierre-review frontend — render a git diff with @pierre/diffs, capture inline
// review comments, and ship them to the agent pane via POST /api/send.
//
// Commenting is page-level (a floating composer + a comments panel) rather than
// @pierre/diffs inline annotations: annotations only attach to fully-rendered
// change lines (async highlighting + context collapsing make that flaky), so we
// own the comment UI end-to-end for reliability. Click a line number or the
// gutter "+" -> a composer opens at that line -> Comment -> it lands in the
// panel -> "Send to agent" POSTs them all to the server, which pastes them into
// the cmux agent pane. A left sidebar lists changed files.
import { FileDiff, processPatch } from "@pierre/diffs";

const $ = (s) => document.querySelector(s);
const btnCss = (bg) => `margin:6px 6px 0 0;padding:4px 10px;border:none;border-radius:6px;background:${bg};color:#fff;font:600 12px system-ui;cursor:pointer`;

let style = "split";
let cid = 0;
const comments = []; // {id, path, side:'additions'|'deletions', line, body}
const diffs = [];    // {path, instance, section, body, chev, vchk, setCollapsed}
const viewed = new Set(); // paths marked "viewed"
let composer = null;

function pathOf(meta) {
  return meta.name || meta.prevName || meta.newPath || meta.path || "(file)";
}

// ---- floating comment composer ----
function closeComposer() { if (composer) { composer.remove(); composer = null; } }

function openComposer(path, line, side, rect) {
  closeComposer();
  side = side === "deletions" ? "deletions" : "additions";
  const box = document.createElement("div");
  composer = box;
  const top = Math.max(56, Math.min((rect ? rect.bottom : 120) + 4, window.innerHeight - 180));
  const left = Math.min(Math.max(rect ? rect.left : 320, 60), window.innerWidth - 372);
  box.style.cssText = `position:fixed;z-index:10000;top:${top}px;left:${left}px;width:340px;background:#161b22;border:1px solid #30363d;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);padding:8px`;
  const hdr = document.createElement("div");
  hdr.textContent = `${path}:${line}${side === "deletions" ? " (old side)" : ""}`;
  hdr.style.cssText = "font:600 12px ui-monospace,monospace;color:#8b949e;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const ta = document.createElement("textarea");
  ta.placeholder = "Leave a comment — ⌘/Ctrl+Enter to save, Esc to cancel";
  ta.style.cssText = "width:100%;box-sizing:border-box;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px;font:13px ui-monospace,monospace;min-height:64px;resize:vertical";
  const save = document.createElement("button"); save.textContent = "Comment"; save.style.cssText = btnCss("#238636");
  const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.style.cssText = btnCss("#6e7681");
  save.onclick = () => { const v = ta.value.trim(); if (!v) return closeComposer(); comments.push({ id: ++cid, path, side, line, body: v }); closeComposer(); renderPanel(); };
  cancel.onclick = closeComposer;
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save.onclick();
    else if (e.key === "Escape") cancel.onclick();
  });
  box.append(hdr, ta, save, cancel);
  document.body.appendChild(box);
  setTimeout(() => ta.focus(), 0);
}

// ---- comments panel + send count ----
function renderPanel() {
  let p = $("#panel");
  if (!p) { p = document.createElement("div"); p.id = "panel"; document.body.appendChild(p); }
  const n = comments.length;
  $("#send").textContent = n ? `▶ Send ${n} to agent` : "▶ Send to agent";
  if (!n) { p.style.display = "none"; return; }
  p.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:9998;width:330px;max-height:44vh;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:8px;display:block";
  p.innerHTML = `<div style="font:600 12px system-ui;color:#8b949e;margin-bottom:4px">Comments (${n})</div>`;
  comments.forEach((c) => {
    const row = document.createElement("div");
    row.style.cssText = "padding:6px 2px;border-top:1px solid #21262d;font:12px system-ui;color:#c9d1d9";
    const del = document.createElement("button"); del.textContent = "×";
    del.style.cssText = "float:right;border:none;background:none;color:#8b949e;cursor:pointer;font-size:15px;line-height:1";
    del.onclick = () => { const i = comments.indexOf(c); if (i >= 0) comments.splice(i, 1); renderPanel(); };
    const loc = document.createElement("div");
    loc.textContent = `${c.path}:${c.line}`;
    loc.style.cssText = "font:600 11px ui-monospace,monospace;color:#2f81f7;cursor:pointer";
    loc.onclick = () => { const d = diffs.find((x) => x.path === c.path); if (d) d.section.scrollIntoView({ behavior: "smooth", block: "center" }); };
    const body = document.createElement("div"); body.textContent = c.body; body.style.whiteSpace = "pre-wrap";
    row.append(del, loc, body);
    p.appendChild(row);
  });
}

function activate(path) {
  document.querySelectorAll(".fitem").forEach((el) => el.classList.toggle("active", el.dataset.path === path));
}

function updateViewedMeta() {
  const total = diffs.length, n = viewed.size;
  $("#meta").textContent = `${total} file${total === 1 ? "" : "s"} changed${n ? ` · ${n} viewed` : ""}`;
}

function setViewed(path, on) {
  const d = diffs.find((x) => x.path === path);
  if (!d) return;
  if (on) viewed.add(path); else viewed.delete(path);
  d.vchk.checked = on;
  d.setCollapsed(on);
  d.section.classList.toggle("viewed", on);
  const item = document.querySelector(`.fitem[data-path="${CSS.escape(path)}"]`);
  if (item) item.classList.toggle("viewed", on);
  updateViewedMeta();
}

function buildSidebar(files, stats, workspace) {
  const side = $("#sidebar");
  side.innerHTML = `<div class="title">${workspace ? `Workspace · ${workspace}` : "Files changed"}</div>`;
  let curRepo = null;
  files.forEach((meta, i) => {
    const path = pathOf(meta);
    if (workspace) {
      const repo = path.split("/")[0];
      if (repo !== curRepo) {
        curRepo = repo;
        const g = document.createElement("div"); g.className = "frepo"; g.textContent = repo;
        side.appendChild(g);
      }
    }
    const st = stats[path] || {};
    const item = document.createElement("div");
    item.className = "fitem"; item.dataset.path = path;
    const display = workspace ? path.slice(path.indexOf("/") + 1) : path;
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = display; nm.dir = "rtl";
    const add = document.createElement("span"); add.className = "add"; add.textContent = `+${st.add ?? 0}`;
    const del = document.createElement("span"); del.className = "del"; del.textContent = `−${st.del ?? 0}`;
    item.append(nm, add, del);
    item.onclick = () => {
      const d = diffs.find((x) => x.path === path);
      if (d) d.setCollapsed(false);   // expand so the jumped-to file is visible
      document.getElementById(`file-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      activate(path);
    };
    side.appendChild(item);
  });
}

// Toggle a single file between its diff hunks and the whole file (full context,
// fetched on demand from /api/file with -U100000, cached after the first fetch).
async function toggleExpand(entry, btn) {
  entry.expanded = !entry.expanded;
  entry.setCollapsed(false);
  if (entry.expanded) {
    if (!entry.fullMeta) {
      btn.textContent = "loading…";
      try {
        const { patch } = await (await fetch(`/api/file?path=${encodeURIComponent(entry.path)}`)).json();
        entry.fullMeta = (processPatch(patch).files || [])[0] || null;
      } catch { entry.fullMeta = null; }
    }
    if (entry.fullMeta) {
      btn.textContent = "Collapse"; btn.classList.add("on");
      entry.instance.setOptions({ ...entry.instance.options, expandUnchanged: true });
      entry.body.innerHTML = "";
      entry.instance.render({ fileDiff: entry.fullMeta, containerWrapper: entry.body });
    } else { entry.expanded = false; btn.textContent = "⤢ Whole file"; }
  } else {
    btn.textContent = "⤢ Whole file"; btn.classList.remove("on");
    entry.instance.setOptions({ ...entry.instance.options, expandUnchanged: false });
    entry.body.innerHTML = "";
    entry.instance.render({ fileDiff: entry.meta, containerWrapper: entry.body });
  }
}

async function load() {
  let data;
  try { data = await (await fetch("/api/diff")).json(); }
  catch (e) { $("#files").innerHTML = `<div class="pad">failed to load diff: ${e.message}</div>`; return; }
  const patch = data.patch, stats = data.stats || {}, workspace = data.workspace || null;
  if (!patch || !patch.trim()) { $("#files").innerHTML = `<div class="pad">no changes to review.</div>`; return; }

  const parsed = processPatch(patch);
  const files = parsed.files || parsed || [];
  $("#meta").textContent = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
  buildSidebar(files, stats, workspace);

  const root = $("#files");
  root.innerHTML = `<div id="hint">Click a line number (or hover a line and click the blue <b>+</b>) to comment, then <b>▶ Send to agent</b>.</div>`;
  files.forEach((meta, i) => {
    const path = pathOf(meta);
    const st = stats[path] || {};
    const sec = document.createElement("section");
    sec.className = "file"; sec.id = `file-${i}`;

    const hdr = document.createElement("div"); hdr.className = "fhdr";
    const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▾";
    const name = document.createElement("span"); name.className = "fhname"; name.textContent = path;
    const cnt = document.createElement("span"); cnt.className = "fhcnt";
    cnt.innerHTML = `<span class="add">+${st.add ?? 0}</span> <span class="del">−${st.del ?? 0}</span>`;
    const exp = document.createElement("button"); exp.className = "expand"; exp.textContent = "⤢ Whole file"; exp.title = "Show the entire file";
    const vlabel = document.createElement("label"); vlabel.className = "vlabel";
    const vchk = document.createElement("input"); vchk.type = "checkbox";
    vlabel.append(vchk, document.createTextNode("Viewed"));
    hdr.append(chev, name, cnt, exp, vlabel);

    const body = document.createElement("div"); body.className = "fbody";
    sec.append(hdr, body);
    root.appendChild(sec);

    const inst = new FileDiff({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: "dark",
      diffStyle: style,
      disableFileHeader: true,   // we render our own header (collapse + Viewed)
      enableLineSelection: true,
      enableGutterUtility: true,
      lineHoverHighlight: "both",
      renderGutterUtility: (getHoveredRow) => {
        const b = document.createElement("button");
        b.textContent = "+"; b.title = "Comment on this line";
        b.style.cssText = "width:18px;height:18px;line-height:16px;padding:0;border:none;border-radius:5px;background:#2f81f7;color:#fff;font:700 14px system-ui;cursor:pointer";
        b.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          const row = getHoveredRow();
          if (row) openComposer(path, row.lineNumber, row.side, b.getBoundingClientRect());
        });
        return b;
      },
      onLineNumberClick: (p) => openComposer(path, p.lineNumber, p.annotationSide, p.numberElement && p.numberElement.getBoundingClientRect()),
    });

    const setCollapsed = (c) => { body.style.display = c ? "none" : ""; chev.textContent = c ? "▸" : "▾"; sec.classList.toggle("collapsed", c); };
    const entry = { path, instance: inst, section: sec, body, chev, vchk, setCollapsed, meta, expanded: false, fullMeta: null };
    diffs.push(entry);
    inst.render({ fileDiff: meta, containerWrapper: body });

    hdr.addEventListener("click", (e) => { if (e.target.closest("label") || e.target.closest("button")) return; setCollapsed(body.style.display !== "none"); });
    vchk.addEventListener("change", (e) => { e.stopPropagation(); setViewed(path, vchk.checked); });
    exp.addEventListener("click", (e) => { e.stopPropagation(); toggleExpand(entry, exp); });
  });
  renderPanel();
  updateViewedMeta();

  const obs = new IntersectionObserver((es) => {
    const vis = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) activate(diffs[Number(vis.target.id.split("-")[1])]?.path);
  }, { rootMargin: "-46px 0px -70% 0px" });
  diffs.forEach((d) => obs.observe(d.section));
}

$("#toggle").onclick = () => {
  style = style === "split" ? "unified" : "split";
  for (const d of diffs) { d.instance.setOptions({ ...d.instance.options, diffStyle: style }); d.instance.rerender(); }
  $("#toggle").textContent = style === "split" ? "Unified" : "Split";
};

function setStatus(t) {
  const s = $("#status");
  s.textContent = t; s.style.display = "block";
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => (s.style.display = "none"), 2500);
}

$("#send").onclick = async () => {
  if (!comments.length) return setStatus("no comments to send");
  $("#send").disabled = true;
  try {
    const r = await (await fetch("/api/send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ comments: comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })) }),
    })).json();
    if (r.error) setStatus("error: " + r.error);
    else { setStatus(`sent ${r.sent} ✓`); comments.length = 0; renderPanel(); }
  } catch (e) { setStatus("server offline: " + e.message); }
  setTimeout(() => ($("#send").disabled = false), 1200);
};

load();
