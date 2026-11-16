// Verilay Patchmap v0.1: reads data/*.json and draws the step-by-step drill-down.
const state = { ver: "server-2022", q: "", area: "", sw: "", software: {}, data: null, tags: {}, issues: [] };
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
  state.sw = h.get("s") || "";
}
function writeHash() {
  const h = new URLSearchParams();
  h.set("v", state.ver);
  if (state.q) h.set("q", state.q);
  if (state.area) h.set("a", state.area);
  if (state.sw) h.set("s", state.sw);
  history.replaceState(null, "", "#" + h.toString());
}

function setupTheme() {
  const btn = $("theme");
  const show = () => { btn.textContent = document.documentElement.dataset.theme === "dark" ? "Light" : "Dark"; };
  btn.onclick = () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    if (dark) document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("pm-theme", dark ? "dark" : "light"); } catch (e) {}
    show();
  };
  show();
}

async function init() {
  setupTheme();
  readHash();
  const [index, tags, issues, ms, builds] = await Promise.all([
    getJSON("data/index.json"), getJSON("data/area_tags.json"), getJSON("data/known_issues.json"),
    getJSON("data/release_health.json").catch(() => ({ issues: [] })),
    getJSON("data/builds.json").catch(() => []),
  ]);
  state.files = await getJSON("data/files/index.json").catch(() => ({}));
  const swList = await getJSON("data/software/index.json").catch(() => []);
  for (const id of swList) { try { state.software[id] = await getJSON(`data/software/${id}.json`); } catch (e) {} }
  const ssel = $("sw");
  ssel.innerHTML = '<option value="">No filter</option>' + Object.values(state.software).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
  if (!state.software[state.sw]) state.sw = "";
  ssel.value = state.sw;
  ssel.onchange = () => { state.sw = ssel.value; render(); };
  state.tags = tags.tags;
  state.issues = issues.issues.concat(ms.issues);
  state.builds = builds;
  state.labels = index.labels;
  state.generated = index.generated;
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
  window.addEventListener("hashchange", () => { readHash(); sel.value = state.ver; q.value = state.q; $("sw").value = state.software[state.sw] ? state.sw : ""; load(); });
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
  const sw = state.software[state.sw];
  $("swinfo").innerHTML = sw ? `<details class="sw-card" id="swdetails"><summary><span class="l">${esc(sw.name)}: the ${sw.depends_on.length} parts of Windows it relies on</span><span class="r">show</span></summary>${swCard()}</details>` : "";
  renderIssues();
  const pair = parseBuildPair(state.q);
  if (pair) {
    const [h1, h2] = [findBuild(pair[0]), findBuild(pair[1])];
    if (h1 && h2 && h1.version === h2.version && h1.version !== state.ver) { state.ver = h1.version; $("ver").value = h1.version; load(); return; }
    $("issues").innerHTML = "";
    const res = compareCard(pair, h1, h2);
    $("results").innerHTML = res.html;
    $("results").querySelectorAll("button[data-a]").forEach((x) => (x.onclick = () => { state.area = state.area === x.dataset.a ? "" : x.dataset.a; render(); }));
    if (res.months) renderMonths(res.months); else $("months").innerHTML = "";
    return;
  }
  const b = parseBuild(state.q);
  if (b) {
    const hit = findBuild(b);
    if (hit && hit.version !== state.ver) { state.ver = hit.version; $("ver").value = hit.version; load(); return; }
    $("issues").innerHTML = "";
    $("results").innerHTML = buildCard(b, hit);
    renderMonths();
    return;
  }
  if (/^[\w.-]+\.(dll|exe|sys|cpl|drv|ocx|efi|mui|winmd)$/i.test(state.q)) {
    $("issues").innerHTML = ""; $("months").innerHTML = "";
    const name = state.q.toLowerCase();
    $("results").innerHTML = '<p class="muted">Loading file history…</p>';
    fileHistory(name).then((h) => { if (state.q.toLowerCase() === name) $("results").innerHTML = h; });
    return;
  }
  if (state.q.length >= 2) { $("issues").innerHTML = ""; renderSearch(); $("months").innerHTML = ""; }
  else { $("results").innerHTML = ""; renderMonths(); }
}

