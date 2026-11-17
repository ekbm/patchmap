"""
Verilay Patchmap - builds the alert feeds (Atom format, works in any RSS/feed reader).

What it does (plain English):
  Reads the data the other two scripts made and writes:
    feed.xml                    everything: known problems + each month's updates, all versions
    feeds/<version>.xml         the same, for one Windows version only (e.g. feeds/server-2022.xml)
  A known problem that changes status (open -> fixed) shows up as a NEW item ("Now fixed: ..."),
  so subscribers notice.

Run after fetch_msrc.py and fetch_release_health.py:
    py scripts\\build_feed.py
"""

import datetime as dt
import json
import sys
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE = "https://patchmap.verilay.dev/"
MAX_ITEMS = 60
STATUS = {"open": "Not fixed yet", "mitigated": "Workaround available", "fix-rolling-out": "Fix rolling out",
          "fix-available": "Fix available", "fixed": "Now fixed"}


def load(name, default):
    p = DATA / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def ts(date):
    """'2026-11-10' -> '2026-11-10T00:00:00Z'"""
    return (date or dt.date.today().isoformat())[:10] + "T00:00:00Z"


def month_name(mid):
    """'2026-Nov' -> 'November 2026'"""
    y, m = mid.split("-")
    return dt.datetime.strptime(m, "%b").strftime("%B") + " " + y


def site_link(ver, q):
    return f"{SITE}#v={quote(ver)}&q={quote(q)}"


def issue_items(issues, labels, only=None):
    items = []
    for i in issues:
        vers = [v for v in i["versions"] if v in labels and (only is None or v == only)]
        if not vers:
            continue
        ver = vers[0]
        pv = (i.get("by_version") or {}).get(ver, {})
        caused = pv.get("caused_by") or i.get("caused_by") or []
        fixed = pv.get("fixed_by") or i.get("fixed_by") or []
        status = STATUS.get(i["status"], i["status"])
        kbs = (f" Started with {', '.join(caused)}." if caused else "") + (f" Fixed in {', '.join(fixed)}." if fixed else "")
        body = " ".join(filter(None, [i.get("summary"), i.get("status_note")])) + kbs
        srcs = [s["url"] for s in i.get("sources", [])]
        if pv.get("url"):
            srcs = [pv["url"]]
        items.append({
            "id": f"tag:patchmap.verilay.dev,2026:issue:{i['id']}:{i['status']}",
            "title": f"{status}: {i['title']}",
            "updated": ts(i.get("updated") or i.get("checked")),
            "link": site_link(ver, caused[0] if caused else i["title"][:40]),
            "summary": f"{body.strip()} Affects: {', '.join(labels[v] for v in vers)}. "
                       f"Source: {srcs[0] if srcs else 'see Patchmap'}. "
                       f"From {'Microsoft release health' if i.get('origin') == 'microsoft' else 'Patchmap (news and vendor reports)'}.",
            "category": "known-problem",
        })
    return items


def update_items(labels, only=None):
    items = []
    for ver in labels:
        if only and ver != only:
            continue
        d = load(f"versions/{ver}.json", {"months": []})
        for m in d["months"]:
            ups = m["updates"]
            kb = ", ".join(u["kb"] + (f" (build {u['build']})" if u.get("build") else "") for u in ups) or "update number not listed"
            top = sorted(m["areas"].items(), key=lambda x: -x[1]["count"])[:5]
            areas = ", ".join(f"{a} {v['count']}" for a, v in top)
            items.append({
                "id": f"tag:patchmap.verilay.dev,2026:update:{ver}:{m['month']}",
                "title": f"{labels[ver]}: {month_name(m['month'])} security update {', '.join(u['kb'] for u in ups)}".strip(),
                "updated": ts(m["released"]),
                "link": site_link(ver, ups[0]["kb"] if ups else ""),
                "summary": f"{kb}. {m['fix_count']} security fixes. Biggest areas: {areas}.",
                "category": "monthly-update",
            })
    return items


