// Verilay Patchmap v0.1: reads data/*.json and draws the step-by-step drill-down.
const state = { ver: "server-2022", q: "", area: "", data: null, tags: {}, issues: [] };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const monthName = (id) => { const [y, m] = id.split("-"); return `${({Jan:"January",Feb:"February",Mar:"March",Apr:"April",May:"May",Jun:"June",Jul:"July",Aug:"August",Sep:"September",Oct:"October",Nov:"November",Dec:"December"})[m]} ${y}`; };
const label = (tag) => (state.tags[tag] && state.tags[tag].label) || (tag === "other" ? "Other" : tag);
const getJSON = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("v")) state.ver = h.get("v");
  state.q = h.get("q") || "";
  state.area = h.get("a") || "";
}
function writeHash() {
  const h = new URLSearchParams();
  h.set("v", state.ver);
  if (state.q) h.set("q", state.q);
  if (state.area) h.set("a", state.area);
  history.replaceState(null, "", "#" + h.toString());
}

async function init() {
  readHash();
  const [index, tags, issues] = await Promise.all([
    getJSON("data/index.json"), getJSON("data/area_tags.json"), getJSON("data/known_issues.json"),
  ]);
  state.tags = tags.tags;
  state.issues = issues.issues;
  $("gen").textContent = `Data updated ${index.generated}.`;
  const sel = $("ver");
  sel.innerHTML = index.scope.map((v) => `<option value="${v}">${esc(index.labels[v])}</option>`).join("");
  if (!index.scope.includes(state.ver)) state.ver = index.scope[0];
  sel.value = state.ver;
  sel.onchange = () => { state.ver = sel.value; load(); };
  const q = $("q");
  q.value = state.q;
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.q = q.value.trim(); render(); }, 200); };
  window.addEventListener("hashchange", () => { readHash(); sel.value = state.ver; q.value = state.q; load(); });
  await load();
}

async function load() {
  $("months").innerHTML = '<p class="muted">Loading…</p>';
  state.data = await getJSON(`data/versions/${state.ver}.json`);
  render();
}

function render() {
  writeHash();
  renderChips();
  renderIssues();
  if (state.q.length >= 2) { $("issues").innerHTML = ""; renderSearch(); $("months").innerHTML = ""; }
  else { $("results").innerHTML = ""; renderMonths(); }
}

function renderChips() {
  const order = Object.keys(state.tags).concat("other");
  $("chips").innerHTML = '<span class="muted" style="align-self:center">Area:</span>' +
    [["", "All"]].concat(order.map((t) => [t, label(t)]))
      .map(([t, l]) => `<button class="chip${state.area === t ? " on" : ""}" data-a="${t}">${esc(l)}</button>`).join("");
  $("chips").querySelectorAll("button").forEach((b) => (b.onclick = () => { state.area = b.dataset.a; render(); }));
}

function issuesFor(month) {
  return state.issues.filter((i) => i.versions.includes(state.ver) && (!month || i.months.includes(month)) && (!state.area || i.areas.includes(state.area)));
}
function issueHTML(i) {
  const src = i.sources.map((s) => `<a href="${esc(s.url)}" rel="noopener">${esc(s.name)}</a>`).join(", ");
  const st = { open: "Open", "fix-rolling-out": "Fix rolling out", "fix-available": "Fix available" }[i.status] || i.status;
  return `<div class="issue ${esc(i.status)}"><b>Known problem · ${esc(st)} · ${esc(i.title)}</b>${esc(i.summary)} ${esc(i.status_note || "")}<br><span style="font-size:13px">Sources: ${src} · checked ${esc(i.checked)}</span></div>`;
}
function renderIssues() {
  const latest = state.data.months[0] && state.data.months[0].month;
  const list = issuesFor(latest).filter((i) => i.status === "open");
  $("issues").innerHTML = list.map((i) =>
    `<div class="issue open"><b>Open known problem in the latest update: ${esc(i.title)}</b><span style="font-size:13px">Details and sources under ${monthName(latest)} below.</span></div>`).join("");
}

function fixHTML(f) {
  const kbs = (f.kbs || []).map((k) => `<span class="kb">${esc(k)}</span>`).join(" ");
  return `<div class="fix"><a class="cve" href="https://msrc.microsoft.com/update-guide/vulnerability/${esc(f.cve)}" rel="noopener">${esc(f.cve)}</a>` +
    `<span>${esc(f.title)}</span>${f.severity ? `<span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>` : ""}<span class="muted">${kbs}</span></div>`;
}