// ---- Build number lookup (R1) ----
// Accepts 10.0.20348.5870, 20348.5870 or "OS Build 20348.5870".
function parseBuild(q) {
  const m = String(q).toLowerCase().replace(/^os\s*build\s*/, "").match(/^(?:10\.0\.)?(\d{5})\.(\d{1,5})$/);
  return m ? { major: +m[1], rev: +m[2], text: `10.0.${m[1]}.${m[2]}` } : null;
}
const bparts = (s) => s.split(".").map(Number);
function findBuild(b) {
  const same = state.builds.filter((x) => bparts(x.build)[2] === b.major);
  if (!same.length) return null;
  // Several versions can share a build family (e.g. 26100): pick the one whose builds are closest.
  const byVer = {};
  same.forEach((x) => (byVer[x.version] = byVer[x.version] || []).push(x));
  let best = null;
  for (const [ver, list] of Object.entries(byVer)) {
    list.sort((a, c) => bparts(a.build)[3] - bparts(c.build)[3]);
    const dist = Math.min(...list.map((x) => Math.abs(bparts(x.build)[3] - b.rev)));
    if (!best || dist < best.dist) best = { version: ver, list, dist };
  }
  const list = best.list;
  const exact = list.filter((x) => bparts(x.build)[3] === b.rev);
  const earlier = list.filter((x) => bparts(x.build)[3] < b.rev);
  const later = list.filter((x) => bparts(x.build)[3] > b.rev);
  return { version: best.version, exact, nearest: earlier[earlier.length - 1] || null, later, list };
}
// ---- Compare two builds (R2) ----
// Accepts "20348.5622 to 20348.5870", "... vs ...", "... -> ...", or two builds separated by a space or comma.
function parseBuildPair(q) {
  const parts = String(q).toLowerCase().replace(/os\s*build\s*/g, "").split(/\s*(?:\bto\b|\bvs\.?|->|→|,|\s)\s*/).filter(Boolean);
  if (parts.length !== 2) return null;
  const a = parseBuild(parts[0]), b = parseBuild(parts[1]);
  return a && b ? [a, b] : null;
}
function refOf(hit) { return hit.exact[0] || hit.nearest; }
function compareCard(pair, h1, h2) {
  const card = (title, body) => `<div class="issue build"><span class="pill src">Compare builds</span><span class="it">${title}</span>${body}</div>`;
  if (!h1 || !h2) return { html: card(`Can't compare: Patchmap doesn't recognise ${esc((!h1 ? pair[0] : pair[1]).text)}`, `<div class="is">Check the number with <code>winver</code>. Patchmap covers ${Object.values(state.labels).map(esc).join(", ")}.</div>`) };
  if (h1.version !== h2.version) return { html: card("These builds are different Windows versions", `<div>${esc(pair[0].text)} is ${esc(state.labels[h1.version])}; ${esc(pair[1].text)} is ${esc(state.labels[h2.version])}. Compare two builds of the same version.</div>`) };
  let [a, b, ha, hb] = [pair[0], pair[1], h1, h2];
  let swapped = "";
  if (a.rev > b.rev) { [a, b, ha, hb] = [b, a, h2, h1]; swapped = `<div class="is">Put in order: older build first.</div>`; }
  const vlabel = state.labels[ha.version];
  if (a.rev === b.rev) return { html: card(`Both are build ${esc(a.text)} (${esc(vlabel)})`, `<div>Same build, so the same updates and fixes. If one machine misbehaves, the difference isn't the Windows update.</div>`) };
  const months = state.data.months.map((m) => m.month);
  const ra = refOf(ha), rb = refOf(hb);
  const ia = ra ? months.indexOf(ra.month) : months.length;   // older build's month (bigger index = older)
  const ib = rb ? months.indexOf(rb.month) : months.length;
  const between = state.data.months.filter((m, i) => i < ia && i >= ib); // months after A, up to and including B
  const ups = ha.list.filter((x) => { const r = bparts(x.build)[3]; return r > a.rev && r <= b.rev; });
  const desc = (h, x, ref) => h.exact.length ? `${ref.kb}, ${monthName(ref.month)}` : ref ? `not a listed update; after ${ref.kb} (${monthName(ref.month)})` : "older than 12 months";
  const fixes = between.reduce((n, m) => n + m.fix_count, 0);
  const areaTotals = {};
  between.forEach((m) => Object.entries(m.areas).forEach(([t, a2]) => (areaTotals[t] = (areaTotals[t] || 0) + a2.count)));
  const areas = Object.entries(areaTotals).sort((x, y) => y[1] - x[1])
    .map(([t, n]) => `<button class="chip" data-a="${esc(t)}">${esc(label(t))} ${n}</button>`).join(" ");
  const problems = between.flatMap((m) => issuesFor(m.month));
  const prob = problems.length
    ? `<div><b>${problems.length} known problem${problems.length > 1 ? "s" : ""}</b> started in between (${problems.filter((i) => i.status !== "fixed").length} still open): ` +
      problems.map((i) => `${esc(i.title)} <span class="pill ${esc(i.status)}">${esc(STATUS_LABEL[i.status] || i.status)}</span>`).join("; ") + `</div>`
    : `<div>No known problems started in between.</div>`;
  const body =
    `<div>Older: <b>${esc(a.text)}</b> (${esc(desc(ha, a, ra))})<br>Newer: <b>${esc(b.text)}</b> (${esc(desc(hb, b, rb))})</div>` + swapped +
    `<div><b>${ups.length} update${ups.length === 1 ? "" : "s"}</b> in between${ups.length ? ": " + ups.map((x) => esc(x.kb)).join(", ") : ""}.</div>` +
    (between.length ? `<div><b>${fixes} security fixes</b> from ${between.length} month${between.length > 1 ? "s" : ""}. By area (click to filter):</div><div class="chips">${areas}</div>`
                    : `<div>Both builds are from the same month, so the security fixes are the same; the newer build only adds that month's extra or hotpatch releases.</div>`) +
    prob + `<div class="is">The months in between are listed below.</div>`;
  return { html: card(`What changed between two ${esc(vlabel)} builds`, body), months: between.length ? new Set(between.map((m) => m.month)) : null };
}

