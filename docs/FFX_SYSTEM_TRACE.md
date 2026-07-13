# FFX System Trace

Complete, read-only, code-grounded trace of FortitudeFX. Every claim cites `file:line`.
Produced from five parallel deep passes (entry/lifecycle, intelligence loops, knowledge
base/social, KV census, dashboards/GSC-GA4). **Nothing was changed, built, or deployed.**

`[branch-only]` = exists only on branch `quality-gate-port`, NOT deployed to main/live.
Live/main has none of the `lib/gate/*` code or its wiring.

> **CORRECTION (2nd pass, live-verified).** The first pass was source-only and got the knowledge
> base and the feedback loop WRONG. Corrected here against the live system (`api/nuggets`,
> `api/intelligence-engine`): there IS a 226-nugget verbatim library with retrieval and a
> `nugget_generate` decision already built (§7); the engine DOES consume measured performance —
> it's fed the site's own zero-volume GSC echo, not blind (§5). The keyword-driven change is a
> **source swap, not a rebuild** (§10).

---

## 0. Architecture at a glance

- **Cloudflare Pages** serves the public site + ~57 Pages Functions (`functions/**`, auto-deploy on push).
- **4 standalone Workers** (own `wrangler.toml`, own deploy): `ffx-cron` (scheduler), `ffx-consumer` (queue consumer / generator), `ffx-social-scanner` (reply drafting), `ffx-email-worker` (onboarding email).
- **1 Queue:** `ffx-generate-queue` (producer = cron/generate endpoints; consumer = `ffx-consumer`).
- **1 KV namespace:** `env.FFX_KV` everywhere (only `save-edits.js:10` aliases it `KV`). **82 distinct key patterns** (§4).
- **External:** Anthropic (`claude-sonnet-4-5` articles/platforms, `claude-haiku-4-5` gate fabrication [branch-only]), Supadata (transcripts), GitHub Contents API (`sitemap.xml`, `articles.json`), Google OAuth (GSC + GA4 + YouTube), Brevo (email), X/LinkedIn/Discord/Tumblr, Pexels.

### Data-flow (article, today = video-sourced)
```
ffx-cron (Mon–Fri 05:00 UTC) ── findNewVideo/findBacklogVideos ──► queue:index
        │ triggerGeneration → ffx-generate-queue {jobId,videoId,youtubeUrl}
        ▼
ffx-consumer.processJob
  transcript:{videoId} ← Supadata          (SOURCE INGESTION)
  callClaudeArticle  ← intelligence:brief.articleBrief.targetQuery  (already keyword-aware)
                     ← seo:learning:summary, intelligence:targets, voice_calibration, articles:index
  callClaudePlatforms → x_thread/linkedin/discord/tumblr
  [branch-only] runGate → gate:{slug}
  video:{videoId} (permanent)  +  content:performance:{slug}  +  nugget:*
        ▼  (email → dashboard-queue.html?video=)
dashboard-queue ── GET /queue (reads video:{videoId}) ── Salman reviews/edits (queue-edits:{videoId})
        │ POST /press-publish
        ▼
press-publish ─[branch-only re-gate]─► publish-confirm ──► /publish (blog) ─[branch-only enforce gate:{slug}]─► article:{slug}, articles:index, sitemap.xml
                                                      ├──► /tweet /linkedin /tumblr /discord
                                                      └──► published:{videoId} (post URLs) → press-data → dashboard-press
        ▼
GSC + GA4 (daily cron) → seo:signals / ga4:signals → content:performance snapshot7/30/90
        ▼
intelligence-engine  ──►  reads signals, NOT measured performance  ──► intelligence:brief (next article)
                          (feedback loop OPEN — see §5)
```

---

## 1. Entry points

### Crons
- **`ffx-cron`** (`wrangler.toml:11-15`): two triggers, `0 5 * * MON-FRI` and `10 5 * * MON-FRI` (05:00 / 05:10 UTC = 09:00 / 09:10 Dubai). `scheduled()` branches on `event.cron` (`index.js:24-33`): `10 5` → `runEngine` (POSTs `/api/intelligence-engine`, split out because the tail-of-run Claude call exhausted budget and the brief went 3 weeks stale, `index.js:37-42`); all else → `runCron`.
  - `runCron` steps (`index.js:65-228`): (1) `findNewVideo` (YouTube, last 25h) → `addToQueueTop`; (2) queue top-up to ~10; (3) `triggerGeneration` on `queue[0]`; (4) POST `/api/seo-signals` + `/api/ga4-signals`; (5) `updateTargetActuals`; (5b) YouTube search-signals; (7) `checkReplyPerformance`.
