# FortitudeFX — SEO Audit (evidence-based)

**Scope:** Live indexability of `fortitudefx.com`, focused on the "discovered – not indexed" failure mode.
**Method:** Live `curl` against production with a Googlebot User-Agent (`Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`), captured this session (response `date: Mon, 29 Jun 2026`), cross-referenced against repo source at `file:line`. Where I rely on the live response bytes I say so; where I rely on source I cite `file:line`. Findings I could not prove from bytes are tagged `[UNVERIFIED]`.
**Tags:** `[ERROR]` blocking/penalty-risk · `[FIX]` below standard · `[OPTIMIZE]` adequate→best-in-class · `[DELETE]` redundant/crawl-waste.

---

## A. CRAWLER-VISIBLE BYTES — `/article` and `/newsletter-issue`

### A1. `[ERROR]` Article pages serve Googlebot a generic shell — wrong title, EMPTY canonical, no OG title/url/description, no body, no real H1, no JSON-LD.

**Method:** live curl, Googlebot UA.

`/article?slug=opening-candle-continuation-setup-forex-session-direction` (a **KV-backed, real** article — `/article-content` for this slug returns `success:true`, `title:"Opening Candle Continuation: Reading Session Direction"`, `body length: 8957`).

The exact `<head>` bytes the crawler received:

```
15:  <title>FortitudeFX™ — Trading Insights</title>
16:  <meta name="description" content="FortitudeFX™ — forex trading strategy, price action, and trader mindset." />
17:  <meta name="robots" content="index, follow" />
18:  <link rel="canonical" href="" id="canonicalTag" />
19:  <meta property="og:type"        content="article" />
20:  <meta property="og:image"       content="https://fortitudefx.com/og-fortitudefx.png" />
21:  <meta property="og:image:width"  content="1200" />
22:  <meta property="og:image:height" content="630" />
23:  <meta property="og:site_name"   content="FortitudeFX™" />
24:  <meta name="twitter:card"        content="summary_large_image" />
25:  <meta name="twitter:site"        content="@_fortitudefx" />
26:  <meta name="twitter:image"       content="https://fortitudefx.com/og-fortitudefx.png" />
```

Hard facts from these bytes:
- **Title is the generic shell** `FortitudeFX™ — Trading Insights` — identical on every article URL, not the article title.
- **Canonical is literally empty:** `<link rel="canonical" href="" id="canonicalTag" />`. An empty `href` resolves to the requesting URL, so there is **no canonical consolidation signal** and the value is identical-shell across all URLs.
- **No `og:title`, no `og:url`, no `og:description`, no `twitter:title`, no `twitter:description`** in the served bytes (only `og:type/image/site_name` + `twitter:card/site/image` are present).
- **Body is client-injected only.** Source proof: `article.html:584` `fetch('/article-content?slug=' + encodeURIComponent(slug))` then `article.html:674`/`:685` `wrap.innerHTML = … '<h1>' + a.title + '</h1>' …`. The only `<h1>` in the server bytes is the unrendered JS template literal `<h1>${a.title}` inside a `<script>`. **A non-JS crawler receives zero article body and zero rendered H1.**
- **No server JSON-LD.** The two `application/ld+json` matches in the bytes are the strings `schema.type = 'application/ld+json'` (`article.html:615`) and `breadcrumb.type` (`article.html:638`) inside an inline `<script>` — the blocks are built with `document.createElement` + `document.head.appendChild(schema)` (`article.html:634`), i.e. **client-side only**. Server JSON-LD = none.

**Why this is the headline defect:** `functions/_middleware.js` is *designed* to fix exactly this server-side — it sets `title` (`_middleware.js:48`), `meta[name=description]` (`:49`), `link#canonicalTag` href (`:50`), `og:url/og:title/og:description` (`:51-53`), and appends JSON-LD to `<head>` (`:60`). The live bytes prove **the middleware rewrite is not taking effect** on production URLs: canonical is still `""`, title is still the generic shell, and no server JSON-LD was appended. The page route returns `HTTP/2 200` with `cf-cache-status: DYNAMIC`.

