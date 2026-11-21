// Verilay Patchmap v0.1: reads data/*.json and draws the step-by-step drill-down.
const state = { ver: "server-2022", q: "", area: "", sw: "", software: {}, data: null, tags: {}, issues: [] };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Escaped, because month names go straight into the page in several places (Verilay scan, 17 Nov 2026).
const monthName = (id) => { const [y, m] = String(id).split("-"); return esc(`${({Jan:"January",Feb:"February",Mar:"March",Apr:"April",May:"May",Jun:"June",Jul:"July",Aug:"August",Sep:"September",Oct:"October",Nov:"November",Dec:"December"})[m] || m} ${y}`); };
const label = (tag) => (state.tags[tag] && state.tags[tag].label) || (tag === "other" ? "Other" : tag);
const getJSON = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  // A link that names a version wins; otherwise open on the version this browser used last.
  let last = ""; try { last = localStorage.getItem("pm-ver") || ""; } catch (e) {}
  if (h.get("v") || last) state.ver = h.get("v") || last;
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
  try { localStorage.setItem("pm-ver", state.ver); } catch (e) {}
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
  // Ask for every file at once (not one after another), and fill the version box
  // as soon as the small version list arrives, so it isn't blank while the rest loads.
  const indexP = getJSON("data/index.json");
  indexP.then((index) => {
    const sel = $("ver");
    sel.innerHTML = index.scope.map((v) => `<option value="${esc(v)}">${esc(index.labels[v])}</option>`).join("");
    sel.value = index.scope.includes(state.ver) ? state.ver : index.scope[0];
  }).catch(() => {});
  const softwareP = getJSON("data/software/index.json").catch(() => [])
    .then((ids) => Promise.all(ids.map((id) => getJSON(`data/software/${id}.json`).catch(() => null))));
  const [index, tags, issues, ms, builds, files, kbinfo, hotpatch, tshoot, sw, kev] = await Promise.all([
    indexP, getJSON("data/area_tags.json"), getJSON("data/known_issues.json"),
    getJSON("data/release_health.json").catch(() => ({ issues: [] })),
    getJSON("data/builds.json").catch(() => []),
    getJSON("data/files/index.json").catch(() => ({})),
    getJSON("data/kb_titles.json").catch(() => ({})),
    getJSON("data/files/hotpatch_index.json").catch(() => ({})),
    getJSON("data/troubleshooting.json").catch(() => null),
    softwareP,
    getJSON("data/kev.json").catch(() => ({})),
  ]);
  Object.assign(state, { files, kbinfo, hotpatch, tshoot, kev });
  for (const x of sw) if (x && x.id) state.software[x.id] = x;
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
  // Same date, near the top where people actually see it: "Data updated 18 Nov 2026 · refreshed every Wednesday"
  const g = String(index.generated || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (g) $("gentop").textContent = `Data updated ${+g[3]} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[+g[2] - 1]} ${g[1]} · refreshed every Wednesday`;
  const sel = $("ver");
  sel.innerHTML = index.scope.map((v) => `<option value="${esc(v)}">${esc(index.labels[v])}</option>`).join("");
  if (!index.scope.includes(state.ver)) state.ver = index.scope[0];
  sel.value = state.ver;
  sel.onchange = () => { state.ver = sel.value; load(); };
  const q = $("q");
  q.value = state.q;
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.q = q.value.trim(); render(); }, 200); };
  setupSuggest();
  $("bld").onchange = () => {
    const v = $("bld").value;
    state.q = v ? v.replace(/^10\.0\./, "") : "";
    $("q").value = state.q;
    render();
  };
  window.addEventListener("hashchange", () => { readHash(); sel.value = state.ver; q.value = state.q; $("sw").value = state.software[state.sw] ? state.sw : ""; load(); });
  await load();
}

async function load() {
  $("months").innerHTML = '<p class="muted">Loading…</p>';
  state.data = await getJSON(`data/versions/${state.ver}.json`);
  fillBuilds();
  render();
}

function render() {
  writeHash();
  syncBuildMenu();
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
    loadNames().then(() => fileHistory(name)).then((h) => { if (state.q.toLowerCase() === name) $("results").innerHTML = h; });
    return;
  }
  const kbq = /^kb\d{6,7}$/i.test(state.q) ? state.q.toUpperCase() : null;
  if (kbq && !state.builds.some((x) => x.kb === kbq && x.version === state.ver)) {
    const other = state.builds.find((x) => x.kb === kbq);
    if (other) { state.ver = other.version; $("ver").value = other.version; load(); return; }
  }
  if (state.q.length >= 2) { $("issues").innerHTML = ""; renderSearch(); $("months").innerHTML = ""; }
  else { $("results").innerHTML = state.area ? areaCard(state.area) : ""; renderMonths(); if (state.area) loadNames().then(() => { if (state.area && !state.q) $("results").innerHTML = areaCard(state.area); }); }
}

// ---- Build menu: pick a build of the chosen Windows version ----
function fillBuilds() {
  const sel = $("bld"), field = $("bldfield");
  const list = state.builds.filter((x) => x.version === state.ver && x.build.startsWith("10.0."));
  if (!list.length) { field.hidden = true; sel.innerHTML = ""; return; }   // Exchange, SQL Server, Microsoft 365: no Windows builds
  field.hidden = false;
  const byBuild = new Map();
  for (const x of list) (byBuild.get(x.build) || byBuild.set(x.build, []).get(x.build)).push(x);
  const builds = [...byBuild.keys()].sort((a, b) => bparts(b)[3] - bparts(a)[3]);
  sel.innerHTML = `<option value="">All builds</option>` + builds.map((b) => {
    const xs = byBuild.get(b);
    const kbs = xs.map((x) => x.kb + (kindLabel(x.kb) ? " · " + kindLabel(x.kb) : "")).join(", ");
    return `<option value="${esc(b)}">${esc(b.replace(/^10\.0\./, ""))} · ${esc(kbs)} · ${esc(monthName(xs[0].month))}</option>`;
  }).join("");
  syncBuildMenu();
}
function syncBuildMenu() {
  const sel = $("bld");
  if (!sel || !sel.options.length) return;
  const b = parseBuild(state.q);
  const want = b ? b.text : "";
  sel.value = [...sel.options].some((o) => o.value === want) ? want : "";
}

