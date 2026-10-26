#!/usr/bin/env python3
"""
Widen the FFX keyword demand map — free, keyless, no paid tool.

WHY: `winnableOpenTopics` is down to 6 against a 5/week cron (~1 week of runway).
KEYWORD_SOURCE_SWAP.md anticipated this: "when dry, alerts to widen the map".

METHOD: Google autocomplete (suggestqueries.google.com) — the same free pipeline built
for scout-network/scripts/demand. No DataForSEO call, so new rows carry volume: null.
That is SAFE: select.js:141 sorts by `(b.volume || 0)`, so unscored rows simply sort
after the DataForSEO-scored ones — proven-volume targets keep priority.

THE BOUNDARY (PROPFIRM_BROKER_SCOPE.md 2c / 8.7):
  FFX never names a firm; the prop-firm/broker site always does.
Any candidate containing a tracked firm or broker name is EXCLUDED here. This is the
one place the boundary can break — if entity keywords enter FFX's map, the cron starts
writing FTMO reviews automatically and the two properties cannibalise each other.

DEDUPE: headTopic() is ported verbatim from lib/keyword/select.js so candidates fold
onto the same head topics the live selector uses. A candidate whose topic is already
claimed/published is dropped — that guard is what stopped "fair value gap" and "fair
value gaps" becoming two articles.
"""
import json, re, sys, time, string, urllib.parse, urllib.request, pathlib, collections

HERE = pathlib.Path(__file__).parent
REPO = HERE.parent.parent
MAP = REPO / "docs" / "demand_map.json"
OUT_RAW = HERE / "widen-raw.jsonl"
OUT_NEW = HERE / "widen-candidates.json"

BASE = "https://suggestqueries.google.com/complete/search"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

# ── headTopic — PORTED VERBATIM from lib/keyword/select.js ───────────────────
TOPIC_PREFIXES = [
    'what is a ', 'what is an ', 'what is ', 'what does a ', 'what does ',
    'how to trade ', 'how to spot a ', 'how to spot ', 'how to identify a ',
    'how to identify ', 'how to read ', 'how to ',
    'buy side ', 'buy-side ', 'sell side ', 'sell-side ', 'bullish ', 'bearish ',
]
TOPIC_SUFFIXES = [
    ' look like', ' in trading', ' explained', ' definition', ' examples',
    ' example', ' meaning', ' strategies', ' strategy', ' indicator', ' entry',
    ' times', ' time', ' pdf', ' trading', ' forex',
]


def head_topic(value):
    s = re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9\s-]', ' ', str(value or '').lower().strip()))
    changed = True
    while changed:
        changed = False
        for p in TOPIC_PREFIXES:
            if s.startswith(p) and len(s) > len(p):
                s = s[len(p):]; changed = True
        for suf in TOPIC_SUFFIXES:
            if s.endswith(suf) and len(s) > len(suf):
                s = s[:-len(suf)]; changed = True
        s = s.strip()
    if re.search(r'[a-z]{3,}s$', s) and not re.search(r'(ss|us|is)$', s):
        s = s[:-1]
    return s.strip()


# ── THE BOUNDARY: entity names that belong to the prop-firm/broker site ──────
FIRM_NAMES = [
    "ftmo", "topstep", "apex trader", "apex funding", "fundednext", "funded next",
    "the funded trader", "myfundedfx", "seacrest", "funding pips", "fundingpips",
    "alpha capital", "e8 markets", "e8 funding", "blue guardian", "takeprofit",
    "take profit trader", "earn2trade", "bulenox", "tradeify", "goat funded",
    "maven trading", "funded trading plus", "city traders imperium", "myforexfunds",
    "true forex funds", "the5ers", "5ers", "fxify", "surgetrader", "breakout prop",
    "ic markets", "pepperstone", "saxo", "interactive brokers", "oanda", "fxpro",
    "etoro", "plus500", "cmc markets", "admirals", "exness", "tickmill", "vantage",
    "thinkmarkets", "avatrade", "swissquote", "forex.com", "fbs", "eightcap",
    "fp markets", "axi", "ig index", "ig markets", "xtb", "trading212", "trading 212",
]
FIRM_RE = re.compile(r"\b(" + "|".join(re.escape(f) for f in FIRM_NAMES) + r")\b")

# Method/craft vocabulary — FFX's actual territory. Seeds expand AROUND what already
# works rather than inventing a new topic space.
EXTRA_SEEDS = [
    "liquidity sweep", "order block", "fair value gap", "break of structure",
    "change of character", "market structure shift", "displacement", "inducement",
    "stop hunt", "smart money concepts", "supply and demand zone", "imbalance",
    "premium and discount", "optimal trade entry", "mitigation block", "breaker block",
    "london open", "new york session", "killzone", "asian range", "session timing",
    "risk to reward", "position sizing", "drawdown", "risk management forex",
    "trading psychology", "overtrading", "revenge trading", "trading journal",
    "backtesting forex", "confluence trading", "multi timeframe analysis",
    "trend continuation", "reversal setup", "candlestick confirmation",
]

PATTERNS = ["{t}", "what is {t}", "how to trade {t}", "{t} strategy", "how to identify {t}"]
STOP_JUNK = re.compile(r"\b(pdf|course|discord|telegram|indicator download|ea|robot|"
                       r"signal group|free download|mt4 indicator|mt5 indicator)\b")