- **`ffx-email-worker`** (`wrangler.toml crons=["0 3 * * *"]`): daily 03:00 UTC onboarding/nurture email over Brevo List 4.
- **`ffx-social-scanner`**: **no cron** — HTTP-triggered by `social-intelligence.js`.

### Producers / pipeline routes (Pages Functions)
`POST /generate` (`generate.js:71`), `GET/POST /api/youtube-generate` (`youtube-generate.js:198`) → enqueue `ffx-generate-queue`. `GET /generate-status`, `GET /api/regen-status`, `GET/POST/DELETE /queue`, `POST /press-publish`, `POST /publish-confirm`, `POST /publish`, `POST /save-edits`, `GET /article-content`, `GET /article`, `POST /api/queue-edits`, `POST /api/regenerate-platform`, `POST /api/restore-platform`, `GET /press-data`, `GET /api/gate-audit` [branch-only]. Full route table + methods in the lifecycle §2.

---

## 2. Article lifecycle (step by step, file:line)

| Step | What runs | Reads | Writes | On failure |
|---|---|---|---|---|
| **0 Source select** | `ffx-cron` `findNewVideo`/`findBacklogVideos` → `triggerGeneration` (`index.js:543-581`) | `queue:index`, `published:{videoId}`, `lock:generating`, YouTube API | `queue:index`, `job:{jobId}` (TTL 86400), enqueue `{jobId,videoId,youtubeUrl}` | lock present or `video:` exists → skip silently; fatal → alert email |
| **1 Pick up** | `ffx-consumer.processJob` (`index.js:39`) | `video:{videoId}` (skip-guard `:52`) | `lock:generating` (TTL 1800) | throw → delete lock, error `job:`, `message.retry()` (≤2) |
| **2 Transcript** | `fetchTranscriptSupadata` (`:105`, def `:598`) | Supadata | `transcript:{videoId}` (permanent `:120`), `transcript:timestamps:{videoId}` (best-effort `:131`) | <100 chars or error → `failJob(retryable:false)`, **no retry** |
| **3 Generate** | `callClaudeArticle` (`claude-sonnet-4-5`, `:680`), `callClaudePlatforms` (`:852`) | `intelligence:brief` (`.articleBrief.targetQuery` `:714`), `seo:learning:summary`, `intelligence:targets`, `voice_calibration`, `articles:index`(related links) | `video:checkpoint:{videoId}` (`:179`) | any Claude call → `failJob(retryable:true)`, queue retries |
| **4 Nuggets** | `extractLibrary` (`:900`, 45s race) | `transcript` slice | `nugget:{id}`, `nuggets:index` | non-fatal → `libraryItems=[]`, continue |
| **5 Gate [branch-only]** | `runGate` (`:297`) → similarity ≤0.55, structural ≤0.55, banned-openings, voice ≥70, fabrication hard-fail | `gate:corpus`, `voice_calibration` | `gate:{slug}` (+ contentHash) (`verdict.js:48`) | error → verdict forced `failed`, still written (fail-closed); **non-fatal to generation** |
| **6 Store** | build `videoRecord` (`:311`) | — | `video:{videoId}` (permanent `:332`), `content:performance:{slug}` (`:372`), `content:link_graph:{slug}`, `queue:index[i].wasGenerated`, `job:` complete; del `checkpoint`,`lock` | `video:` write → `failJob('kv_write',retryable:true)`; others non-fatal; completion email (Brevo) |
| **7 Queue sees it** | `GET /queue` (`queue.js:58`) / `GET /press-data` | `queue:index`, `video:{videoId}` | — | state at read-time: grey→orange→red |
| **8 Review/edit** | `queue-edits` (`:67`), `save-edits`, `regenerate-platform` (`claude-sonnet-4-5`), `restore-platform` | `transcript:{videoId}`(regen) | `queue-edits:{videoId}`, `video:{videoId}` staging, `regen:{videoId}:{platform}` (TTL 24h) | mapped Claude error, writes nothing |
| **9 Publish** | `press-publish` → `publish-confirm` → `/publish` | `published:{videoId}`, `gate:{slug}`[branch] | see below | see below |
| **10 Site render** | `GET /article?slug=` (`article.js:1149`) → `/article-content` (+self-heal) | `article:{slug}`, `published:{videoId}.globalContent.body`→`video:`→`articles.json`; `article:links:{slug}`, `newsletter:article_refs:{slug}` | `503log:{ts}:{slug}` on 503 | 404 (missing) / 503 (`Retry-After:120`, no body); **no content gate in render path** |
| **11 Press links** | `press-data` → `dashboard-press` | `published:*.platforms.{p}.status` | — | — |

