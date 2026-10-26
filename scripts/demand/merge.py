#!/usr/bin/env python3
"""
Merge the APPROVED widened topics into docs/demand_map.json and regenerate
lib/keyword/seed-data.js from it.

Approved by Salman 2026-08-04 (32 keywords / ~25 distinct topics, firm-free).

seed-data.js declares itself AUTO-GENERATED from the demand map, so it is rebuilt
here rather than hand-edited — that header exists because hand-edited canonicals are
what produced duplicate articles ("how to trade fair value gap" + "...gaps").

SAFETY: this touches SOURCE FILES only. The live map lives in KV and is untouched by
this script. Reaching it needs appendDemandTargets() (lib/keyword/seed.js) — a
force-reseed would reset every claimed row and re-generate every published article.
"""
import json, re, pathlib, sys, importlib.util

HERE = pathlib.Path(__file__).parent
REPO = HERE.parent.parent
MAP = REPO / "docs" / "demand_map.json"
SEED = REPO / "lib" / "keyword" / "seed-data.js"
REVIEW = HERE / "widen-review.json"

spec = importlib.util.spec_from_file_location("widen", HERE / "widen.py")
w = importlib.util.module_from_spec(spec); sys.modules["widen"] = w; spec.loader.exec_module(w)


def main():
    existing = json.loads(MAP.read_text())
    approved = json.loads(REVIEW.read_text())["keep"]

    have_kw = {r["keyword"] for r in existing}
    have_topic = {w.head_topic(r.get("canonical") or r["keyword"]) for r in existing}

    added, skipped = [], 0
    for r in approved:
        kw = r["keyword"]
        topic = w.head_topic(kw)
        if kw in have_kw or topic in have_topic:
            skipped += 1
            continue
        have_kw.add(kw); have_topic.add(topic)
        added.append({
            "keyword": kw, "volume": None, "competition": None, "kd": None,
            "ai_volume": None, "ai_ratio": None, "verdict": r["verdict"],
            "cluster": r["cluster"], "proprietary_term": None,
            "nugget_tags": r["nugget_tags"], "status": "open", "article_slug": None,
            # canonical left NULL on purpose — rowTopic() falls back to the keyword and
            # normalises it. Hand-assigning canonicals is what split one topic across
            # several and produced near-duplicate articles.
            "canonical": None,
            "source": "google-autocomplete", "date_checked": "2026-08-04",
        })

    merged = existing + added
    MAP.write_text(json.dumps(merged, indent=2))

    # ── regenerate seed-data.js ──────────────────────────────────────────────
    keep = [r for r in merged if r.get("verdict") in ("WINNABLE", "AMBIGUOUS", "AI_CANNIBALIZED")]
    targets = [{
        "keyword": r["keyword"], "volume": r.get("volume"), "kd": r.get("kd"),
        "verdict": r["verdict"], "cluster": r.get("cluster"),
        "canonical": r.get("canonical") or w.head_topic(r["keyword"]),
        "proprietary_term": r.get("proprietary_term") or "",
        "nugget_tags": r.get("nugget_tags") or "",
    } for r in keep]

    win_topics = len({t["canonical"] for t in targets if t["verdict"] == "WINNABLE"})
    header = (
        "// AUTO-GENERATED from docs/demand_map.json. DO NOT hand-edit — regenerate via\n"
        "// scripts/demand/merge.py. Canonicals normalised via headTopic() (lib/keyword/\n"
        "// select.js) so one real topic never carries several canonicals — that split is\n"
        "// what produced duplicate articles (\"how to trade fair value gap\" + \"...gaps\").\n"
        f"// {len(targets)} targets (WINNABLE+AMBIGUOUS+AI_CANNIBALIZED; DEAD dropped).\n"
        "// Rows with volume:null came from the free autocomplete widening (2026-08-04) —\n"
        "// select.js sorts by (volume||0), so they queue BEHIND the DataForSEO-scored\n"
        "// targets rather than displacing them. verdict WINNABLE = generate;\n"
        "// AMBIGUOUS = manual promote; AI_CANNIBALIZED = skip.\n"
    )
    SEED.write_text(header + "export const SEED_TARGETS = " +
                    json.dumps(targets, separators=(",", ":")) + ";\n" +
                    f"export const WINNABLE_TOPIC_COUNT = {win_topics};\n")

    print(f"demand_map.json: {len(existing)} -> {len(merged)} rows (+{len(added)}, {skipped} already covered)")
    print(f"seed-data.js:    {len(targets)} targets, {win_topics} winnable topics")
    print(f"\nNEW winnable topics added: {sum(1 for a in added if a['verdict']=='WINNABLE')}")
    print("Live KV map is UNCHANGED — needs appendDemandTargets() to apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
