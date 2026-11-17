"""
Verilay Patchmap - week 2 data script.

What it does (plain English):
  1. Asks Microsoft's free Security Updates API for the last N months of security fixes.
  2. Keeps only Windows fixes for the Windows versions we care about (SCOPE below).
  3. Tags each fix with an "area" (print, sign-in, file sharing...) using data/area_tags.json.
  4. Writes simple JSON files into data/ that the website will read later.

How to run (from the update-explorer folder):
    py scripts\\fetch_msrc.py            (last 12 months)
    py scripts\\fetch_msrc.py --months 3 (last 3 months, quicker)

Downloads are saved in cache/ so re-running is fast. cache/ is NOT backed up (too big).
Only uses Python's built-in tools, nothing to install.
"""

import argparse
import datetime as dt
import json
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

API = "https://api.msrc.microsoft.com/cvrf/v3.0"
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
DATA = ROOT / "data"

# Windows versions in the first version of Patchmap.
# Left = our short name, right = Microsoft's exact product names (Server Core merged in).
SCOPE = {
    "win11-24h2": ["Windows 11 Version 24H2 for x64-based Systems"],
    "win11-25h2": ["Windows 11 Version 25H2 for x64-based Systems"],
    "win11-26h2": ["Windows 11 Version 26H2 for x64-based Systems"],
    "server-2025": ["Windows Server 2025", "Windows Server 2025 (Server Core installation)"],
    "server-2022": ["Windows Server 2022", "Windows Server 2022 (Server Core installation)"],
    "server-2019": ["Windows Server 2019", "Windows Server 2019 (Server Core installation)"],
    "server-2016": ["Windows Server 2016", "Windows Server 2016 (Server Core installation)"],
    # Other Microsoft products support teams look after. "re:" = a pattern, so new versions
    # (e.g. a new SQL Server cumulative update) are picked up without editing this list.
    "exchange": [r"re:^Microsoft Exchange Server (2016|2019|Subscription Edition)"],
    "sql-server": [r"re:^Microsoft SQL Server 20\d\d for x64-based Systems"],
    "m365-apps": [r"re:^Microsoft 365 Apps for Enterprise", r"re:^Microsoft Office (2016 \(|2019 for|LTSC 20\d\d for \d)"],
}

WINDOWS = [v for v in SCOPE if v.startswith(("win", "server"))]
C2R = "Click-to-Run update"  # stands in for a KB number for Microsoft 365 Apps / Office 2021-2024


def product_matches(name, patterns):
    for pat in patterns:
        if pat.startswith("re:") and re.search(pat[3:], name):
            return True
        if name == pat:
            return True
    return False

LABELS = {
    "win11-24h2": "Windows 11 24H2", "win11-25h2": "Windows 11 25H2", "win11-26h2": "Windows 11 26H2",
    "server-2022": "Windows Server 2022", "server-2025": "Windows Server 2025",
    "server-2019": "Windows Server 2019", "server-2016": "Windows Server 2016",
    "exchange": "Exchange Server", "sql-server": "SQL Server", "m365-apps": "Microsoft 365 Apps and Office",
}

IMPACT_SUFFIX = re.compile(
    r"\s+(Remote Code Execution|Elevation of Privilege|Information Disclosure|Denial of Service|"
    r"Security Feature Bypass|Spoofing|Tampering)\s+Vulnerability$"
)


def get_json(url, cache_file=None, refresh=False):
    """Download JSON from Microsoft, or read it from cache/ if we already have it."""
    if cache_file and cache_file.exists() and not refresh:
        return json.loads(cache_file.read_text(encoding="utf-8"))
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "patchmap-fetch/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read().decode("utf-8")
    if cache_file:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(raw, encoding="utf-8")
    return json.loads(raw)


def pick_months(n):
    """The newest n monthly security releases (IDs like '2026-Nov')."""
    listing = get_json(f"{API}/updates", refresh=True)["value"]
    monthly = [u for u in listing if re.fullmatch(r"\d{4}-[A-Z][a-z]{2}", u["ID"])]
    monthly.sort(key=lambda u: u["InitialReleaseDate"])
    return monthly[-n:]


def load_tag_rules():
    rules = json.loads((DATA / "area_tags.json").read_text(encoding="utf-8"))
    return [(tag, re.compile(r["match"], re.I)) for tag, r in rules["tags"].items()]


