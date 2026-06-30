# FFX — EXECUTION-PLAN.md (frozen reference: canonical execution order)

**Purpose:** the architecturally correct order for every remaining fix, so no step is ever undone or invalidated by a later one, and no step runs that secretly depends on a later phase. This doc holds the *reasoning*; `TASKS.md` holds the *actions* in this order. Frozen reference — supersede with a new dated file, don't overwrite.

**Status note:** Several Phase-1 items are already **built + verified on the Redesign preview** (article SSR, /blog SSR, sitemap generator dedupe+lastmod, /blog title, `_middleware.js` deletion, canonicals, soft-404). They are not yet live and are not checked off in `TASKS.md` (owner reviews before check-off). "Built" below = on preview, pending the final CUTOVER.

**Go-live model (owner's definition — no incremental merges):** We do **NOT** do incremental git merges of Redesign into `main`. **ALL** work stays on Redesign / preview until the very end; nothing reaches the live audience until **one final cutover**. The M1/M2/M3 "checkpoints" below are **preview verification gates only** — they do not go live. GO-LIVE is a single **CUTOVER**: archive the current live site in its entirety and make **Redesign become production** (a full replacement). Because Redesign was branched from `main` they share git history, so a true clean cutover is **repoint Cloudflare Pages production → Redesign (archive old `main`)** OR **wholesale-replace `main` with Redesign after tagging/archiving the old version** — *not* a normal merge. Exact mechanism `[TO CONFIRM against the live Cloudflare project at cutover time]`.

**The cutover line (refined):** **Anything Google can SEE or INDEX must be fixed + verified BEFORE cutover** (SEO structural fix, regional-pipeline removal, index cleanup, existing-pages E-E-A-T bar, full guard sweep incl. real-browser render check). **Anything private/backend, or that only improves FUTURE content, happens AFTER cutover** (dashboards, backend pipeline review, engine tuning, E-E-A-T *engine* tuning, voice recalibration, the deferred decisions) — it has zero effect on indexing, so it does **not** gate go-live. The locked sequence is split into these two groups; **CUTOVER depends on the BEFORE group only.**

---

## Owner decisions encoded (do not re-litigate)
- **D1 — Shared links may 404.** Links affected by our cleanup (LinkedIn/X posts) are ALLOWED to 404. Do not over-engineer to preserve them. Gate B's job is to make breakage **visible** (list exactly what will 404), not prevent it.
- **D2 — Phase 2 regional removal, 301-vs-404 (owner's call; my recommendation):** **301 each removed regional URL to its global parent where a parent exists** (consolidates equity + any backlinks to the surviving canonical, better UX, cheap, aligns with the standing hard-constraint that removed public URLs get 301'd); **404 only where no global parent exists.** Per D1 the owner may instead let some 404 — that's acceptable; flag is theirs.
- **D3 — Home→article direct links: DEFERRED.** Adding article links to `index.html` is a design change (home has zero article section today — only 3 `href="blog.html"`). Not resolved here; not in the sequence until the owner decides. Orphan fix does not require it (every article is reachable via `/blog` SSR, which home links to).

---

## Item inventory (changes · reads/depends · produces · before/after · evidence)

**G0 — GSC 5xx URL confirm** (read-only). Changes: nothing. Reads: GSC report; live URL status. Produces: confirmation the reported 5xx now serves 200 (SEO-AUDIT.md §C proved HTML routes are static 200; 5xx only on JSON subroutes). Before: anything. After: the M1 checkpoint confidence. *Ev: SEO-AUDIT.md §C.*

**GA — Link-Safety Gate A** (read-only). Changes: nothing. Reads: `functions/article.js`, `functions/article-content.js` serving path. Produces: proof article serving resolves from `article:{slug}` / `published:{videoId}`, **not** the `articles:index` list — so deduping/removing index entries cannot break any `/article?slug=` link. **Before:** any index dedupe (CLEAN), any Phase-2 index removal. **After:** none. If serving depends on the index → STOP. *Ev: article-content.js reads `article:{slug}`/`published:{videoId}`; blog uses index only for the list.*

**GB — Link-Safety Gate B** (read-only). Changes: nothing. Reads: social post logs in KV (writers: `tweet.js`, `linkedin.js`, `discord.js`, `tumblr.js`), `published:{videoId}` for posted URLs. Produces: full list of every socially-shared URL classified "still lives" vs "must 301/404 in Phase 2." **Before:** Phase-2 redirect/removal. **After:** none. If posted URLs aren't logged anywhere retrievable → say so explicitly (then Phase-2 redirect targeting is best-effort from the regional→global sibling map). *Ev: per-platform posters; BACKEND-AUDIT.md §1.*

**TQ — targetQuery [UNVERIFIED] check** (read-only — **AFTER cutover**). Changes: nothing. Reads: `intelligence-engine.js` brief-selection. Produces: confirmation whether `targetQuery` picks highest-opportunity term or first-in-list. *Placement: informs FUTURE generation only — no effect on current public pages; does not gate go-live.* *Ev: BACKEND-AUDIT.md §F.*

**P1a — newsletter-issue SSR** (§A2). Changes: new `functions/newsletter-issue.js` (server-render per-issue title/canonical/OG/JSON-LD + body). Reads: `newsletter:issue:{date}` (read-only subrequest, like article SSR). Produces: complete crawlable issue page. Before: the M1 checkpoint. After: none. Note: currently a no-op risk only (0 published issues), but required before issues exist. *Ev: SEO-AUDIT.md §A2; middleware deletion removed its head-patch.*

**P1b — /blog defensive dedupe.** Changes: `functions/blog.js` dedupes the SSR list by slug. Reads: `/articles` (read-only). Produces: clean blog list even while production `articles:index` still holds 23 dup entries (interim, until CLEAN). **Before:** the M1 checkpoint (so production blog is never ugly). **After:** redundant-but-harmless once CLEAN runs. Depends on GA (link-safety reasoning). *Ev: 58 entries/35 unique on production /articles.*

**WF — articles:index writer fix** `[AUTHORIZED — KV-write path]`. Changes: `functions/publish.js` index-update path — dedupe on write, never write a `title:null` stub. Reads: `articles:index`. Produces: future publishes stop creating duplicates. **Before:** CLEAN (else cleaned data re-dirties on next publish). **After:** GA (serving proven index-independent first, defensive). Bundle with the Phase-1 `publish.js` change (same file) → live by the M1 checkpoint. *Ev: publish.js index-update ~`:81-108`; suspected source of the `title:null` twins.*

**RG — recurrence-guard pre-deploy SEO audit** (Phase 3). Changes: reusable audit script + wire into launch; reference from `CLAUDE.md`. Reads: code/build. Produces: every checkpoint + the cutover gated by the SEO-AUDIT checks. **Before:** the M1 checkpoint (so every checkpoint is audited). After: all later checkpoints + the CUTOVER use it. *Ev: SEO-AUDIT.md (the checks to encode).*

**M1 — CHECKPOINT 1: Phase-1 complete + audit-passing on preview** (NOT a live merge). All Phase-1 (article SSR, /blog SSR+dedupe, newsletter SSR, canonicals §B, soft-404 §F1, sitemap generator dedupe §D1 + real lastmod §D2 + WF, /blog title §F, `_middleware.js` deletion) built and verified on Redesign/preview; `scripts/seo-audit.js` passes against preview. **Stays on preview — does NOT go live** (no merge to `main`). Depends: G0, GA, P1a, P1b, WF, RG verified on preview. After: Phase 2.

**P2-audit — regional touchpoint audit** (read-only map). Reads: `config:regionCycle`/`ffx-config.json`, `ffx-consumer` regional gen, `regionalContent` in `published:{id}`, regional posting, regional slugs in `articles:index`+sitemap, canonical logic. Produces: the exact removal/redirect work-list. Before: any Phase-2 change. *Ev: BACKEND-AUDIT.md §D.*

**P2-gen — remove regional generation** (`ffx-consumer`). Produces: no new regional articles created. Before: removing existing regional URLs (stop the source first). *Ev: BACKEND-AUDIT.md §D (`ffx-consumer:639` "core insight identical").*

**P2-post — remove regional posting paths.** Produces: no new regional URLs posted. Coordinate w/ GB map. Before: M2.

**P2-ui — remove blog region filters/UI.** Changes: `blog.html`/`functions/blog.js` filter UI. Produces: no dead region `fetch` params; list still renders. Coordinate w/ P1b SSR. Before: M2.

**P2-301 — redirect removed regional URLs → global parent.** Changes: `functions/article.js` detects a regional slug and 301s to its global parent (query-param URLs can't be done in `_redirects`; the SSR Function resolves the parent via the sibling/`regionalContent` map). Produces: shared regional links land on the global article (per D2). **Before:** removing regional records (so the redirect is live before the URL stops resolving). **After:** GB (need the shared-URL list). *Ev: article-content.js sibling resolution; D2.*

**M2 — CHECKPOINT 2: Phase-2 complete + audit-passing on preview** (NOT a live merge). Phase-2 code (P2-gen, P2-post, P2-ui, P2-301) built and verified on preview; audit passes. **Stays on preview — does NOT go live.** Depends: P2-audit…P2-301 verified on preview; GA, GB done. After: the KV data ops below.

**P2-idx — remove regional slugs from articles:index** `[AUTHORIZED — KV write]`. Produces: index no longer lists regional articles → sitemap drops them on next publish. **Before:** CLEAN. **After:** M2 (redirects live first, so removed URLs 301 rather than 404 mid-flight).

**CLEAN — one-time articles:index cleanup** `[AUTHORIZED — KV write]`. Changes: dedupe production `articles:index` to unique real records (keep real-title record, drop `title:null` twin); verify unique=total, 0 dupes, 0 null titles. Tool likely `backfill-articles-index.js`. **Before:** none (terminal data step). **After:** WF live (else re-dirties) **and** P2-idx (else it dedupes slugs about to be deleted → double work). *Ev: 23 dup entries listed in prior audit.*

**SM-verify — confirm sitemap regenerates clean** (read-only after a publish). Produces: proof of 0 dup `<loc>`, no regional URLs, real lastmod. After: WF + P2-idx + CLEAN. *Ev: §D1/§D2.*

**EEAT-pages — existing public pages pass the E-E-A-T bar** (BEFORE cutover). Changes: assess + fix the CURRENT live-bound public pages (homepage, articles, /blog, bootcamp, vipdiscord, pricing, privacy) against an approved checklist. Public/indexing-facing → gates go-live. Pass-criteria come from the **EEAT-criteria DECISION** (Claude proposes; owner approves) — not invented here. Distinct from the AFTER-cutover E-E-A-T *engine* tuning, which improves future generation.

**GUARD-SWEEP — full-site guard sweep** (BEFORE cutover; final gate). Run the upgraded `seo-audit.js` across all SSR pages incl. the **real-browser render check** (body actually visible, no uncaught JS) — the exact blind spot that let the blank-article bug pass a bytes-only check. Must pass before CUTOVER.

**BK1 — indexing-engine auto-submit disable** (Phase 4 — **AFTER cutover**). Changes: `indexing-engine.js` stop POSTing article URLs to the Indexing API; keep URL-Inspection. *Placement: a backend cron that pings Google's Indexing API — it does NOT change what Google crawls on the public pages, and runs on production already; indexing-**adjacent** (owner may pull earlier) but does not gate go-live.* *Ev: BACKEND-AUDIT.md §4-A; `indexing-engine.js:536,:590`.*

**BK2 — linkedin-test.js removal** (Phase 4 — **AFTER cutover**). Changes: delete orphan `functions/linkedin-test.js`. Before: a read-only "no external monitor hits `/linkedin-test`" check. *Placement: purely backend/security cleanup — not a content/indexing page; does not gate go-live.* *Ev: 0 refs; BACKEND-AUDIT.md §3.*

**BK3 — title-rewriter removal** (Phase 4 — **AFTER cutover**) `[owner: remove vs constrain]`. Changes: remove `title_rewrite` path from `intelligence-engine.js` (`:364-367`,`:671-677`) and the live-title write in `title-test.js` (`:52-54`); freeze published titles. *Placement: changes live titles only on FUTURE operator action — cutover-state titles are unaffected; engine/behaviour change, does not gate go-live.* *Ev: BACKEND-AUDIT.md §4-B/§4-C.*

**M3 — CHECKPOINT 3: backend fixes complete + audit-passing on preview** (AFTER cutover; NOT a live merge). BK1–BK3 built and verified on preview. Independent — sequenced after the SEO work; does not gate cutover.

**DASH/PIPE — dashboards + backend pipeline review** (**AFTER cutover**). Internal operator dashboards review; backend pipeline / workflow / design review. Private tooling — not public/indexed; no go-live effect.

**ENGINE tuning** (Phase 5 — **AFTER cutover**). Article naming, keyword strategy; **E-E-A-T engine tuning** (hardening FUTURE generation for YMYL/finance) `[BLOCKED]`; voice recalibration `[BLOCKED]`. Improves future content only. *Scout Network refinement: the brief no longer fully blocks cutover — only EEAT-pages (existing pages) is pre-cutover; full voice/engine recalibration is post-cutover.* *Ev: BACKEND-AUDIT.md §E/§F.*

**POL — single-hop redirect polish.** Collapse `http://www → https://www → apex` to one hop. Cosmetic, no SEO defect; lowest priority; anytime. *Ev: both hops are clean 301s today.*

**CUTOVER — clean replacement: archive live site, Redesign becomes production** (the ONE and ONLY go-live; happens last, after EVERYTHING above is built, audit-passing, and stress-tested on preview). Nothing reaches the live audience before this. Steps: (1) archive the current live site in its entirety (tag/snapshot the old production); (2) make Redesign the production source — a full replacement, NOT a normal git merge; (3) run `scripts/seo-audit.js` against the cutover/production and confirm PASS before declaring go-live. **Technical reality:** Redesign was branched from `main`, so they share git history — a true clean cutover is therefore done by **repointing the Cloudflare Pages production branch to Redesign** (and archiving old `main`), **OR** wholesale-replacing `main`'s contents with Redesign after tagging/archiving the old version — *not* a normal merge. **Exact mechanism `[TO CONFIRM against the live Cloudflare project at cutover time]`.** Depends: **the BEFORE-CUTOVER group ONLY** — M1, M2, P2-idx, CLEAN, SM-verify, existing-pages E-E-A-T bar, and the full guard sweep, all audit-passing on preview. Does **NOT** depend on M3 / backend fixes / engine tuning / E-E-A-T engine work (those are AFTER cutover and have no indexing effect).

---

## Collisions (explicitly surfaced)
1. **CLEAN after P2-idx** — deduping the index before Phase 2 removes regional slugs would dedupe slugs about to be deleted → double work / churn. Cleanup runs once, last.
2. **CLEAN after WF — now SOFT, not load-bearing.** WF investigation found NO current writer actively re-dirties `articles:index` (all four writers already dedupe / require a real title; the 23 null-twins are legacy data). So CLEAN no longer depends on WF to prevent re-dirtying — there is no active re-dirty source. WF still precedes CLEAN as good practice (ship the code fix before the data mop-up; WF also self-heals each re-published slug), but the ordering is no longer a hard correctness gate.
3. **GA before CLEAN and P2-idx** — if serving depended on `articles:index`, deduping/removing entries could 404 live `/article?slug=` URLs. GA proves independence first, or we STOP.
4. **GB before P2-301/P2-post** — can't target redirects (or even see the 404 blast radius) without the shared-URL list. GB first.
5. **Sitemap generator dedupe ≠ clean data** — the generator dedupes its *output* every publish (already built), so no duplicate `<loc>` ships even from dirty data; but the *underlying* `articles:index` stays dirty until WF+CLEAN, and the sitemap keeps regional URLs until P2-idx. Full sitemap correctness = generator (done) + P2-idx + CLEAN.
6. **P1b (blog dedupe) vs CLEAN** — both produce a clean blog list. P1b is the interim guard for the M1→CLEAN window; CLEAN fixes the root data. They don't reverse each other; P1b becomes redundant-but-harmless after CLEAN.
7. **P2-301 before P2-idx** — redirects must be live before the regional records are pulled, or shared links 404 in the gap (worse than the agreed end-state of a clean 301).
8. **RG before M1** — wiring the recurrence guard after the big cutover means the cutover itself isn't audited. Build it first.

---

## LOCKED ORDERED SEQUENCE (canonical)

### ═══ BEFORE CUTOVER — public-facing / indexing (GATES go-live) ═══
1. **G0** — confirm GSC 5xx URL now serves 200 (read-only) [no dep; gates M1 confidence]
2. **GA** — prove serving independent of `articles:index` (read-only) [BLOCKS CLEAN + P2-idx; STOP if dependent]
3. **GB** — map every shared social URL → still-lives / must-301-or-404 (read-only) [BLOCKS P2-301/P2-post]
4. **P1a** — build newsletter-issue SSR (read-only data) [Phase-1; → M1]
5. **P1b** — add `/blog` defensive slug-dedupe [after GA; → M1; interim until CLEAN]
6. **WF** — `publish.js` writer fix: dedupe-on-write, no `title:null` stub `[AUTH]` [bundle w/ Phase-1 publish.js; MUST precede CLEAN]
7. **RG** — build + wire pre-deploy SEO audit incl. real-browser render check [before M1 so every checkpoint is audited]
8. **M1** — CHECKPOINT 1: all Phase-1 complete + `seo-audit.js` passing on preview [after 1–7 verified on preview; NOT a live merge — stays on preview]
9. **P2-audit** — map every regional touchpoint (read-only) [before any Phase-2 change]
10. **P2-gen** — remove regional generation from `ffx-consumer` [stop the source before removing outputs]
11. **P2-post** — remove regional posting paths [after GB]
12. **P2-ui** — remove blog region filters/UI [coordinate w/ P1b; no dead region params]
13. **P2-301** — 301 removed regional URLs → global parent in `functions/article.js` (404 only where no parent; D2) [after GB; before P2-idx]
14. **M2** — CHECKPOINT 2: Phase-2 complete + audit passing on preview [after 9–13 verified; NOT a live merge — stays on preview]
15. **P2-idx** — remove regional slugs from `articles:index` `[AUTH KV write]` [after P2-301 live on preview; before CLEAN]
16. **CLEAN** — one-time `articles:index` dedupe to unique real records, 0 null `[AUTH KV write]` [after WF + P2-idx; terminal data step]
17. **SM-verify** — confirm next-publish sitemap: 0 dupes, no regional, real lastmod (read-only) [after 6+15+16]
18. **EEAT-pages** — existing public pages pass the E-E-A-T bar (assessment + fix of CURRENT live-bound pages) [criteria via the EEAT-criteria DECISION; this is the existing-pages check, NOT future generation]
19. **GUARD-SWEEP** — full-site guard sweep: SEO-complete + optimized via upgraded `seo-audit.js` incl. real-browser render check (body visible, no uncaught JS) [after all public work; final pre-cutover gate]
20. **POL** — single-hop www→apex redirect [public-facing; cosmetic; NON-BLOCKING — does not gate cutover]
21. **CUTOVER** — clean replacement: archive the live site in full, **Redesign becomes production** (full replacement, not a merge); run `seo-audit.js` (incl. real-browser check) against the cutover and confirm PASS before go-live [THE single go-live; **depends on the BEFORE-CUTOVER group ONLY** (1–19; POL optional); mechanism `[TO CONFIRM]`]

### ═══ AFTER CUTOVER — private / backend / future (does NOT gate go-live) ═══
22. **BK1 / BK2 / BK3 → M3** — indexing-engine auto-submit disable (backend cron pinging Google's Indexing API — does not change crawled public content); `linkedin-test.js` removal (backend/security); title-rewriter removal (changes live titles only on future operator action) → **M3 CHECKPOINT** [all backend; none change cutover-state public pages]
23. **TQ** — verify `targetQuery` selection (read-only) [informs FUTURE generation only]
24. **DASH/PIPE review** — internal dashboards review; backend pipeline / workflow / design review [private; no indexing effect]
25. **ENGINE tuning** — article naming, keyword strategy; **E-E-A-T engine tuning** (FUTURE generation) `[BLOCKED]`; voice recalibration `[BLOCKED]` [improves future content; needs Salman/Scout-Network brief]

> **DECISION — EEAT-criteria:** before step 18, Claude proposes concrete pre-cutover E-E-A-T pass-criteria for owner approval. Not invented here; slot held.

**DEFERRED (not in sequence until owner decides):** home→article direct links (D3 — design change).

*Read-only plan. No code, KV, or live site changed by authoring this doc.*
