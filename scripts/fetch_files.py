"""
Verilay Patchmap - which Windows files each monthly update changed.

What it does (plain English):
  For each Windows version, it opens Microsoft's page for each monthly update, follows the
  "Download the file information for cumulative update" link (a CSV list of every file in the
  update), and compares it with the previous month's list. Files whose version changed, or that
  are new, are saved as "changed" and grouped by area using data/file_tags.json.

  Windows 11 24H2, 25H2 and 26H2 share the same update and the same files, so one list covers all three.
  Language files (.mui) are counted but not listed, to keep the lists readable.

It only downloads lists it hasn't processed yet, and remembers the last month's list in
data/files/<family>/_latest.json.gz, so the weekly refresh downloads about one list per Windows version.

Run (from the patchmap folder):
    py scripts\\fetch_files.py              (next months not yet processed; first run: last 3 months)
    py scripts\\fetch_files.py --months 6   (first run: go back further)
    py scripts\\fetch_files.py --retag      (re-apply data/file_tags.json to saved results only)
"""

import argparse
import csv
import gzip
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "files"
CACHE = ROOT / "cache" / "files"
UA = {"User-Agent": "Mozilla/5.0 (patchmap-fetch/0.1)"}
FAMILIES = {  # which versions share one update / one file list
    "win11-26100": ["win11-24h2", "win11-25h2", "win11-26h2"],
    "server-2025": ["server-2025"],
    "server-2022": ["server-2022"],
    "server-2019": ["server-2019"],
    "server-2016": ["server-2016"],
}
A_TAG = re.compile(r'<a href="(https://go\.microsoft\.com/fwlink/\?LinkId=\d+)"[^>]*>(.*?)</a>', re.I | re.S)