**Root-cause `[UNVERIFIED]`:** The live `article.html` is also *missing OG/Twitter tags that the repo file contains* — repo `article.html:24 og:url`, `:25 og:title`, `:26 og:description`, `:32 twitter:title`, `:33 twitter:description` are **absent** from the served bytes. That points to deployed assets being an older build than the repo (deploy drift), which would also explain `_middleware.js` not running if the deployed Pages bundle predates it. To confirm: check the Cloudflare Pages deployment commit/build vs `main`, and confirm `functions/_middleware.js` is in the deployed Functions bundle.

### A2. `[ERROR]` Newsletter issues serve a generic shell title to crawlers.

**Method:** live curl. `/newsletter-issue?date=2026-06-15` → `HTTP 200`, served `<head>` contains only:

```
6:  <title>FFX Newsletter | FortitudeFX</title>
```

No per-issue `<link rel="canonical">`, no `og:url`, no `og:title` were present in the served bytes (grep for those returned nothing). Same failure class as A1: `_middleware.js:90 buildNewsletterMeta` is meant to inject per-issue title/canonical/OG/JSON-LD and is not effective live. Every issue URL is an identical generic shell to a crawler.

---

## B. CANONICAL MAP (every article variant)

**Server-side (what a non-JS crawler gets): `<link rel="canonical" href="" …>` — EMPTY for every variant.** Proof: live bytes A1 line 18; source default `article.html:17 <link rel="canonical" href="" id="canonicalTag" />`.

**Client-side (JS, browsers only): self-canonical for every variant.** Proof: `article.html:582` `canonicalEl.setAttribute('href', 'https://fortitudefx.com/article?slug=' + slug)` and `:594` `… + a.slug`. JSON-LD `url`/`mainEntityOfPage` also self (`article.html:630-631`).

Variant families confirmed live from `/articles` (count: 58 entries returned; Global + regional pairs). Representative map — each row's **emitted canonical is `""` server-side / self client-side**, and **no regional points to its Global parent**:

| Variant slug | Region | Correct canonical target | Emitted | Verdict |
|---|---|---|---|---|
| `opening-candle-continuation-setup-forex-session-direction` | Global | self | `""` → self | `[ERROR]` empty server-side |
| `opening-candle-continuation-setup-forex-session-direction-gcc` | GCC | should point to Global parent | `""` → self | `[ERROR]` self-canonical on a regional duplicate |
| `opening-candle-continuation-setup-forex-session-direction-us-canada` | US/Canada | Global parent | `""` → self | `[ERROR]` self-canonical on duplicate |
| `forex-risk-management-rules-that-matter` / `…-us-canada` | Global / US-CA | parent | `""` → self | `[ERROR]` |
| `fractal-trading-strategy-multiple-timeframes` / `…-gcc` | Global / GCC | parent | `""` → self | `[ERROR]` |
| `why-trading-strategy-fails-execution-not-strategy` / `…-eu` | Global / EU | parent | `""` → self | `[ERROR]` |
| `liquidity-sweep-entry-strategy-bearish-momentum` / `…-sea` | Global / SEA | parent | `""` → self | `[ERROR]` |
| `open-candle-trading-strategy-institutional-intent` / `…-eu-uk-germany` | Global / EU | parent | `""` → self | `[ERROR]` |
| `catch-the-wick-bootcamp-mechanical-forex-trading` / `…-sea-asia` | Global / SEA | parent | `""` → self | `[ERROR]` |

The API even *knows* the relationship — `/article-content` returns `siblingSlug: opening-candle-continuation-setup-forex-session-direction-gcc, siblingRegion: GCC` — but the canonical never uses it to consolidate. Net effect: **regional variants compete with their Global parent as separate self-canonicalizing near-duplicates** (cannibalization), and server-side none of them assert any canonical at all.

### B1. `[ERROR]` Regional variants carry duplicated / mismatched titles (thin-duplicate signal).

Live evidence from `/articles`:
- `fractal-trading-strategy-multiple-timeframes-gcc` → title `"Why Your Trading Strategy Fails (It's Not the Strategy)"` — **identical to** the Global `why-trading-strategy-fails-execution-not-strategy` → `"Why Your Trading Strategy Fails (It's Not the Strategy)"`. The GCC "fractal" page is mislabeled with another article's title.
- `why-trading-strategy-fails-execution-not-strategy-eu` → title `"The Only Forex Risk Management Rules That Actually Matter (Most Traders Ignore These)"` — another article's title.

