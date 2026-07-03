# FortitudeFX — Backend SEO Audit

**Scope:** Every Pages Function (`functions/`, `functions/api/`) + the four Workers (`ffx-consumer`, `ffx-cron`, `ffx-email-worker`, `ffx-social-scanner`), scored by effect on **indexing / ranking / penalty-risk**, with KEEP / FIX / REMOVE dispositions.
**Method:** Re-derived from source this session. Usage proven by `grep -rl` reference counts across `*.html`, `ffx-*/`, `functions/` (a route referenced in 0 files outside its own definition = ORPHAN). Confidence labels: **[EVIDENCE-BACKED]** = provable from `file:line` + a documented Google rule; **[REASONED-JUDGMENT]** = defensible argument, not proven fact. Unprovable claims tagged **[UNVERIFIED]**.
**Disposition rule applied:** REMOVE only if it HURTS SEO with no offsetting purpose, OR is genuinely orphaned. NEUTRAL-but-does-a-real-job = KEEP.

---

## Section 1 — Function Inventory

### Pages Functions — `functions/` (root)

| Function | Route / Trigger | Reads → Writes (KV / external) | USED? (proof) |
|---|---|---|---|
| `submit.js` | POST `/submit` | Turnstile verify; Brevo `/v3/contacts`, `/v3/smtp/email` | USED — 6 files (joinfree/waitlist/contact) |
| `notify.js` | POST `/notify` | R `video:{id}`,`lock:generating`; W `job:{id}`; Brevo email; Queue send | USED — `notify.html` |
| `generate.js` | POST `/generate` | R `lock:generating`; W `job:{id}`; `ffx_generate_queue.send` | USED — 10 files |
| `generate-status.js` | GET `/generate-status` | R `job:{id}`,`video:{id}` | USED — 3 files |
| `queue.js` | GET/POST/DELETE `/queue`,`/queue/topup`,`/reorder` | R/W `queue:index`; R `video:{id}`,`published:{id}`; YouTube Data API (topup) | USED — 12 files |
| `publish.js` | POST `/publish` | W `article:{slug}`,`articles:index`,`content:performance:{slug}`,`platform:performance:*`; **GitHub Contents API → `sitemap.xml`** | USED — 7 files |
| `publish-confirm.js` | POST `/publish-confirm` | calls `/publish`,`/tweet`,`/linkedin`,`/discord`,`/tumblr`; W `published:{id}`; del `video:{id}`,`regen:*`; triggers `/api/health-check` | USED — 4 files |
| `press-data.js` | GET `/press-data` | R `published:*` (list),`queue:index`,`video:{id}` | USED — 3 files |
| `press-publish.js` | POST `/press-publish` | R `published:{id}`,`regen:*`; calls `/publish-confirm`; del `queue-edits:{id}`, edits `queue:index` | USED — 4 files |
| `save-edits.js` | POST `/save-edits` | R/W `video:{id}` or `published:{id}.pendingEdits` | USED — 4 files |
| `kv-status.js` | POST `/kv-status` | R `video:{id}`,`published:{id}` | USED — 3 files |
| `articles.js` | GET `/articles` | R `articles:index`,`article:{slug}` | USED — 13 files (`blog.html`) |
| `article-content.js` | GET `/article-content` | R `article:{slug}`,`published:{id}`,`video:{id}`,`article:links:{slug}`,`newsletter:article_refs:{slug}`; GitHub raw `articles.json` fallback | USED — `article.html`, `_middleware.js` |
| `discord.js` | POST `/discord` | Discord webhook; GitHub raw fallback | USED — 28 files |
| `linkedin.js` | POST `/linkedin` | LinkedIn `ugcPosts`; GitHub raw fallback | USED — 19 files |
| **`linkedin-test.js`** | GET `/linkedin-test` | LinkedIn `/v2/userinfo` (debug echo) | **ORPHAN — 0 references** |
| `tweet.js` | POST `/tweet` | X `/2/tweets` (OAuth1); GitHub raw fallback | USED — 12 files |
| `tumblr.js` | POST `/tumblr` | Tumblr `/v2/blog/.../post` (OAuth1); GitHub raw fallback | USED — 19 files |
| `_middleware.js` | all GET (acts on `/article`,`/newsletter-issue`) | calls `/article-content`,`/api/newsletter`; rewrites `<head>` | USED — runs site-wide |