def tags_for(component, rules):
    found = [tag for tag, rx in rules if rx.search(component)]
    return found or ["other"]


def note(v, note_type):
    for n in v.get("Notes", []):
        if n.get("Type") == note_type:
            return n.get("Value") or n.get("Title")
    return None


KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
KEV = {}  # CVE -> {"added": date, "ransomware": bool}; filled in main()


def load_kev():
    """CISA's Known Exploited Vulnerabilities list: weaknesses attackers are confirmed to be using."""
    try:
        data = get_json(KEV_URL, CACHE / "kev.json", refresh=True)
    except Exception as e:  # keep going without it; the weekly run tries again
        print(f"  CISA list not available ({e.__class__.__name__}); exploited flags use Microsoft's data only")
        return {}
    return {x["cveID"]: {"added": x.get("dateAdded"), "ransomware": (x.get("knownRansomwareCampaignUse") or "").lower() == "known"}
            for x in data.get("vulnerabilities", [])}


def exploit_info(v):
    """Microsoft's 'Exploit Status' (exploited / publicly disclosed / how likely) + CISA's list."""
    out = {}
    for t in v.get("Threats", []):
        if t.get("Type") == 1:
            val = (t.get("Description") or {}).get("Value", "")
            if re.search(r"Exploited:\s*Yes", val):
                out["exploited"] = True
            if re.search(r"Publicly Disclosed:\s*Yes", val):
                out["disclosed"] = True
            if re.search(r"Exploitation More Likely", val):
                out["likely"] = True
            break
    k = KEV.get(v["CVE"])
    if k:
        out["exploited"] = True
        out["kev"] = k["added"]
        if k["ransomware"]:
            out["ransomware"] = True
    return out


def process_month(month, rules, refresh):
    doc = get_json(month["CvrfUrl"], CACHE / f"{month['ID']}.json", refresh)
    released = doc["DocumentTracking"]["InitialReleaseDate"][:10]
    names = {p["ProductID"]: p["Value"] for p in doc["ProductTree"]["FullProductName"]}

    # Microsoft product ID -> our short name, e.g. "12345" -> "server-2022"
    pid_to_ver = {}
    for short, patterns in SCOPE.items():
        for pid, name in names.items():
            if product_matches(name, patterns):
                pid_to_ver[pid] = short
    missing = [s for s in SCOPE if s not in pid_to_ver.values()]

    fixes, kbs = [], {}
    for v in doc["Vulnerability"]:
        title = (v.get("Title") or {}).get("Value") or ""  # a few entries have no title
        component = note(v, 7) or IMPACT_SUFFIX.sub("", title)
        # (Fixes for products outside SCOPE - Linux, Mariner, Edge, etc. - are dropped below,
        # because none of their product IDs are in pid_to_ver.)
        # Microsoft's monthly file also re-lists OLDER fixes it edited this month. Only count a fix
        # in the month it was first published (first revision within 7 days of release day).
        first = min((h.get("Date", "")[:10] for h in v.get("RevisionHistory", []) if h.get("Date")), default=released)
        if first < (dt.date.fromisoformat(released) - dt.timedelta(days=7)).isoformat():
            continue

        severity = {}
        impact = None
        for t in v.get("Threats", []):
            for pid in t.get("ProductID", []):
                if pid in pid_to_ver:
                    desc = (t.get("Description") or {}).get("Value")
                    if not desc:
                        continue
                    if t["Type"] == 3:
                        severity[pid_to_ver[pid]] = desc
                    elif t["Type"] == 0:
                        impact = desc

        fix_kbs = defaultdict(set)  # our version -> KB numbers that fix this
        for r in v.get("Remediations", []):
            kb = str(r.get("Description", {}).get("Value", ""))
            if r.get("Type") == 2 and kb == "Release Notes":
                # Microsoft 365 Apps and Office 2021/2024 update through Click-to-Run: no KB number,
                # just a link to the release notes. Count it as that month's Office update.
                for pid in r.get("ProductID", []):
                    if pid in pid_to_ver:
                        fix_kbs[pid_to_ver[pid]].add(C2R)
                continue
            if r.get("Type") != 2 or not re.fullmatch(r"\d{6,7}", kb):
                continue
            for pid in r.get("ProductID", []):
                if pid not in pid_to_ver:
                    continue
                ver = pid_to_ver[pid]
                fix_kbs[ver].add("KB" + kb)
                k = kbs.setdefault("KB" + kb, {
                    "kb": "KB" + kb, "month": month["ID"], "released": released,
                    "type": r.get("SubType"), "restart": (r.get("RestartRequired") or {}).get("Value"),
                    "catalog_url": r.get("URL"), "versions": {}, "supersedes": set(),
                    "fixes": [],
                })
                k["versions"].setdefault(ver, r.get("FixedBuild"))
                if r.get("Supercedence"):
                    k["supersedes"].update("KB" + s.strip() for s in str(r["Supercedence"]).split(",") if s.strip().isdigit())

        if not fix_kbs:
            continue  # doesn't affect any version in our scope

        fix = {
            "cve": v["CVE"], "title": title, "component": component, "tags": tags_for(component, rules),
            "impact": impact, "severity": severity,
            "customer_action_required": note(v, 6) == "Yes",
            "kbs": {ver: sorted(s) for ver, s in sorted(fix_kbs.items())},
            "msrc_url": f"https://msrc.microsoft.com/update-guide/vulnerability/{v['CVE']}",
        }
        fix.update(exploit_info(v))
        fixes.append(fix)
        for kb in {k for s in fix_kbs.values() for k in s} - {C2R}:
            kbs[kb]["fixes"].append(v["CVE"])

    return {"month": month["ID"], "released": released, "fixes": fixes, "kbs": kbs, "missing_versions": missing}


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False, default=sorted) + "\n", encoding="utf-8")