def fetch(q):
    req = urllib.request.Request(
        f"{BASE}?{urllib.parse.urlencode({'client': 'firefox', 'q': q, 'hl': 'en'})}",
        headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode("utf-8", "replace"))
        return d[1] if len(d) > 1 and isinstance(d[1], list) else []
    except Exception as e:
        print(f"  !! {q}: {e}", file=sys.stderr)
        return None


def cluster_for(kw):
    k = kw.lower()
    if re.search(r"\b(prop|funded|challenge|payout|drawdown|risk|psychology|journal|position siz)", k):
        return "Prop & Risk"
    if re.search(r"\b(session|london|new york|asian|killzone|time|open)\b", k):
        return "Sessions & Timing"
    if re.search(r"\b(liquidity|sweep|stop hunt|inducement|entry|ote|imbalance)\b", k):
        return "Liquidity & Entries"
    return "Smart Money Concepts"


TAGS = [
    (r"\b(structure|bos|choch|shift|trend)\b", "structure"),
    (r"\b(zone|block|supply|demand|premium|discount|fvg|gap)\b", "zones"),
    (r"\b(risk|drawdown|position siz|stop|lot)\b", "risk"),
    (r"\b(psychology|discipline|journal|overtrad|revenge|patience)\b", "discipline"),
    (r"\b(entry|execution|confirm|trigger)\b", "execution"),
    (r"\b(liquidity|sweep|hunt|inducement)\b", "liquidity"),
    (r"\b(session|london|new york|asian|killzone|timing)\b", "timing"),
]


def tags_for(kw):
    out = [t for rx, t in TAGS if re.search(rx, kw.lower())]
    return ",".join(dict.fromkeys(out)) or "structure"


def main():
    existing = json.loads(MAP.read_text())
    taken = set()
    for r in existing:
        taken.add(head_topic(r.get("canonical") or r.get("keyword")))
    print(f"existing map: {len(existing)} rows, {len(taken)} distinct head topics")

    # seed from what already works, plus the craft vocabulary
    seeds = {head_topic(r.get("canonical") or r["keyword"]) for r in existing
             if r.get("verdict") in ("WINNABLE", "AMBIGUOUS")}
    seeds |= set(EXTRA_SEEDS)
    seeds = sorted(s for s in seeds if s and not FIRM_RE.search(s))
    print(f"{len(seeds)} seed topics -> harvesting")

    raw, n = [], 0
    with OUT_RAW.open("w") as fh:
        for s in seeds:
            queries = [p.format(t=s) for p in PATTERNS]
            queries += [f"{s} {ch}" for ch in string.ascii_lowercase[:8]]
            for q in queries:
                sugg = fetch(q)
                n += 1
                if sugg:
                    fh.write(json.dumps({"seed": s, "query": q, "suggestions": sugg,
                                         "source": "google-autocomplete",
                                         "fetched_at": time.strftime("%Y-%m-%d")}) + "\n")
                    raw.extend(sugg)
                time.sleep(0.1)
            if n % 200 == 0:
                print(f"  {n} requests...", flush=True)

    # ── filter to candidates ────────────────────────────────────────────────
    excluded_firm, excluded_taken, excluded_junk = [], 0, 0
    cand = {}
    for s in raw:
        kw = re.sub(r"\s+", " ", s.strip().lower())
        if not kw or len(kw) < 6 or len(kw.split()) > 8:
            continue
        if FIRM_RE.search(kw):
            excluded_firm.append(kw); continue          # THE BOUNDARY
        if STOP_JUNK.search(kw):
            excluded_junk += 1; continue
        topic = head_topic(kw)
        if not topic or topic in taken:
            excluded_taken += 1; continue
        # Keep the MOST COMPLETE phrasing for a topic, not the shortest. Shortest
        # selected mangled fragments ("how to mitigate", "what is smart concept")
        # over the real query they came from.
        prev = cand.get(topic)
        if prev is None or len(kw.split()) > len(prev.split()):
            cand[topic] = kw

    rows = []
    for topic, kw in sorted(cand.items()):
        rows.append({
            "keyword": kw, "volume": None, "competition": None, "kd": None,
            "ai_volume": None, "ai_ratio": None,
            "verdict": "WINNABLE",
            "cluster": cluster_for(kw), "proprietary_term": None,
            "nugget_tags": tags_for(kw), "status": "open", "article_slug": None,
            "canonical": None,
            "source": "google-autocomplete", "date_checked": time.strftime("%Y-%m-%d"),
        })

    OUT_NEW.write_text(json.dumps(rows, indent=2))
    print(f"\n{n} requests -> {len(raw)} suggestions")
    print(f"  excluded (firm-named, boundary):  {len(set(excluded_firm))}")
    print(f"  excluded (topic already taken):   {excluded_taken}")
    print(f"  excluded (junk):                  {excluded_junk}")
    print(f"  NEW candidate topics:             {len(rows)}  -> {OUT_NEW}")
    print("\n  cluster split:", dict(collections.Counter(r['cluster'] for r in rows)))
    if excluded_firm:
        print("\n  sample firm-named exclusions (these belong to the prop-firm site):")
        for k in sorted(set(excluded_firm))[:10]:
            print(f"      {k}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