### Pages Functions — `functions/api/`

| Function | Route | Reads → Writes | USED? |
|---|---|---|---|
| `intelligence-engine.js` | GET/POST `/api/intelligence-engine` | R all signal keys; W `intelligence:brief`,`intelligence:brief_log:{date}`,`seo:learning:summary` | USED — 4 |
| `indexing-engine.js` | GET/POST/PATCH `/api/indexing-engine` | R `article:*`; Search Console URL-Inspection; **Google Indexing API submit**; W `indexing:status/history/pending` | USED — 2 |
| `seo-signals.js` | GET/POST `/api/seo-signals` | Search Console search-analytics; W `seo:signals`,`seo:learning`,`content:performance:*`,`seo:title_tests:*` | USED — 6 |
| `ga4-signals.js` | GET/POST `/api/ga4-signals` | GA4 Data API; W `ga4:signals`,`ga4:learning` | USED — 4 |
| `social-intelligence.js` | GET/POST `/api/social-intelligence` | Claude web-search; W `intelligence:opportunities:*`,`intelligence:signals` | USED — 2 |
| `health-check.js` | GET/POST `/api/health-check` | R ~30 KV keys; W `health:results:{date}`,`health:history` | USED — 3 |
| `seed-targets.js` | GET/POST `/api/seed-targets` | R/W `intelligence:targets` | USED — 3 |
| `nuggets.js` | GET/POST/DELETE `/api/nuggets` | R/W `nuggets:index`,`nugget:{id}` | USED — 2 |
| `parked-queue.js` | GET/POST `/api/parked-queue` | R/W `queue:parked` | USED — 2 |
| `directive-feedback.js` | POST `/api/directive-feedback` | W `intelligence:brief_log:{date}`,`intelligence:directive_outcome:*` | USED — 3 |
| `directive-history.js` | GET `/api/directive-history` | R `intelligence:directive_outcome:*` | USED — 2 |
| `newsletter.js` | GET `/api/newsletter` | R `newsletter:issue/index/draft/progress/performance` | USED — 8 |
| `newsletter-generate.js` | GET/POST `/api/newsletter-generate` | R `newsletter:last_sent`; W progress; Queue send | USED — 2 |
| `newsletter-publish.js` | GET/PATCH/POST `/api/newsletter-publish` | Brevo campaigns; W `newsletter:issue/index/last_sent/performance/article_refs` | USED — 2 |
| `newsletter-performance.js` | GET/POST `/api/newsletter-performance` | Brevo campaign stats; W `newsletter:performance:{date}` | USED — 2 |
| `article-link.js` | POST `/api/article-link` | W `article:links:{slug}`,`articles:index.internalLinks`,`intelligence:directive_outcome:*` | USED — 2 |
| `bulk-link-scan.js` | GET/POST `/api/bulk-link-scan` | R `articles:index`,`content:link_graph:*`; W `article:links:*` | USED — 2 |
| `backfill-articles-index.js` | GET/POST `/api/backfill-articles-index` | R `article:*`,`published:{id}`; W `articles:index` | USED — 3 |
| `regenerate-platform.js` | POST `/api/regenerate-platform` | R `transcript:{id}`,`published:{id}`; Claude; W `regen:{id}:{platform}` | USED — 5 |
| `restore-platform.js` | POST `/api/restore-platform` | R/W `published:{id}`; del `regen:*` | USED — 2 |
| `regen-status.js` | GET/DELETE `/api/regen-status` | R/del `regen:{id}:{platform}` | USED — 2 |
| `queue-edits.js` | GET/POST `/api/queue-edits` | R/W `queue-edits:{id}` | USED — 3 |
| `queue-remove.js` | POST `/api/queue-remove` | R/W `queue:index` | USED — 2 |
| `video-content.js` | GET `/api/video-content` | R `video:{id}`,`regen:*` | USED — 3 |
| `title-test.js` | GET/POST `/api/title-test` | **W `article:{slug}.title`,`articles:index.title`**,`seo:title_tests:*`,`intelligence:directive_outcome:*` | USED — 3 |
| `youtube-generate.js` | GET/POST `/api/youtube-generate` | W `job:{id}`,`youtube:yt:jobId:{id}`; Queue send | USED — 2 |
| `youtube-metadata.js` | GET/POST `/api/youtube-metadata` | R ~11 signal keys; Claude; W `youtube:metadata:{id}`,`intelligence:brief_log:{date}` | USED — 3 |
| `youtube-signals.js` | GET/POST `/api/youtube-signals` | YouTube Data/Analytics API; W `youtube:published/performance/title:learning/signals` | USED — 2 |
| `youtube-analytics.js` | GET/POST `/api/youtube-analytics` | YouTube Analytics API; W `youtube:analytics:signals` | USED — 3 |
| `youtube-thumbnail.js` | POST `/api/youtube-thumbnail` | Leonardo.ai; W `youtube:metadata:{id}` | USED — 2 |
| `thumbnail-proxy.js` | GET `/api/thumbnail-proxy` | proxies Leonardo/GCS image bytes | USED — 2 |
| `google-auth.js` | GET `/api/google-auth` | Google OAuth refresh; R/W `google:access_token*` | USED — 6 |