def assign_kb_months(month_results, all_kbs):
    """Give each update (KB) its real release month.

    Microsoft sometimes adds a NEWER update to an older month's fixes (when it revises them), so
    "the first month a KB appears in" can be wrong. The month's main cumulative update covers
    most of that month's fixes, so: a KB is a month's main update if it fixes at least half of
    that month's fixes for that Windows version. Other KBs (hotpatches, extra releases) take the
    month of the next main update by build number, or the previous one if there is no next.
    """
    released = {r["month"]: r["released"] for r in month_results}
    order = [r["month"] for r in month_results]
    main = {}  # (version, kb) -> month
    seen = defaultdict(set)  # kb -> months it appears in
    for r in month_results:
        for ver in SCOPE:
            fixes = [f for f in r["fixes"] if ver in f["kbs"]]
            counts = defaultdict(int)
            for f in fixes:
                for kb in f["kbs"][ver]:
                    counts[kb] += 1
                    seen[kb].add(r["month"])
            for kb, n in counts.items():
                if fixes and n >= len(fixes) / 2 and (ver, kb) not in main:
                    main[(ver, kb)] = r["month"]
    build_num = lambda b: [int(p) if p.isdigit() else 0 for p in (b or "0").split(".")]
    for ver in SCOPE:
        kbs = sorted((k for k, i in all_kbs.items() if i["versions"].get(ver)), key=lambda k: build_num(all_kbs[k]["versions"][ver]))
        mains = [(build_num(all_kbs[k]["versions"][ver]), main[(ver, k)]) for k in kbs if (ver, k) in main]
        for k in kbs:
            if (ver, k) in main:
                m = main[(ver, k)]
            else:
                b = build_num(all_kbs[k]["versions"][ver])
                nxt = [mm for bb, mm in mains if bb >= b]
                prv = [mm for bb, mm in mains if bb < b]
                m = nxt[0] if nxt and nxt[0] in seen[k] else (prv[-1] if prv else all_kbs[k]["month"])
            # one KB can serve several versions; keep the earliest month any version gives it
            if "month_fixed" not in all_kbs[k] or order.index(m) < order.index(all_kbs[k]["month"]):
                all_kbs[k]["month"] = m
                all_kbs[k]["released"] = released[m]
                all_kbs[k]["month_fixed"] = True
    for i in all_kbs.values():
        i.pop("month_fixed", None)


