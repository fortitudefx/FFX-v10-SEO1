# FFX — GATE-FINDINGS.md (frozen reference: read-only gate results)

Results of the four read-only gates from `EXECUTION-PLAN.md` steps 1–4, run against production this session. Frozen — supersede with a new dated file, don't overwrite. These are the inputs the destructive steps (CLEAN, P2-idx, P2-301) depend on.

---

## [G0] 5xx RESOLVED — no blocker
Live origin today:
```
https://fortitudefx.com/        → HTTP/2 200
http://www.fortitudefx.com/     → 301 → https://www.fortitudefx.com/
https://www.fortitudefx.com/    → 301 → https://fortitudefx.com/
```
Apex serves **200**; `http://www` is two clean **301s** to the apex. No 5xx reproducible. The GSC "Server error (5xx)" is not present on the live origin (per `SEO-AUDIT.md §C`, 5xx only ever fired on JSON subroutes, never the HTML routes). **No STOP.**

## [GA] SERVING IS INDEPENDENT OF `articles:index` — CLEAN + P2-idx are link-safe
**Verdict: the article renderer never reads `articles:index`.**
- `functions/article.js:840` — only data call is `fetch('/article-content?slug=…')` (read-only subrequest).
- `functions/article-content.js` resolves from: `article:{slug}` (`:30`, 404 if missing `:33`) → `published:{videoId}` (`:47`) → `video:{videoId}` (`:83`) → `video:slug:{slug}` (`:102`) → GitHub-raw `articles.json` → appends `article:links:{slug}` (`:134`) + `newsletter:article_refs:{slug}` (`:181`).
- `grep 'articles:index'` → **0** in `functions/article.js`, **0** in `functions/article-content.js`.

`articles:index` backs the **blog list only**, never article serving. **Deduping/cleaning the index cannot break any `/article?slug=` link.** → CLEAN and P2-idx are cleared (link-safe).
**Caveat:** serving depends on `article:{slug}` existing. CLEAN/P2-idx touch only `articles:index`, not `article:{slug}` — safe. (Deleting `article:{slug}` records WOULD break serving — that is the deliberate Phase-2 article removal, covered by P2-301 redirects.)

## [GB] SHARED-LINK FATE MAP — 13 regional URLs will break
**Where posted URLs live:** the posters (`tweet.js`, `linkedin.js`, `discord.js`, `tumblr.js`) do **0 KV reads/writes** — there is **no dedicated posted-URL log.** Authoritative record = `published:{videoId}` (written by `publish-confirm.js:172+`): `platforms.{x,linkedin,discord,tumblr}.status` = social permalink (proves posted); shared article URL = `https://fortitudefx.com/article?slug=${slug}` (`publish-confirm.js:99`). Reconstructed via read-only `/press-data`.

**Tally:** 23 published records → **29 shared article URLs → 16 survive (global), 13 regional will break.**

### The 13 regional URLs that WILL 404 → recommended 301 target (global parent)
> **CRITICAL:** build this map from each record's `globalContent.slug ↔ regionalContent.slug` pairing — **NOT** by suffix-stripping. The `match-…` row proves it: stripping `-us` does not yield the real parent slug, so a naive strip would 301 to a 404.

| Regional URL shared (posted x/linkedin/discord) | → 301 global parent | strip-safe? |
|---|---|---|
| `/article?slug=catch-the-wick-bootcamp-mechanical-forex-trading-sea-asia` | `catch-the-wick-bootcamp-mechanical-forex-trading` | yes |
| `/article?slug=forex-risk-management-rules-that-matter-us-canada` | `forex-risk-management-rules-that-matter` | yes |
| `/article?slug=fractal-trading-strategy-multiple-timeframes-gcc` | `fractal-trading-strategy-multiple-timeframes` | yes |
| `/article?slug=how-to-prepare-for-forex-trading-day-before-london-open-sea-asia` | `how-to-prepare-for-forex-trading-day-before-london-open` | yes |
| `/article?slug=liquidity-sweep-entry-strategy-bearish-momentum-sea` | `liquidity-sweep-entry-strategy-bearish-momentum` | yes |
| `/article?slug=match-trading-strategy-personality-lifestyle-us` | `match-trading-strategy-to-personality-lifestyle` | **NO — slug differs (`-to-`, no `-us`)** |
| `/article?slug=momentum-candle-continuation-probability-forex-trading-gcc` | `momentum-candle-continuation-probability-forex-trading` | yes |
| `/article?slug=open-candle-trading-strategy-institutional-intent-eu-uk-germany` | `open-candle-trading-strategy-institutional-intent` | yes |
| `/article?slug=opening-candle-continuation-setup-forex-session-direction-gcc` | `opening-candle-continuation-setup-forex-session-direction` | yes |
| `/article?slug=opening-candle-continuation-setup-forex-session-direction-us-canada` | `opening-candle-continuation-setup-forex-session-direction` | yes |
| `/article?slug=opening-candle-continuation-strategy-direction-eu` | `opening-candle-continuation-strategy-direction` | yes |
| `/article?slug=opening-candle-continuation-strategy-forex-gcc` | `opening-candle-continuation-strategy-forex` | yes |
| `/article?slug=why-trading-strategy-fails-execution-not-strategy-eu` | `why-trading-strategy-fails-execution-not-strategy` | yes |

All 13 global parents exist and were themselves posted (in the 16 survivors), so 301-to-parent is clean for every one. Per owner **D1** 404s are allowed; per **D2** the recommendation is to **301 all 13**.

**Boundary:** this covers only URLs posted through the publish-confirm pipeline. Anything posted **manually** (outside the pipeline) is logged nowhere and is invisible to this map.

## [TQ] targetQuery SELECTION — delegated to the LLM, not deterministic
Not hard-coded first-in-list, not a code-side highest-opportunity computation:
- `intelligence-engine.js:474-475` — rising queries fed to the model **in stored order** (no re-sort), each with `impressions` + `position`.
- `:455` — instruction `'2. Identify the highest-ROI opportunities across all platforms'`.
- `:864` — required JSON `'"targetQuery": "exact search query to target"'`; code consumes `brief.articleBrief.targetQuery` (`:359`, `:612`) — **no `risingQueries[0]`, no max/sort to force the pick.**

**Verdict:** soft-guided LLM discretion. The model sees the metrics and is told to pick highest-ROI, but nothing in code guarantees the genuine maximum (nor forces first-in-list). Deterministic targeting would require a code change (pre-score + force the top query) — flagged for engine-tuning, not a blocker.

---
*Read-only gates. No code, KV, or live site changed by capturing these findings.*