### Workers

| Worker | Trigger | Reads → Writes | USED? |
|---|---|---|---|
| `ffx-cron` | cron `0 5 * * MON-FRI` | maintains `queue:index`; `FFX_QUEUE.send`; calls `/api/seo-signals`,`/api/ga4-signals`,`/api/intelligence-engine` (cron `index.js:71,86,169`); W `youtube:search:global:signals`,`intelligence:targets` | USED — scheduled |
| `ffx-consumer` | queue consumer `ffx-generate-queue` | Supadata transcript; **Claude article+platform generation**; W `video:{id}`,`content:performance/link_graph`,`nugget:*` | USED — queue |
| `ffx-email-worker` | cron `0 3 * * *` (+30s) | Brevo List 4 drip; R/W `email:log:*` | USED — scheduled |
| `ffx-social-scanner` | HTTP POST (via `SOCIAL_SCANNER_URL`) | Claude web-search; W `intelligence:opportunities:*`,`intelligence:signals` | USED — called by `social-intelligence.js` |

---

## Section 2 — Per-Function Scorecard

Format: **SEO verdict · confidence · usage · disposition** — reason.

**Directly SEO-relevant (the ones that matter):**

- `publish.js` — **HELPS · [EVIDENCE-BACKED] · USED · KEEP** — writes `articles:index` (internal-link source) and rebuilds `sitemap.xml` via GitHub (`publish.js:104,226-255`); the discovery backbone. *(Caveat: emits duplicate `<loc>` — a content defect of the output, not grounds to remove the function.)*
- `articles.js` — **HELPS · [EVIDENCE-BACKED] · USED · KEEP** — `/articles` is the blog-list/discovery feed (`articles.js:41`).
- `article-content.js` — **HELPS · [EVIDENCE-BACKED] · USED · KEEP** — serves the article body + metadata consumed by `_middleware.js` for crawler `<head>` (`article-content.js:30,193`).
- `_middleware.js` — **HELPS (by design) · [EVIDENCE-BACKED] · USED · KEEP/FIX** — the only server-side crawler-`<head>` injector (`_middleware.js:48-64`). KEEP its purpose; FIX is a deploy/efficacy concern documented in `SEO-AUDIT.md`, not a backend-logic defect.
- `article-link.js` / `bulk-link-scan.js` — **HELPS · [EVIDENCE-BACKED] · USED · KEEP** — programmatic internal linking by tag overlap (`bulk-link-scan.js` link map; `article-link.js:writes article:links:{slug}`). Good SEO intent.
- `backfill-articles-index.js` — **HELPS · [EVIDENCE-BACKED] · USED · KEEP** — keeps `articles:index` complete (discovery + linking depend on it).
- `seo-signals.js` / `ga4-signals.js` / `youtube-*` / `social-intelligence.js` / `youtube-analytics.js` — **NEUTRAL · [REASONED-JUDGMENT] · USED · KEEP** — measurement/intelligence inputs; no live page output, no penalty surface.
- **`indexing-engine.js`** — **HURTS · [EVIDENCE-BACKED] · USED · FIX** — auto-submits **article URLs** to the Google Indexing API outside its documented scope (see §4-A). Keep the Search-Console URL-Inspection read; FIX the auto-submit.
- **`title-test.js`** — **HURTS · [REASONED-JUDGMENT] · USED · FIX** — mutates a **live published** article's `<title>` post-publish (`title-test.js:52-54`). Ranking-stability risk (see §4-C).
- **`intelligence-engine.js`** — **NEUTRAL→HURTS · [EVIDENCE-BACKED] · USED · FIX** — *suggests* post-publish title rewrites (`intelligence-engine.js:364,671-677`); gated to substantive intent shifts (`:879`) so milder, but it is the source of the title-mutation directives (see §4-B). Otherwise its core role (briefs) is NEUTRAL. KEEP the engine, FIX the title-rewrite directive coupling.
- **`ffx-consumer`** — **MIXED: HELPS (original long-form) / HURTS (regional duplication) · [EVIDENCE-BACKED] · USED · FIX** — generates original 2000-word articles (good) but also a near-duplicate **regional** variant per video with "core trading insight identical" (see §4-D). FIX the duplication, don't remove the generator.
- `ffx-cron` — **NEUTRAL · [REASONED-JUDGMENT] · USED · KEEP** — orchestration/scheduling; touches `queue:index`, signals; no live-page SEO surface.

