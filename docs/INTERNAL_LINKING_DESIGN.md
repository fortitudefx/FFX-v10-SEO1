# Internal Cross-Linking — Architecture

**Why this is locked before generation:** in-body links are baked into the article at
generation and never rewritten (rewriting indexed pages churns them and risks ranking).
If the architecture is wrong, every article carries the mistake permanently.

## Audit of the 26 (today)

- 70 article→article links, avg 2.7 out, but **relevance-greedy with no structure**:
  chosen by `fetchRelatedArticles` on IDF-weighted tag/transcript overlap.
- **6 orphans** (0 inbound) and **6 dead-ends** (0 outbound) — including the best article,
  `how-to-prepare…london-open`, which is both.
- **No render-time related zone** — `functions/article.js` ends with a Discord CTA only.
- Links point *within a cannibalized corpus*, so the 8 opening-candle near-duplicates
  interlink and read to Google as one thin body. **Linking and consolidation are the same
  problem** — you cannot cleanly link duplicates; consolidate first, then link.

## The cluster model (hub-and-spoke)

Content is organised into **topic clusters** drawn from `FFX_KEYWORD_DEMAND_MAP.md`. Each
cluster is ONE authoritative body of work:

- **Pillar** — one comprehensive canonical page for the cluster's broad topic.
- **Spokes** — specific articles, each targeting one Tier-1/2 keyword. Every spoke links
  **up** to its pillar; the pillar links **down** to its spokes.
- **Sibling links** — a spoke links sideways to 1–2 genuinely-related siblings *within its
  own cluster only*, never across the whole corpus (that is what spreads confusion).

Initial cluster map (each article is BORN into a cluster; its pillar is known before generation):

| Cluster | Pillar (canonical) | Example spokes (Tier-1/2 targets) |
|---|---|---|
| Liquidity & entries | Liquidity Sweep Trading | how to trade a liquidity sweep · why price hits your stop then reverses · how to trade stop hunts |
| Smart money concepts | Smart Money Concepts (the FFX way) | order block vs fair value gap · bos vs choch · what is inducement · order block vs supply & demand |
| Sessions & timing | Trading Session Timing | how to trade the london open · new york session strategy · ict killzone times |
| Prop firms & risk | Passing a Funded Account | best strategy to pass a funded account · prop firm challenge rules · how much to risk per trade |

## Two-layer linking

**Layer 1 — static in-body links (baked once, never rewritten).** Load-bearing, editorial,
in-context. Rules enforced at generation:
- **Mandatory up-link:** every spoke links to its cluster pillar, woven into the prose. This
  is the structural signal that says "this page belongs to the pillar's body of work."
- **≤2 sibling links,** chosen **within the cluster** and by the **TF-IDF metric**
  (`lib/gate/similarity.js`) — genuinely-related pages, not vocabulary matches. Replaces
  `fetchRelatedArticles`' whole-corpus tag overlap.
- Because these are stable (the pillar relationship doesn't change), they never need
  rewriting — protecting indexed pages from churn.

**Layer 2 — render-time "related" zone (computed at request, zero write fan-out).**
- `functions/article.js` renders a **"Continue in {cluster}"** zone after the body from the
  live `articles:index` + the cluster map: the pillar + the 2–3 most recent/relevant sibling
  spokes *currently published*.
- Adding a new spoke makes it appear in its siblings' related zones on their next render —
  **no rewriting any baked body.** The cluster's internal linking grows automatically.

Why both: Layer 1 carries the strongest SEO signal (in-context pillar link) and stays
frozen; Layer 2 grows coverage without ever touching an indexed page.

## Consolidation of the 26 (do first — same problem)

1. Assign each of the 26 to a cluster.
2. Designate the pillar per cluster (strongest existing page, or a new consolidated one).
3. **Collapse duplicates into the pillar via 301** (never `rm`; 301 + drop from sitemap, per
   the FFX rules): the every-candle exact twin → one canonical; the 8 opening-candle
   near-duplicates → the Sessions pillar, which absorbs their substance.
4. Keep genuinely-distinct spokes; re-home under their pillar (up-link baked on next regen,
   related-zone immediate at render).

Result: ~26 mostly-duplicate pages collapse to ~4 pillars + ~8–10 distinct spokes — a clean
cluster tree with no orphans (every spoke links up; every pillar links down via the zone).

## The reader's next step (the funnel)

One search visit must become 2–3 pages, then an email capture:
1. **In-body:** the pillar up-link + 1–2 sibling links let a reader go deeper mid-article.
2. **Related zone:** "Continue in {cluster}" cards keep them on-site after the body.
3. **Inline email capture:** a cluster-relevant capture (joinfree / newsletter — "get the
   {cluster} playbook / weekly breakdowns") placed after the related zone, *then* the Discord
   CTA. Currently `joinfree` is only in nav/popup; this adds a contextual, in-flow capture.

Funnel: search → article → pillar/sibling (2nd–3rd page) → email capture → Discord / bootcamp.

## What this requires building (later, on approval)

- A cluster map (KV `content:clusters` or a committed config): keyword/slug → cluster + pillar.
- Generation change: bake the mandatory pillar up-link + ≤2 in-cluster sibling links (TF-IDF),
  replacing `fetchRelatedArticles`' whole-corpus tag scorer.
- `functions/article.js`: the Layer-2 render-time related zone + inline email capture.
- The consolidation pass (301s + pillar merges) — routed through overlap routing
  (`lib/gate/routing.js`), which already sends over-threshold overlaps to *enrich* the pillar.