**Step 9 detail.** `press-publish.js:19` — queue-source content is passed inline (dashboard pre-merges `gc`+`queue-edits`), republish merges `regen:` staging. **[branch-only]** re-gate (`:112-139`) → 403 refuses whole publish on fail. `publish-confirm.js:10` fans out **sequentially** Blog→X→LinkedIn→Tumblr→Discord (regional hard-disabled `GLOBAL_ONLY=true :82`), writes `published:{videoId}` (`:276`), flips `content:performance` to `published`, **deletes `video:{videoId}`** (`:312`). Honest verdict (SH-4): 200 all-ok / 409 article-failed / 502 socials-only-failed (`:356-407`). `publish.js:16` is the **only writer of `article:{slug}`** (`:130`); **[branch-only]** `checkPublishAllowed` (`:58-67`) is the single hard publish gate (403 if no matching passing `gate:{slug}`); slug-collision guard (409 `:97`); rebuilds `sitemap.xml` via GitHub (`:297`).

**Rebuild note:** the pipeline is **already keyword-aware from Step 3** — `intelligence:brief.articleBrief.targetQuery` is injected into the article prompt (`ffx-consumer:714`) and used as the gate `targetQuery` (`:293`). **Only Step 0 (source selection) and Step 2 (source ingestion) are video-specific.** Everything from Step 3 → 11 is source-agnostic.

---

## 3. Workers summary

| Worker | Trigger | Role | Writes |
|---|---|---|---|
| `ffx-cron` | cron ×2/day | scheduler: source-select, signals pull, targets, reply perf, engine trigger | `queue:index`, `job:`, `intelligence:targets`, `intelligence:reply_performance:*` |
| `ffx-consumer` | `ffx-generate-queue` | generator: transcript→article+platforms(+gate[branch])→store | `transcript:*`, `video:*`, `content:performance:*`, `nugget:*`, `gate:*`[branch] |
| `ffx-social-scanner` | HTTP from `social-intelligence.js` | **drafts** forum replies (web search), **never posts** | `intelligence:signals` (TTL 30d) |
| `ffx-email-worker` | cron daily 03:00 | onboarding/nurture email (Brevo List 4) | `email:log:*`, `email:error:*`(dead), `test:state:*` |

---

## 4. KV key census (82 patterns) — dead keys flagged

Single namespace `env.FFX_KV`. **60 LIVE, 17 SELF (incl. 2 gate:* branch-only), 2 write-only dead, 8 read-only dangling, 1 dead constant.** Full per-key writer/reader tables were produced per subsystem; the actionable defects:

### WRITE-ONLY (written, never read → captured-but-unused bug)
1. **`platform:performance:{platform}:{slug}`** — writer `publish.js:214`, **no reader anywhere**.
2. **`email:error:{email}:{day}:{ts}`** — writer `ffx-email-worker:1014`, never surfaced.
3. **`ga4:conversions`** (`CONV_KEY` `ga4-signals.js:8`) — declared constant, **no KV op at all**.

