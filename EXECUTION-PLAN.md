# FFX — EXECUTION-PLAN.md (frozen reference: canonical execution order)

**Purpose:** the architecturally correct order for every remaining fix, so no step is ever undone or invalidated by a later one, and no step runs that secretly depends on a later phase. This doc holds the *reasoning*; `TASKS.md` holds the *actions* in this order. Frozen reference — supersede with a new dated file, don't overwrite.

**Status note:** Several Phase-1 items are already **built + verified on the Redesign preview** (article SSR, /blog SSR, sitemap generator dedupe+lastmod, /blog title, `_middleware.js` deletion, canonicals, soft-404). They are not yet live and are not checked off in `TASKS.md` (owner reviews before check-off). "Built" below = on preview, pending the final CUTOVER.

**Go-live model (owner's definition — no incremental merges):** We do **NOT** do incremental git merges of Redesign into `main`. **ALL** work stays on Redesign / preview until the very end; nothing reaches the live audience until **one final cutover**. The M1/M2/M3 "checkpoints" below are **preview verification gates only** — they do not go live. GO-LIVE is a single **CUTOVER**: archive the current live site in its entirety and make **Redesign become production** (a full replacement). Because Redesign was branched from `main` they share git history, so a true clean cutover is **repoint Cloudflare Pages production → Redesign (archive old `main`)** OR **wholesale-replace `main` with Redesign after tagging/archiving the old version** — *not* a normal merge. Exact mechanism `[TO CONFIRM against the live Cloudflare project at cutover time]`.

**The cutover line (refined):** **Anything Google can SEE or INDEX must be fixed + verified BEFORE cutover** (SEO structural fix, the regional serving/collision/recovery fixes, index cleanup, existing-pages E-E-A-T bar, full guard sweep incl. real-browser render check). *(The regional-pipeline **removal** that used to live here is RETIRED — regionals are kept; see D2 and the P2-\* items.)* **Anything private/backend, or that only improves FUTURE content, happens AFTER cutover** (dashboards, backend pipeline review, engine tuning, E-E-A-T *engine* tuning, voice recalibration, the deferred decisions) — it has zero effect on indexing, so it does **not** gate go-live. The locked sequence is split into these two groups; **CUTOVER depends on the BEFORE group only.**

---

## Owner decisions encoded (do not re-litigate)
- **D1 — Shared links may 404.** Links affected by our cleanup (LinkedIn/X posts) are ALLOWED to 404. Do not over-engineer to preserve them. Gate B's job is to make breakage **visible** (list exactly what will 404), not prevent it.
- **D2 — Phase 2 regional removal, 301-vs-404 — ⛔ SUPERSEDED / RETIRED.** The owner has DECIDED to **keep the regionals** (they are genuinely distinct, correctly-served articles now that the serving bug is fixed). There is therefore **no regional removal**, and this 301-vs-404 question no longer applies. The only regional work remaining is fine-tuning generation + a similarity gate, **AFTER cutover** (P2-tune). *(Kept here for history; do not execute.)*
- **D3 — Home→article direct links: DEFERRED.** Adding article links to `index.html` is a design change (home has zero article section today — only 3 `href="blog.html"`). Not resolved here; not in the sequence until the owner decides. Orphan fix does not require it (every article is reachable via `/blog` SSR, which home links to).

---

## Item inventory (changes · reads/depends · produces · before/after · evidence)

**G0 — GSC 5xx URL confirm** (read-only). Changes: nothing. Reads: GSC report; live URL status. Produces: confirmation the reported 5xx now serves 200 (SEO-AUDIT.md §C proved HTML routes are static 200; 5xx only on JSON subroutes). Before: anything. After: the M1 checkpoint confidence. *Ev: SEO-AUDIT.md §C.*

**GA — Link-Safety Gate A** (read-only). Changes: nothing. Reads: `functions/article.js`, `functions/article-content.js` serving path. Produces: proof article serving resolves from `article:{slug}` / `published:{videoId}`, **not** the `articles:index` list — so deduping/removing index entries cannot break any `/article?slug=` link. **Before:** any index dedupe (CLEAN), any Phase-2 index removal. **After:** none. If serving depends on the index → STOP. *Ev: article-content.js reads `article:{slug}`/`published:{videoId}`; blog uses index only for the list.*

**GB — Link-Safety Gate B** (read-only; done). Changes: nothing. Reads: social post logs in KV (writers: `tweet.js`, `linkedin.js`, `discord.js`, `tumblr.js`), `published:{videoId}` for posted URLs. Produced: full list of every socially-shared URL classified "still lives" vs "must 301/404 in Phase 2." *(Its downstream — P2-301/P2-post removal — is now RETIRED: regionals are kept, so no shared regional URL is removed and nothing needs a redirect. GB survives only as a completed read-only record.) Ev: per-platform posters; BACKEND-AUDIT.md §1.*

**TQ — targetQuery [UNVERIFIED] check** (read-only — **AFTER cutover**). Changes: nothing. Reads: `intelligence-engine.js` brief-selection. Produces: confirmation whether `targetQuery` picks highest-opportunity term or first-in-list. *Placement: informs FUTURE generation only — no effect on current public pages; does not gate go-live.* *Ev: BACKEND-AUDIT.md §F.*

**P1a — newsletter-issue SSR** (§A2). Changes: new `functions/newsletter-issue.js` (server-render per-issue title/canonical/OG/JSON-LD + body). Reads: `newsletter:issue:{date}` (read-only subrequest, like article SSR). Produces: complete crawlable issue page. Before: the M1 checkpoint. After: none. Note: currently a no-op risk only (0 published issues), but required before issues exist. *Ev: SEO-AUDIT.md §A2; middleware deletion removed its head-patch.*

**P1b — /blog defensive dedupe.** Changes: `functions/blog.js` dedupes the SSR list by slug. Reads: `/articles` (read-only). Produces: clean blog list even while production `articles:index` still holds 23 dup entries (interim, until CLEAN). **Before:** the M1 checkpoint (so production blog is never ugly). **After:** redundant-but-harmless once CLEAN runs. Depends on GA (link-safety reasoning). *Ev: 58 entries/35 unique on production /articles.*

**WF — articles:index writer fix** `[AUTHORIZED — KV-write path]`. Changes: `functions/publish.js` index-update path — dedupe on write, never write a `title:null` stub. Reads: `articles:index`. Produces: future publishes stop creating duplicates. **Before:** CLEAN (else cleaned data re-dirties on next publish). **After:** GA (serving proven index-independent first, defensive). Bundle with the Phase-1 `publish.js` change (same file) → live by the M1 checkpoint. *Ev: publish.js index-update ~`:81-108`; suspected source of the `title:null` twins.*

**RG — recurrence-guard pre-deploy SEO audit** (Phase 3). Changes: reusable audit script + wire into launch; reference from `CLAUDE.md`. Reads: code/build. Produces: every checkpoint + the cutover gated by the SEO-AUDIT checks. **Before:** the M1 checkpoint (so every checkpoint is audited). After: all later checkpoints + the CUTOVER use it. *Ev: SEO-AUDIT.md (the checks to encode).*

**M1 — CHECKPOINT 1: Phase-1 complete + audit-passing on preview** (NOT a live merge). All Phase-1 (article SSR, /blog SSR+dedupe, newsletter SSR, canonicals §B, soft-404 §F1, sitemap generator dedupe §D1 + real lastmod §D2 + WF, /blog title §F, `_middleware.js` deletion) built and verified on Redesign/preview; `scripts/seo-audit.js` passes against preview. **Stays on preview — does NOT go live** (no merge to `main`). Depends: G0, GA, P1a, P1b, WF, RG verified on preview. After: Phase 2.

**P2-audit — regional touchpoint audit** (read-only map; done). Reads: `config:regionCycle`/`ffx-config.json`, `ffx-consumer` regional gen, `regionalContent` in `published:{id}`, regional posting, regional slugs in `articles:index`+sitemap, canonical logic. Produced: the touchpoint map — which surfaced that regionals are distinct-but-mis-served, feeding the owner's **keep** decision (not the removal work-list originally anticipated). Before: any Phase-2 change. *Ev: BACKEND-AUDIT.md §D.*

**P2-serve / P2-collision-guard / P2-recover — the kept-and-fixed Phase-2 work** (DONE, on preview; shared KV → also live). P2-serve: regional URLs now serve their own `regionalContent.body` (was `globalContent.body` for every slug). P2-collision-guard: `publish.js` blocks a different video from clobbering an existing `article:{slug}`. P2-recover: recovered the 2 collision-orphaned globals to unique slugs. These are the entirety of Phase-2's before-cutover code. *Ev: TASKS.md B3 (1618c54, bf0442d, and the recovery turn).*

**P2-gen / P2-post — ⛔ RETIRED (removals cancelled).** Regionals are kept, so generation and posting keep running unchanged. Superseded by **P2-tune** (AFTER cutover): fine-tune generation for genuine differentiation + add a post-generation similarity gate. *Ev: owner decision; see D2.*

**P2-ui — ✅ DECIDED KEEP (not removed).** The blog region filter is a real feature now that regional pages have genuinely distinct content. No change to `blog.html`/`functions/blog.js` filter UI. *Ev: owner decision.*

**P2-301 / P2-idx — ⛔ RETIRED (not needed).** No regional URL is removed, so there is nothing to 301 (P2-301) and no regional slug to pull from `articles:index` (P2-idx); regional slugs stay in the index and the sitemap. *Ev: owner decision; see D2.*

**P2-tune — regional-generation fine-tuning + similarity gate** (**AFTER cutover**; improves FUTURE content only). Changes: tune `ffx-consumer` regional generation so new regionals are genuinely differentiated from their global/parent; add a post-generation similarity gate that blocks/flags a new regional too close to parent/siblings. Zero effect on live pages → does not gate go-live. Replaces the retired P2-gen removal. *Ev: BACKEND-AUDIT.md §D.*

**M2 — CHECKPOINT 2: Phase-2 complete + audit-passing on preview** (NOT a live merge). Phase-2 now consists ONLY of the kept-and-fixed work (P2-serve, P2-collision-guard, P2-recover — all done) — no removal/301/de-index code remains. **Stays on preview — does NOT go live.** Depends: those three verified on preview; GA, GB done (read-only). After: the KV data ops below (CLEAN).

**CLEAN — one-time articles:index cleanup** `[AUTHORIZED — KV write]`. Changes: dedupe production `articles:index` to unique real records (keep real-title record, drop `title:null` twin); verify unique=total, 0 dupes, 0 null titles. Tool likely `backfill-articles-index.js`. **Before:** none (terminal data step). **After:** WF live (else re-dirties). *(The old "after P2-idx" dependency is GONE — P2-idx is retired, so no regional slugs are being deleted; CLEAN only dedupes twins and keeps every real record, regionals included.) Ev: 23 dup entries listed in prior audit.* *(Already verified a NO-OP — see TASKS.md B4 CLEAN.)*

**SM-verify — confirm sitemap regenerates clean** (read-only after a publish). Produces: proof of 0 dup `<loc>`, real lastmod. **Regional URLs are EXPECTED to be present** (regionals are kept) — this is no longer a "no regional URLs" check. After: WF + CLEAN. *Ev: §D1/§D2.*

**EEAT-pages — existing public pages pass the E-E-A-T bar** (BEFORE cutover). Changes: assess + fix the CURRENT live-bound public pages (homepage, articles, /blog, bootcamp, vipdiscord, pricing, privacy) against an approved checklist. Public/indexing-facing → gates go-live. Pass-criteria come from the **EEAT-criteria DECISION** (Claude proposes; owner approves) — not invented here. Distinct from the AFTER-cutover E-E-A-T *engine* tuning, which improves future generation.

**GUARD-SWEEP — full-site guard sweep** (BEFORE cutover; final gate). Run the upgraded `seo-audit.js` across all SSR pages incl. the **real-browser render check** (body actually visible, no uncaught JS) — the exact blind spot that let the blank-article bug pass a bytes-only check. Must pass before CUTOVER.

**BK1 — indexing-engine auto-submit disable** (Phase 4 — **BEFORE cutover**, per owner). Changes: `indexing-engine.js` stop POSTing article URLs to the Indexing API; keep URL-Inspection. *Placement: it fires at Google automatically — we want a clean handshake at relaunch, so disable it before cutover.* *Ev: BACKEND-AUDIT.md §4-A; `indexing-engine.js:536,:590`.*

**BK2 — linkedin-test.js removal** (Phase 4 — **AFTER cutover**). Changes: delete orphan `functions/linkedin-test.js`. Before: a read-only "no external monitor hits `/linkedin-test`" check. *Placement: purely backend/security cleanup — not a content/indexing page; does not gate go-live.* *Ev: 0 refs; BACKEND-AUDIT.md §3.*

**BK3 — title-rewrite path made INERT** (Phase 4 — **anytime; NOT a pre-cutover blocker**). Re-scoped per owner: the title rewrite only ever fires on the owner's **manual dashboard CTA** — it is NOT automatic (no route/cron/trigger fires it), so it cannot affect cutover. Changes: disable the path so it is inert (cannot execute via any route/cron/trigger), reflect it OFF/greyed-out on the internal dashboard, fully **REVERSIBLE** (one toggle to re-enable later). `intelligence-engine.js:364-367,:671-677`; `title-test.js:52-54`. *Ev: BACKEND-AUDIT.md §4-B/§4-C.*

**M3 — CHECKPOINT 3: backend fixes complete + audit-passing on preview** (AFTER cutover; NOT a live merge). BK2–BK3 built and verified on preview. (BK1 is BEFORE cutover.) Independent — sequenced after the SEO work; does not gate cutover.

**DASH/PIPE — dashboards + backend pipeline review** (**AFTER cutover**). Internal operator dashboards review; backend pipeline / workflow / design review. Private tooling — not public/indexed; no go-live effect.

**ENGINE tuning** (Phase 5 — **AFTER cutover**). Article naming, keyword strategy; **E-E-A-T engine tuning** (hardening FUTURE generation for YMYL/finance) `[BLOCKED]`; voice recalibration `[BLOCKED]`. Improves future content only. *Scout Network refinement: the brief no longer fully blocks cutover — only EEAT-pages (existing pages) is pre-cutover; full voice/engine recalibration is post-cutover.* *Ev: BACKEND-AUDIT.md §E/§F.*

**POL — single-hop redirect polish.** Collapse `http://www → https://www → apex` to one hop. Cosmetic, no SEO defect; lowest priority; anytime. *Ev: both hops are clean 301s today.*

**CUTOVER — clean replacement: archive live site, Redesign becomes production** (the ONE and ONLY go-live; happens last, after EVERYTHING above is built, audit-passing, and stress-tested on preview). Nothing reaches the live audience before this. Steps: (1) archive the current live site in its entirety (tag/snapshot the old production); (2) make Redesign the production source — a full replacement, NOT a normal git merge; (3) run `scripts/seo-audit.js` against the cutover/production and confirm PASS before declaring go-live. **Technical reality:** Redesign was branched from `main`, so they share git history — a true clean cutover is therefore done by **repointing the Cloudflare Pages production branch to Redesign** (and archiving old `main`), **OR** wholesale-replacing `main`'s contents with Redesign after tagging/archiving the old version — *not* a normal merge. **Exact mechanism `[TO CONFIRM against the live Cloudflare project at cutover time]`.** Depends: **the BEFORE-CUTOVER group ONLY** — M1, M2 (now just the kept-and-fixed regional work), CLEAN, SM-verify, existing-pages E-E-A-T bar, and the full guard sweep, all audit-passing on preview. *(P2-idx removed from this list — retired; regionals are kept.)* Does **NOT** depend on M3 / backend fixes / engine tuning / E-E-A-T engine work (those are AFTER cutover and have no indexing effect).

---

## Collisions (explicitly surfaced)
1. ~~**CLEAN after P2-idx**~~ — ⛔ MOOT. P2-idx is retired (regionals kept), so no regional slugs are deleted and there is nothing for CLEAN to "wait behind." CLEAN just dedupes twins, keeping every real record (regionals included), and has already been verified a no-op.
2. **CLEAN after WF — now SOFT, not load-bearing.** WF investigation found NO current writer actively re-dirties `articles:index` (all four writers already dedupe / require a real title; the 23 null-twins are legacy data). So CLEAN no longer depends on WF to prevent re-dirtying — there is no active re-dirty source. WF still precedes CLEAN as good practice (ship the code fix before the data mop-up; WF also self-heals each re-published slug), but the ordering is no longer a hard correctness gate.
3. **GA before CLEAN** — if serving depended on `articles:index`, deduping entries could 404 live `/article?slug=` URLs. GA proves independence first, or we STOP. *(Formerly "before CLEAN and P2-idx"; P2-idx retired.)*
4. ~~**GB before P2-301/P2-post**~~ — ⛔ MOOT. P2-301/P2-post are retired (regionals kept), so there are no redirects/removals to target. GB stands only as a completed read-only record.
5. **Sitemap generator dedupe ≠ clean data** — the generator dedupes its *output* every publish (already built), so no duplicate `<loc>` ships even from dirty data; the *underlying* `articles:index` was dirty until WF+CLEAN. **Regional URLs stay in the sitemap by design** (regionals are kept). Full sitemap correctness = generator (done) + CLEAN. *(No P2-idx step — retired.)*
6. **P1b (blog dedupe) vs CLEAN** — both produce a clean blog list. P1b is the interim guard for the M1→CLEAN window; CLEAN fixes the root data. They don't reverse each other; P1b becomes redundant-but-harmless after CLEAN.
7. ~~**P2-301 before P2-idx**~~ — ⛔ MOOT. Both retired (regionals kept); no records are pulled and nothing is redirected.
8. **RG before M1** — wiring the recurrence guard after the big cutover means the cutover itself isn't audited. Build it first.

---

## LOCKED ORDERED SEQUENCE (canonical)

### ═══ BEFORE CUTOVER — public-facing / indexing (GATES go-live) ═══
1. **G0** — confirm GSC 5xx URL now serves 200 (read-only) [no dep; gates M1 confidence]
2. **GA** — prove serving independent of `articles:index` (read-only) [BLOCKS CLEAN; STOP if dependent]
3. **GB** — map every shared social URL → still-lives / must-301-or-404 (read-only) [done — read-only record only; its downstream P2-301/P2-post are RETIRED]
4. **P1a** — build newsletter-issue SSR (read-only data) [Phase-1; → M1]
5. **P1b** — add `/blog` defensive slug-dedupe [after GA; → M1; interim until CLEAN]
6. **WF** — `publish.js` writer fix: dedupe-on-write, no `title:null` stub `[AUTH]` [bundle w/ Phase-1 publish.js; MUST precede CLEAN]
7. **RG** — build + wire pre-deploy SEO audit incl. real-browser render check [before M1 so every checkpoint is audited]
7b. **BK1** — indexing-engine auto-submit disable [**BEFORE cutover**, per owner: it fires at Google automatically → clean handshake at relaunch; part of the M1 set]
8. **M1** — CHECKPOINT 1: all Phase-1 + BK1 complete + `seo-audit.js` passing on preview [after 1–7b verified on preview; NOT a live merge — stays on preview]
9. **P2-audit** — map every regional touchpoint (read-only; done) [fed the owner's KEEP decision]
10. **P2-serve / P2-collision-guard / P2-recover** — the kept-and-fixed regional work (serving fix, collision guard, orphan recovery) [DONE on preview; this IS Phase-2's before-cutover code]
    - ~~P2-gen / P2-post~~ — RETIRED (removals cancelled; regionals kept). Generation/posting keep running; superseded by P2-tune (after cutover).
    - ~~P2-ui~~ — DECIDED KEEP (blog region filter is a real feature; not removed).
    - ~~P2-301 / P2-idx~~ — RETIRED (no regional URL removed → nothing to redirect or de-index; regional slugs stay in the index + sitemap).
11. **M2** — CHECKPOINT 2: Phase-2 complete + audit passing on preview [= P2-serve/collision-guard/recover verified; no removal code remains; NOT a live merge — stays on preview]
12. **CLEAN** — one-time `articles:index` dedupe to unique real records, 0 null `[AUTH KV write]` [after WF; terminal data step; verified NO-OP — keeps every real record, regionals included]
13. **SM-verify** — confirm next-publish sitemap: 0 dupes, real lastmod, regional URLs present-by-design (read-only) [after WF + CLEAN]
14. **EEAT-pages** — existing public pages pass the E-E-A-T bar (assessment + fix of CURRENT live-bound pages) [criteria via the EEAT-criteria DECISION; this is the existing-pages check, NOT future generation]
15. **GUARD-SWEEP** — full-site guard sweep: SEO-complete + optimized via upgraded `seo-audit.js` incl. real-browser render check (body visible, no uncaught JS) [after all public work; final pre-cutover gate]
16. **POL** — single-hop www→apex redirect [public-facing; cosmetic; NON-BLOCKING — does not gate cutover]
17. **CUTOVER** — clean replacement: archive the live site in full, **Redesign becomes production** (full replacement, not a merge); run `seo-audit.js` (incl. real-browser check) against the cutover and confirm PASS before go-live [THE single go-live; **depends on the BEFORE-CUTOVER group ONLY** (1–15; POL optional); mechanism `[TO CONFIRM]`]

### ═══ AFTER CUTOVER — private / backend / future (does NOT gate go-live) ═══
18. **BK2 / BK3 → M3** — `linkedin-test.js` removal (backend/security); title-rewrite path made INERT + reversible (fires only on manual dashboard CTA, never automatic — cannot affect cutover; anytime) → **M3 CHECKPOINT** [backend; none change cutover-state public pages] · *(BK1 moved to the BEFORE group — step 7b)*
19. **TQ** — verify `targetQuery` selection (read-only) [informs FUTURE generation only]
20. **DASH/PIPE review** — internal dashboards review; backend pipeline / workflow / design review [private; no indexing effect]
21. **P2-tune** — fine-tune regional generation for genuine differentiation + add a post-generation similarity gate (`ffx-consumer`) [improves FUTURE regionals only; zero effect on live pages; replaces the retired P2-gen removal]
22. **ENGINE tuning** — article naming, keyword strategy; **E-E-A-T engine tuning** (FUTURE generation) `[BLOCKED]`; voice recalibration `[BLOCKED]` [improves future content; needs Salman/Scout-Network brief]

> **DECISION — EEAT-criteria:** before step 14, Claude proposes concrete pre-cutover E-E-A-T pass-criteria for owner approval. Not invented here; slot held.

**DEFERRED (not in sequence until owner decides):** home→article direct links (D3 — design change).

*Read-only plan. No code, KV, or live site changed by authoring this doc.*