Duplicate/mismatched titles across variants reinforce "duplicate content" classification, a known driver of *discovered – not indexed*.

---

## C. 5xx TRACE on public routes

**Exact 5xx-returning lines (grep, with conditions):**
- `functions/articles.js:32` → `status: 500` when `!env.FFX_KV` (binding missing). Route `/articles` (consumed by `blog.html`).
- `functions/articles.js:100` → `status: 500` on any thrown error in the index/merge loop. Route `/articles`.
- `functions/article-content.js:18` → `status: 500` when `!env.FFX_KV`. Route `/article-content`.
- `functions/article-content.js:197` → `status: 500` on catch. Route `/article-content`.
- `functions/api/newsletter.js:59` → `status: 500` on catch. Route `/api/newsletter`.
- `functions/api/article-link.js:14,118` → `500` (operator route, not crawl path).

**Code path / ranking justification:** These 5xx live only on **JSON API subroutes**, not on the indexable HTML page routes. I proved the primary HTML routes are static `200` regardless of KV, via live curl this session:
- `/article?slug=…` → `HTTP/2 200` (static `article.html`)
- `/blog` → `HTTP 200`
- `/newsletter-issue?date=…` → `HTTP 200`

Because the crawled HTML documents are static assets served `200`, **a 5xx here cannot throttle whole-site HTML crawl** — it can only (a) blank the client-rendered blog list (`blog.html` `fetch('/articles')`) and (b) make `_middleware.js` bail to the shell if `/article-content` 5xxes. So I am **not** ranking this #1; the proof that it can't fire on the indexable HTML routes is the three `200`s above. Tag: `[FIX]` (degradation/availability risk, not a crawl-throttle). The `!env.FFX_KV` branches are effectively dead on a correctly-bound deploy (KV `FFX_KV` is bound per `wrangler.toml`).

---

## D. SITEMAP RECONCILIATION (`/sitemap.xml`, fetched live)

Live `/sitemap.xml` → `HTTP 200`. **Total `<loc>`: 63 · Unique: 40 · Duplicates: 23.**

**Static URLs (all verified live `HTTP 200`, self-canonical, indexable):**
| URL | Status |
|---|---|
| `https://fortitudefx.com/` | 200 — canonical `https://fortitudefx.com/` ✓ |
| `https://fortitudefx.com/bootcamp` | 200 — canonical `…/bootcamp` ✓ |
| `https://fortitudefx.com/vipdiscord` | 200 — canonical `…/vipdiscord` ✓ |
| `https://fortitudefx.com/waitlist` | 200 — canonical `…/waitlist` ✓ |
| `https://fortitudefx.com/blog` | 200 — canonical `…/blog` ✓ |
| `https://fortitudefx.com/privacy` | 200 — canonical `…/privacy` ✓ |

**Article URLs (34 unique `…/article?slug=…`):** every one returns `HTTP 200` **but is a non-indexable shell** (generic title, empty canonical, no body — see A1). Status = **"200 shell / not cleanly indexable."** This set *is* the discovered-not-indexed population.

### D1. `[DELETE]` 23 duplicate `<loc>` entries — crawl waste / quality signal.
Each of these slugs appears **twice or three times** in the sitemap (live `uniq -c`), e.g.:
- `…/article?slug=opening-candle-continuation-setup-forex-session-direction` ×3
- `…/article?slug=15-minute-candle-framework-day-trading` ×2
- `…/article?slug=catch-the-wick-bootcamp-mechanical-forex-trading` ×2
- (…21 more rows, full list captured: 22 distinct slugs duplicated, 23 redundant `<loc>` lines)
Source: generated by `functions/publish.js:189-224` listing `prefix:'article:'` and emitting one `<url>` per key without dedupe; duplicate `article:{slug}` keys/list pages produce repeated `<loc>`.