### READ-ONLY (read, never written → dangling; reads always miss)
1. **`video:slug:{slug}`** — read `article.js:1022`, `article-content.js:110`, `kv-status.js:68`; **no writer** → the slug→videoId reverse index is never populated (breaks republish-by-slug-alone; see `published:slug:{slug}` below).
2. **`intelligence:daily_directive:{date}`** — read `health-check.js:447`; health-check's own comments (`:453-454`) diagnose the missing writer in `directive-feedback.js`.
3. **`ga4:exec_summary:{date}`** — read `health-check.js:420,448`; no writer.
4. **`email:signals`** (`intelligence-engine.js:40`), **`discord:signals`** (`:39`), **`calendar:signals`** (`:42`), **`knowledge:taxonomy`** (`:43`), **`knowledge:performance`** (`:44`) — all read as optional analyst inputs (`.catch(()=>null)`), **none has a writer**. The knowledge:* pair are the intended KB inputs to the intelligence engine and are permanently null.

### Also flagged
- **`published:slug:{slug}`** — written only in `save-edits.js` slug-branch (`:86/88`); the normal publish path writes `published:{videoId}` only. Republish-by-slug depends on a record the normal flow doesn't create.
- `gate:{slug}`, `gate:corpus` — **[branch-only]**, not in production.

---

## 5. The intelligence engine + feedback loops (the part that most matters)

### Loop status
| Loop | Status | Evidence |
|---|---|---|
| signals → daily brief → article generation | **CLOSED** | engine reads `seo:signals`/`ga4:signals`/`seo:learning`/directive+title outcomes → `callClaudeAnalyst` (`intelligence-engine.js:251`) → `intelligence:brief` (`:284`); consumer folds `brief.promptInjection`+`articleBrief` into the writer prompt (`ffx-consumer:698-745`) |
| directive suppression | **CLOSED** | `directive_outcome` blocks re-surfacing acted directives (`engine:600-610,:637`) |
| title-CTR test (14-day) | **CLOSED** | `title-test → seo-signals checkTitleTests → brief context/suppression` |
| voice calibration | **CLOSED** (fires after ≥10 edits) | Salman edits → `social-intelligence:370` `corrections` → article prompt (`ffx-consumer:770`), social prompt, voice gate |
| social-reply subsystem | **CLOSED but isolated** | `opportunities → reply_performance → next scan`; never touches the article engine |
| measured site performance (GSC/GA4 aggregate) → next brief | **CLOSED at the signal level** | engine reads `seo:signals`/`ga4:signals` (top pages/queries/positions) — live brief targets a query the site already ranks for |
| per-article prediction-accuracy → next decision | **NOT wired** | engine never reads `content:performance:{slug}` snapshots or `accuracy_scores` |

### The performance loop is half-built
- **Measurement half — WIRED and running.** GSC/GA4 pull daily (§6). `content:performance:{slug}` is created at generation (`ffx-consumer:372`), flipped to `published` at publish (`publish.js:177`); `seo-signals.js` populates `snapshot7/30/90` daily (`:206-226`), writes `intelligence:outcomes` (`:359`), rolls up `intelligence:accuracy_scores` weekly (`:449`).
- **Consumption half — ABSENT.** `intelligence-engine.js` **never reads `content:performance`, `intelligence:outcomes`, or `intelligence:accuracy_scores`** (its Step-1 `Promise.all` `:33-47` and Step-2 `:59-63` list every input; none appear). `intelligence:accuracy_scores`'s only reader binds and never uses it (`youtube-metadata.js:55/67`). `snapshot7/30/90` are read only by the code that writes them. `directive_outcome.outcome` is never set to `'improved'` (`engine:552,:557` filter for a value nothing writes).
- **CORRECTION (live-verified):** the engine is **not** blind to performance. It reads measured
  GSC/GA4 signals (`seo:signals`/`ga4:signals`: top pages, queries, positions), so measured site
  performance **does** feed the next brief. The live brief (`GET /api/intelligence-engine`,
  generatedAt 2026-07-07) proves it: `articleBrief.targetQuery = "opening candle continuation
  strategy"` — a query the site already ranks for. **So the loop is closed, but it's fed the
  site's OWN low-volume GSC data → it echoes the site's zero-volume proprietary vocabulary.** The
  fix is a better *input* (external demand data), not "closing an open loop."
- **What genuinely isn't wired:** the tighter per-article accuracy sub-loop — the engine never
  reads `content:performance:{slug}` snapshots or `intelligence:accuracy_scores`, so it can't learn
  "my brief for keyword X actually ranked / didn't." Adding that reader in `intelligence-engine.js`
  Step 1 (`:33-47`) + `buildSignalContext` (`:444`) would sharpen it — useful, but secondary to
  swapping the target-selection input from GSC-echo to the demand map.

