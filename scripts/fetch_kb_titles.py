"""
Verilay Patchmap - what kind of update each KB is (hotpatch, baseline, out-of-band, preview).

Why: Microsoft's security data calls most updates just "Security Update", but hotpatches
(patch Windows in memory, no restart) behave differently from full cumulative updates.
Microsoft's release information pages list every update with its type, including a hotpatch
calendar that marks each month as "Hotpatch" or "Baseline (Restart)".

Reads 2 pages (Windows 11, Windows Server) and saves data/kb_titles.json:
    {"KB5132043": {"kind": "hotpatch", "builds": ["26200.9911", ...], "type": "2026-11 B"}, ...}
Also counts Microsoft security data marked "Security Hotpatch Update" (e.g. Server 2022 Azure Edition).

Run after fetch_msrc.py:
    py scripts\\fetch_kb_titles.py
"""

import html
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "kb_titles.json"
PAGES = ["https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information",
         "https://learn.microsoft.com/en-us/windows/release-health/windows-server-release-info"]


def cells(row):
    return [html.unescape(re.sub(r"<[^>]+>", "", c)).replace("\xa0", " ").strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]


def main():
    known = {}
    for url in PAGES:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (patchmap-fetch/0.1)"})
        page = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        for row in re.findall(r"<tr>(.*?)</tr>", page, re.S):
            c = cells(row)
            kb = next((x for x in c if re.fullmatch(r"KB\d{6,7}", x)), None)
            if not kb:
                continue
            text = " | ".join(c)
            build = next((x for x in c if re.fullmatch(r"\d{5}\.\d+", x)), None)
            utype = next((x for x in c if re.fullmatch(r"\d{4}[-.]\d{2} \w+", x)), None)
            if "Hotpatch" in text:
                kind = "hotpatch"
            elif "Baseline" in text:
                kind = "baseline"
            elif utype and utype.split()[-1].upper() == "OOB":
                kind = "out-of-band"
            elif utype and utype.split()[-1].upper() == "D":
                kind = "preview"
            else:
                kind = "standard"
            e = known.setdefault(kb, {"kind": kind, "builds": [], "type": utype})
            # a specific label (hotpatch/baseline/OOB/preview) beats "standard" from another table
            if e["kind"] == "standard" and kind != "standard":
                e["kind"] = kind
            if build and build not in e["builds"]:
                e["builds"].append(build)
            if utype and not e.get("type"):
                e["type"] = utype
    # Microsoft's security data also marks some hotpatches (e.g. Windows Server 2022 Azure Edition)
    for p in (DATA / "updates").glob("KB*.json"):
        u = json.loads(p.read_text(encoding="utf-8"))
        if "hotpatch" in (u.get("type") or "").lower():
            known.setdefault(u["kb"], {"kind": "hotpatch", "builds": [], "type": None})["kind"] = "hotpatch"
    OUT.write_text(json.dumps(dict(sorted(known.items())), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    kinds = {}
    for v in known.values():
        kinds[v["kind"]] = kinds.get(v["kind"], 0) + 1
    print(f"Done: {len(known)} updates typed: {kinds}")


if __name__ == "__main__":
    sys.exit(main())
