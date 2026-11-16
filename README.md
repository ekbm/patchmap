# Verilay Patchmap

**See what each Windows update touched, step by step.** Pick your Windows version, open an update,
then open an area (printing, sign-in, file sharing...) to see the security fixes in it. Known
problems caused by updates are shown at the top, with links to their sources.

**Live site: https://patchmap.verilay.dev**

Free and open source. Not affiliated with Microsoft.

**Status: v0.1.** Covers Windows 11 24H2 / 25H2 / 26H2 and Windows Server 2016 / 2019 / 2022 / 2025, plus Exchange Server, SQL Server and Microsoft 365 Apps / Office, last 12 months. Build number lookup and two-build comparison in the search box. Alert feeds: [feed.xml](https://patchmap.verilay.dev/feed.xml) (all) or one per version in [feeds/](feeds/).

## Coming next

- An optional **"my software"** filter (starting with print management tools) that narrows the view
  to the Windows features that software relies on
- More known problems

## Help out

- **Found a problem an update caused?** [Open an issue](../../issues/new) with the update number,
  Windows version, symptom/error code and a link to a source.
- **An area tag looks wrong?** Edit [`data/area_tags.json`](data/area_tags.json) and send a pull request.

## Run it yourself

Needs Python 3 (nothing to install).

```
py scripts\fetch_msrc.py          # refresh the data (last 12 months)
py -m http.server 8765            # then open http://localhost:8765
```

On macOS/Linux use `python3` instead of `py`. The data refreshes automatically every Wednesday via
GitHub Actions ([.github/workflows/site.yml](.github/workflows/site.yml)).

## What's in `data/`

| File | What's in it |
|---|---|
| `versions/<version>.json` | What the website reads: month → area → component → fixes |
| `files/` | Files each monthly update changed (from Microsoft's file lists), made by `scripts/fetch_files.py` |
| `known_issues.json` | Known problems, written by hand, each with sources |
| `release_health.json` | Microsoft's own known problems (titles, status, update numbers, links), collected by `scripts/fetch_release_health.py` |
| `area_tags.json` | Rules that turn Microsoft's component names into areas |
| `index.json` | One line per month: release date, fix counts, update numbers |
| `months/`, `updates/`, `components.json` | The same data organised by month, by update (KB), and by component |

Notes: security fixes only (non-security bugs go in `known_issues.json` by hand). A month can list
older updates that Microsoft also names as fixing that month's issues.

## Licence

Code: [MIT](LICENSE). Data: see [LICENSE-DATA.md](LICENSE-DATA.md).
More from [Verilay](https://verilay.dev).