// ---- Build number lookup (R1) ----
// Accepts 10.0.20348.5870, 20348.5870 or "OS Build 20348.5870".
function parseBuild(q) {
  const m = String(q).toLowerCase().replace(/^os\s*build\s*/, "").match(/^(?:10\.0\.)?(\d{5})\.(\d{1,5})$/);
  return m ? { major: +m[1], rev: +m[2], text: `10.0.${m[1]}.${m[2]}` } : null;
}
const bparts = (s) => s.split(".").map(Number);
function findBuild(b) {
  const same = state.builds.filter((x) => x.build.startsWith("10.0.") && bparts(x.build)[2] === b.major);
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
  // KB numbers work too ("KB5122882 to KB5131090"): turn each into its Windows build number.
  const isKb = (p) => /^kb\d{6,7}$/.test(p);
  if (isKb(parts[0]) || isKb(parts[1])) {
    const vers = (p) => isKb(p) ? state.builds.filter((x) => x.kb.toLowerCase() === p && x.build.startsWith("10.0.")).map((x) => x.version) : null;
    const va = vers(parts[0]), vb = vers(parts[1]);
    // pick a Windows version both have (prefer the one on screen), e.g. Windows 11 updates cover 3 versions
    const common = (va || vb || []).filter((v) => (!va || va.includes(v)) && (!vb || vb.includes(v)));
    const ver = common.includes(state.ver) ? state.ver : common[0];
    const toBuild = (p) => {
      if (!isKb(p)) return parseBuild(p);
      const hit = state.builds.find((x) => x.kb.toLowerCase() === p && x.version === ver);
      return hit ? Object.assign(parseBuild(hit.build), { kb: p.toUpperCase() }) : { major: 0, rev: 0, text: p.toUpperCase(), kb: p.toUpperCase() };
    };
    return [toBuild(parts[0]), toBuild(parts[1])];
  }
  const a = parseBuild(parts[0]), b = parseBuild(parts[1]);
  return a && b ? [a, b] : null;
}
function refOf(hit) { return hit.exact[0] || hit.nearest; }
function compareCard(pair, h1, h2) {
  const card = (title, body) => `<div class="issue build"><span class="pill src">Compare builds</span><span class="it">${title}</span>${body}</div>`;
  if (!h1 || !h2) {
    const bad = (!h1 ? pair[0] : pair[1]).text;
    const help = /^KB/.test(bad)
      ? `Comparing by KB works for Windows updates Patchmap lists (last 12 months), and both updates must be for the same Windows version. Check the KB numbers, or compare build numbers instead (run <code>winver</code>).`
      : `Check the number with <code>winver</code>. Patchmap covers ${Object.values(state.labels).map(esc).join(", ")}.`;
    return { html: card(`Can't compare: Patchmap can't match ${esc(bad)}`, `<div class="is">${help}</div>`) };
  }
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
    ? `<div><b>${problems.length} known problem${problems.length > 1 ? "s" : ""}</b> started in between (${problems.filter((i) => i.status !== "fixed").length} not fixed yet): ` +
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

// ---- Update types and troubleshooting (hotpatch label + "Something broke?") ----
const KIND_LABEL = { hotpatch: "Hotpatch", baseline: "Baseline", "out-of-band": "Out-of-band", preview: "Preview" };
function kbKind(kb) { return ((state.kbinfo || {})[kb] || {}).kind || ""; }
function kindLabel(kb) {
  // "Baseline" only means something where hotpatching is mainstream (Windows 11, Server 2025); elsewhere it's just the monthly update
  const k = kbKind(kb);
  if (k === "baseline" && !/^(win11|server-2025)/.test(state.ver)) return "";
  return KIND_LABEL[k] || "";
}
function kbBadge(kb) { const k = kindLabel(kb); return k ? ` <span class="pill src" title="${k === "Hotpatch" ? "Patched in memory, no restart" : ""}">${k}</span>` : ""; }
function fullUpdateFor(ref, hit) {
  // the full (non-hotpatch) update for the same month and version, newest build first
  const same = hit.list.filter((x) => x.month === ref.month && x.kb !== ref.kb && kbKind(x.kb) !== "hotpatch");
  return same.sort((a, c) => bparts(c.build)[3] - bparts(a.build)[3])[0] || null;
}
function hotpatchNote(ref, hit) {
  if (kbKind(ref.kb) !== "hotpatch") return "";
  const full = fullUpdateFor(ref, hit);
  return `<div class="is">This is a <b>hotpatch</b>: Windows was patched in memory, without a restart.` +
    (full ? ` The full update for the same month is <b>${esc(full.kb)}</b> (build ${esc(full.build)}), which replaces the files on disk.` : "") + `</div>`;
}
function kbFixStats(kb, month) {
  // A fix published in an earlier month can be delivered by a later update, so look at every month.
  const seen = new Map(), areas = {};
  for (const m of state.data.months) for (const [t, a] of Object.entries(m.areas)) for (const fx of Object.values(a.components)) for (const f of fx) {
    if (!(f.kbs || []).includes(kb)) continue;
    seen.set(f.cve, f);
    areas[t] = areas[t] || new Set(); areas[t].add(f.cve);
  }
  const all = [...seen.values()];
  const crit = all.filter((f) => f.severity === "Critical").length;
  const exploited = all.filter((f) => f.exploited);
  const exAreas = {};
  for (const [t, set] of Object.entries(areas)) { const n = exploited.filter((f) => set.has(f.cve)).length; if (n && t !== "other") exAreas[t] = n; }
  return { total: seen.size, crit, exploited: exploited.length, ransomware: exploited.filter((f) => f.ransomware).length,
           likely: all.filter((f) => f.likely && !f.exploited).length, exAreas,
           areas: Object.entries(areas).map(([t, set]) => [t, set.size]).sort((a, b) => b[1] - a[1]) };
}
function exploitLine(st, kb) {
  const where = Object.entries(st.exAreas).sort((a, b) => (b[0] === "print") - (a[0] === "print") || b[1] - a[1]).map(([t, n]) => `${n} in ${label(t)}`).join(", ");
  if (st.exploited) return `<div class="xp-line"><b>${st.exploited} of its ${st.total} fixes ${st.exploited === 1 ? "is" : "are"} being exploited</b>${where ? ` (${esc(where)})` : ""}${st.ransomware ? `, ${st.ransomware} used in ransomware` : ""}. Attackers are using ${st.exploited === 1 ? "this weakness" : "these weaknesses"}: don't stay without ${esc(kb)} for long.</div>`;
  return `<div class="is">None of its ${st.total} fixes are known to be exploited (Microsoft and CISA, as of ${esc(state.generated)})${st.likely ? `; Microsoft rates ${st.likely} as more likely to be exploited` : ""}.</div>`;
}
function tsList(items) { return items && items.length ? `<ul class="sw-list">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""; }
function tshootBlock(ref) {
  const T = state.tshoot;
  if (!T || !ref) return "";
  const st = kbFixStats(ref.kb, ref.month);
  const hit = findBuild(parseBuild(ref.build));
  const full = kbKind(ref.kb) === "hotpatch" && hit ? fullUpdateFor(ref, hit) : null;
  const areaBits = st.areas.filter(([t]) => T.areas[t]).sort((x, y) => (y[0] === "print") - (x[0] === "print")).map(([t, n]) => {
    const a = T.areas[t];
    return `<details><summary><span class="l">${esc(label(t))}</span><span class="r">${n} fix${n === 1 ? "" : "es"} in this update</span></summary>` +
      `<div class="is">Where to look</div>${tsList(a.logs)}<div class="is">What to check</div>${tsList(a.checks)}` +
      (a.stopgap && a.stopgap.length ? `<div class="is">Stopgap</div>${tsList(a.stopgap)}` : "") + `</details>`;
  }).join("");
  const top = st.areas.slice(0, 4).map(([t, n]) => `${label(t)} ${n}`).join(", ");
  return `<details class="tshoot"><summary><span class="l">Something broke after ${esc(ref.kb)}?</span><span class="r">steps</span></summary>` +
    tsList(T.general) +
    (kbKind(ref.kb) === "hotpatch" ? `<p class="is"><b>Hotpatch:</b> ${esc(T.hotpatch)}${full ? ` For this machine that's <b>${esc(full.kb)}</b> (build ${esc(full.build)}).` : ""}</p>` : "") +
    `<div class="is"><b>Before removing it:</b> ${esc(ref.kb)} carries ${st.total} security fixes${st.crit ? ` (${st.crit} critical)` : ""}${top ? `, most in ${esc(top)}` : ""}.</div>` + exploitLine(st, ref.kb) +
    tsList(T.uninstall) +
    (areaBits ? `<div class="is"><b>By area</b> (open the one that's failing):</div>${areaBits}` : "") +
    `<div class="is">Searching an error code (for example 0xC1 or 0x0000011b) shows any matching guidance. Not Microsoft advice; check Microsoft's page for the update.</div></details>`;
}
function areaCard(t) {
  if (!state.tags[t] && t !== "other") return "";
  const months = state.data.months.filter((m) => m.areas[t]);
  if (!months.length) return "";
  const latest = months[0];
  const comps = {};
  for (const m of months) for (const [c, fx] of Object.entries(m.areas[t].components)) comps[c] = (comps[c] || 0) + fx.length;
  const topComps = Object.entries(comps).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const key = ["spoolsv.exe", "localspl.dll", "win32spl.dll", "kerberos.dll", "lsasrv.dll", "msv1_0.dll", "srv2.sys", "mrxsmb.sys", "rpcrt4.dll", "gdi32full.dll"];
  const files = fileNamesForVersion().filter(([, tg]) => tg.includes(t)).map(([n]) => n).sort((a, b) => key.includes(b) - key.includes(a)).slice(0, 6);
  const pats = ((state.tshoot || {}).patterns || []).filter((p) => p.area === t);
  const open = state.issues.filter((i) => i.versions.includes(state.ver) && i.areas.includes(t) && i.status !== "fixed");
  let exN = 0;
  for (const m of months) for (const fx of Object.values(m.areas[t].components)) exN += fx.filter((f) => f.exploited).length;
  return `<div class="issue build"><span class="pill src">Area</span><span class="it">${esc(label(t))} on ${esc(state.data.label)}</span>` +
    `<div>Latest: ${esc(monthName(latest.month))} (${latest.updates.map((u) => esc(u.kb) + kbBadge(u.kb)).join(", ")}): <b>${latest.areas[t].count} fixes</b>. ${months.length} of the last ${state.data.months.length} months touched this area.${exN ? ` <span class="xp-txt">${exN} exploited fix${exN > 1 ? "es" : ""} in 12 months</span> (search “exploited”).` : ""}${open.length ? ` <b>${open.length} known problem${open.length > 1 ? "s" : ""} not fixed yet.</b>` : ""}</div>` +
    jumpsRow([
      ["Parts of Windows", topComps.map(([c, n]) => jl({ q: c, a: t }, `${c.replace(/^Windows /, "")} ${n}`))],
      ["Files", files.map((f) => jl({ q: f }, f))],
      ["Errors", pats.map((p) => jl({ q: p.match[0] }, p.title.length > 40 ? p.title.slice(0, 40) + "…" : p.title))],
      ["Updates", [jl({ q: latest.updates[0] ? latest.updates[0].kb : "" }, "Latest update")]],
    ]) + `</div>`;
}
function kbJumps(ref) {
  const st = kbFixStats(ref.kb, ref.month);
  const fi = filesInfo({ month: ref.month });
  const probs = state.issues.filter((i) => i.versions.includes(state.ver) &&
    (((i.by_version || {})[state.ver] || {}).caused_by || []).includes(ref.kb) || (!i.by_version && i.versions.includes(state.ver) && i.months.includes(ref.month)));
  const codes = [...new Set(probs.flatMap((i) => (i.title.match(/0x[0-9a-f]{6,8}/gi) || [])))];
  return jumpsRow([
    ["Areas", st.areas.filter(([t]) => t !== "other").sort((x, y) => (y[0] === "print") - (x[0] === "print")).slice(0, 5).map(([t, n]) => jl({ a: t }, `${label(t)} ${n}`))],
    ["Files", fi ? [`<a class="jl" href="/kb/${esc(fi.kb)}/">Files changed in ${esc(monthName(ref.month))}</a>`] : []],
    ["Errors", codes.slice(0, 4).map((c) => jl({ q: c }, c))],
  ]);
}
function kbCard(q) {
  // Searching an update number: a summary card on top with its type, build and the troubleshooting guide.
  if (!/^kb\d{6,7}$/i.test(q)) return "";
  const kb = q.toUpperCase();
  const ref = state.builds.find((x) => x.kb === kb && x.version === state.ver);
  // Patchmap only has a page for updates in builds.json (its last 12 months), so don't link to a page that isn't there
  const msLink = `<a href="https://support.microsoft.com/help/${esc(kb.slice(2))}" rel="noopener">Microsoft's page for ${esc(kb)}</a>`;
  const hasPage = state.builds.some((x) => x.kb === kb);
  const pageLink = hasPage ? `<a href="/kb/${esc(kb)}/">Full page for ${esc(kb)}</a> · ${msLink}` : msLink;
  if (!ref) return `<div class="issue build"><span class="pill src">Update</span><span class="it">${esc(kb)}${kbBadge(kb)}</span>` +
    (hasPage ? "" : `<div>Patchmap doesn't have this update. It covers the last 12 months of updates for the versions it lists, so older updates aren't included.</div>`) +
    `<div class="is">${pageLink}</div></div>`;
  const hit = findBuild(parseBuild(ref.build));
  const newer = hit ? hit.later.filter((x) => bparts(x.build)[3] > bparts(ref.build)[3]) : [];
  return `<div class="issue build"><span class="pill src">Update</span><span class="it">${esc(kb)}${kbBadge(kb)}: ${esc(state.data.label)}, ${esc(monthName(ref.month))}, build ${esc(ref.build)}</span>` +
    (hit ? hotpatchNote(ref, hit) : "") +
    `<div>${newer.length ? `${newer.length} newer update${newer.length > 1 ? "s" : ""} since, the latest being ${esc(newer[newer.length - 1].kb)} (build ${esc(newer[newer.length - 1].build)}).` : "The newest update Patchmap knows for this version."}</div>` +
    exploitLine(kbFixStats(ref.kb, ref.month), ref.kb) + `<div class="is">${pageLink}</div>` + kbJumps(ref) + tshootBlock(ref) + `</div>`;
}
function patternHits(q) {
  const T = state.tshoot;
  if (!T || !q || q.length < 3) return [];
  const ql = q.toLowerCase();
  return T.patterns.filter((p) => p.match.some((m) => ql.includes(m) || (m.length > 4 && m.includes(ql)))).map((p) =>
    `<div class="issue build"><span class="pill src">Troubleshooting</span><span class="it">${esc(p.title)}</span>${tsList(p.advice)}` +
    `<div class="is">Basis: ${esc(p.basis)}${(p.sources || []).map((s) => ` · <a href="${esc(s.url)}" rel="noopener">${esc(s.name)}</a>`).join("")}</div>` +
    jumpsRow([["Area", p.area && state.tags[p.area] ? [jl({ a: p.area }, label(p.area))] : []], ["Files", (p.files || []).map((f) => jl({ q: f }, f))]]) + `</div>`);
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
    head = `Build ${esc(b.text)} is ${esc(label)}, update ${esc(kbs)}${kbBadge(ref.kb)}`;
    note = `<div>${esc(when)}.</div>` + hotpatchNote(ref, hit);
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
      (problemsSince.length ? `<div class="is">Known problems that started in those later updates: ${problemsSince.length} (${problemsSince.filter((i) => i.status !== "fixed").length} not fixed yet). See the months below.</div>` : "");
  }
  const open = openUpTo.length ? `<div class="is">Known problems not fixed yet, from this update or earlier: ${openUpTo.map((i) => esc(i.title)).join("; ")}.</div>` : "";
  return `<div class="issue build"><span class="pill src">Build lookup</span><span class="it">${head}</span>${note}${hit.exact.length ? exploitLine(kbFixStats(ref.kb, ref.month), ref.kb) : ""}${after}${open}${hit.exact.length ? tshootBlock(ref) : ""}</div>`;
}

function renderChips() {
  const present = new Set((state.data ? state.data.months : []).flatMap((m) => Object.keys(m.areas)));
  const order = Object.keys(state.tags).concat("other").filter((t) => present.has(t) || t === state.area);
  // Show the first 6 areas (Printing first) and fold the rest behind "More areas", so the row isn't a wall of buttons
  const SHOW = 6;
  const shown = state.chipsAll ? order : order.filter((t, i) => i < SHOW || t === state.area);
  $("chips").innerHTML = '<span class="muted" style="align-self:center">Area:</span>' +
    [["", "All"]].concat(shown.map((t) => [t, label(t)]))
      // esc(t): the area can come from the page address (#a=...), so it must never go into the page raw
      .map(([t, l]) => `<button class="chip${state.area === t ? " on" : ""}" data-a="${esc(t)}">${esc(l)}</button>`).join("") +
    (order.length > SHOW ? `<button class="chip more" data-chipmore="1">${state.chipsAll ? "Fewer areas" : `More areas (${order.length - shown.length}) ▾`}</button>` : "");
  $("chips").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    if (b.dataset.chipmore) { state.chipsAll = !state.chipsAll; renderChips(); return; }
    state.area = b.dataset.a; render();
  }));
}

