#!/usr/bin/env python3
"""
Curate widen.py's raw output into something safe to merge into the live map.

WHY THIS EXISTS: widen.py produced 3,087 candidate topics against an existing map of
236 rows / 59 topics. That is 50x the corpus — a flood of long-tail, not a widening.
Worse, the first cut marked every row WINNABLE, which select.js WILL pick up and
publish at 5/week. Handing that over would have the cron writing unvetted autocomplete
output. Raw breadth is not demand.

THE STAGING MODEL:
  WINNABLE   — a small, scored, reviewed set. This is what the cron consumes.
  AMBIGUOUS  — reserve. select.js only counts these (line ~168), never picks them.
               Promote deliberately when the winnable queue runs low again.
  dropped    — everything else. Not merged at all.

SCORING favours what FFX is actually good at: method explanation grounded in Salman's
nuggets. Question/how-to intent scores high; bare noun phrases and ultra-long-tail
score low. Provenance from an already-proven seed topic is weighted, because expanding
around what works beats inventing a new topic space.
"""
import json, re, sys, pathlib, collections

HERE = pathlib.Path(__file__).parent
CAND = HERE / "widen-candidates.json"
RAW = HERE / "widen-raw.jsonl"
MAP = HERE.parent.parent / "docs" / "demand_map.json"
OUT = HERE / "widen-merged.json"

WINNABLE_CAP = 40      # ~8 weeks of runway at 5/week
AMBIGUOUS_CAP = 160    # reserve, never auto-selected

QUESTION = re.compile(r"^(what|how|why|when|where|which|is|are|does|do|can|should)\b")
# DOMAIN GUARD. Alphabet expansion drags in off-topic results — seed "order block"
# + "b" returned Blocksi (a school web filter) and ad-blocker queries. A candidate
# must be anchored in the trading domain, either by carrying its seed phrase or by
# containing real trading vocabulary. Without this ~half the top-scoring rows were junk.
TRADING_VOCAB = re.compile(
    r"\b(forex|fx|trading|trade|trader|market|price|candle|chart|pip|lot|entry|exit|"
    r"stop loss|take profit|risk|reward|drawdown|prop firm|funded|challenge|payout|"
    r"liquidity|order block|fair value gap|fvg|structure|bos|choch|smart money|smc|"
    r"supply|demand|session|london|new york|asian|killzone|timeframe|backtest|"
    r"psychology|journal|position siz|leverage|margin|spread|setup|confluence)\b")
METHOD = re.compile(r"\b(how to|what is|why does|explained|meaning|difference|vs|"
                    r"identify|spot|read|trade|use|find|avoid|fix|improve)\b")
# Signals a page we could not ground in Salman's nuggets, or would not want to write.
UNGROUNDABLE = re.compile(r"\b(pdf|book|course|app|software|website|youtube|reddit|"
                          r"quora|meaning in (hindi|urdu|tamil|telugu|arabic)|"
                          r"in hindi|in urdu|salary|job|vacancy|login|sign up)\b")


def main():
    cands = json.loads(CAND.read_text())
    existing = json.loads(MAP.read_text())

    # which seeds were already proven topics in the live map?
    proven = {r.get("canonical") or r["keyword"] for r in existing
              if r.get("verdict") == "WINNABLE"}
    proven_norm = {re.sub(r"[^a-z0-9 ]", "", p.lower()) for p in proven}

    seed_of = {}
    for line in RAW.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        for s in r["suggestions"]:
            seed_of.setdefault(re.sub(r"\s+", " ", s.strip().lower()), r["seed"])

    scored = []
    for c in cands:
        kw = c["keyword"]
        if UNGROUNDABLE.search(kw):
            continue
        words = kw.split()
        if not (2 <= len(words) <= 6):
            continue

        seed_raw = seed_of.get(kw, "")
        seed_core = re.sub(r"[^a-z0-9 ]", " ", seed_raw.lower()).strip()
        # must carry its seed, or be independently anchored in trading vocabulary
        if seed_core and seed_core in kw:
            anchored = True
        else:
            anchored = bool(TRADING_VOCAB.search(kw))
        if not anchored:
            continue

        score = 0
        if QUESTION.match(kw):
            score += 3                      # question intent — FFX's core shape
        if METHOD.search(kw):
            score += 2                      # method/explanation framing
        if re.sub(r"[^a-z0-9 ]", "", seed_raw.lower()) in proven_norm:
            score += 2                      # expands a topic already proven to win
        tags = [t for t in (c.get("nugget_tags") or "").split(",") if t]
        score += min(len(tags), 2)          # richer nugget overlap = better grounding
        if len(words) in (3, 4):
            score += 1                      # the sweet spot for a standalone article
        if c["cluster"] == "Prop & Risk":
            score += 1                      # closest to the membership funnel

        scored.append((score, kw, c))

    scored.sort(key=lambda x: (-x[0], len(x[1]), x[1]))

    win = [c for _, _, c in scored[:WINNABLE_CAP]]
    amb = [c for _, _, c in scored[WINNABLE_CAP:WINNABLE_CAP + AMBIGUOUS_CAP]]
    for c in win:
        c["verdict"] = "WINNABLE"
    for c in amb:
        c["verdict"] = "AMBIGUOUS"

    merged = win + amb
    OUT.write_text(json.dumps(merged, indent=2))

    print(f"{len(cands)} raw candidates -> {len(merged)} merged "
          f"({len(win)} WINNABLE, {len(amb)} AMBIGUOUS reserve), "
          f"{len(cands) - len(merged)} dropped")
    print(f"  -> {OUT}")
    print(f"\nruntime at 5/week: {len(win)/5:.0f} weeks winnable, "
          f"{(len(win)+len(amb))/5:.0f} weeks including reserve\n")
    print("clusters (winnable):", dict(collections.Counter(c['cluster'] for c in win)))
    print("\nTOP 20 WINNABLE — these are what the cron will publish next:")
    for s, kw, c in scored[:20]:
        print(f"  [{s}] {kw:<48} {c['cluster']:<22} tags={c['nugget_tags']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