function renderMonths() {
  const box = $("months");
  const months = state.data.months;
  if (!months.length) { box.innerHTML = '<p class="muted">No data for this version yet.</p>'; return; }
  box.innerHTML = months.map((m, idx) => {
    const ups = m.updates.map((u) => `<span class="kb">${esc(u.kb)}</span>`).join(" ") || '<span class="muted">KB not listed</span>';
    const n = state.area ? (m.areas[state.area] ? m.areas[state.area].count : 0) : m.fix_count;
    const ki = issuesFor(m.month).length;
    return `<details class="month" data-i="${idx}"${idx === 0 ? " open" : ""}><summary><span class="l">${monthName(m.month)} · ${ups}</span>` +
      `<span class="r">${n} fixes${state.area ? " in " + esc(label(state.area)) : ""}${ki ? ` · ${ki} known problem${ki > 1 ? "s" : ""}` : ""}</span></summary></details>`;
  }).join("");
  box.querySelectorAll("details.month").forEach((d) => {
    const fill = () => { if (!d.dataset.done) { d.insertAdjacentHTML("beforeend", monthBody(months[+d.dataset.i])); d.dataset.done = 1; wireAreas(d); } };
    if (d.open) fill();
    d.addEventListener("toggle", fill);
  });
}

function monthBody(m) {
  const ups = m.updates.map((u) => `${esc(u.kb)}${u.build ? ` → build ${esc(u.build)}` : ""}${u.supersedes && u.supersedes.length ? ` (replaces ${esc(u.supersedes.join(", "))})` : ""}`).join(" · ");
  const issues = issuesFor(m.month).map(issueHTML).join("");
  const areas = Object.entries(m.areas).filter(([t]) => !state.area || t === state.area);
  return `<p class="meta">Released ${esc(m.released)}${ups ? " · " + ups : ""}</p>${issues}` + areas.map(([t, a]) =>
    `<details class="area" data-t="${esc(t)}"><summary><span class="l">${esc(label(t))}</span><span class="r">${a.count} fixes · ${Object.keys(a.components).length} components</span></summary></details>`
  ).join("");
}

function wireAreas(monthEl) {
  const m = state.data.months[+monthEl.dataset.i];
  monthEl.querySelectorAll("details.area").forEach((d) => d.addEventListener("toggle", () => {
    if (d.dataset.done) return;
    const comps = Object.entries(m.areas[d.dataset.t].components).sort((a, b) => b[1].length - a[1].length);
    d.insertAdjacentHTML("beforeend", comps.map(([c, fixes]) =>
      `<details><summary><span class="l">${esc(c)}</span><span class="r">${fixes.length} fix${fixes.length === 1 ? "" : "es"}</span></summary>${fixes.map(fixHTML).join("")}</details>`).join(""));
    d.dataset.done = 1;
  }));
}

function renderSearch() {
  const q = state.q.toLowerCase();
  const out = [];
  let total = 0;
  const issueHits = state.issues.filter((i) => i.versions.includes(state.ver) &&
    (i.title + " " + i.summary + " " + i.areas.join(" ")).toLowerCase().includes(q));
  for (const m of state.data.months) {
    const hits = [];
    const kbHit = m.updates.some((u) => u.kb.toLowerCase().includes(q));
    for (const [t, a] of Object.entries(m.areas)) {
      if (state.area && t !== state.area) continue;
      const areaHit = label(t).toLowerCase().includes(q) || t.includes(q);
      for (const [c, fixes] of Object.entries(a.components)) {
        for (const f of fixes) {
          if (kbHit || areaHit || (c + " " + f.title + " " + f.cve + " " + (f.kbs || []).join(" ")).toLowerCase().includes(q)) {
            if (!hits.some((h) => h.cve === f.cve)) hits.push(f);
          }
        }
      }
    }
    if (hits.length) { total += hits.length; out.push([m, hits]); }
  }
  const head = `<p class="muted">${total} fixes match “${esc(state.q)}” on ${esc(state.data.label)}${state.area ? " in " + esc(label(state.area)) : ""}.</p>`;
  $("results").innerHTML = issueHits.map(issueHTML).join("") + head + out.map(([m, hits]) =>
    `<details class="month"${out[0][0] === m ? " open" : ""}><summary><span class="l">${monthName(m.month)} · ${m.updates.map((u) => `<span class="kb">${esc(u.kb)}</span>`).join(" ")}</span><span class="r">${hits.length} matches</span></summary>${hits.slice(0, 300).map(fixHTML).join("")}</details>`
  ).join("");
}

init().catch((e) => { $("months").innerHTML = `<p class="muted">Couldn't load the data (${esc(e.message)}). Try refreshing.</p>`; });
