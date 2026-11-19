"""CISA's details for the exploited fixes Patchmap lists -> data/kev.json

Runs after fetch_msrc.py, which downloads CISA's Known Exploited Vulnerabilities list into cache/kev.json.
For each exploited fix in data/months/, keeps only what Patchmap shows under "What this means":
when CISA added it, the deadline it gave US agencies, whether it was used in ransomware, and CISA's
one-line description. Fixes Microsoft marks as exploited but CISA hasn't listed simply have no entry.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
KEV_FILE = ROOT / "cache" / "kev.json"


def main():
    if not KEV_FILE.exists():
        print("cache/kev.json not found (run fetch_msrc.py first); keeping the old data/kev.json")
        return
    kev = {x["cveID"]: x for x in json.loads(KEV_FILE.read_text(encoding="utf-8")).get("vulnerabilities", [])}
    out = {}
    for p in sorted((DATA / "months").glob("*.json")):
        for f in json.loads(p.read_text(encoding="utf-8"))["fixes"]:
            k = kev.get(f["cve"])
            if f.get("exploited") and k:
                out[f["cve"]] = {
                    "added": k.get("dateAdded"),
                    "due": k.get("dueDate"),
                    "ransomware": (k.get("knownRansomwareCampaignUse") or "").lower() == "known",
                    "desc": (k.get("shortDescription") or "").strip(),
                }
    (DATA / "kev.json").write_text(json.dumps(dict(sorted(out.items())), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"data/kev.json: CISA details for {len(out)} exploited fixes")


if __name__ == "__main__":
    main()