**Neutral operator/transactional plumbing — all KEEP (real non-SEO job):**

`submit.js` (lead capture+email), `notify.js`, `generate.js`, `generate-status.js`, `queue.js`, `queue-edits.js`, `queue-remove.js`, `parked-queue.js`, `publish-confirm.js`, `press-data.js`, `press-publish.js`, `save-edits.js`, `kv-status.js`, `discord.js`, `linkedin.js`, `tweet.js`, `tumblr.js`, `video-content.js`, `regenerate-platform.js`, `restore-platform.js`, `regen-status.js`, `nuggets.js`, `seed-targets.js`, `directive-feedback.js`, `directive-history.js`, `health-check.js`, `google-auth.js`, `thumbnail-proxy.js`, `youtube-generate.js`, `youtube-thumbnail.js`, `youtube-metadata.js`, `youtube-signals.js`, all `newsletter-*`, `ffx-email-worker`, `ffx-social-scanner` — each: **NEUTRAL · [REASONED-JUDGMENT] · USED · KEEP**. None emit indexable page metadata or create a penalty surface; each performs a real job (publishing orchestration, social posting, transactional/drip email, analytics, image gen, auth-token caching).
*Note — social posters (`tweet/linkedin/tumblr/discord`): the article URL they post is a legit backlink/distribution signal → mildly HELPS, but I score NEUTRAL to avoid overclaiming since social links are typically `nofollow`. [REASONED-JUDGMENT].*

**Orphan:**
- **`linkedin-test.js`** — **NEUTRAL · [EVIDENCE-BACKED] · ORPHAN (0 references) · REMOVE** — debug endpoint echoing LinkedIn `/v2/userinfo` (`linkedin-test.js:1-15`). Dead weight; see §3 break-risk.

---

