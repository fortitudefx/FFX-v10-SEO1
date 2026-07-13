# Gate Calibration

Thresholds and metric choices for the quality gate (`lib/gate/`), calibrated against
the live 26-article corpus. Operational scores come from the live gate, never this doc.

## Similarity — TF-IDF (unigram + bigram) cosine, threshold ≤ 0.55

Raw unigram cosine was too blunt: every forex article shares the same vocabulary, so
the metric had a high floor and genuinely-distinct articles false-failed.

**Distribution over the 26 (pairwise), before vs after:**

| | p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|
| unigram cosine (old) | 0.81 | 0.89 | 0.91 | 0.95 | 1.00 |
| **TF-IDF uni+bigram (new)** | **0.44** | **0.55** | **0.65** | **0.77** | **1.00** |

TF-IDF down-weights shared vocabulary (high document-frequency → low IDF) and bigrams
almost never overlap across genuinely different topics, so the two populations separate:

- **True duplicates stay high:** the exact twin (`every-candle…` / `why-every-candle…`) = **1.00**; the "opening candle" cannibalization cluster = **0.76–0.77**.
- **Legit-distinct pairs drop:** risk-management vs fractal `0.86 → 0.51`; London-prep vs every-candle `→ 0.28`.

**Threshold = 0.55** (the corpus p90) cleanly separates them: distinct content sits ≤0.55,
true duplicates sit ≥0.76. The gap between is deliberately biased toward *enrich* (below).

## Structural diversity — composite skeleton, threshold ≤ 0.55

Secondary backstop (fail-open). Catches "same skeleton, topic swapped" that the content
cosine could miss. Set to 0.55 per the acceptance standard.

## Voice — banned-openings veto + compliance score ≥ 70

Verifies FFX's *preventive* voice system held; it does not re-grade with an independent
LLM (which could fight the tuned prompts). Two parts:

- **Banned-openings check (HARD veto):** scans the full body — every heading and sentence
  opener — for the banned phrases. A prompt alone leaked 2 of 5 in the batch test
  (`This is why…`, `Most traders…`); the check catches both. The list + the
  `intelligence:voice_calibration` correction loop are now also wired into the *article*
  generation prompt (previously social-only).
- **Compliance score (≥70):** first-person register (30) + FFX trading register (30) +
  restraint (20, ≥2 hype signals to fail so a single debunk doesn't misfire) +
  correction-loop respected (20).

## Anti-fabrication — hard-fail, fail-closed

Unchanged. Invented win-rates/probabilities/backtests/sample sizes veto the publish; an
unverifiable result (judge unreachable) also blocks. Nothing ships on an unchecked claim.

## Overlap routing — enrich vs new (`lib/gate/routing.js`)

The enrich line **is** the similarity threshold (0.55). A draft that overlaps an existing
canonical page above it **enriches that page** (same slug, re-gated) instead of spawning a
rival — the structural fix for "26 articles on 4 concepts". When in doubt, the
conservative bias is to enrich, not proliferate.