def write_feed(path, title, self_url, items):
    items = sorted(items, key=lambda x: (x["updated"], x["id"]), reverse=True)[:MAX_ITEMS]
    updated = items[0]["updated"] if items else ts(None)
    out = ['<?xml version="1.0" encoding="utf-8"?>',
           '<feed xmlns="http://www.w3.org/2005/Atom">',
           f"  <title>{escape(title)}</title>",
           "  <subtitle>Known problems and monthly security updates for Windows, from Verilay Patchmap. Not affiliated with Microsoft.</subtitle>",
           f'  <link rel="self" href="{escape(self_url)}"/>',
           f'  <link rel="alternate" href="{SITE}"/>',
           f"  <id>{escape(self_url)}</id>",
           f"  <updated>{updated}</updated>",
           "  <author><name>Verilay Patchmap</name></author>"]
    for it in items:
        out += ["  <entry>",
                f"    <id>{escape(it['id'])}</id>",
                f"    <title>{escape(it['title'])}</title>",
                f"    <updated>{it['updated']}</updated>",
                f'    <link href="{escape(it["link"])}"/>',
                f'    <category term="{it["category"]}"/>',
                f"    <summary>{escape(it['summary'])}</summary>",
                "  </entry>"]
    out.append("</feed>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return len(items)


def main():
    labels = load("index.json", {}).get("labels", {})
    issues = load("known_issues.json", {"issues": []})["issues"] + load("release_health.json", {"issues": []})["issues"]
    n = write_feed(ROOT / "feed.xml", "Verilay Patchmap: Windows updates and known problems",
                   SITE + "feed.xml", issue_items(issues, labels) + update_items(labels))
    print(f"feed.xml: {n} items")
    for ver, name in labels.items():
        n = write_feed(ROOT / "feeds" / f"{ver}.xml", f"Verilay Patchmap: {name}",
                       f"{SITE}feeds/{ver}.xml", issue_items(issues, labels, ver) + update_items(labels, ver))
        print(f"feeds/{ver}.xml: {n} items")
    build_area_feeds(labels, issues)


def area_month_items(area, area_label, labels, only=None):
    """One item per (version, month) where this area had fixes: counts, top parts, files changed."""
    files_idx = load("files/index.json", {})
    items = []
    for ver in labels:
        if only and ver != only:
            continue
        d = load(f"versions/{ver}.json", {"months": []})
        for m in d["months"]:
            a = m["areas"].get(area)
            if not a:
                continue
            kbs = ", ".join(u["kb"] for u in m["updates"])
            parts = sorted(a["components"].items(), key=lambda x: -len(x[1]))[:4]
            parts_txt = "; ".join(f"{c} ({len(fx)})" for c, fx in parts)
            files_txt = ""
            fi = (files_idx.get(ver) or {}).get(m["month"])
            if fi and fi.get("by_tag", {}).get(area):
                r = json.loads((ROOT / fi["path"]).read_text(encoding="utf-8"))
                names = [f["n"] for f in r["changed"] + r["added"] if area in f["t"]]
                key = ("spool", "localspl", "win32spl", "printui", "ntprint", "kerberos", "lsasrv", "msv1_0", "srv2", "mrxsmb", "rpcrt4")
                names.sort(key=lambda n: (not n.startswith(key), n))  # the best-known files first
                files_txt = f" Files changed ({len(names)}): {', '.join(names[:8])}{'…' if len(names) > 8 else ''}."
            items.append({
                "id": f"tag:patchmap.verilay.dev,2026:area:{area}:{ver}:{m['month']}",
                "title": f"{labels[ver]}: {area_label} in the {month_name(m['month'])} update ({a['count']} fixes)",
                "updated": ts(m["released"]),
                "link": f"{SITE}#v={quote(ver)}&a={quote(area)}",
                "summary": f"{kbs or 'Update'}: {a['count']} security fixes in {area_label}. Biggest parts: {parts_txt}.{files_txt}",
                "category": "area-update",
            })
    return items


def build_area_feeds(labels, issues):
    """feeds/<area>/<version>.xml and feeds/<area>/all.xml, plus a list for the website's feed picker."""
    tags = {k: v["label"] for k, v in load("area_tags.json", {"tags": {}})["tags"].items()}
    available = {}
    for area, area_label in tags.items():
        area_issues = [i for i in issues if area in i.get("areas", [])]
        for ver in list(labels) + ["all"]:
            only = None if ver == "all" else ver
            items = area_month_items(area, area_label, labels, only) + issue_items(area_issues, labels, only)
            if not items:
                continue
            title = f"Verilay Patchmap: {area_label}" + ("" if ver == "all" else f" on {labels[ver]}")
            write_feed(ROOT / "feeds" / area / f"{ver}.xml", title, f"{SITE}feeds/{area}/{ver}.xml", items)
            available.setdefault(area, []).append(ver)
    (DATA / "feeds_index.json").write_text(json.dumps({"areas": {a: tags[a] for a in available}, "available": available}, indent=1), encoding="utf-8")
    print(f"area feeds: {sum(len(v) for v in available.values())} across {len(available)} areas")


if __name__ == "__main__":
    sys.exit(main())
