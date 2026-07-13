# Source Swap — video → keyword (SOURCE_MODE)

**Status:** built on branch `keyword-source-swap`, **not deployed**. Nothing here
publishes; the 26 live articles are never touched. Flipping `SOURCE_MODE` back to
`"video"` restores today's exact behaviour with no other change.

## What it does

The pipeline can be sourced two ways, chosen by one env var on `ffx-cron`:

| `SOURCE_MODE` | Cron picks from… | Grounding | Everything downstream |
|---|---|---|---|
| `video` (original) | YouTube back-catalogue | video transcript | unchanged |
| `keyword` (new) | `demand:map` (keyword demand) | Salman's verbatim nuggets | **unchanged** |

Both branches are live in the code. The video path (`processJob`,
`fetchTranscriptSupadata`, queue top-up, etc.) is byte-for-byte intact.

## The four changes (all reversible)

1. **Selection** — in keyword mode the cron replaces Steps 1–3 (find video / top up
   queue / trigger) with `runKeywordSource()`: it takes the next `KEYWORDS_PER_RUN`
   (=2) **winnable, unclaimed, distinct-canonical-topic** targets from `demand:map`,
   marks them claimed, and enqueues one keyword job each. 2/weekday × 5 = **10/week**.
   The shared signals/intelligence steps (4–7) still run in both modes.
2. **Grounding** — the consumer's new `processKeywordJob` skips the transcript and
   builds the article around the target keyword + the matched nuggets
   (`lib/keyword/grounding.js`). The keyword is the demand; the nuggets are the
   E-E-A-T layer, quoted verbatim and cited.
3. **Gate** — the same gate runs, plus a **quote-verification** check
   (`lib/gate/quote-verify.js`): every `<blockquote>` must trace **verbatim** to a
   nugget used to ground the article, or the article hard-fails and cannot publish.
   In video mode no nuggets are passed, so the check is skipped — behaviour unchanged.
4. **Dashboard** — keyword rows render a **demand SEO card** (keyword · volume · KD ·
   cluster · nuggets · gate) instead of a video thumbnail (`dashboard-queue.html`).
   Under `SOURCE_MODE=video` the row is the original thumbnail row.

**The quality gate — not the cadence — is the control.** A keyword job that fails
any gate check is stored with its reason but held from publish. Nothing publishes
without Salman pressing publish (`publish.js` still the sole enforcement point).

## The demand map

- `docs/demand_map.json` — 236 keywords with DataForSEO volume/KD/AI-volume and a
  verdict (WINNABLE / AMBIGUOUS / AI_CANNIBALIZED / DEAD).
- `lib/keyword/seed-data.js` — the committed, deploy-time seed: the 94 useful rows
  (WINNABLE+AMBIGUOUS+AI_CANNIBALIZED; 141 DEAD dropped), each with a `canonical`
  topic so one article is made per distinct topic and variants become enrichment.
- **Runway:** 22 distinct winnable topics ≈ **~2 weeks at 10/week of net-new**, then
  the cron emails you (`WINNABLE_LOW_WATERMARK`) and, when dry, alerts to widen the
  map or drop to enrichment. Keyword *variants* of a claimed topic are never spawned
  as new articles (that is what cannibalised the first 26).

## Go-live (your Cloudflare account — I cannot do these from here)

1. **Merge/deploy the branch.** Push `keyword-source-swap`; the paths-filtered
   GitHub Actions redeploy `ffx-cron` + `ffx-consumer`, Pages redeploys the functions
   + dashboard. (`SOURCE_MODE="keyword"` is already set in `ffx-cron/wrangler.toml`.)
2. **Seed the demand map once:**
   `curl -X POST "https://fortitudefx.com/api/seed-demand-map?key=$GATE_AUDIT_KEY"`
   (GET the same URL any time for a runway check; `&force=1` to re-seed deliberately).
3. **(Recommended) Seed `gate:corpus` from the 26** so similarity/structural have the
   live corpus to compare against — read-only:
   `curl "https://fortitudefx.com/api/gate-audit?key=$GATE_AUDIT_KEY&commit=1"`.
4. **Dry-run first (optional):** set `KEYWORD_DRY_RUN="1"` on `ffx-cron`, let one run
   fire — articles generate + gate but land in `dryrun:keyword:{slug}`, never the
   live queue. Unset it to go live.
5. **Watch** `wrangler tail ffx-cron` on the next weekday 05:00 UTC: it enqueues 2,
   the consumer generates + gates them, and they appear in the queue for review.

## Revert (seconds)

Set `SOURCE_MODE="video"` on `ffx-cron` (or merge `main` back) and redeploy. The
video pipeline resumes exactly as before; `demand:map` and any keyword articles
already generated are left untouched and simply idle.