### D2. `[FIX]` Sitemap `<lastmod>` is static/wrong.
`functions/publish.js:201-206` hardcodes static-page `lastmod: '2026-04-26'`; article `lastmod` falls back to publish date but the static block never updates. Low-trust freshness signal.

---

## E. INTERNAL LINKING (indexing-speed lever)

**Method:** live curl of `/` and `/blog`, count server-rendered `<a href>` to article URLs.

- **Home (`/`):** **0** server-rendered links to any specific `/article?slug=…`. (`grep 'href="…article…"'` on the live home bytes returned none; the 12 raw "article" string occurrences are non-href text/JS.) High-authority homepage passes **no internal link equity** to any article.
- **Blog (`/blog`):** **1** article `href` in the server HTML; the real list is client-side only — live bytes contain `fetch('/articles'`. So a non-JS crawler sees ~1 article link, not 34.

**Consequence — orphan set:** All 34 article URLs (Global + every regional) are **effectively orphaned** in the crawlable HTML graph. Their *only* server-discoverable path is `sitemap.xml` (which is duplicate-laden, D1). No anchor-text context, no PageRank flow from home/blog. Regional variants link to nothing and are linked from nothing server-side.

Tag: `[ERROR]` — for a small site this is the single biggest **indexing-speed** suppressor after A1. There is an internal-linking engine (`functions/api/bulk-link-scan.js`, `article-link.js`) but its links are injected into article **bodies**, which are themselves client-rendered (A1) and therefore invisible to a non-JS crawler.

---

## F. ON-PAGE per public page (actual values)

| Page | Title (literal) | Len | Single H1? | Meta description | JSON-LD | Verdict |
|---|---|---|---|---|---|---|
| `/` | `FortitudeFX \| Catch The Wick — Forex Trading System` | 51 | ✅ 1 — `Mechanical Forex Trading System — 2 Candles, 5 Entry Models.` | present | (org schema in source) | `[OPTIMIZE]` good |
| `/blog` | `FortitudeFX Trading Insights — Catch The Wick Framework, Execution & Market Psychology` | 86 | ✅ 1 — `Trading Insights` | present | — | `[FIX]` title >60 char, truncates in SERP |
| `/bootcamp` | `Catch The Wick Bootcamp \| FortitudeFX — Forex Course` | 51 | n/v | present | n/v | `[OPTIMIZE]` |
| `/vipdiscord` | `VIP Discord \| FortitudeFX — Live Forex Trading Community` | 55 | n/v | present | n/v | `[OPTIMIZE]` |
| `/waitlist` | `Join the Waitlist \| FortitudeFX — Catch The Wick` | 48 | n/v | present | n/v | `[OPTIMIZE]` |
| `/pricing` | `Pricing \| FortitudeFX — VIP Discord & Bootcamp Plans` | 51 | n/v | present | n/v | `[OPTIMIZE]` |
| `/privacy` | `Privacy Policy \| FortitudeFX — Data Protection & Your Rights` | 59 | n/v | present | n/v | `[OPTIMIZE]` |
| **`/article?slug=…`** | **`FortitudeFX™ — Trading Insights`** (generic, identical on all 34) | 31 | **❌ 0 server-side** (H1 client-injected, `article.html:685`) | **generic, identical on all 34** | **❌ none server-side** | `[ERROR]` |
| **`/newsletter-issue?date=…`** | **`FFX Newsletter \| FortitudeFX`** (generic, identical on all) | 28 | n/v server-side | generic | ❌ none server-side | `[ERROR]` |

- **Static pages:** unique titles, single H1 (home/blog verified live), self-canonical, robots `index, follow`. Healthy.
- **Image alt:** sampled article body (`opening-candle-continuation-setup-forex-session-direction`, 8957 chars) contains **0 `<img>`** (text-only, `h2`×7, `h1`×0) — no alt debt in body, but also no images. OG image carries alt in source (`article.html:27 og:image:alt`). 
- **Title-length `[FIX]`:** `/blog` title is 86 chars (will truncate ~60).