## Section 3 — KEEP / FIX / REMOVE

### KEEP (do a real job; no SEO harm)
All inventory items **except** those in FIX/REMOVE below. Explicitly: every transactional/operator/analytics function listed at the end of §2, plus the SEO-positive `publish.js`, `articles.js`, `article-content.js`, `_middleware.js`, `article-link.js`, `bulk-link-scan.js`, `backfill-articles-index.js`.

### FIX (HURTS SEO but serves a purpose — fix, don't delete)
1. **`indexing-engine.js`** — stop auto-submitting article URLs to the Google Indexing API (out-of-scope use; §4-A). Keep URL-Inspection + status tracking.
2. **`ffx-consumer` regional generation** — the Global+Regional near-duplicate path (§4-D) is the scaled/duplicate-content risk. Fix the duplication policy; keep the original-article generator.
3. **`title-test.js`** — mutates live published titles (§4-C). Constrain/guard post-publish title changes.
4. **`intelligence-engine.js` title-rewrite directives** — the upstream suggester for #3 (§4-B). Keep briefs; reconsider the title-mutation directive.

### REMOVE
1. **`linkedin-test.js`** (orphan).
   - **What would break:** nothing references it (grep: 0 files). No KV writes, no other function depends on it.
   - **Break-risk / must-happen-first:** It is a **public GET route** (`/linkedin-test`) returning LinkedIn account info derived from `LINKEDIN_ACCESS_TOKEN` with **no auth**. Before removal, confirm no external bookmark/monitor hits it (low risk). Removal is safe — it neither reads nor writes shared KV. *(Even if kept, it does not affect SEO; it is flagged REMOVE purely as orphaned dead weight per rule (b), and incidentally closes a token-info-exposure endpoint.)*

> No other REMOVE candidates. Every other function is either SEO-positive, SEO-neutral-with-a-real-job, or HURTS-but-fixable. Nothing else is orphaned (all ≥2 references).

---

## Section 4 — Named Suspects (quoted evidence)

### A. `indexing-engine.js` — auto-submitting article URLs to Google's Indexing API
**Verdict: HURTS · [EVIDENCE-BACKED] · FIX**

**Which URLs it submits.** The URL list includes the 6 static pages *and every article*:
- `indexing-engine.js:32-37` — static: `'https://fortitudefx.com/'`, `/blog`, `/bootcamp`, `/vipdiscord`, `/waitlist`, `/privacy`.
- `indexing-engine.js:536` (in `ixBuildUrlList`) — `var articleUrl = IX_SITE_BASE + '/article?slug=' + meta.slug;` (one per `article:{slug}`).

**The submit call** (`indexing-engine.js:588-593`):
```
async function ixSubmitUrl(saToken, pageUrl) {
  ...
  var res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
    method:  'POST',
    body: JSON.stringify({ url: pageUrl, type: 'URL_UPDATED' }),
```
Triggered for any URL whose cause is `not_submitted`, `canonical_mismatch`, or `unknown` (`indexing-engine.js:262-266`) — i.e. **article and marketing URLs**.

**The Google rule.** Per Google Search Central, the Indexing API officially supports **only pages with `JobPosting` or `BroadcastEvent` (livestream) structured data** — it is not a general "submit my pages" endpoint. FortitudeFX articles are `Article`-schema marketing pages (the JSON-LD built in `article.html:616` is `@type: 'Article'`), so these submissions fall outside the documented scope.

**Assessment:** Not a documented manual-penalty trigger, but it is **false confidence** — the dashboard reports URLs "submitted to Google" (`indexing-engine.js:266,300 submittedCount`) when Google does not honor Indexing-API pings for `Article` content; real indexing still depends on normal crawl + sitemap. It is also a Terms-of-Service gray area for non-supported content types. **FIX:** keep the URL-Inspection diagnostics, drop the auto-submit of article URLs (or gate it to genuinely-eligible schema). `[UNVERIFIED]` whether Google has ever rejected/penalized this account — confirmation needs the live Indexing API response logs / GSC manual-actions report.

