"""Posts the same companies published from 2023 on: the false-positive probe (docs/66 §8).

The detectors in docs/66 were measured against human posts from before
ChatGPT. A detector in use meets posts written now, by humans who have read
five years of templated content. This fetches, from the same val+test
companies, posts dated 2023-01-01 or later.

Nobody can certify a 2023+ post as human-written, so what these posts measure
is a FLAG RATE, an upper bound on the false-positive rate: any AI-written post
among them raises it.

Discovery: robots.txt `Sitemap:` lines, /sitemap.xml and /sitemap_index.xml,
indexes expanded one level (post/blog/article sitemaps first). A candidate must
sit under the same first path segment as that company's pre-2022 posts in the
release manifest (or on the same blog subdomain), must not be a manifest URL,
and must not carry a sitemap lastmod before 2023.

Filters, the release's where they exist: trafilatura 2.2.0 extraction,
600-2,500 words, English (stopword share), and a publication date from
trafilatura's metadata (htmldate) on or after 2023-01-01. At most PER_DOMAIN
posts per company, seeded order.

Text goes to data/recent/ (gitignored); the ledger (URLs, dates, gate
outcomes, no text) to records/recent_ledger.csv.

  python3 src/fetch_recent.py [--per-domain 4]
"""
from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import json
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import trafilatura

ROOT = Path(__file__).resolve().parent.parent
REL = ROOT / "vendor" / "slopshape"
OUT = ROOT / "data" / "recent"
LEDGER = ROOT / "records" / "recent_ledger.csv"
SEED = 2023_0101
SINCE = "2023-01-01"
UA = {"User-Agent": "Mozilla/5.0 (research replication; jev-playground docs/66)"}
STOP = set("the of and to a in is that for it on with as are this be by or an at from your you can".split())


def get(url: str, timeout: int = 20) -> bytes | None:
    try:
        return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()
    except Exception:  # noqa: BLE001 - a missing sitemap is a normal outcome
        return None


def locs(xml: bytes) -> list[tuple[str, str]]:
    """(loc, lastmod) pairs from a sitemap or sitemap index."""
    t = xml.decode("utf8", "ignore")
    out = []
    for block in re.findall(r"<(?:url|sitemap)>(.*?)</(?:url|sitemap)>", t, re.S):
        loc = re.search(r"<loc>\s*(.*?)\s*</loc>", block, re.S)
        mod = re.search(r"<lastmod>\s*(.*?)\s*</lastmod>", block, re.S)
        if loc:
            out.append((loc.group(1).replace("&amp;", "&"), mod.group(1)[:10] if mod else ""))
    return out


def sitemap_urls(domain: str) -> list[tuple[str, str]]:
    roots = []
    for host in (f"https://{domain}", f"https://www.{domain}"):
        robots = get(f"{host}/robots.txt")
        if robots:
            roots += re.findall(r"(?im)^sitemap:\s*(\S+)", robots.decode("utf8", "ignore"))
        roots += [f"{host}/sitemap.xml", f"{host}/sitemap_index.xml"]
    seen, pages = set(), []
    queue = list(dict.fromkeys(roots))
    fetched = 0
    while queue and fetched < 40:
        sm = queue.pop(0)
        if sm in seen:
            continue
        seen.add(sm)
        xml = get(sm)
        fetched += 1
        if not xml:
            continue
        for loc, mod in locs(xml):
            if re.search(r"\.xml(\.gz)?($|\?)", loc):
                # post/blog/article sitemaps first: they are where the posts are
                (queue.insert(0, loc) if re.search(r"post|blog|article|resource|insight", loc, re.I) else queue.append(loc))
            else:
                pages.append((loc, mod))
    return list(dict.fromkeys(pages))


def section(url: str) -> tuple[str, str]:
    p = urllib.parse.urlsplit(url.replace(":80/", "/"))
    host = p.netloc.lower().removeprefix("www.")
    seg = p.path.strip("/").split("/")[0].lower() if p.path.strip("/") else ""
    return host, seg


def english(text: str) -> bool:
    w = re.findall(r"[a-z']+", text.lower())
    return bool(w) and sum(x in STOP for x in w) / len(w) > 0.2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-domain", type=int, default=4)
    ap.add_argument("--candidates", type=int, default=12, help="fetches per domain at most")
    ap.add_argument("--pace", type=float, default=0.5)
    args = ap.parse_args()

    split = json.load(open(REL / "artifacts/r6/splits.json"))["domain_split"]
    manifest = [r for r in csv.DictReader(open(REL / "fetch/corpus_manifest.csv")) if split.get(r["domain"]) in ("val", "test")]
    known = {r["url"].replace(":80/", "/").rstrip("/").split("//", 1)[-1].lower() for r in manifest}
    sections: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for r in manifest:
        sections[r["domain"]][section(r["url"])] += 1
    domains = sorted(sections)

    OUT.mkdir(parents=True, exist_ok=True)
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    done = {r["domain"] for r in csv.DictReader(open(LEDGER))} if LEDGER.exists() else set()
    fields = ["id", "domain", "url", "lastmod", "date", "words", "kept", "reason"]
    new = not LEDGER.exists()
    lf = open(LEDGER, "a", newline="")
    w = csv.DictWriter(lf, fieldnames=fields)
    if new:
        w.writeheader()
    rng = random.Random(SEED)
    for domain in domains:
        if domain in done:
            continue
        home = {s for s, _ in sections[domain].most_common(2)}
        cands = []
        for loc, mod in sitemap_urls(domain):
            key = loc.rstrip("/").split("//", 1)[-1].lower()
            if key in known or (mod and mod < SINCE):
                continue
            host, seg = section(loc)
            if any(host == h and seg == s and seg for h, s in home) or any(host == h and host != domain and not s for h, s in home):
                cands.append((loc, mod))
        cands.sort()
        rng.shuffle(cands)
        kept = 0
        wrote = False
        for loc, mod in cands[: args.candidates]:
            if kept >= args.per_domain:
                break
            doc_id = hashlib.sha256(loc.encode()).hexdigest()[:16]
            row = {"id": doc_id, "domain": domain, "url": loc, "lastmod": mod, "date": "", "words": "", "kept": False, "reason": ""}
            raw = get(loc, 30)
            time.sleep(args.pace)
            doc = trafilatura.bare_extraction(raw, include_comments=False, with_metadata=True) if raw else None
            if not doc or not doc.text:
                row["reason"] = "fetch_or_extract"
            else:
                n = len(doc.text.split())
                row["date"], row["words"] = doc.date or "", n
                if not doc.date:
                    row["reason"] = "no_date"
                elif doc.date < SINCE:
                    row["reason"] = "before_2023"
                elif not 600 <= n <= 2500:
                    row["reason"] = "length"
                elif not english(doc.text):
                    row["reason"] = "language"
                else:
                    row["kept"] = True
                    kept += 1
                    json.dump({"id": doc_id, "domain": domain, "url": loc, "date": doc.date,
                               "title": doc.title or "", "text": doc.text}, open(OUT / f"{doc_id}.json", "w"))
            w.writerow(row)
            wrote = True
        if not wrote:
            w.writerow({"id": "", "domain": domain, "url": "", "lastmod": "", "date": "", "words": "",
                        "kept": False, "reason": f"no_candidates ({len(cands)})"})
        lf.flush()
        print(f"{domain:32} candidates {len(cands):5d} kept {kept}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
