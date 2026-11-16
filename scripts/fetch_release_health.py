"""
Verilay Patchmap - collects Microsoft's known problems from the Windows release health pages.

What it does (plain English):
  Reads Microsoft's public "known issues" and "resolved issues" pages for each Windows version
  in scope, and saves one entry per problem: its title, status (open / workaround / fixed), the
  update that caused it, the update that fixed it, and a link back to Microsoft's page.
  It does NOT copy Microsoft's descriptions; people follow the link for the details.

Run (from the patchmap folder):
    py scripts\\fetch_release_health.py

Writes data/release_health.json. The website merges it with data/known_issues.json
(the hand-written problems).
"""

import datetime as dt
import html
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = "https://learn.microsoft.com/en-us/windows/release-health/"

# Our version name -> Microsoft's page names
PAGES = {
    "win11-24h2": ["status-windows-11-24h2", "resolved-issues-windows-11-24h2"],
    "win11-25h2": ["status-windows-11-25h2", "resolved-issues-windows-11-25h2"],
    "win11-26h2": ["status-windows-11-26h2", "resolved-issues-windows-11-26h2"],
    "server-2022": ["status-windows-server-2022", "resolved-issues-windows-server-2022"],
    "server-2025": ["status-windows-server-2025", "resolved-issues-windows-server-2025"],
}

STATUS = {  # Microsoft's word -> Patchmap status
    "confirmed": "open", "investigating": "open", "reported": "open",
    "mitigated": "mitigated", "mitigated: external": "mitigated",
    "resolved": "fixed", "resolved: external": "fixed",
}

ROW = re.compile(r"<tr><td><div id=\"(\d+)msg\"></div>(.*?)</tr>", re.S)
KB = re.compile(r"KB(\d{6,7})")
DATE = re.compile(r"(\d{4}-\d{2}-\d{2})")
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def fetch(page):
    req = urllib.request.Request(BASE + page, headers={"User-Agent": "Mozilla/5.0 (patchmap-fetch/0.1)"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # page doesn't exist (e.g. no resolved issues yet for a new version)
        raise


def text(fragment):
    return html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split()


def parse(page_html):
    """Yield one dict per row of the summary table at the top of the page."""
    table = page_html.split("<h2 id=\"issue-details\"", 1)[0]
    for msg_id, row in ROW.findall(table):
        cells = re.split(r"</td>\s*<td[^>]*>", row)
        if len(cells) < 4:
            continue
        title_m = re.search(r"<b>(.*?)</b>", cells[0], re.S)
        if not title_m:
            continue
        title = " ".join(text(title_m.group(1)))
        origin_kbs = KB.findall(cells[1])
        origin_date = (DATE.findall(cells[1]) or [None])[-1]
        status_words = " ".join(text(cells[2]))
        status_word = re.sub(r"\s*KB\d+.*$", "", status_words).strip().lower()
        fixed_kbs = KB.findall(cells[2])
        updated = (DATE.findall(cells[3]) or [None])[0]
        yield {
            "msg_id": msg_id, "title": title, "origin_kbs": ["KB" + k for k in origin_kbs],
            "origin_date": origin_date, "ms_status": status_word, "fixed_kbs": ["KB" + k for k in fixed_kbs],
            "updated": updated,
        }


def month_id(date):
    y, m, _ = date.split("-")
    return f"{y}-{MONTHS[int(m) - 1]}"


def main():
    rules = json.loads((DATA / "area_tags.json").read_text(encoding="utf-8"))["tags"]
    rules = [(t, re.compile(r["match"], re.I)) for t, r in rules.items()]
    today = dt.date.today().isoformat()
    issues = {}
    for ver, pages in PAGES.items():
        for page in pages:
            page_html = fetch(page)
            if page_html is None:
                print(f"  {ver}: {page} not found (skipped)")
                continue
            rows = list(parse(page_html))
            print(f"  {ver}: {page}: {len(rows)} issues")
            for r in rows:
                key = f"ms-{r['msg_id']}"
                status = STATUS.get(r["ms_status"], "open" if "resolved" not in r["ms_status"] else "fixed")
                tags = [t for t, rx in rules if rx.search(r["title"])] or ["other"]
                months = [month_id(r["origin_date"])] if r["origin_date"] else []
                e = issues.setdefault(key, {
                    "id": key, "origin": "microsoft", "title": r["title"], "summary": "",
                    "areas": tags, "months": [], "versions": [], "status": status,
                    "ms_status": r["ms_status"].capitalize(),
                    "checked": today, "sources": [{"name": "Microsoft release health", "url": BASE + pages[0]}],
                })
                for field, vals in (("months", months), ("versions", [ver])):
                    for v in vals:
                        if v not in e[field]:
                            e[field].append(v)
                # per-version details, so the website shows only the chosen version's updates and link
                pv = e.setdefault("by_version", {}).setdefault(ver, {"caused_by": [], "fixed_by": [], "url": None})
                pv["caused_by"] = sorted(set(pv["caused_by"]) | set(r["origin_kbs"]))
                pv["fixed_by"] = sorted(set(pv["fixed_by"]) | set(r["fixed_kbs"]))
                if pv["url"] is None or page.startswith("status-"):
                    pv["url"] = f"{BASE}{page}#{r['msg_id']}msgdesc"
                e["updated"] = max(filter(None, [e.get("updated"), r["updated"]]), default=None)

    out = sorted(issues.values(), key=lambda i: i.get("updated") or "", reverse=True)
    (DATA / "release_health.json").write_text(json.dumps({
        "about": "Collected from Microsoft's public Windows release health pages by scripts/fetch_release_health.py. Titles and statuses only; follow the links for Microsoft's details.",
        "checked": today, "issues": out,
    }, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Done: {len(out)} known problems -> data/release_health.json")


if __name__ == "__main__":
    sys.exit(main())