def write_versions(month_results, all_kbs):
    """One file per Windows version, shaped for the website's drill-down:
    month -> area -> component -> fixes. Newest month first."""
    for ver in SCOPE:
        months_out = []
        for res in reversed(month_results):
            fixes = [f for f in res["fixes"] if ver in f["kbs"]]
            if not fixes:
                continue
            kbs = sorted({k for f in fixes for k in f["kbs"][ver] if all_kbs.get(k, {}).get("month") == res["month"]})
            areas = {}
            for f in fixes:
                for tag in f["tags"]:
                    a = areas.setdefault(tag, {"count": 0, "components": {}})
                    a["count"] += 1
                    a["components"].setdefault(f["component"], []).append({
                        "cve": f["cve"], "title": f["title"], "impact": f["impact"],
                        "severity": f["severity"].get(ver), "kbs": f["kbs"][ver],
                        **{k: f[k] for k in ("exploited", "disclosed", "likely", "kev", "ransomware") if f.get(k)},
                    })
            ups = [{"kb": k, "build": all_kbs[k]["versions"].get(ver), "type": all_kbs[k]["type"],
                    "supersedes": all_kbs[k]["supersedes"]} for k in kbs]
            if any(C2R in f["kbs"][ver] for f in fixes):
                ups.append({"kb": C2R, "build": None, "type": "Microsoft 365 Apps / Office 2021-2024", "supersedes": []})
            months_out.append({
                "month": res["month"], "released": res["released"], "fix_count": len(fixes),
                "exploited_count": sum(1 for f in fixes if f.get("exploited")),
                "updates": ups,
                "areas": dict(sorted(areas.items(), key=lambda x: -x[1]["count"])),
            })
        write_json(DATA / "versions" / f"{ver}.json", {"version": ver, "label": LABELS[ver], "months": months_out})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--refresh", action="store_true", help="re-download even if cached")
    args = ap.parse_args()

    rules = load_tag_rules()
    KEV.update(load_kev())
    print(f"CISA known-exploited list: {len(KEV)} entries")
    months = pick_months(args.months)
    print(f"Fetching {len(months)} months: {months[0]['ID']} .. {months[-1]['ID']}")

    all_kbs, components, index, month_results = {}, {}, [], []
    for m in months:
        res = process_month(m, rules, args.refresh)
        by_tag = defaultdict(int)
        for f in res["fixes"]:
            for t in f["tags"]:
                by_tag[t] += 1
            c = components.setdefault(f["component"], {"component": f["component"], "tags": f["tags"], "months": {}, "kbs": set()})
            c["months"].setdefault(res["month"], []).append(f["cve"])
            c["kbs"].update(k for ks in f["kbs"].values() for k in ks)

        write_json(DATA / "months" / f"{res['month']}.json", {
            "month": res["month"], "released": res["released"], "fix_count": len(res["fixes"]),
            "by_tag": dict(sorted(by_tag.items(), key=lambda x: -x[1])), "fixes": res["fixes"],
        })
        for kb, info in res["kbs"].items():
            if kb in all_kbs:  # same KB listed again in a later month's data
                all_kbs[kb]["fixes"] = sorted(set(all_kbs[kb]["fixes"]) | set(info["fixes"]))
            else:
                all_kbs[kb] = info
        index.append({"month": res["month"], "released": res["released"], "fix_count": len(res["fixes"]),
                      "by_tag": dict(by_tag), "kbs": sorted(res["kbs"])})
        warn = f"  (not in Microsoft's data that month: {', '.join(res['missing_versions'])})" if res["missing_versions"] else ""
        print(f"  {res['month']}: {len(res['fixes'])} Windows fixes in scope, {len(res['kbs'])} KBs{warn}")

        month_results.append(res)

    assign_kb_months(month_results, all_kbs)
    for kb, info in all_kbs.items():
        info["fixes"] = sorted(set(info["fixes"]))
        write_json(DATA / "updates" / f"{kb}.json", info)
    write_json(DATA / "components.json", dict(sorted(components.items())))
    write_json(DATA / "index.json", {
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "source": API, "scope": list(SCOPE), "labels": LABELS, "months": index,
    })
    write_versions(month_results, all_kbs)
    # Every (Windows version, update, build number) we know, for the build number lookup.
    builds = sorted(
        ({"version": ver, "kb": kb, "build": b, "month": info["month"], "released": info["released"], "type": info["type"]}
         for kb, info in all_kbs.items() for ver, b in info["versions"].items() if b),
        key=lambda x: (x["version"], [int(p) if p.isdigit() else 0 for p in x["build"].split(".")]),
    )
    write_json(DATA / "builds.json", builds)
    print(f"Done: {len(all_kbs)} update files, {len(components)} Windows components -> {DATA}")


if __name__ == "__main__":
    sys.exit(main())