function issuesFor(month) {
  return state.issues.filter((i) => i.versions.includes(state.ver) && (!month || i.months.includes(month)) && (!state.area || i.areas.includes(state.area)));
}
const STATUS_LABEL = { open: "Not fixed yet", mitigated: "Workaround available", "fix-rolling-out": "Fix rolling out", "fix-available": "Fix available", fixed: "Fixed" };
function issueHTML(i) {
  const pv = (i.by_version && i.by_version[state.ver]) || {};
  const sources = pv.url ? [{ name: "Microsoft release health", url: pv.url }] : i.sources;
  const src = sources.map((s) => `<a href="${esc(s.url)}" rel="noopener">${esc(s.name)}</a>`).join(", ");
  const st = STATUS_LABEL[i.status] || i.status;
  const caused = pv.caused_by || i.caused_by || [], fixedIn = pv.fixed_by || i.fixed_by || [];
  const kbs = [caused.length ? `Started with ${caused.join(", ")}` : "",
               fixedIn.length ? `fixed in ${fixedIn.join(", ")}` : ""].filter(Boolean).join(" · ");
  const body = [i.summary, i.status_note].filter(Boolean).join(" ");
  // One plain line on what to do. Patchmap's own problems carry a hand-written line; for Microsoft's we only point
  // to Microsoft's page, so Patchmap never makes up advice.
  const todo = i.what_to_do ? esc(i.what_to_do)
    : i.status === "fixed" ? "Install the update that fixed it (see details)."
    : sources[0] ? `See <a href="${esc(sources[0].url)}" rel="noopener">Microsoft's page</a> for the latest workaround or fix.` : "";
  // Link to "Thinking of removing it?" on the update's page, only for updates Patchmap has a page for (this version)
  const rmKb = i.status !== "fixed" && caused.find((k) => (state.builds || []).some((b) => b.kb === k && b.version === state.ver));
  const cost = rmKb ? `<a class="cost" href="/kb/${esc(rmKb)}/#remove">What does removing ${esc(rmKb)} cost? ›</a>` : "";
  return `<div class="issue ${esc(i.status)}" data-issue="${esc(i.id)}"><span class="pill ${esc(i.status)}">${esc(st)}</span>` +
    `<span class="pill src">${i.origin === "microsoft" ? "Microsoft" : "Patchmap"}</span>` +
    `<span class="it">${esc(i.title)}</span>${todo ? `<div class="todo"><b>What to do:</b> ${todo}</div>` : ""}${cost ? `<div>${cost}</div>` : ""}` +
    `<details class="more"><summary><span class="l">More details and sources</span></summary>${body ? `<div>${esc(body)}</div>` : ""}` +
    `<div class="is">${kbs ? esc(kbs) + " · " : ""}Sources: ${src} · checked ${esc(i.checked)}</div></details></div>`;
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
  const n = list.length;
  $("issues").innerHTML = n ? `<a class="alert-line" href="#" data-goto="${esc(list[0].id)}"><span>⚠ ${n} problem${n > 1 ? "s" : ""} in the latest update (${monthName(latest)}) ${n > 1 ? "are" : "is"} not fixed yet: ` +
    `${list.map((i) => esc(i.title)).join("; ")}.</span><b>See what to do ↓</b></a>` : "";
}