### B. `intelligence-engine.js` — does it recommend changing PUBLISHED titles?
**Verdict: NEUTRAL→HURTS · [EVIDENCE-BACKED] · FIX**

Yes. It emits `titleRewrites` and resolves them into an operator directive against already-published articles:
- `intelligence-engine.js:364-367` — `if (Array.isArray(brief.titleRewrites)) { brief.titleRewrites.forEach(function(r,i){ id: today+'_title_'+i, type: 'title_rewrite' …`
- `intelligence-engine.js:671-677` —
  ```
  resolution.type = 'title_rewrite';
  resolution.directiveText = 'Rewrite title for: ' + (currentTitle || slug);
  ... label: 'Apply Title', type: 'title_rewrite',
      currentTitle: currentTitle, suggestedTitle: rewrite.suggestedTitle,
  ```
  where `currentTitle = cMeta.title` from `article:{slug}` (`:669`).

**Mitigation present** (`intelligence-engine.js:879`):
> "TITLE REWRITE RULES: Only recommend a title rewrite if the new title targets a meaningfully different keyword or clearer search intent. NEVER suggest removing articles the/a/an, reordering words, or any change that leaves the core keyword target unchanged."

So it is **gated against cosmetic churn** — good. But it remains the upstream source of live-title mutation. **It only suggests**; the actual live write happens in `title-test.js` (§C). NEUTRAL in isolation, HURTS as the trigger of a post-publish title change. FIX = re-evaluate whether published titles should change at all once ranking has stabilized.

### C. `title-test.js` — the function that actually mutates a live page's title
**Verdict: HURTS · [REASONED-JUDGMENT] · FIX**

This is the executor. It overwrites the live title that `article-content.js` serves:
- `title-test.js:52-54`:
  ```
  articleMeta.title     = newTitle;
  articleMeta.updatedAt = new Date().toISOString();
  await env.FFX_KV.put('article:' + slug, JSON.stringify(articleMeta));
  ```
- `title-test.js:63-64` — also rewrites `articles:index[idx].title`.
- Its own header comment (`title-test.js:5`): *"The live article heading reads from `article:{slug}` via `article-content.js` (articleMeta.title first)"* — i.e. this change is immediately live on the page `<h1>`/`<title>` path.

**Why HURTS (reasoned, not a Google "rule"):** changing a ranking URL's title/heading after it has accreted query signals resets relevance signals and can cause CTR/position volatility; doing it as an ongoing "A/B test" loop (`seo:title_tests:{slug}`, `:86`) means titles churn repeatedly. There is no documented penalty, hence **[REASONED-JUDGMENT]**. It correctly does **not** touch the immutable `published:{videoId}` (`title-test.js:4`), so body content is stable — only the title churns. FIX = cap frequency / freeze titles for ranking URLs.

### D. `ffx-consumer` article prompt — original vs thin/duplicate/scaled
**Verdict: MIXED (HELPS original, HURTS regional duplication) · [EVIDENCE-BACKED] · FIX**

**The article prompt** (`ffx-consumer/index.js:642`, quoted verbatim):
```
"body": "full 2000-word SEO article as valid HTML using h2 and h3 tags.
 Include internal links to /bootcamp /vipdiscord /blog.
 End with CTA to join free Discord at https://discord.gg/fortitudefx.
 Maximum 1 exclamation mark."
"title": "SEO title 50-60 characters including primary keyword"
"excerpt": "compelling meta description max 160 characters"
```
**Good signals (HELPS):** long-form (2000w), heading structure (h2/h3), keyworded 50-60-char title, 160-char meta description, internal links, and **related-article cross-links are injected** into the prompt — `ffx-consumer/index.js:73-74`: `signalInjection += relatedArticles.linkBlock;` (built from `fetchRelatedArticles`, formatted at `:395` as `"title" -> https://fortitudefx.com/article?slug=…`). This is genuinely Google-friendly, original, interlinked content generation.

