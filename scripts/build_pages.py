"""
Verilay Patchmap - builds plain pages that search engines (Google, Bing) can read.

Why: the main explorer is one page that fills itself in with JavaScript, and its links use "#",
so search engines only see an empty shell. This script writes one ordinary HTML page per:
    /kb/KB5131090/              each update (what it fixed, by area; what it replaced; problems)
    /problem/<name>/            each known problem
    /error/0x80041008/          each error code mentioned in a known problem
    /version/server-2022/       each Windows version (its monthly updates, open problems)
plus /sitemap.xml and /robots.txt so search engines can find them all.

Pages are generated fresh on every publish and are NOT saved in the repo (see .gitignore).

Run after the data scripts:
    py scripts\\build_pages.py
"""

import datetime as dt
import html
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE = "https://patchmap.verilay.dev"
OUT_DIRS = ["kb", "problem", "error", "version"]
STATUS = {"open": "Not fixed yet", "mitigated": "Workaround available", "fix-rolling-out": "Fix rolling out",
          "fix-available": "Fix available", "fixed": "Fixed"}
ERR = re.compile(r"0x[0-9A-Fa-f]{8}")
e = lambda s: html.escape(str(s if s is not None else ""), quote=True)


def load(name, default=None):
    p = DATA / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def month_name(mid):
    y, m = mid.split("-")
    return dt.datetime.strptime(m, "%b").strftime("%B") + " " + y


def slug(text, n=60):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", text.lower())).strip("-")[:n].strip("-")


def page(path, title, desc, body, crumbs):
    """Write one page. path like 'kb/KB5131090' -> kb/KB5131090/index.html"""
    url = f"{SITE}/{path}/"
    body = body.replace('<table class="src-table">', '<div class="tablewrap"><table class="src-table">').replace("</table>", "</table></div>")
    nav = " › ".join([f'<a href="/">Patchmap</a>'] + crumbs)
    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)} · Verilay Patchmap</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{url}">
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="application/atom+xml" title="Verilay Patchmap" href="/feed.xml">
<script>try {{ if (localStorage.getItem("pm-theme") === "dark") document.documentElement.dataset.theme = "dark"; }} catch (e) {{}}
// Links to other sites (Microsoft, CISA, GitHub) open in a new tab, so Patchmap stays open
document.addEventListener("click", (ev) => {{ const a = ev.target.closest && ev.target.closest("a[href]");
  if (a && /^https?:$/.test(a.protocol) && a.host !== location.host) {{ a.target = "_blank"; a.rel = "noopener"; }} }});</script>