function exploitPills(f) {
  // red: attackers are using it; amber: details were public before the fix; grey: Microsoft rates it more likely to be exploited
  let out = "";
  if (f.exploited) out += `<span class="pill xp" title="${f.kev ? "On CISA's Known Exploited Vulnerabilities list since " + esc(f.kev) : "Microsoft says this was exploited"}">Exploited${f.ransomware ? " · ransomware" : ""}</span>`;
  else if (f.likely) out += `<span class="pill src" title="Microsoft rates this weakness as more likely to be exploited">More likely to be exploited</span>`;
  if (f.disclosed) out += `<span class="pill dis" title="Details were public before the fix">Publicly disclosed</span>`;
  return out;
}
function fixHTML(f) {
  const kbs = (f.kbs || []).map((k) => `<span class="kb">${esc(k)}</span>`).join(" ");
  return `<div class="fix"><a class="cve" href="https://msrc.microsoft.com/update-guide/vulnerability/${esc(f.cve)}" rel="noopener">${esc(f.cve)}</a>` +
    `<span>${esc(f.title)}</span>${f.severity ? `<span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>` : ""}${exploitPills(f)}<span class="muted">${kbs}</span></div>`;
}

function renderMonths(only) {
  const box = $("months");
  const months = state.data.months;
  if (!months.length) { box.innerHTML = '<p class="muted">No data for this version yet.</p>'; return; }
  const firstShown = months.findIndex((m) => !only || only.has(m.month));
  box.innerHTML = months.map((m, idx) => {
    if (only && !only.has(m.month)) return "";
    const n = state.area ? (m.areas[state.area] ? m.areas[state.area].count : 0) : m.fix_count;
    const ki = issuesFor(m.month).filter((i) => i.status === "open").length;
    const ex = exCount(m);
    const facts = [`${m.updates.length} update${m.updates.length === 1 ? "" : "s"}`,
      `${n.toLocaleString()} fixes${state.area ? " in " + esc(label(state.area)) : ""}`,
      ex ? `<span class="xp-txt">${ex} exploited</span>` : "",
      swCount(m) !== null ? `<b>${swCount(m)} in ${esc(state.software[state.sw].name)}'s parts</b>` : "",
      ki ? `<span class="xp-txt">${ki} not fixed yet</span>` : ""].filter(Boolean).join(" · ");
    return `<details class="month" data-i="${idx}"${idx === firstShown ? " open" : ""}><summary><span class="l">${monthName(m.month)}</span>` +
      `<span class="r">${facts}</span></summary></details>`;
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
  const hps = ((state.hotpatch || {})[state.ver] || {})[m.month] || [];
  const hpBlocks = hps.map((h) => `<details class="files hp" data-hppath="${esc(h.path)}"><summary><span class="l">Hotpatch ${esc(h.kb)} patches files in memory</span>` +
    `<span class="r">${h.count} files${swTags ? ` · <b>${swTags.reduce((n, t) => n + (h.by_tag[t] || 0), 0)} in ${esc(sw.name)}'s parts</b>` : ""}</span></summary><div class="files-body"><p class="muted">Loading…</p></div></details>`).join("");
  return hpBlocks + `<details class="files" data-path="${esc(fi.path)}"><summary><span class="l">Files changed by ${esc(fi.kb)}</span>` +
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
async function fillHotpatch(el) {
  const r = await loadFiles(el.dataset.hppath);
  const groups = {};
  for (const f of r.patches) for (const t of (f.t.length ? f.t : ["other"])) (groups[t] = groups[t] || []).push(f);
  const swTags = swFileTags() || [];
  const order = Object.keys(groups).sort((a, b) => (swTags.includes(b) - swTags.includes(a)) || (a === "other") - (b === "other") || groups[b].length - groups[a].length);
  el.querySelector(".files-body").innerHTML =
    `<p class="is">Only on devices enrolled in hotpatching: these Windows files were patched in memory, without a restart. The files on disk keep the last full or baseline update's version.</p>` +
    order.map((t) => `<details${swTags.includes(t) ? " open" : ""}><summary><span class="l">${esc(fileTagLabel(t))}</span><span class="r">${groups[t].length} files</span></summary>` +
      groups[t].map((f) => `<div class="fix"><span class="cve">${esc(f.n)}</span><span class="muted">via ${esc(f.hp)} ${esc(f.v)}</span></div>`).join("") + `</details>`).join("");
}
document.addEventListener("toggle", (ev) => {
  const el = ev.target;
  if (el.matches && el.matches("details.files.hp") && el.open && !el.dataset.done) { el.dataset.done = 1; fillHotpatch(el).catch(() => { el.querySelector(".files-body").innerHTML = '<p class="muted">Could not load the hotpatch list.</p>'; }); return; }
  if (el.matches && el.matches("details.files") && el.open && !el.dataset.done) { el.dataset.done = 1; fillFiles(el).catch(() => { el.querySelector(".files-body").innerHTML = '<p class="muted">Couldn\'t load the file list.</p>'; }); }
}, true);
async function fileHistory(name) {
  const per = (state.files || {})[state.ver] || {};
  const rows = [];
  const hpPer = (state.hotpatch || {})[state.ver] || {};
  for (const [month, fi] of Object.entries(per)) {
    const r = await loadFiles(fi.path);
    const f = r.changed.concat(r.added).find((x) => x.n === name);
    const hps = [];
    for (const h of hpPer[month] || []) {
      const hr = await loadFiles(h.path);
      const p = hr.patches.find((x) => x.n === name);
      if (p) hps.push({ kb: h.kb, p });
    }
    rows.push({ month, kb: fi.kb, f, hps });
  }
  rows.sort((a, b) => state.data.months.findIndex((m) => m.month === a.month) - state.data.months.findIndex((m) => m.month === b.month));
  if (!rows.length) return `<div class="issue"><span class="pill src">File history</span><span class="it">No file lists for ${esc(state.data.label)} yet</span></div>`;
  const tags = (fileNamesForVersion().find(([n]) => n === name) || [null, []])[1];
  const last = rows.find((x) => x.f);
  const fileJumps = jumpsRow([
    ["Area", tags.map((t) => state.tags[t] ? jl({ a: t }, label(t)) : "").filter(Boolean)],
    ["Updates", (last ? [jl({ q: last.kb }, "Last changed by " + last.kb)] : []).concat(rows.flatMap((x) => x.hps).slice(0, 1).map((h) => jl({ q: h.kb }, "Hotpatch " + h.kb)))],
    ["Errors", patternsForFile(name).map((p) => jl({ q: p.match[0] }, p.title.length > 45 ? p.title.slice(0, 45) + "…" : p.title))],
  ]);
  return `<div class="issue build"><span class="pill src">File history</span><span class="it">${esc(name)} on ${esc(state.data.label)}</span>` + fileJumps +
    rows.map((x) => `<div class="fh-month"><b>${esc(monthName(x.month))}</b>` +
      `<div>• Full update ${esc(x.kb)}${kbBadge(x.kb)}: ${x.f ? `<b>changed</b> ${x.f.o ? esc(x.f.o) + " → " : "new · "}${esc(x.f.v)}` : "not changed"}</div>` +
      x.hps.map((h) => `<div>• ${esc(h.kb)}${kbBadge(h.kb)}: <b>patched in memory</b> (${esc(h.p.hp)} ${esc(h.p.v)}). ` +
        `The file on disk stays ${x.f && x.f.o ? `at ${esc(x.f.o)}` : "at the last full or baseline update's version"} on hotpatched devices, until the next full or baseline update.</div>`).join("") +
      `</div>`).join("") +
    `<div class="is">Covers the months Patchmap has file lists for. Versions are from Microsoft's file lists (x64). Hotpatch lines only matter for devices enrolled in hotpatching.</div></div>`;
}

function exCount(m) {
  // fixes being exploited: the whole month, or only the chosen area
  if (!state.area) return m.exploited_count || 0;
  const a = m.areas[state.area];
  return a ? new Set(Object.values(a.components).flat().filter((f) => f.exploited).map((f) => f.cve)).size : 0;
}
function updateType(u) {
  const k = kbKind(u.kb), win = /^10\.0\./.test(u.build || "");
  if (!/^KB\d+$/.test(u.kb)) return '<span class="tag">Monthly channel update</span>';   // Microsoft 365 Apps: no KB number
  if (k === "hotpatch") return '<span class="tag hot">Hotpatch</span> no restart';
  if (k === "baseline" && /^(win11|server-2025)/.test(state.ver)) return '<span class="tag full">Baseline</span> needs restart';
  if (k === "standard" || k === "baseline") return '<span class="tag full">Full update</span> needs restart';
  if (k === "out-of-band") return '<span class="tag">Out-of-band</span> urgent fix outside Patch Tuesday';
  if (k === "preview") return '<span class="tag">Preview</span> optional';
  return win ? '<span class="tag">Type not listed yet</span>' : '<span class="tag">Update</span>';
}
// ---- Fixes being exploited: one line each, "What this means" opens on click ----
// One plain line per kind of weakness (Microsoft's "impact"). Kept the same as IMPACT_PLAIN in scripts/build_pages.py.
const IMPACT_PLAIN = {
  "Remote Code Execution": "an attacker could run their own code on the machine. This is the most serious kind of weakness.",
  "Elevation of Privilege": "someone who already has a foothold on the machine (a normal user account, or malware) can make themselves admin. Attackers often use this as the second step of an attack.",
  "Security Feature Bypass": "an attacker can get past a Windows protection that would normally stop or warn you.",
  "Spoofing": "an attacker can make something fake look trustworthy, for example an email or a link, to trick people into acting on it.",
  "Information Disclosure": "an attacker can read information they shouldn't, which can help a bigger attack.",
  "Denial of Service": "an attacker can crash or freeze a service, so it stops working for everyone.",
  "Tampering": "an attacker can change data or settings they shouldn't be able to.",
};
const dayDiff = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) : null);
function shortName(f) {
  const t = f.title.replace(/\s+Vulnerability$/, ""), imp = f.impact || "";
  return imp && t.endsWith(imp) && t.length > imp.length ? t.slice(0, -imp.length).trim() : f.title;
}
function exploitedBlock(m) {
  const seen = new Map();
  for (const [t, a] of Object.entries(m.areas)) {
    if (state.area && t !== state.area) continue;
    for (const fx of Object.values(a.components)) for (const f of fx) if (f.exploited && !seen.has(f.cve)) seen.set(f.cve, f);
  }
  if (!seen.size) return "";
  const card = (f) => {
    const k = (state.kev || {})[f.cve], imp = f.impact || "";
    const facts = [`Fixed in: <b>${esc((f.kbs || []).join(", ") || monthName(m.month))}</b>`];
    if (k && k.added) {
      const gap = dayDiff(m.released, k.added);
      const later = gap >= 45 ? `, ${Math.floor(gap / 30)} month${Math.floor(gap / 30) === 1 ? "" : "s"} after the fix came out` : "";
      facts.push(`Attacks seen: <b>CISA added it ${esc(niceDate(k.added))}</b>${later}`);
      const n = dayDiff(k.added, k.due);
      if (n !== null) facts.push(`<span class="${n <= 7 ? "urgent" : ""}">CISA gave US agencies ${n} days to patch (by ${esc(niceDate(k.due))})</span>`);
      facts.push(`Ransomware: <b>${k.ransomware ? "seen in ransomware" : "not known"}</b>`);
    } else facts.push("Attacks seen: <b>Microsoft</b>");
    return `<details class="xf"><summary><span class="pill xp">Exploited${k && k.ransomware ? " · ransomware" : ""}</span>` +
      `<span class="nm">${esc(shortName(f))}</span><code>${esc(f.cve)}</code><span class="open">What this means ›</span></summary><div class="xbody">` +
      (imp ? `<span class="pill src">${esc(imp)}</span>` : "") +
      (IMPACT_PLAIN[imp] ? `<p class="means"><b>What this means:</b> ${esc(IMPACT_PLAIN[imp])}</p>` : "") +
      `<div class="facts">${facts.map((x) => `<span>${x}</span>`).join("")}</div>` +
      (k && k.desc ? `<p class="is">CISA's description: "${esc(k.desc)}"</p>` : "") +
      `<p class="is"><a href="https://msrc.microsoft.com/update-guide/vulnerability/${esc(f.cve)}" rel="noopener">Microsoft's page for ${esc(f.cve)}</a></p></div></details>`;
  };
  return `<h3 class="mh">Fixes being exploited</h3><p class="is">Attackers are using these weaknesses. Click one to see what it lets them do. ` +
    `From Microsoft and CISA; neither says who the attackers are, so Patchmap doesn't either.</p>` + [...seen.values()].map(card).join("");
}
function monthBody(m) {
  const list = issuesFor(m.month);
  const notFixed = list.filter((i) => i.status === "open").length;
  const withFix = list.filter((i) => ["mitigated", "fix-rolling-out", "fix-available"].includes(i.status)).length;
  const ex = exCount(m);
  const tile = (n, l, cls) => `<div class="tile ${cls}"><div class="n">${n}</div><div class="tl">${l}</div></div>`;
  const tiles = `<div class="tiles">` +
    tile(m.updates.length, `update${m.updates.length === 1 ? "" : "s"} this month`, "") +
    tile(notFixed, `problem${notFixed === 1 ? "" : "s"} not fixed yet`, notFixed ? "red" : "green") +
    tile(withFix, `problem${withFix === 1 ? "" : "s"} with a fix or workaround`, withFix ? "amber" : "") +
    tile(ex, `fix${ex === 1 ? "" : "es"} being exploited${state.area ? " in " + esc(label(state.area)) : ""}`, ex ? "red" : "green") + `</div>`;
  const isWin = m.updates.some((u) => /^10\.0\./.test(u.build || ""));
  const rows = m.updates.map((u) => `<tr><td class="kbc">${esc(u.kb)}</td><td>${updateType(u)}</td>` +
    (isWin ? `<td class="kbc">${esc((u.build || "").replace(/^10\.0\./, ""))}</td>` : "") +
    `<td>${/^KB\d+$/.test(u.kb) ? `<a href="/kb/${esc(u.kb)}/">Details</a>` : ""}</td></tr>`).join("");
  const ups = m.updates.length ? `<h3 class="mh">Which update do you have?</h3><div class="tablewrap"><table class="ups"><tr><th>Update</th><th>Type</th>` +
    (isWin ? `<th>Build (see <code>winver</code>)</th>` : "") + `<th></th></tr>${rows}</table></div>` : "";
  const probs = `<h3 class="mh">Known problems</h3>` + (list.length ? issuesBlock(list) : `<p class="muted">None listed for this update${state.area ? " in " + esc(label(state.area)) : ""}.</p>`);
  const xfix = exploitedBlock(m);
  const files = swBlock(m) + filesBlock(m);
  // Areas as bars, biggest first; your software's areas pinned on top; only the top 6 until you ask for more
  const pins = swFileTags() || [];
  const areas = Object.entries(m.areas).filter(([t]) => !state.area || t === state.area)
    .sort((a, b) => (pins.includes(b[0]) - pins.includes(a[0])) || ((b[0] === "print") - (a[0] === "print")) * pins.includes(a[0]) || b[1].count - a[1].count);
  const max = Math.max(1, ...areas.map(([, a]) => a.count));
  const bar = ([t, a]) => `<details class="area" data-t="${esc(t)}"><summary><span class="l${pins.includes(t) ? " pin" : ""}">${esc(label(t))}</span>` +
    `<span class="bar"><i style="width:${Math.max(2, Math.round(a.count / max * 100))}%"></i></span><span class="r">${a.count}</span></summary></details>`;
  const SHOW = 6;
  const total = state.area ? (m.areas[state.area] || { count: 0 }).count : m.fix_count;
  const areaHTML = `<h3 class="mh">What it changed: ${total.toLocaleString()} fixes${state.area ? " in " + esc(label(state.area)) : " by area"}</h3>` +
    `<div class="bars">${areas.slice(0, SHOW).map(bar).join("")}` +
    (areas.length > SHOW ? `<div class="more-areas" hidden>${areas.slice(SHOW).map(bar).join("")}</div>` +
      `<button type="button" class="linkbtn" data-moreareas="${areas.length}">Show all ${areas.length} areas ›</button>` : "") + `</div>` +
    `<p class="muted">${pins.length ? "Areas your software relies on are pinned first. " : ""}Click an area to see its fixes.</p>`;
  return `<div class="mbody"><p class="meta">Released ${esc(niceDate(m.released))}</p>${tiles}${ups}${probs}${xfix}${files ? `<h3 class="mh">Files changed</h3>${files}` : ""}${areaHTML}</div>`;
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-moreareas]");
  if (!b) return;
  const box = b.parentElement.querySelector(".more-areas");
  box.hidden = !box.hidden;
  b.textContent = box.hidden ? `Show all ${b.dataset.moreareas} areas ›` : "Show fewer areas";
});

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
          if (kbHit || areaHit || (c + " " + f.title + " " + f.cve + " " + (f.kbs || []).join(" ") + (f.exploited ? " exploited zero-day zero day" : "") + (f.disclosed ? " publicly disclosed" : "") + (f.ransomware ? " ransomware" : "")).toLowerCase().includes(q)) {
            if (!hits.some((h) => h.cve === f.cve)) hits.push(f);
          }
        }
      }
    }
    if (hits.length) { total += hits.length; out.push([m, hits]); }
  }
  const head = `<p class="muted">${total} fixes match “${esc(state.q)}” on ${esc(state.data.label)}${state.area ? " in " + esc(label(state.area)) : ""}.</p>`;
  $("results").innerHTML = kbCard(state.q) + patternHits(state.q).join("") + issueHits.map(issueHTML).join("") + head + out.map(([m, hits]) =>
    `<details class="month"${out[0][0] === m ? " open" : ""}><summary><span class="l">${monthName(m.month)} · ${m.updates.map((u) => `<span class="kb">${esc(u.kb)}</span>${kbBadge(u.kb)}`).join(" ")}</span><span class="r">${hits.length} matches</span></summary>${hits.slice(0, 300).map(fixHTML).join("")}</details>`
  ).join("");
}