def get(url, binary=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def file_list_csv(kb):
    """Download (or read from cache) Microsoft's file list for one update. None if there isn't one."""
    p = CACHE / f"{kb}.csv"
    if p.exists():
        return p.read_text(encoding="utf-8-sig", errors="replace")
    page = get(f"https://support.microsoft.com/help/{kb[2:]}")
    # Microsoft words it differently per page ("for cumulative update KB…", "for this cumulative
    # update KB…", "for update KB…"), so take the file-information link whose text names this KB.
    url = None
    for href, text in A_TAG.findall(page):
        if kb.lower() in re.sub(r"\s+", "", text).lower() and "ssu" not in text.lower():
            url = href
            break
    if not url:
        return None
    raw = get(url, binary=True)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(raw)
    return raw.decode("utf-8-sig", "replace")


def vkey(v):
    try:
        return tuple(int(x) for x in v.split("."))
    except ValueError:
        return (0,)


def manifest(text):
    """file name -> highest version, x64 files only."""
    files, section = {}, ""
    for line in text.splitlines():
        if line and not line.startswith('"'):
            section = line.lower()
            continue
        if "x64" not in section or "arm64" in section:
            continue
        row = next(csv.reader(io.StringIO(line)), [])
        if len(row) < 6 or row[0] == "File name":
            continue
        name, ver = row[0].lower(), row[1]
        if not vkey(ver)[0]:
            ver = "sha1:" + row[5][:12]  # not versioned: use part of the file hash
        if name not in files or vkey(ver) > vkey(files[name]):
            files[name] = ver
    return files


def tagger():
    rules = json.loads((DATA / "file_tags.json").read_text(encoding="utf-8"))["tags"]
    rules = [(t, re.compile(rx)) for t, rx in rules.items()]
    return lambda n: [t for t, rx in rules if rx.search(n)]


def monthly_kbs(family):
    """[(month, [candidate KBs, best first])] oldest first, from the main data."""
    ver = FAMILIES[family][0]
    d = json.loads((DATA / "versions" / f"{ver}.json").read_text(encoding="utf-8"))
    out = []
    for m in reversed(d["months"]):
        ups = sorted(m["updates"], key=lambda u: (u.get("type") == "Security Update", vkey(u.get("build") or "0")), reverse=True)
        out.append((m["month"], [u["kb"] for u in ups]))
    return out


def save_result(family, kb, month, prev_kb, old, new, tag):
    changed, added, mui = [], [], 0
    for n, v in new.items():
        if n.endswith(".mui"):
            mui += n not in old or old[n] != v
            continue
        if n not in old:
            added.append({"n": n, "v": v, "t": tag(n)})
        elif old[n] != v:
            changed.append({"n": n, "o": old[n], "v": v, "t": tag(n)})
    by_tag = {}
    for f in changed + added:
        for t in f["t"] or ["other"]:
            by_tag[t] = by_tag.get(t, 0) + 1
    res = {"kb": kb, "family": family, "versions": FAMILIES[family], "month": month, "compared_with": prev_kb,
           "counts": {"changed": len(changed), "added": len(added), "language_files": mui, "total_files": len(new)},
           "by_tag": dict(sorted(by_tag.items(), key=lambda x: -x[1])),
           "changed": sorted(changed, key=lambda f: f["n"]), "added": sorted(added, key=lambda f: f["n"])}
    (OUT / family).mkdir(parents=True, exist_ok=True)
    (OUT / family / f"{kb}.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return res


def write_index():
    idx = {}
    for family, vers in FAMILIES.items():
        for p in sorted((OUT / family).glob("KB*.json")) if (OUT / family).exists() else []:
            r = json.loads(p.read_text(encoding="utf-8"))
            for v in vers:
                idx.setdefault(v, {})[r["month"]] = {"kb": r["kb"], "path": f"data/files/{family}/{p.name}",
                                                     "changed": r["counts"]["changed"] + r["counts"]["added"], "by_tag": r["by_tag"]}
    (OUT / "index.json").write_text(json.dumps(idx, indent=1), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=3, help="first run only: how many recent months to cover")
    ap.add_argument("--retag", action="store_true")
    args = ap.parse_args()
    tag = tagger()
    if args.retag:
        for p in OUT.glob("*/KB*.json"):
            r = json.loads(p.read_text(encoding="utf-8"))
            for f in r["changed"] + r["added"]:
                f["t"] = tag(f["n"])
            by_tag = {}
            for f in r["changed"] + r["added"]:
                for t in f["t"] or ["other"]:
                    by_tag[t] = by_tag.get(t, 0) + 1
            r["by_tag"] = dict(sorted(by_tag.items(), key=lambda x: -x[1]))
            p.write_text(json.dumps(r, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        write_index()
        print("Re-tagged saved results.")
        return

    for family in FAMILIES:
        months = monthly_kbs(family)
        latest_p = OUT / family / "_latest.json.gz"
        latest = json.loads(gzip.decompress(latest_p.read_bytes())) if latest_p.exists() else None
        done = {p.stem for p in (OUT / family).glob("KB*.json")} if (OUT / family).exists() else set()
        if latest:
            start = next((i + 1 for i, (m, _) in enumerate(months) if m == latest["month"]), len(months))
        else:
            start = max(0, len(months) - args.months - 1)  # one extra month as the starting point
        prev = latest
        for month, kbs in months[start:]:
            text, kb = None, None
            for cand in kbs:
                text = file_list_csv(cand)
                if text:
                    kb = cand
                    break
            if not text:
                print(f"  {family} {month}: no file list found ({', '.join(kbs)})")
                continue
            files = manifest(text)
            if prev and kb not in done:
                r = save_result(family, kb, month, prev["kb"], prev["files"], files, tag)
                print(f"  {family} {month} {kb}: {r['counts']['changed']} changed, {r['counts']['added']} new "
                      f"(vs {prev['kb']}); print {r['by_tag'].get('print', 0)}, sign-in {r['by_tag'].get('sign-in', 0)}")
            else:
                print(f"  {family} {month} {kb}: starting point ({len(files)} files)")
            prev = {"kb": kb, "month": month, "files": files}
        if prev:
            latest_p.parent.mkdir(parents=True, exist_ok=True)
            latest_p.write_bytes(gzip.compress(json.dumps(prev).encode("utf-8")))
    write_index()
    print("Done -> data/files/")


if __name__ == "__main__":
    sys.exit(main())