---

## 6. GSC + GA4 wiring — genuinely connected

- **Mechanism:** shared OAuth **refresh-token** helper `google-auth.js` (`:33-42`), env `GOOGLE_REFRESH_TOKEN`+`GOOGLE_CLIENT_SECRET`, scopes `webmasters.readonly`+`analytics.readonly`, token cached in `google:access_token`(+expiry) 55min. **Service account explicitly removed** (`indexing-engine.js:470`). Inert if the two secrets are unset (`google-auth.js:20-21` → 500) — cannot be confirmed from source whether secrets are set in prod.
- **GSC — connected, read-only, 3 paths:** `seo-signals.js` (POST) queries `searchAnalytics/query` for `sc-domain:fortitudefx.com` (`scQuery :580`) → writes `seo:signals`/`seo:learning` + cascades snapshots/outcomes/accuracy/title-tests; `dashboard-seo.html` hits GSC **directly from the browser** (`:852`); `indexing-engine.js` uses URL-Inspection API (`:492`) **diagnostic only** (submission is manual GSC).
- **GA4 — connected, read-only, 2 paths:** `ga4-signals.js` (POST) runs 9 reports on property `534628287` (`ga4Query :191`) → `ga4:signals`/`ga4:learning`; `dashboard-audience.html` hits GA4 Data API **directly from the browser** (`:602`).
- **Automated:** the 05:00 UTC cron POSTs `/api/seo-signals` + `/api/ga4-signals` (`ffx-cron:107,122`); dashboards can force refresh. `indexing-engine` is **manual only** (no cron caller).
- **Consumers:** `ffx-cron updateTargetActuals` (→ `intelligence:targets`), reply-perf scoring, `seo-signals` snapshots, `health-check` freshness, and the intelligence-engine brief.
- **YouTube analytics** (`youtube-analytics.js`/`youtube-signals.js`) uses the same token but needs `yt-analytics.readonly` scope **not in google-auth's list** — "gracefully skips if 403" (`youtube-signals.js:215`); needs manual re-consent.

**Implication:** the data needed to close the performance loop is already flowing and stored. Closing the loop is a *reader*, not a new integration.

---

## 7. The knowledge base — CORRECTED against the live system

> **This section was wrong in the first pass and is corrected here from LIVE data
> (`GET https://fortitudefx.com/api/nuggets`), not from the extraction code.**

- **There is a real, curated Knowledge Library: 226 nuggets, live.** Categories (live counts):
  CTW Framework **88**, Execution Discipline **55**, Professional Thinking **43**, Trading
  Reality **21**, Market Psychology **13**, Founder Observation **4**, Lifestyle & Philosophy **2**.