**The duplication problem (HURTS).** For every video the consumer generates a **second, regional** article with instructions to keep the substance identical:
- `ffx-consumer/index.js:639` (regionInstruction):
  > "This is the regional variant. The global slug is: … Append the region to the slug: e.g. 'trading-london-session-gcc'. Frame examples, market session times, currency pairs, and cultural context specifically for [region] traders. **Keep the core trading insight identical — only framing and examples shift.**"
- Region cycles GCC → US/Canada → EU/UK/Germany → SEA/Asia (`ffx-consumer/index.js:131-134` from `config:regionCycle`), so the corpus accumulates near-duplicate pairs (confirmed live in `SEO-AUDIT.md`: e.g. `…-gcc` / `…-us-canada` variants).

**Rule:** Google Search Essentials spam policies — **"scaled content abuse"** and duplicate-content guidance — flag programmatically producing many pages with little added value / the same core content. Two articles per video where the second is explicitly "core insight identical" is the textbook pattern. **FIX:** consolidate regional variants under one canonical (or genuinely differentiate them), don't ship "identical insight" duplicates. **[EVIDENCE-BACKED]** by `:639`.

### E. Title / slug generation logic
**Verdict: title HELPS, slug NEUTRAL · [EVIDENCE-BACKED] · KEEP (within FIX-D)**

- **Titles** are model-generated to spec: `ffx-consumer/index.js:642` → `"SEO title 50-60 characters including primary keyword"`. Sound SEO practice (length + keyword). Newsletter perspective titles avoid repetition via `Do NOT repeat previous perspective title` (`:881`).
- **Slugs** are model-generated, not derived from the title: `:642` → `"slug": "url-safe-lowercase-hyphenated-3-to-6-words"`; regional slugs get the region suffix appended (`:639`). On regeneration the Global slug is preserved (`:691` `if (existingSlug && region === 'Global') parsed.slug = existingSlug;`). Slugs are clean and keyword-bearing — fine.
- **Risk:** because slug+title are independently model-generated per call, the regional duplication (§D) plus occasional mislabeled titles (documented in `SEO-AUDIT.md` §B1, e.g. a GCC "fractal" article titled "Why Your Trading Strategy Fails") is a data-quality byproduct, not a slug-logic bug per se. **[EVIDENCE-BACKED]** title/slug spec; the mismatch is a generation-quality issue tracked under FIX-D.

### F. Keyword strategy — signals feeding the intelligence engine
**Verdict: NEUTRAL→HELPS, signal quality sound · [EVIDENCE-BACKED] · KEEP**

The article brief's target keyword originates from real first-party search data, not invented terms:
- `seo-signals.js` pulls **Search Console** search-analytics (rising queries, page-2 / zero-click opportunities) → `seo:signals`.
- `ga4-signals.js` pulls **GA4** behavior → `ga4:signals`.
- `youtube-signals.js`/`youtube-analytics.js` add channel + YouTube-search queries.
- `intelligence-engine.js` fuses these into `intelligence:brief.articleBrief` (`targetQuery`, `suggestedTitle`, `nuggetTags`), which the consumer injects: `ffx-consumer/index.js:35` `briefLines.push('Target query: "' + ab.targetQuery + '"')`.

This is a **grounded** keyword loop (real GSC/GA4 demand → article target), which is sound rather than noise. The accuracy-scoring loop (`intelligence:brief_log`, `intelligence:accuracy_scores`) even back-tests predictions. **KEEP.** The only weakness is downstream (duplication §D, title churn §C), not the keyword sourcing. `[UNVERIFIED]` whether `targetQuery` selection actually picks the highest-opportunity term vs first-in-list — confirming would require reading the brief-selection ranking in `intelligence-engine.js`, but the *input* signals are legitimate.

---

*Read-only audit. No source, KV, or live-site changes were made. `BACKEND-AUDIT.md` is the only output. No code changes proposed per instructions.*