function niceDate(d) { return new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); }
function daysAgo(d) { return Math.max(0, Math.round((Date.now() - Date.parse(d + "T00:00:00Z")) / 86400000)); }
function buildCard(b, hit) {
  if (!hit) {
    const other = { 19045: "Windows 10 22H2", 19044: "Windows 10 21H2 (LTSC 2021)", 22631: "Windows 11 23H2", 22621: "Windows 11 22H2",
      17763: "Windows Server 2019 / Windows 10 1809 (LTSC 2019)", 14393: "Windows Server 2016 / Windows 10 1607 (LTSB 2016)", 22000: "Windows 11 21H2" }[b.major];
    return `<div class="issue"><span class="pill src">Build lookup</span><span class="it">${other ? `Build ${esc(b.text)} is ${esc(other)}, which Patchmap doesn't cover yet` : `We don't recognise build ${esc(b.text)}`}</span>` +
      `<div class="is">Patchmap covers ${Object.values(state.labels).map(esc).join(", ")}.</div></div>`;
  }
  const label = state.labels[hit.version];
  const months = state.data.months.map((m) => m.month);
  const oldest = months[months.length - 1];
  const ref = hit.exact[0] || hit.nearest;
  let head, note = "";
  if (hit.exact.length) {
    const kbs = hit.exact.map((x) => `${x.kb}${x.type && x.type !== "Security Update" ? ` (${x.type})` : ""}`).join(" and ");
    const maxOfMonth = hit.list.filter((x) => x.month === ref.month).slice(-1)[0];
    const when = ref.month === oldest && maxOfMonth.build !== ref.build ? `${monthName(ref.month)} or earlier` : `${monthName(ref.month)}, released ${niceDate(ref.released)} (${daysAgo(ref.released)} days ago)`;
    head = `Build ${esc(b.text)} is ${esc(label)}, update ${esc(kbs)}`;
    note = `<div>${esc(when)}.</div>`;
  } else if (hit.nearest && !hit.later.length) {
    head = `Build ${esc(b.text)} is ${esc(label)}, newer than every update Patchmap knows`;
    note = `<div>Our newest is ${esc(hit.nearest.kb)} (build ${esc(hit.nearest.build)}). It may be a preview or emergency update, or our data (updated ${esc(state.generated)}) hasn't caught up yet.</div>`;
  } else if (hit.nearest) {
    head = `Build ${esc(b.text)} is ${esc(label)}, but not one of the security updates Patchmap lists`;
    note = `<div>Closest earlier: ${esc(hit.nearest.kb)} (build ${esc(hit.nearest.build)}, ${esc(monthName(hit.nearest.month))}). It's probably a preview or emergency update released after that.</div>`;
  } else {
    head = `Build ${esc(b.text)} is ${esc(label)}, older than the 12 months Patchmap covers`;
    note = `<div>It's at least a year out of date.</div>`;
  }
  // What came after this build
  const newer = hit.later.filter((x) => !ref || x.month !== ref.month || bparts(x.build)[3] > bparts(ref.build)[3]);
  const refIdx = ref ? months.indexOf(ref.month) : months.length;
  const laterMonths = state.data.months.slice(0, Math.max(0, refIdx));
  const fixesSince = laterMonths.reduce((n, m) => n + m.fix_count, 0);
  const problemsSince = laterMonths.flatMap((m) => issuesFor(m.month));
  const openUpTo = state.issues.filter((i) => i.versions.includes(hit.version) && i.status !== "fixed" &&
    i.months.some((m) => months.indexOf(m) >= refIdx));
  let after;
  if (!newer.length && !hit.exact.length) {
    after = "";
  } else if (!newer.length) {
    after = `<div class="ok-line">This is the newest update Patchmap knows for ${esc(label)}.</div>`;
  } else {
    const latest = newer[newer.length - 1];
    after = `<div><b>${newer.length} newer update${newer.length > 1 ? "s" : ""}</b> since, the latest being ${esc(latest.kb)} (build ${esc(latest.build)}, ${esc(monthName(latest.month))}). <a href="#v=${esc(hit.version)}&q=${encodeURIComponent(b.text + " to " + latest.build)}">Compare with the latest</a>.` +
      (fixesSince ? ` Updating would add <b>${fixesSince} security fixes</b> from ${laterMonths.length} later month${laterMonths.length > 1 ? "s" : ""}.` : "") + `</div>` +
      (problemsSince.length ? `<div class="is">Known problems that started in those later updates: ${problemsSince.length} (${problemsSince.filter((i) => i.status !== "fixed").length} still open). See the months below.</div>` : "");
  }
  const open = openUpTo.length ? `<div class="is">Still-open known problems from this update or earlier: ${openUpTo.map((i) => esc(i.title)).join("; ")}.</div>` : "";
  return `<div class="issue build"><span class="pill src">Build lookup</span><span class="it">${head}</span>${note}${after}${open}</div>`;
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
const STATUS_LABEL = { open: "Open", mitigated: "Workaround available", "fix-rolling-out": "Fix rolling out", "fix-available": "Fix available", fixed: "Fixed" };
function issueHTML(i) {
  const pv = (i.by_version && i.by_version[state.ver]) || {};
  const sources = pv.url ? [{ name: "Microsoft release health", url: pv.url }] : i.sources;
  const src = sources.map((s) => `<a href="${esc(s.url)}" rel="noopener">${esc(s.name)}</a>`).join(", ");
  const st = STATUS_LABEL[i.status] || i.status;
  const caused = pv.caused_by || i.caused_by || [], fixedIn = pv.fixed_by || i.fixed_by || [];
  const kbs = [caused.length ? `Started with ${caused.join(", ")}` : "",
               fixedIn.length ? `fixed in ${fixedIn.join(", ")}` : ""].filter(Boolean).join(" · ");
  const body = [i.summary, i.status_note].filter(Boolean).join(" ");
  return `<div class="issue ${esc(i.status)}"><span class="pill ${esc(i.status)}">${esc(st)}</span>` +
    `<span class="pill src">${i.origin === "microsoft" ? "Microsoft" : "Patchmap"}</span>` +
    `<span class="it">${esc(i.title)}</span>${body ? `<div>${esc(body)}</div>` : ""}` +
    `<div class="is">${kbs ? esc(kbs) + " · " : ""}Sources: ${src} · checked ${esc(i.checked)}</div></div>`;
}
function issuesBlock(list) {
  const active = list.filter((i) => i.status !== "fixed");
  const fixed = list.filter((i) => i.status === "fixed");
  return active.map(issueHTML).join("") + (fixed.length
    ? `<details class="fixed-list"><summary>${fixed.length} known problem${fixed.length > 1 ? "s" : ""} from this update, now fixed</summary>${fixed.map(issueHTML).join("")}</details>` : "");
}
function renderIssues() {
  const latest = state.data.months[0] && state.data.months[0].month;
  const list = issuesFor(latest).filter((i) => i.status === "open");
  $("issues").innerHTML = list.map((i) =>
    `<div class="issue open"><span class="pill open">Open</span><span class="it">${esc(i.title)}</span><div class="is">Known problem in the latest update. Details under ${monthName(latest)} below.</div></div>`).join("");
}

function fixHTML(f) {
  const kbs = (f.kbs || []).map((k) => `<span class="kb">${esc(k)}</span>`).join(" ");
  return `<div class="fix"><a class="cve" href="https://msrc.microsoft.com/update-guide/vulnerability/${esc(f.cve)}" rel="noopener">${esc(f.cve)}</a>` +
    `<span>${esc(f.title)}</span>${f.severity ? `<span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>` : ""}<span class="muted">${kbs}</span></div>`;
}

function renderMonths(only) {
  const box = $("months");
  const months = state.data.months;
  if (!months.length) { box.innerHTML = '<p class="muted">No data for this version yet.</p>'; return; }
  const firstShown = months.findIndex((m) => !only || only.has(m.month));
  box.innerHTML = months.map((m, idx) => {
    if (only && !only.has(m.month)) return "";
    const ups = m.updates.map((u) => `<span class="kb">${esc(u.kb)}</span>`).join(" ") || '<span class="muted">KB not listed</span>';
    const n = state.area ? (m.areas[state.area] ? m.areas[state.area].count : 0) : m.fix_count;
    const ki = issuesFor(m.month).filter((i) => i.status !== "fixed").length;
    const kf = issuesFor(m.month).length - ki;
    const kt = [ki ? `${ki} open problem${ki > 1 ? "s" : ""}` : "", kf ? `${kf} fixed` : ""].filter(Boolean).join(", ");
    return `<details class="month" data-i="${idx}"${idx === firstShown ? " open" : ""}><summary><span class="l">${monthName(m.month)} · ${ups}</span>` +
      `<span class="r">${n} fixes${state.area ? " in " + esc(label(state.area)) : ""}${swCount(m) !== null ? ` · <b>${swCount(m)} in ${esc(state.software[state.sw].name)}'s parts</b>` : ""}${kt ? " · " + kt : ""}</span></summary></details>`;
  }).join("");
  box.querySelectorAll("details.month").forEach((d) => {
    const fill = () => { if (!d.dataset.done) { d.insertAdjacentHTML("beforeend", monthBody(months[+d.dataset.i])); d.dataset.done = 1; wireAreas(d); } };
    if (d.open) fill();
    d.addEventListener("toggle", fill);
  });
}

// ---- "My software" filter (R5) ----
function swFixes(m, dep) {
  // fixes this month in the Windows parts one dependency lists (no duplicates)
  const seen = new Map();
  for (const a of Object.values(m.areas)) for (const c of dep.components) for (const f of a.components[c] || []) seen.set(f.cve, f);
  return [...seen.values()];
}
function swCount(m) {
  const sw = state.software[state.sw];
  if (!sw) return null;
  return new Set(sw.depends_on.flatMap((d) => swFixes(m, d).map((f) => f.cve))).size;
}
function swBlock(m) {
  const sw = state.software[state.sw];
  if (!sw) return "";
  const rows = sw.depends_on.map((d) => {
    const fx = swFixes(m, d);
    return `<details class="sw-dep"><summary><span class="l">${esc(d.name)}</span><span class="r">${fx.length ? `<b>${fx.length} fix${fx.length === 1 ? "" : "es"}</b>` : "no change"}</span></summary>` +
      `<p class="is">${esc(d.why)}</p>${fx.map(fixHTML).join("")}</details>`;
  }).join("");
  return `<div class="sw-box"><div class="sw-h">Parts of Windows ${esc(sw.name)} relies on, changed in ${monthName(m.month)}</div>${rows}` +
    `<p class="is">"Relies on" means worth checking, not "will break". ${sw.basis === "support-experience" ? "Based on support experience. " : "Based on the vendor's public documentation. "}<a href="#" data-swinfo="1">About this list</a></p></div>`;
}
function swCard() {
  const sw = state.software[state.sw];
  if (!sw) return "";
  const deps = sw.depends_on.map((d) => {
    const src = (d.sources || []).map((s) => `<a href="${esc(s.url)}" rel="noopener">${esc(s.name)}</a>`).join(", ");
    return `<li><b>${esc(d.name)}</b>: ${esc(d.why)}${src ? ` <span class="is">Sources: ${src}</span>` : ""}</li>`;
  }).join("");
  const past = (sw.past_problems || []).map((p) => `<li>${esc(p.when)}: <a href="${esc(p.url)}" rel="noopener">${esc(p.what)}</a></li>`).join("");
  return `<div class="issue build" id="swcard"><span class="pill src">${sw.basis === "support-experience" ? "From support experience" : "From vendor docs"}</span><span class="it">${esc(sw.name)}: what it relies on in Windows</span>` +
    `<div>${esc(sw.about)}</div><ul class="sw-list">${deps}</ul>${past ? `<div class="is">Past Windows update problems the vendor documented:</div><ul class="sw-list">${past}</ul>` : ""}` +
    `<div class="is">${esc(sw.note)} Checked ${esc(sw.checked)}. <a href="https://github.com/ekbm/patchmap/blob/main/data/software/${esc(sw.id)}.json">Suggest a correction</a></div></div>`;
}

// ---- Files changed per update (R6) ----
const fileCache = {};
const loadFiles = (path) => (fileCache[path] = fileCache[path] || getJSON(path));
function filesInfo(m) { return ((state.files || {})[state.ver] || {})[m.month]; }
function swFileTags() {
  const sw = state.software[state.sw];
  return sw ? [...new Set(sw.depends_on.flatMap((d) => d.file_tags || []))] : null;
}
const FILE_TAG_LABEL = { rpc: "Remote Procedure Call (RPC)", other: "Other files" };
const fileTagLabel = (t) => FILE_TAG_LABEL[t] || label(t);
function filesBlock(m) {
  const fi = filesInfo(m);
  if (!fi) return "";
  const sw = state.software[state.sw];
  const swTags = swFileTags();
  const swN = swTags ? swTags.reduce((n, t) => n + (fi.by_tag[t] || 0), 0) : 0;
  return `<details class="files" data-path="${esc(fi.path)}"><summary><span class="l">Files changed by ${esc(fi.kb)}</span>` +
    `<span class="r">${fi.changed.toLocaleString()} files${sw ? ` · <b>${swN} in ${esc(sw.name)}'s parts</b>` : ""}</span></summary><div class="files-body"><p class="muted">Loading…</p></div></details>`;
}
function fileRow(f) {
  return `<div class="fix"><span class="cve">${esc(f.n)}</span><span class="muted">${f.o ? `${esc(f.o)} → ` : "new · "}${esc(f.v)}</span></div>`;
}
async function fillFiles(el) {
  const r = await loadFiles(el.dataset.path);
  const groups = {};
  for (const f of r.changed.concat(r.added)) for (const t of (f.t.length ? f.t : ["other"])) (groups[t] = groups[t] || []).push(f);
  const swTags = swFileTags() || [];
  const order = Object.keys(groups).sort((a, b) => (swTags.includes(b) - swTags.includes(a)) || (a === "other") - (b === "other") || groups[b].length - groups[a].length);
  el.querySelector(".files-body").innerHTML =
    `<p class="is">Compared with ${esc(r.compared_with)}: ${r.counts.changed.toLocaleString()} files with a new version, ${r.counts.added.toLocaleString()} new files` +
    `${r.counts.language_files ? ` (plus ${r.counts.language_files.toLocaleString()} language files, not listed)` : ""}. x64 files from Microsoft's file list for ${esc(r.kb)}.</p>` +
    order.map((t) => `<details${swTags.includes(t) ? " open" : ""}><summary><span class="l">${esc(fileTagLabel(t))}${swTags.includes(t) ? ' <span class="pill src">your software</span>' : ""}</span><span class="r">${groups[t].length} files</span></summary>` +
      (t === "other" && groups[t].length > 400 ? groups[t].slice(0, 400).map(fileRow).join("") + `<p class="is">…and ${groups[t].length - 400} more. Search a file name to see its history.</p>` : groups[t].map(fileRow).join("")) + `</details>`).join("");
}
document.addEventListener("toggle", (ev) => {
  const el = ev.target;
  if (el.matches && el.matches("details.files") && el.open && !el.dataset.done) { el.dataset.done = 1; fillFiles(el).catch(() => { el.querySelector(".files-body").innerHTML = '<p class="muted">Couldn\'t load the file list.</p>'; }); }
}, true);
async function fileHistory(name) {
  const per = (state.files || {})[state.ver] || {};
  const rows = [];
  for (const [month, fi] of Object.entries(per)) {
    const r = await loadFiles(fi.path);
    const f = r.changed.concat(r.added).find((x) => x.n === name);
    rows.push({ month, kb: fi.kb, f });
  }
  rows.sort((a, b) => state.data.months.findIndex((m) => m.month === a.month) - state.data.months.findIndex((m) => m.month === b.month));
  if (!rows.length) return `<div class="issue"><span class="pill src">File history</span><span class="it">No file lists for ${esc(state.data.label)} yet</span></div>`;
  return `<div class="issue build"><span class="pill src">File history</span><span class="it">${esc(name)} on ${esc(state.data.label)}</span>` +
    rows.map((x) => `<div>${esc(monthName(x.month))} (${esc(x.kb)}): ${x.f ? `<b>changed</b> ${x.f.o ? esc(x.f.o) + " → " : "new · "}${esc(x.f.v)}` : "not changed"}</div>`).join("") +
    `<div class="is">Covers the months Patchmap has file lists for. Versions are from Microsoft's file lists (x64).</div></div>`;
}

function monthBody(m) {
  const ups = m.updates.map((u) => `${esc(u.kb)}${u.build ? ` → build ${esc(u.build)}` : ""}${u.supersedes && u.supersedes.length ? ` (replaces ${esc(u.supersedes.join(", "))})` : ""}`).join(" · ");
  const issues = issuesBlock(issuesFor(m.month));
  const areas = Object.entries(m.areas).filter(([t]) => !state.area || t === state.area);
  return `<p class="meta">Released ${esc(m.released)}${ups ? " · " + ups : ""}</p>${issues}${swBlock(m)}${filesBlock(m)}` + areas.map(([t, a]) =>
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

document.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-swinfo]");
  if (!t) return;
  ev.preventDefault();
  const d = $("swdetails");
  if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
});

init().catch((e) => { $("months").innerHTML = `<p class="muted">Couldn't load the data (${esc(e.message)}). Try refreshing.</p>`; });