document.addEventListener("click", (ev) => {
  const g = ev.target.closest("[data-goto]");
  if (g) {
    ev.preventDefault();
    const d = document.querySelector('details.month[data-i="0"]');
    if (d) {
      d.open = true;
      let tries = 0;
      const go = () => {
        // the month's contents are added just after it opens: wait for the problem card, then scroll to it
        const card = d.querySelector(`[data-issue="${CSS.escape(g.dataset.goto)}"]`);
        if (!card && tries++ < 20) return setTimeout(go, 50);
        const target = card || d;
        target.scrollIntoView({ block: "center" });
        target.classList.add("flash"); setTimeout(() => target.classList.remove("flash"), 1600);
      };
      setTimeout(go, 50);
    }
    return;
  }
  const t = ev.target.closest("[data-swinfo]");
  if (!t) return;
  ev.preventDefault();
  const d = $("swdetails");
  if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
});


// ---- Four ways in: suggestions as you type + "Start from" (update, area, error, file/component) ----
const sg = { mode: "", items: [], active: -1, names: null };
const MODE_HINT = {
  update: "KB5132043 or a build like 26200.9911",
  area: "printing, sign-in, file sharing",
  error: "0xC1, 0x0000011b, event 808",
  file: "localspl.dll or Print Spooler",
};
async function loadNames() {
  if (sg.names === null) sg.names = await getJSON("data/files/names.json").catch(() => ({ families: {}, versions: {} }));
  return sg.names;
}
function fileNamesForVersion() {
  const n = sg.names || { families: {}, versions: {} };
  return n.families[n.versions[state.ver]] || [];
}
function errorItems() {
  const out = [];
  for (const p of (state.tshoot || {}).patterns || []) out.push({ kind: "error", text: p.title, value: p.match[0], note: "guide" });
  const codes = new Map();
  for (const i of state.issues) {
    if (!i.versions.includes(state.ver)) continue;
    for (const c of (i.title + " " + (i.summary || "")).match(/0x[0-9a-f]{6,8}/gi) || []) if (!codes.has(c.toLowerCase())) codes.set(c.toLowerCase(), i.title);
  }
  for (const [c, t] of codes) out.push({ kind: "error", text: c, value: c, note: t.length > 40 ? t.slice(0, 40) + "…" : t });
  return out;
}
function suggest(q, mode) {
  q = (q || "").trim().toLowerCase();
  const groups = [];
  const want = (m) => !mode || mode === m;
  const has = (s) => !q || s.toLowerCase().includes(q);
  if (want("update")) {
    const seen = new Set(), items = [];
    for (const m of state.data.months) for (const u of m.updates) {
      if (seen.has(u.kb)) continue; seen.add(u.kb);
      const b = state.builds.find((x) => x.kb === u.kb && x.version === state.ver);
      if (has(u.kb) || (b && has(b.build))) items.push({ kind: "update", text: u.kb + (kindLabel(u.kb) ? " · " + kindLabel(u.kb) : ""), value: u.kb, note: monthName(m.month) + (b ? " · " + b.build.replace("10.0.", "") : "") });
    }
    if (items.length) groups.push(["Updates", items.slice(0, q ? 5 : 4)]);
  }
  if (want("area")) {
    const present = new Set(state.data.months.flatMap((m) => Object.keys(m.areas)));
    const items = Object.keys(state.tags).filter((t) => present.has(t) && (has(label(t)) || has(t))).map((t) => ({ kind: "area", text: label(t), value: t, note: "area" }));
    if (items.length) groups.push(["Areas", items.slice(0, mode ? 20 : 4)]);
  }
  if (want("error")) {
    const items = errorItems().filter((x) => has(x.text) || has(x.value) || (x.note && q && x.note.toLowerCase().includes(q)));
    if (items.length) groups.push(["Errors and symptoms", items.slice(0, mode ? 12 : 4)]);
  }
  if (want("file")) {
    const comps = new Set();
    for (const m of state.data.months) for (const a of Object.values(m.areas)) for (const c of Object.keys(a.components)) comps.add(c);
    const ci = [...comps].filter((c) => q && c.toLowerCase().includes(q)).slice(0, 4).map((c) => ({ kind: "component", text: c, value: c, note: "part of Windows" }));
    const key = ["spoolsv.exe", "localspl.dll", "win32spl.dll", "kerberos.dll", "lsasrv.dll", "srv2.sys", "mrxsmb.sys", "rpcrt4.dll", "gdi32full.dll"];
    // only Windows program files (not app resources like locales\af.pak); best-known and tagged files first
    const names = fileNamesForVersion().filter(([n]) => !/[\\/]/.test(n) && /\.(dll|exe|sys|drv|cpl|ocx|efi|winmd)$/.test(n));
    const rank = ([n, t]) => (key.includes(n) ? 0 : 2) + (t && t.length ? 0 : 1) + (n.startsWith(q) ? 0 : 3);
    let fi;
    if (!q) fi = names.filter(([n]) => key.includes(n));
    else fi = names.filter(([n]) => n.includes(q)).sort((a, b) => rank(a) - rank(b) || a[0].localeCompare(b[0]));
    fi = fi.slice(0, 6).map(([n, t]) => ({ kind: "file", text: n, value: n, note: t && t.length ? fileTagLabel(t[0]) : "file" }));
    if (ci.length || fi.length) groups.push(["Files and components", ci.concat(fi)]);
  }
  return groups;
}
function showSugg() {
  const box = $("sugg"), input = $("q");
  if (!state.data) return;
  const groups = suggest(input.value, sg.mode);
  sg.items = groups.flatMap(([, items]) => items);
  sg.active = -1;
  if (!sg.items.length) { box.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
  let i = 0;
  box.innerHTML = groups.map(([h, items]) => `<div class="sg-h">${esc(h)}</div>` +
    items.map((x) => `<div class="sg-i" role="option" data-i="${i++}"><span>${esc(x.text)}</span><small>${esc(x.note || "")}</small></div>`).join("")).join("");
  box.hidden = false;
  input.setAttribute("aria-expanded", "true");
}
function hideSugg() { $("sugg").hidden = true; $("q").setAttribute("aria-expanded", "false"); }
function pickSugg(x) {
  hideSugg();
  sg.mode = "";
  document.querySelectorAll("#startfrom .chip").forEach((b) => b.classList.remove("on"));
  if (x.kind === "area") { state.area = x.value; state.q = ""; $("q").value = ""; }
  else { state.q = x.value; $("q").value = x.value; }
  render();
}
function setupSuggest() {
  const input = $("q"), box = $("sugg");
  input.addEventListener("focus", () => { loadNames().then(() => { if (document.activeElement === input) showSugg(); }); });
  input.addEventListener("input", () => { loadNames().then(showSugg); });
  input.addEventListener("blur", () => setTimeout(hideSugg, 150));
  input.addEventListener("keydown", (ev) => {
    if (box.hidden) return;
    const els = box.querySelectorAll(".sg-i");
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      sg.active = (sg.active + (ev.key === "ArrowDown" ? 1 : -1) + els.length) % els.length;
      els.forEach((e, k) => e.classList.toggle("active", k === sg.active));
      els[sg.active].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter" && sg.active >= 0) {
      ev.preventDefault(); pickSugg(sg.items[sg.active]);
    } else if (ev.key === "Escape") { hideSugg(); }
  });
  box.addEventListener("mousedown", (ev) => {
    const el = ev.target.closest(".sg-i");
    if (el) { ev.preventDefault(); pickSugg(sg.items[+el.dataset.i]); }
  });
  // "Compare two builds": fills in a real example for the version on screen (a recent build to the newest one), so
  // people see what the comparison shows and how to type their own.
  const cmp = $("cmpbtn");
  if (cmp) cmp.onclick = () => {
    const key = (b) => b.split(".").map(Number);
    const wb = state.builds.filter((x) => x.version === state.ver && /^10\.0\./.test(x.build))
      .sort((x, y) => { const a = key(x.build), b = key(y.build); return a[2] - b[2] || a[3] - b[3]; });
    if (wb.length < 2) { input.value = ""; input.placeholder = "Compare works for Windows versions: pick one above, then type two builds, e.g. 26200.9445 to 26200.9974"; input.focus(); return; }
    const short = (x) => x.build.replace(/^10\.0\./, "");
    input.value = `${short(wb[Math.max(0, wb.length - 4)])} to ${short(wb[wb.length - 1])}`;
    input.dispatchEvent(new Event("input"));
    input.focus();
  };
  document.querySelectorAll("#startfrom .chip[data-mode]").forEach((b) => (b.onclick = () => {
    const on = sg.mode !== b.dataset.mode;
    sg.mode = on ? b.dataset.mode : "";
    document.querySelectorAll("#startfrom .chip[data-mode]").forEach((x) => x.classList.toggle("on", x === b && on));
    input.placeholder = on ? MODE_HINT[sg.mode] : "print, KB5131090, localspl.dll, 0x80041008, 20348.5870";
    if (on) input.value = "";
    input.focus();
    loadNames().then(showSugg);
  }));
}

// ---- Jump links between the four ways in ----
const jl = (params, text) => `<a class="jl" href="#${new URLSearchParams(Object.assign({ v: state.ver }, params)).toString()}">${esc(text)}</a>`;
function jumpsRow(parts) {
  const bits = parts.filter(([, links]) => links.length).map(([h, links]) => `<span class="jh">${esc(h)}:</span> ${links.join(" ")}`);
  return bits.length ? `<div class="jumps">${bits.join(" ")}</div>` : "";
}
function patternsForFile(name) {
  const base = name.replace(/\.[^.]+$/, "").toLowerCase();
  return ((state.tshoot || {}).patterns || []).filter((p) => (p.files || []).includes(name) || p.match.some((m) => m === base));
}
init().catch((e) => { $("months").innerHTML = `<p class="muted">Couldn't load the data (${esc(e.message)}). Try refreshing.</p>`; });