- **Each nugget is source-traceable and quotable.** Stored shape (`nugget:{id}`, indexed by
  `nuggets:index`): `{ id, text, category, tags[], hook, format, sourceVideoId, sourceTitle,
  youtubeUrl, publishedTo{}, createdAt, updatedAt }`. The `text` is Salman's methodology in his
  own teaching voice (formats: `question` / `story` / `contrarian` / `insight`), each carrying
  `sourceVideoId` + `youtubeUrl` → **a citable source**. (Live example, CTW: *"Why use stop
  orders instead of market orders at liquidity sweeps? Because the sweep itself is your
  confirmation…"* → `sourceVideoId 0_YybIdgkFo`.) My earlier "Claude-paraphrased, not verbatim,
  unusable" was wrong — these are his curated, attributed knowledge units, built on purpose for reuse.
- **CTW methodology is stored as data, not just prompt strings.** The 88 CTW-Framework nuggets
  ARE the methodology as retrievable, tagged records. (The five *model names* LC-E/LE-I/… still
  appear only in prompt blurbs, but the methodology substance is a live library, contra the first pass.)
- **Retrieval already exists, at two levels:** (1) `api/nuggets` GET serves the whole indexed
  library; the knowledge dashboard filters by category/tag/search. (2) **The intelligence engine
  already retrieves nuggets by tag** — `intelligence-engine.js:744-768`: it loads nuggets, filters
  by `articleBrief.nuggetTags` overlap (`:751 matchedNuggets`), and when ≥2 match emits
  `action.type='nugget_generate'` with the matching `nuggetIds` and the note *"inject them for a
  stronger article"* (vs `'new_article' → 'Add Video to Queue'` when nothing matches). So the
  system already **retrieves, matches, and decides to generate from nuggets.**
- **What generation does NOT do yet:** `callClaudeArticle` injects only the nugget *tags* (labels)
  into the prompt (`ffx-consumer:720`), **not the nugget text**, and there is **no executor** that
  runs a `nugget_generate` directive (the generation pipeline is still triggered by a video in the
  queue). The transcripts (`transcript:{videoId}` flat text; `transcript:timestamps:{videoId}`
  `{text,start-sec}`, best-effort) remain as a raw backup if strict word-for-word-from-spoken is
  ever needed. `knowledge:taxonomy`/`knowledge:performance` (the planned engine *inputs*) have no
  writer (§4) — but those are minor unused inputs, **not** the knowledge base; the KB is the 226 live nuggets.
- **So grounded, source-cited quoting is feasible NOW** using the existing library — see §10.

---

## 8. The social path

- **Order (sequential `await`):** Blog → Blog-Regional (disabled) → X → LinkedIn → Tumblr → Discord (`publish-confirm.js`).
- **Failure isolation:** each platform in its own try/catch; a failure sets `status.{p}='Error:…'` and continues — **never aborts the others or the article.** ⚠ **The blog article failing does NOT stop the social posts** — they still post and link to a URL that may not exist (`publish-confirm.js:382` warns of exactly this).
- **Workers:** `tweet.js` (6-tweet thread, OAuth 1.0a, returns `results[0].tweet_id` → x.com URL); `linkedin.js` (personal-profile UGC post, returns `x-restli-id` → feed URL); `discord.js` (webhook `?wait=true` → message link, else `/vipdiscord`); `tumblr.js` (returns `post_id` but **publish-confirm discards it** `:154-156` → dashboard "View post" resolves to the blog homepage, not the specific post).
- **Post URL → dashboard:** URL stored at `published:{videoId}.platforms.{p}.status` (`:210-227`) → `press-data.js` lists `published:*` → `dashboard-press.html` `extractPostUrl` (`:564`) renders "View post →".

---

## 9. Dashboards (12)

| Dashboard | Purpose | Data source (GET) | Actions (POST/PATCH) |
|---|---|---|---|
| `dashboard.html` | ops home / KPI cards | `/press-data` | none (nav; 3 "coming soon" cards) |
| `dashboard-queue.html` | editorial pre-publish queue | `/queue`, `/api/parked-queue`, `/api/video-content`, `/api/queue-edits`, `/generate-status` | generate, queue add/remove/reorder, queue-edits, regenerate-platform, **press-publish** |
| `dashboard-press.html` | published-content manager | `/press-data`, `/api/regen-status`, `/api/seo-signals` | save-edits, title-test, regenerate/restore, press-publish |
| `dashboard-seo.html` | **GSC command center + brief + link graph + scorecard** | **GSC API direct-from-browser** (`:852`), `/api/seo-signals`, `/api/intelligence-engine`, `/api/seed-targets`, `/api/directive-history`, `/api/bulk-link-scan` | seo-signals refresh, **Run Analysis** (intelligence-engine), seed-targets, directive-feedback, title-test, article-link, bulk-link-scan |
| `dashboard-audience.html` | **GA4 audience + client-computed exec summary + priority actions** | **GA4 API direct-from-browser** (`:602`), `/api/ga4-signals`, `/api/seo-signals`, `/api/intelligence-engine`, `/api/seed-targets` | ga4-signals refresh, Run Analysis, seed-targets, directive-feedback |
| `dashboard-health.html` | 6-layer diagnostic + 30d history | `/api/health-check` | Run Health Check |
| `dashboard-indexing.html` | Google index-status monitor | `/api/indexing-engine` (+history/progress) | Run Now, mark_submitted/snooze/ignore/resubmit |
| `dashboard-journey.html` | email-sequence positions (read-only) | `/api/journey-status` | none (re-fetch only) |
| `dashboard-knowledge.html` | nugget CRUD library | `/api/nuggets` | create/update/delete nuggets |
| `dashboard-newsletter.html` | newsletter compose/publish/perf | `/api/newsletter(-generate/-publish)` | generate, save/preview, publish, refresh perf |
| `dashboard-social.html` | forum-reply opportunity feed | `/api/social-intelligence` | Run Scan, post/edit/dismiss reply |
| `dashboard-youtube.html` | YouTube SEO + thumbnail + content + analytics | `/api/youtube-*`, `/api/video-content` | youtube-generate/metadata/thumbnail/signals, regenerate-platform, press-publish, refresh analytics (parallel youtube-analytics+ga4-signals+youtube-signals) |

**SEO dashboard** reads GSC live in the browser for charts/queries/pages, and orchestrates the intelligence brief + internal-link graph + weekly scorecard. **Audience dashboard** reads GA4 live in the browser and computes an executive summary + 1-2-3 priority actions client-side (not from KV).

---

## 10. GAPS against the keyword-driven target end state (file/function level)

Target: cron picks keyword from real demand → generate from KB in voice with verbatim cited quotes → gate → queue (unchanged) → review/publish (unchanged) → site + socials (unchanged) → press dashboard (unchanged) → performance feeds back to intelligence engine.

**What already works (no change):** Steps 3→11 are source-agnostic; the queue→review→publish→social→press flow is intact; the pipeline is already keyword-aware via `articleBrief.targetQuery`; GSC/GA4 measurement is wired.

**Already exists (re-plumb, do NOT rebuild):** the 226-nugget library with text + provenance +
tags + index + dashboard/CRUD (§7); **nugget retrieval-by-tag AND a `nugget_generate` decision**
in `intelligence-engine.js:744-768`; `articleBrief.targetQuery` + `nuggetTags` already flow into
the article prompt (`ffx-consumer:714,720`); the whole queue→review→publish→socials→press flow
(source-agnostic); GSC/GA4 measurement + the intelligence brief.

**What genuinely must be built/changed (small, right-sized):**
1. **Target input → demand map, not GSC-echo.** Feed `articleBrief.targetQuery` from
   `docs/FFX_KEYWORD_DEMAND_MAP.md` (→ `intelligence:targets`) instead of the site's own GSC
   queries. This is the fix for the live `"opening candle continuation strategy"` echo. Re-plumb
   the target-selection input in the brief build — the engine's nugget-matching stays.
2. **Inject nugget TEXT into generation.** Today only `nuggetTags` (labels) reach the article
   prompt (`ffx-consumer:720`); the engine already computes the matching nuggets (`intelligence-engine.js:751`).
   Pass those nuggets' **text** into `callClaudeArticle` as verbatim grounding with a "quote these
   verbatim and cite `youtubeUrl`" instruction. Small prompt + data-passing change.
3. **A `nugget_generate` executor (the source swap).** Today the pipeline is triggered by a video
   in the queue and `processJob` fetches a transcript. Add a path that enqueues
   `{targetQuery, nuggetIds}` (from the existing `nugget_generate` directive) and a `processJob`
   branch that uses the retrieved nugget text as the source **instead of** `fetchTranscriptSupadata`.
   Everything after (validation → store → queue → publish) is unchanged.
4. **Deploy the gate** (branch-only): merge `lib/gate/*` + wiring, seed `gate:corpus`, wire
   `upsertCorpus` on publish, add the queue-dashboard verdict chip.
5. *(Optional)* quote-verification gate check; per-article accuracy reader (§5); fix the
   captured-but-unused keys (§4).

**Hazards flagged (not requested):** article-fails-but-socials-still-post (`publish-confirm` has no
article-success guard); Tumblr "View post" → homepage (`publish-confirm:154`); `CLAUDE.md` still
names `Redesign` active post-cutover.

**Bottom line (corrected):** this is **a source swap, not a rebuild.** The knowledge library,
nugget retrieval, and the "generate from nuggets" decision already exist; the target already flows
into generation. The real work is: point target-selection at the demand map, inject nugget *text*
(not just tags) into the prompt with verbatim-cite, add an executor to run the existing
`nugget_generate` directive without a video, and deploy the built gate. Salman's day-to-day
(queue → review → publish → socials → press) does not change at all.