### F1. `[ERROR]` Soft-404: any bad slug returns `HTTP 200` shell.
Live: `/article?slug=this-does-not-exist-zzz` → **`HTTP 200`** with `<title>FortitudeFX™ — Trading Insights</title>`, while `/article-content?slug=this-does-not-exist-zzz` → `HTTP 404`. Source: `article.html:578/588` renders an in-page "Article not found" but the document is served `200`. Google sees unlimited `200` soft-404s for arbitrary `?slug=` values.

### F2. `[FIX]` Operator surfaces are publicly reachable (no auth), only `robots.txt`-disallowed.
Live: `/dashboard` `[200]`, `/press` `[200]`, `/generate` `[200]`, `/dashboard-seo` `[200]`. `robots.txt` `Disallow: /dashboard …/generate …/press` blocks crawl but **not access**, and these pages call mutating APIs (`/press-publish`, `/generate`, `/save-edits`). SEO impact is minor (disallowed), but they are link-reachable and could leak into the index if linked externally; primary concern is access-control, out of SEO scope.

### F3. `[OPTIMIZE]` Whop duplicate-content noindex is correctly handled.
`_headers:5-15` sets `X-Robots-Tag: noindex, nofollow` on `/products/*`, `/ar/*`, `/ar-us/*`, `/en-us/*`. Correct.

---

## PRIORITY ORDER — most likely causes of "discovered, not indexed"

1. **`[ERROR]` A1 — Article pages serve a generic shell to crawlers: generic `<title>FortitudeFX™ — Trading Insights</title>`, empty `<link rel="canonical" href="">`, no `og:title/url/description`, and the entire article body + H1 + JSON-LD are client-injected only (`_middleware.js` rewrite not effective live; client fixup at `article.html:582-647` can't help first-wave Googlebot).** This is the root cause: 34 URLs that are byte-identical empty shells with no canonical and no content. *Evidence: §A1 live `<head>` bytes lines 15-18; `article.html:584,685,615,634`.*
2. **`[ERROR]` E — All 34 article URLs are orphaned in the crawlable graph: home emits 0 article links, blog emits 1 (list is `fetch('/articles')` client-side). Discovery depends solely on the sitemap.** Starves indexing speed and link equity. *Evidence: §E live link counts; `blog.html` `fetch('/articles')`.*
3. **`[ERROR]` B / B1 — No server canonical + regional self-canonical duplication + mismatched duplicate titles** (e.g. `…-fractal…-gcc` titled "Why Your Trading Strategy Fails"). Variants cannibalize and read as duplicates with no consolidation. *Evidence: §B table; §B1 live `/articles` titles.*
4. **`[ERROR]` F1 — Soft-404s: `/article?slug=<garbage>` → `HTTP 200` shell** while the data API returns `404`. Pollutes crawl with infinite indexable-looking 200s. *Evidence: §F1 live `200` vs `/article-content` `404`.*
5. **`[ERROR]` A2 — Newsletter issues serve identical generic shell `FFX Newsletter | FortitudeFX`** with no per-issue canonical/OG. *Evidence: §A2 live byte line 6.*
6. **`[DELETE]` D1 — 23 duplicate `<loc>` in sitemap** (e.g. one slug ×3). Crawl waste + low-quality signal on the *only* discovery path. *Evidence: §D live 63 total / 40 unique.*
7. **`[FIX]` C — Public JSON routes 5xx on KV/throw** (`articles.js:32,100`; `article-content.js:18,197`; `api/newsletter.js:59`). Not a whole-site throttle (HTML routes are static `200` — proven), but blanks the client blog list and forces middleware to bail. *Evidence: §C grep lines + three live `200`s.*
8. **`[FIX]` D2 / F (blog title length)** — static `lastmod 2026-04-26`; `/blog` title 86 chars. *Evidence: `publish.js:201-206`; §F live title.*

**Root-cause to confirm before fixing #1:** deployed Pages build appears older than `main` (live `article.html` is missing OG tags present at repo `article.html:24-33`), which would explain why `functions/_middleware.js` never rewrites. `[UNVERIFIED]` — verify the Pages deployment commit and that `_middleware.js` is in the deployed Functions bundle.

---
*Read-only audit. No source files, KV, live site, or deployment were modified. This file (`SEO-AUDIT.md`) is the sole output.*
