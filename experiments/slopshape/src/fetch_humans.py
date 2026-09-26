"""Rebuild a sample of the SlopShape human corpus from the posts' live URLs.

The release rebuilds the corpus from Wayback snapshots (fetch/corpus_manifest.csv).
This environment cannot reach web.archive.org, so we fetch each post's *live*
URL instead and keep it only if it still looks like the frozen snapshot: the
trafilatura extraction (same library and version as the release,
trafilatura==2.2.0) must land within +-10% of the manifest's word count and
share most of the title. A live page may have been edited since the snapshot,
and the gate cannot prove it was not; docs/66 declares this as deviation L1.

Sampling: only val+test domains (the release's frozen domain split, so none of
these domains trained the paper's classifier), seeded shuffle, at most
PER_DOMAIN posts per domain, until TARGET posts pass the gate.

The text is copyrighted and is written to data/human/ (gitignored). The
ledger (URLs and gate outcomes, no text) is committed.

  python3 src/fetch_humans.py [--target 60]
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
import time
from pathlib import Path

import trafilatura

ROOT = Path(__file__).resolve().parent.parent
REL = ROOT / "vendor" / "slopshape"
OUT = ROOT / "data" / "human"
LEDGER = ROOT / "records" / "human_ledger.csv"
SEED = 2609_15369
PER_DOMAIN = 2
TOL = 0.10
UA = {"User-Agent": "Mozilla/5.0 (research replication; jev-playground docs/66)"}


def title_overlap(a: str, b: str) -> float:
    ta = set(re.findall(r"[a-z0-9]+", a.lower()))
    tb = set(re.findall(r"[a-z0-9]+", b.lower()))
    return len(ta & tb) / max(1, len(ta))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=60)
    ap.add_argument("--pace", type=float, default=1.0)
    args = ap.parse_args()
    if trafilatura.__version__ != "2.2.0":
        print(f"WARN: trafilatura {trafilatura.__version__}, release pins 2.2.0", file=sys.stderr)

    split = json.load(open(REL / "artifacts/r6/splits.json"))["domain_split"]
    rows = [r for r in csv.DictReader(open(REL / "fetch/corpus_manifest.csv"))
            if split.get(r["domain"]) in ("val", "test")]
    rows.sort(key=lambda r: r["doc_id"])
    random.Random(SEED).shuffle(rows)

    OUT.mkdir(parents=True, exist_ok=True)
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    done = {}
    if LEDGER.exists():
        done = {r["doc_id"]: r for r in csv.DictReader(open(LEDGER))}
    fields = ["doc_id", "domain", "split", "vertical", "url", "snapshot_ts",
              "manifest_words", "live_words", "title_overlap", "kept", "reason"]
    kept = sum(1 for r in done.values() if r["kept"] == "True")
    per_domain: dict[str, int] = {}
    for r in done.values():
        if r["kept"] == "True":
            per_domain[r["domain"]] = per_domain.get(r["domain"], 0) + 1
    new = not LEDGER.exists()
    lf = open(LEDGER, "a", newline="")
    w = csv.DictWriter(lf, fieldnames=fields)
    if new:
        w.writeheader()
    import urllib.request
    for r in rows:
        if kept >= args.target:
            break
        if r["doc_id"] in done or per_domain.get(r["domain"], 0) >= PER_DOMAIN:
            continue
        entry = {"doc_id": r["doc_id"], "domain": r["domain"], "split": split[r["domain"]],
                 "vertical": r["vertical"], "url": r["url"], "snapshot_ts": r["snapshot_ts"],
                 "manifest_words": r["words"], "live_words": "", "title_overlap": "",
                 "kept": False, "reason": ""}
        try:
            req = urllib.request.Request(r["url"].replace(":80/", "/"), headers=UA)
            raw = urllib.request.urlopen(req, timeout=30).read()
            doc = trafilatura.bare_extraction(raw, include_comments=False, with_metadata=True)
        except Exception as e:  # noqa: BLE001 - every failure is a ledger row
            entry["reason"] = f"fetch: {type(e).__name__}"
            doc = None
        time.sleep(args.pace)
        if doc is not None and doc.text:
            lw = len(doc.text.split())
            mw = int(r["words"])
            ov = title_overlap(r["title"], doc.title or "")
            entry["live_words"], entry["title_overlap"] = lw, round(ov, 2)
            if abs(lw - mw) / mw > TOL:
                entry["reason"] = "words"
            elif ov < 0.6:
                entry["reason"] = "title"
            else:
                entry["kept"] = True
                kept += 1
                per_domain[r["domain"]] = per_domain.get(r["domain"], 0) + 1
                json.dump({"doc_id": r["doc_id"], "domain": r["domain"], "vertical": r["vertical"],
                           "title": r["title"], "manifest_words": mw, "text": doc.text},
                          open(OUT / f"{r['doc_id']}.json", "w"))
        elif doc is not None and not entry["reason"]:
            entry["reason"] = "extract"
        w.writerow(entry)
        lf.flush()
        print(f"{kept:3d} {entry['kept']!s:5} {entry['reason']:14} {r['domain']}", file=sys.stderr)
    print(f"kept {kept}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