</head>
<body>
<header class="top"><div class="wrap bar"><a class="brand" href="/">Verilay Patchmap</a>
<nav><a href="/">Explore</a><a href="/about.html">About</a></nav></div></header>
<main class="wrap page">
<p class="crumbs muted">{nav}</p>
{body}
<p class="muted note">Not Microsoft and not official advice: check Microsoft's own page before acting. Data from the Microsoft Security Update Guide and Windows release health, refreshed weekly.</p>
</main>
<footer class="wrap foot"><span>Open source · <a href="https://github.com/ekbm/patchmap/issues/new">Report a problem</a> · <a href="/about.html#alerts">Get alerts</a></span>
<span>Also by us: <a href="https://verilay.dev" target="_blank" rel="noopener">Verilay</a>, plain-English checks for AI-built apps (opens in a new tab)</span></footer>
</body>
</html>
"""
    f = ROOT / path / "index.html"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(doc, encoding="utf-8")
    return url


def issue_card(i, ver=None, problem_url=None):
    pv = (i.get("by_version") or {}).get(ver, {}) if ver else {}
    st = STATUS.get(i["status"], i["status"])
    title = f'<a href="{problem_url}">{e(i["title"])}</a>' if problem_url else e(i["title"])
    return (f'<div class="issue {e(i["status"])}"><span class="pill {e(i["status"])}">{e(st)}</span>'
            f'<span class="pill src">{"Microsoft" if i.get("origin") == "microsoft" else "Patchmap"}</span>'
            f'<span class="it">{title}</span></div>')


def xpills(f):
    out = ""
    if f.get("exploited"):
        out += f'<span class="pill xp">Exploited{" · ransomware" if f.get("ransomware") else ""}</span>'
    elif f.get("likely"):
        out += '<span class="pill src">More likely to be exploited</span>'
    if f.get("disclosed"):
        out += '<span class="pill dis">Publicly disclosed</span>'
    return out


def xline(fixes, kb):
    n = sum(1 for f in fixes if f.get("exploited"))
    if n:
        return (f'<p class="xp-line"><b>{n} of its {len(fixes)} fixes {"is" if n == 1 else "are"} being exploited</b> '
                f'(Microsoft and CISA). Attackers are using {"this weakness" if n == 1 else "these weaknesses"}: don&#39;t stay without {e(kb)} for long.</p>')
    return f'<p class="muted">None of its {len(fixes)} fixes are known to be exploited (Microsoft and CISA).</p>'


# One plain line per kind of weakness (Microsoft's "impact"). Kept the same as IMPACT_PLAIN in app.js.
IMPACT_PLAIN = {
    "Remote Code Execution": "an attacker could run their own code on the machine. This is the most serious kind of weakness.",
    "Elevation of Privilege": "someone who already has a foothold on the machine (a normal user account, or malware) can make themselves admin. Attackers often use this as the second step of an attack.",
    "Security Feature Bypass": "an attacker can get past a Windows protection that would normally stop or warn you.",
    "Spoofing": "an attacker can make something fake look trustworthy, for example an email or a link, to trick people into acting on it.",
    "Information Disclosure": "an attacker can read information they shouldn't, which can help a bigger attack.",
    "Denial of Service": "an attacker can crash or freeze a service, so it stops working for everyone.",
    "Tampering": "an attacker can change data or settings they shouldn't be able to.",
}


def nice_date(d):
    try:
        x = dt.date.fromisoformat(d)
        return f"{x.day} {x.strftime('%b')} {x.year}"
    except Exception:
        return d or ""


def days_between(a, b):
    try:
        return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days
    except Exception:
        return None


def short_name(f):
    """'Windows Update Stack Elevation of Privilege Vulnerability' -> 'Windows Update Stack'"""
    t = re.sub(r"\s+Vulnerability$", "", f["title"])
    imp = f.get("impact") or ""
    return t[: -len(imp)].strip() if imp and t.endswith(imp) and len(t) > len(imp) else f["title"]


def exploited_card(f, k, fixed_in, fix_released):
    """One exploited fix: a single line; 'What this means' opens on click."""
    imp = f.get("impact") or ""
    facts = [f"Fixed in: <b>{fixed_in}</b>"]
    if k and k.get("added"):
        gap = days_between(fix_released, k["added"]) if fix_released else None
        later = f", {gap // 30} month{'s' if gap // 30 != 1 else ''} after the fix came out" if gap and gap >= 45 else ""
        facts.append(f"Attacks seen: <b>CISA added it {e(nice_date(k['added']))}</b>{later}")
        n = days_between(k["added"], k.get("due"))
        if n is not None:
            facts.append(f'<span class="{"urgent" if n <= 7 else ""}">CISA gave US agencies {n} days to patch (by {e(nice_date(k["due"]))})</span>')
        facts.append("Ransomware: <b>seen in ransomware</b>" if k.get("ransomware") else "Ransomware: <b>not known</b>")
    else:
        facts.append("Attacks seen: <b>Microsoft</b>")
    return (f'<details class="xf"><summary><span class="pill xp">Exploited{" · ransomware" if k and k.get("ransomware") else ""}</span>'
            f'<span class="nm">{e(short_name(f))}</span><code>{e(f["cve"])}</code><span class="open">What this means ›</span></summary>'
            f'<div class="xbody">' + (f'<span class="pill src">{e(imp)}</span>' if imp else "")
            + (f'<p class="means"><b>What this means:</b> {e(IMPACT_PLAIN[imp])}</p>' if imp in IMPACT_PLAIN else "")
            + f'<div class="facts">{"".join(f"<span>{x}</span>" for x in facts)}</div>'
            + (f'<p class="is">CISA&#39;s description: &quot;{e(k["desc"])}&quot;</p>' if k and k.get("desc") else "")
            + f'<p class="is"><a href="{e(f["msrc_url"])}" rel="noopener">Microsoft&#39;s page for {e(f["cve"])}</a></p></div></details>')


def exploited_section(kb, fixes, kev, fix_released):
    xs = [f for f in fixes if f.get("exploited")]
    if not xs:
        return ""
    return ("<h2>Fixes being exploited</h2>"
            "<p class=\"muted\">Attackers are using these weaknesses. Click one to see what it lets them do.</p>"
            + "".join(exploited_card(f, kev.get(f["cve"]), e(kb), fix_released.get(f["cve"])) for f in xs)
            + '<p class="muted">From Microsoft&#39;s Security Update Guide and CISA&#39;s Known Exploited Vulnerabilities list. '
            "Neither says who the attackers are or exactly how they attack, so Patchmap doesn&#39;t either. "
            "CISA&#39;s deadlines are for US government agencies, but they&#39;re a good sign of how urgent a fix is.</p>")


def tshoot_section(kb, fixes, areas, tags, T, is_hotpatch, full_alt):
    """'Something broke after this update?' with generic, careful steps (data/troubleshooting.json)."""
    if not T:
        return ""
    li = lambda xs: "".join(f"<li>{e(x)}</li>" for x in xs)
    crit = sum(1 for f in fixes if (f.get("severity") or {}) and "Critical" in (f.get("severity") or {}).values())
    top = sorted(areas.items(), key=lambda x: -len(x[1]))
    blocks = ""
    for t, fs in top[:4]:
        a = T["areas"].get(t)
        if not a:
            continue
        blocks += (f'<details><summary><span class="l">{e(tags.get(t, t))}</span><span class="r">{len(fs)} fixes</span></summary>'
                   f'<p class="is">Where to look</p><ul class="sw-list">{li(a["logs"])}</ul><p class="is">What to check</p><ul class="sw-list">{li(a["checks"])}</ul>'
                   + (f'<p class="is">Stopgap</p><ul class="sw-list">{li(a["stopgap"])}</ul>' if a.get("stopgap") else "") + "</details>")
    return ("<h2>Something broke after this update?</h2>"
            f'<ul class="sw-list">{li(T["general"])}</ul>'
            + (f'<p><b>Hotpatch:</b> {e(T["hotpatch"])}' + (f" The full update for the same month is {full_alt}." if full_alt else "") + "</p>" if is_hotpatch else "")
            + f"<p><b>Before removing it:</b> {e(kb)} carries {len(fixes)} security fixes{f' ({crit} critical)' if crit else ''}. "
            + f'<a href="#remove">See what removing it costs</a>.</p>'
            + f'<ul class="sw-list">{li(T["uninstall"])}</ul>'
            + (f"<p><b>By area</b>:</p>{blocks}" if blocks else "")
            + '<p class="muted">Not Microsoft advice: check Microsoft&#39;s page for this update before acting.</p>')


def build_key(b):
    return [int(x) for x in str(b).split(".") if x.isdigit()]


def remove_section(kb, ver, fixes, prob_c, tags, kbinfo, ver_builds, kb_link):
    """'Thinking of removing this update?': what you give up, and a safer way if Microsoft (or a Patchmap problem)
    names one. Everything comes from data Patchmap already has; nothing here is hand-written per update."""
    if not fixes or not ver_builds:
        return ""
    sev = lambda f: (f.get("severity") or {}).get(ver) or ""
    crit = sum(1 for f in fixes if sev(f) == "Critical")
    likely = sum(1 for f in fixes if f.get("likely") and not f.get("exploited"))
    expl = [f for f in fixes if f.get("exploited")]
    tile = lambda n, l, c: f'<div class="tile {c}"><div class="n">{n:,}</div><div class="tl">{l}</div></div>'
    tiles = ('<div class="tiles">'
             + tile(len(fixes), "security fixes removed", "red")
             + tile(crit, "of them Critical", "red" if crit else "green")
             + tile(likely, "Microsoft rates &quot;more likely to be attacked&quot;", "amber" if likely else "green")
             + tile(len(expl), "already being exploited by attackers" if expl else "being exploited right now", "red" if expl else "green")
             + "</div>")
    # the area the problem is in, if this update started one
    area_note = ""
    areas = [a for i in prob_c for a in i.get("areas", []) if a != "other"]
    if len(prob_c) == 1 and areas:
        a = areas[0]
        n = sum(1 for f in fixes if a in f.get("tags", []))
        if n:
            area_note = f'<p class="muted">{n} of the fixes are in <b>{e(tags.get(a, a))}</b>, the area with the known problem.</p>'
    # where removing it takes you, and the newest full update for this version
    lst = sorted(ver_builds, key=lambda b: build_key(b["build"]))
    me = next((b for b in lst if b["kb"] == kb), None)
    if not me:
        return ""
    full = lambda b: (kbinfo.get(b["kb"]) or {}).get("kind") not in ("hotpatch", "preview")
    latest = next((b for b in reversed(lst) if full(b)), None)
    if latest and build_key(latest["build"]) <= build_key(me["build"]):
        latest = None
    # a safer way for each problem this update started, only where a fix is named (Microsoft's "fixed by", or a
    # Patchmap problem whose "What to do" names another update); problems with no named fix are left out
    safer, fix_kbs = [], []
    for i in prob_c:
        pv = (i.get("by_version") or {}).get(ver, {})
        fx = [k for k in pv.get("fixed_by", []) if k != kb]
        if fx:
            fix_kbs += [k for k in fx if k not in fix_kbs]
            safer.append(f'<li><b>{e(i["title"])}</b>: Microsoft says {", ".join(kb_link(k) for k in fx)} fixes it.</li>')
        elif i.get("what_to_do") and [k for k in re.findall(r"KB\d+", i["what_to_do"].split("Removing")[0]) if k != kb]:
            fix_kbs += re.findall(r"KB\d+", i["what_to_do"].split("Removing")[0])
            safer.append(f'<li><b>{e(i["title"])}</b>: {e(i["what_to_do"])} <span class="muted">(Patchmap)</span></li>')
    if latest and latest["kb"] not in fix_kbs:
        safer.append(f'<li>Or install the newest full update for this version, {kb_link(latest["kb"])} (build {e(latest["build"].replace("10.0.", ""))}): '
                     "each update includes the fixes of the ones before it.</li>")
    worst = sorted(fixes, key=lambda f: (not f.get("exploited"), not (sev(f) == "Critical" and f.get("likely")), sev(f) != "Critical"))
    worst = [f for f in worst if f.get("exploited") or sev(f) == "Critical"][:4]
    why = lambda f: "Already being exploited" if f.get("exploited") else ("Critical, more likely to be attacked" if f.get("likely") else "Critical")
    lose = ("<details><summary><span class=\"l\">The most serious fixes you&#39;d lose</span></summary><ul class=\"sw-list\">"
            + "".join(f'<li><b>{why(f)}:</b> {e(f["title"])} <a href="{e(f["msrc_url"])}" rel="noopener">{e(f["cve"])}</a></li>' for f in worst)
            + "</ul></details>") if worst else ""
    return (f'<h2 id="remove">Thinking of removing {e(kb)}?</h2>'
            "<p class=\"muted\">What you give up, and whether there&#39;s a safer way.</p>"
            + tiles + area_note
            + f"<p>Removing it leaves this device without these fixes{' (including one attackers are already using)' if len(expl) == 1 else (f' (including {len(expl)} attackers are already using)' if expl else '')}.</p>"
            + (f'<div class="safer"><b>Safer options</b><ul>{"".join(safer)}</ul></div>' if safer else "")
            + lose
            + '<p class="muted">Worked out from Microsoft&#39;s public data (security update guide and Windows release health). '
            "&quot;More likely to be attacked&quot; is Microsoft&#39;s own rating. Not Microsoft advice: check Microsoft&#39;s page before acting.</p>")


def files_section(kb, month, ver, tags):
    """Files this update changed (from scripts/fetch_files.py), grouped by area; 'other' only counted."""
    hp = next((h for h in ((load("files/hotpatch_index.json", {}).get(ver) or {}).get(month) or []) if h["kb"] == kb), None)
    if hp:  # a hotpatch: files patched in memory, not replaced on disk
        r = json.loads((ROOT / hp["path"]).read_text(encoding="utf-8"))
        groups = defaultdict(list)
        for f in r["patches"]:
            for t in f["t"] or ["other"]:
                groups[t].append(f)
        names = dict(tags, rpc="Remote Procedure Call (RPC)", other="Other files")
        parts = "".join(
            f'<details><summary><span class="l">{e(names.get(t, t))}</span><span class="r">{len(fs)} files</span></summary>'
            + "".join(f'<div class="fix"><span class="cve">{e(f["n"])}</span><span class="muted">via {e(f["hp"])} {e(f["v"])}</span></div>' for f in fs)
            + "</details>" for t, fs in sorted(groups.items(), key=lambda x: (x[0] == "other", -len(x[1]))))
        return ("<h2>Files this hotpatch patches in memory</h2>"
                f'<p class="muted">{r["count"]} Windows files are patched in memory, without a restart. The files on disk keep the last '
                "full or baseline update's version until the next one (x64, from Microsoft's file list).</p>" + parts)
    fi = (load("files/index.json", {}).get(ver) or {}).get(month)
    if not fi or fi["kb"] != kb:
        return ""
    r = json.loads((ROOT / fi["path"]).read_text(encoding="utf-8"))
    groups = defaultdict(list)
    for f in r["changed"] + r["added"]:
        for t in f["t"] or ["other"]:
            groups[t].append(f)
    names = dict(tags, rpc="Remote Procedure Call (RPC)", other="Other files")
    parts = []
    for t, fs in sorted(groups.items(), key=lambda x: (x[0] == "other", -len(x[1]))):
        if t == "other":
            parts.append(f'<p class="muted">Plus {len(fs):,} other files.</p>')
            continue
        rows = "".join(f'<div class="fix"><span class="cve">{e(f["n"])}</span><span class="muted">{e(f.get("o") or "new")} → {e(f["v"])}</span></div>' for f in fs)
        parts.append(f'<details><summary><span class="l">{e(names.get(t, t))}</span><span class="r">{len(fs)} files</span></summary>{rows}</details>')
    c = r["counts"]
    return (f"<h2>Files this update changed</h2>"
            f'<p class="muted">Compared with {e(r["compared_with"])}: {c["changed"]:,} files with a new version and {c["added"]:,} new files '
            f'(x64, from Microsoft\'s file list; language files not counted).</p>' + "".join(parts))


def software_section(kb, ver, fixes, software):
    """Which print-management (etc.) software relies on parts of Windows this update changed."""
    out = []
    for sw in software:
        rows = []
        for d in sw["depends_on"]:
            n = sum(1 for f in fixes if f["component"] in d["components"])
            if n:
                rows.append(f"<li>{e(d['name'])}: <b>{n} fix{'es' if n != 1 else ''}</b></li>")
        if rows:
            out.append(f'<li><a href="/#v={e(ver)}&amp;q={e(kb)}&amp;s={e(sw["id"])}">{e(sw["name"])}</a>'
                       f'<ul>{"".join(rows)}</ul></li>')
    if not out:
        return ""
    return ("<h2>Software that relies on parts this update changed</h2>"
            '<p class="muted">Worth checking after installing, not a sign it will break.</p>'
            f'<ul class="sw-list">{"".join(out)}</ul>')


def main():
    for d in OUT_DIRS:
        shutil.rmtree(ROOT / d, ignore_errors=True)
    index = load("index.json")
    labels = index["labels"]
    tags = {k: v["label"] for k, v in load("area_tags.json")["tags"].items()}
    tags["other"] = "Other"
    issues = load("known_issues.json", {"issues": []})["issues"] + load("release_health.json", {"issues": []})["issues"]
    builds = load("builds.json", [])
    fix_by_cve, fix_released = {}, {}
    for m in index["months"]:
        md = load(f"months/{m['month']}.json")
        for f in md["fixes"]:
            fix_by_cve[f["cve"]] = f
            if md.get("released") and (f["cve"] not in fix_released or md["released"] < fix_released[f["cve"]]):
                fix_released[f["cve"]] = md["released"]  # when the fix first came out
    kev = load("kev.json", {})
    updates = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (DATA / "updates").glob("KB*.json")}
    software = [json.loads(p.read_text(encoding="utf-8")) for p in sorted((DATA / "software").glob("*.json")) if p.stem != "index"]
    kbinfo = load("kb_titles.json", {})
    tshoot = load("troubleshooting.json", None)
    KIND = {"hotpatch": "Hotpatch", "baseline": "Baseline", "out-of-band": "Out-of-band", "preview": "Preview"}
    urls = []

    # names for problem pages, and which problems mention which KBs / error codes
    pslug = {i["id"]: (i["id"] if i.get("origin") != "microsoft" else f'{slug(i["title"])}-{i["id"][3:]}') for i in issues}
    purl = lambda i: f'/problem/{pslug[i["id"]]}/'
    kb_problems = defaultdict(lambda: {"caused": [], "fixed": []})
    err_problems = defaultdict(list)
    for i in issues:
        for ver, pv in (i.get("by_version") or {}).items():
            for k in pv.get("caused_by", []):
                if i not in kb_problems[k]["caused"]:
                    kb_problems[k]["caused"].append(i)
            for k in pv.get("fixed_by", []):
                if i not in kb_problems[k]["fixed"]:
                    kb_problems[k]["fixed"].append(i)
        if not i.get("by_version"):  # hand-written problems name a month, not a KB: link that month's updates
            for k, u in updates.items():
                if u["month"] in i.get("months", []) and set(u["versions"]) & set(i["versions"]) and i not in kb_problems[k]["caused"]:
                    kb_problems[k]["caused"].append(i)
        for code in set(c.lower() for c in ERR.findall(" ".join([i["title"], i.get("summary", ""), i.get("status_note", "")]))):
            err_problems[code].append(i)
    # "replaced by": the next build of the same version
    by_ver = defaultdict(list)
    for b in builds:
        by_ver[b["version"]].append(b)
    replaced_by = {}
    for ver, lst in by_ver.items():
        for a, b in zip(lst, lst[1:]):
            replaced_by.setdefault(a["kb"], {})[ver] = b["kb"]
    kb_link = lambda k: f'<a href="/kb/{e(k)}/">{e(k)}</a>' if k in updates else e(k)

    # ---- update pages ----
    for kb, u in updates.items():
        vers = [v for v in u["versions"] if v in labels]
        if not vers:
            continue
        names = ", ".join(labels[v] for v in vers)
        fixes = [fix_by_cve[c] for c in u["fixes"] if c in fix_by_cve]
        areas = defaultdict(list)
        for f in fixes:
            for t in f["tags"]:
                areas[t].append(f)
        rows = "".join(f"<tr><td>{e(labels[v])}</td><td>{e(b)}</td></tr>" for v, b in u["versions"].items() if v in labels)
        repl = ", ".join(kb_link(k) for k in u.get("supersedes", [])) or "not listed"
        newer = sorted({replaced_by.get(kb, {}).get(v) for v in vers} - {None})
        prob_c, prob_f = kb_problems[kb]["caused"], kb_problems[kb]["fixed"]
        area_list = "".join(
            f'<details><summary><span class="l">{e(tags.get(t, t))}</span><span class="r">{len(fs)} fixes</span></summary>'
            + "".join(f'<div class="fix"><a class="cve" href="{e(f["msrc_url"])}" rel="noopener">{e(f["cve"])}</a><span>{e(f["title"])}</span>{xpills(f)}</div>' for f in sorted(fs, key=lambda f: not f.get("exploited")))
            + "</details>"
            for t, fs in sorted(areas.items(), key=lambda x: -len(x[1])))
        top = ", ".join(f"{tags.get(t, t)} ({len(fs)})" for t, fs in sorted(areas.items(), key=lambda x: -len(x[1]))[:4])
        explore = f'/#v={vers[0]}&q={kb}'
        kind = (kbinfo.get(kb) or {}).get("kind", "")
        kind_label = KIND.get(kind)
        if kind == "baseline" and not any(v.startswith(("win11", "server-2025")) for v in vers):
            kind_label = None  # only meaningful where hotpatching is mainstream
        full_alt = ""
        if kind == "hotpatch":
            same = [b for b in builds if b["version"] == vers[0] and b["month"] == u["month"] and b["kb"] != kb
                    and (kbinfo.get(b["kb"]) or {}).get("kind") != "hotpatch"]
            same.sort(key=lambda b: [int(x) for x in b["build"].split(".") if x.isdigit()], reverse=True)
            if same:
                full_alt = kb_link(same[0]["kb"]) + (f' (build {e(same[0]["build"])})' if len(vers) == 1 else "")
        body = (f"<h1>{e(kb)}{f' <span class=\"pill src\">{kind_label}</span>' if kind_label else ''}</h1>"
                + (f'<p class="is">This is a <b>hotpatch</b>: Windows is patched in memory, without a restart.'
                   + (f" The full update for the same month is {full_alt}, which replaces the files on disk." if full_alt else "") + "</p>" if kind == "hotpatch" else "")
                + f'<p class="lead">{e(kind_label or u.get("type") or "Update")} for {e(names)}, {e(month_name(u["month"]))} (released {e(u["released"])}). '
                f'It includes {len(fixes)} security fixes{": most in " + e(top) if top else ""}.</p>'
                + xline(fixes, kb)
                + exploited_section(kb, fixes, kev, fix_released) +
                f'<table class="src-table"><tr><th>Windows version</th><th>Build after installing</th></tr>{rows}</table>'
                f"<p>Replaces: {repl}. "
                + (f"Replaced by: {', '.join(kb_link(k) for k in newer)}. " if newer else "The newest update Patchmap knows for this version. ")
                + f'Restart needed: {e(u.get("restart") or "not stated")}.</p>'
                + ("<h2>Known problems this update started</h2>" + "".join(issue_card(i, vers[0], purl(i)) for i in prob_c) if prob_c else "")
                + ("<h2>Known problems this update fixed</h2>" + "".join(issue_card(i, vers[0], purl(i)) for i in prob_f) if prob_f else "")
                + remove_section(kb, vers[0], fixes, prob_c, tags, kbinfo, by_ver.get(vers[0], []), kb_link)
                + software_section(kb, vers[0], fixes, software)
                + files_section(kb, u["month"], vers[0], tags)
                + tshoot_section(kb, fixes, areas, tags, tshoot, kind == "hotpatch", full_alt)
                + f"<h2>Security fixes by area</h2>{area_list or '<p>No security fixes listed.</p>'}"
                + f'<h2>Links</h2><ul><li><a href="{explore}">Open {e(kb)} in the Patchmap explorer</a></li>'
                f'<li><a href="https://support.microsoft.com/help/{e(kb[2:])}" rel="noopener">Microsoft\'s page for {e(kb)}</a></li>'
                f'<li><a href="{e(u.get("catalog_url") or "")}" rel="noopener">Microsoft Update Catalog</a></li></ul>')
        desc = f"{kb}: {names} {month_name(u['month'])} update. {len(fixes)} security fixes{', most in ' + top if top else ''}; known problems and what it replaced."
        urls.append(page(f"kb/{kb}", f"{kb}: {names}, {month_name(u['month'])}", desc, body,
                         [f'<a href="/version/{vers[0]}/">{e(labels[vers[0]])}</a>', e(kb)]))

    # ---- problem pages ----
    for i in issues:
        vers = [v for v in i["versions"] if v in labels]
        if not vers:
            continue
        st = STATUS.get(i["status"], i["status"])
        rows = ""
        for v in vers:
            pv = (i.get("by_version") or {}).get(v, {})
            caused = pv.get("caused_by") or ([] if i.get("by_version") else
                     sorted(k for k, u in updates.items() if u["month"] in i.get("months", []) and v in u["versions"]))
            c = ", ".join(kb_link(k) for k in caused) or "–"
            f = ", ".join(kb_link(k) for k in pv.get("fixed_by", [])) or "–"
            rows += f'<tr><td><a href="/version/{v}/">{e(labels[v])}</a></td><td>{c}</td><td>{f}</td></tr>'
        codes = sorted(set(c.lower() for c in ERR.findall(" ".join([i["title"], i.get("summary", ""), i.get("status_note", "")]))))
        srcs = "".join(f'<li><a href="{e(s["url"])}" rel="noopener">{e(s["name"])}</a></li>' for s in i.get("sources", []))
        for v in vers:
            u = ((i.get("by_version") or {}).get(v) or {}).get("url")
            if u and u not in srcs:
                srcs += f'<li><a href="{e(u)}" rel="noopener">Microsoft release health ({e(labels[v])})</a></li>'
        about = e(i.get("summary")) or "Microsoft lists this problem on its Windows release health pages. Follow the source link for Microsoft's description and any workaround."
        body = (f'<h1>{e(i["title"])}</h1>'
                f'<p><span class="pill {e(i["status"])}">{e(st)}</span><span class="pill src">{"From Microsoft" if i.get("origin") == "microsoft" else "From news and vendor reports"}</span> '
                f'<span class="muted">checked {e(i.get("checked"))}</span></p>'
                f"<p>{about}</p>" + (f'<p>{e(i["status_note"])}</p>' if i.get("status_note") else "")
                + f'<h2>Windows versions</h2><table class="src-table"><tr><th>Version</th><th>Started with</th><th>Fixed in</th></tr>{rows}</table>'
                + (f"<h2>Error codes</h2><p>{', '.join(f'<a href=\"/error/{c}/\">{c}</a>' for c in codes)}</p>" if codes else "")
                + f"<h2>Sources</h2><ul>{srcs}</ul>")
        desc = f"{st}: {i['title']}. Affects {', '.join(labels[v] for v in vers)}. Which update started it, which fixed it, and sources."
        urls.append(page(f"problem/{pslug[i['id']]}", i["title"], desc, body, ["Known problems", e(i["title"][:60])]))

    # ---- error code pages ----
    for code, plist in err_problems.items():
        body = (f"<h1>Windows update error {e(code)}</h1>"
                f"<p class=\"lead\">Known problems that mention error {e(code)}:</p>"
                + "".join(issue_card(i, None, purl(i)) for i in plist)
                + '<p class="muted">An error code can have several causes. If none of these match your situation, check Microsoft\'s documentation for the code.</p>')
        urls.append(page(f"error/{code}", f"Error {code}", f"Windows update error {code}: known problems that cause it, their status and fixes.", body,
                         ["Error codes", e(code)]))

    # ---- version pages ----
    for ver, name in labels.items():
        d = load(f"versions/{ver}.json", {"months": []})
        open_p = [i for i in issues if ver in i["versions"] and i["status"] != "fixed"]
        rows = "".join(
            f"<tr><td>{e(month_name(m['month']))}</td><td>{', '.join(kb_link(x['kb']) for x in m['updates']) or '–'}</td>"
            f"<td>{', '.join(e(x['build'] or '') for x in m['updates'])}</td><td>{m['fix_count']}</td></tr>" for m in d["months"])
        body = (f"<h1>{e(name)} updates</h1>"
                f'<p class="lead">Monthly security updates for {e(name)} over the last 12 months, with build numbers and known problems.</p>'
                + ("<h2>Known problems not fixed yet</h2>" + "".join(issue_card(i, ver, purl(i)) for i in open_p) if open_p else "")
                + f'<h2>Monthly updates</h2><table class="src-table"><tr><th>Month</th><th>Update</th><th>Build</th><th>Security fixes</th></tr>{rows}</table>'
                + f'<p><a href="/#v={ver}">Explore {e(name)} step by step</a> · <a href="/feeds/{ver}.xml">Alert feed for {e(name)}</a></p>')
        urls.append(page(f"version/{ver}", f"{name} updates and known problems",
                         f"{name}: every monthly security update for the last 12 months, build numbers, security fixes and known problems not fixed yet.", body, [e(name)]))

    # ---- software list for the website's "My software" menu ----
    sw_ids = sorted(p.stem for p in (DATA / "software").glob("*.json") if p.stem != "index")
    (DATA / "software" / "index.json").write_text(json.dumps(sw_ids), encoding="utf-8")

    # ---- sitemap + robots ----
    today = dt.date.today().isoformat()
    core = [f"{SITE}/", f"{SITE}/about.html"]
    (ROOT / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{u}</loc><lastmod>{today}</lastmod></url>\n" for u in core + urls) + "</urlset>\n", encoding="utf-8")
    (ROOT / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n", encoding="utf-8")
    print(f"Done: {len(urls)} pages + sitemap.xml + robots.txt")


if __name__ == "__main__":
    sys.exit(main())
