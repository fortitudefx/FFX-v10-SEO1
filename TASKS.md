# FFX — TASKS.md (live work queue)

**This is the single source of truth for what is left to do. It is the only live document; everything else is frozen reference.**
Read this file first, every session, before acting.
**Canonical execution order + reasoning lives in `EXECUTION-PLAN.md`** (step IDs in brackets). Don't reorder without updating that doc.

## The cutover line (the model)
**Anything Google can SEE or INDEX must be fixed + verified BEFORE cutover. Anything private/backend, or that only improves FUTURE content, happens AFTER cutover** (it has zero effect on indexing, so it does not gate go-live). The two groups below are organized around this line.

## Operating rules
- Every line here is an **action** with a checkable state. If something is not an action, it belongs in a reference doc.
- **Never mark an item `[x]` done from memory or assumption.** Verify it in the actually-deployed branch/site first. If you cannot verify, leave it open and say what's needed to confirm.
- One change cluster per deploy. Fix → verify → next. No patches; build the robust version.
- Reference docs for evidence: `SEO-AUDIT.md` (public-page defects), `BACKEND-AUDIT.md` (backend scoring), `GATE-FINDINGS.md` (gate results), `EXECUTION-PLAN.md` (order + dependencies).
- **When a task is completed and verified, immediately update this file:** mark it **✅ (done — preview)**, or `[x]` once live. Keep the queue current — update AFTER doing the work, as a record.

## Status legend
`[ ]` open · `[~]` in progress · `[x]` done (verified deployed) · `[BLOCKED]` waiting on input · `[DECISION]` needs Salman's call before execution
**✅ = built + verified on preview (done bar cutover)** · **✅ (done — gate) = read-only investigation complete** · `[ ]` = not started · `[x]` = live in production · 🔄 = in progress

## Hard constraints (apply to every task)
- **Never change the domain, page names, or any URL slug.** Fixes are internal to existing pages. (The former Phase-2 regional-URL removal exception is **RETIRED** — regionals are KEPT as distinct articles; no public URL is removed. See B3.)
- **No public page is deleted with `rm`.** Any removed public URL must be 301-redirected to the right page AND removed from the sitemap.
- Dead **backend** code (orphaned/unreferenced) is safe to remove; dead **pages** are not.
- Any removal touching a KV key other functions read must list what breaks and handle it first.
- `[AUTHORIZED — KV write]` items must NOT run under a read-only directive.

## Step-ID glossary
- **G0** — Gate 0: GSC 5xx check (confirm the reported 5xx URL now serves 200)
- **GA** — Gate A: prove article serving is independent of `articles:index`
- **GB** — Gate B: shared-link fate map (which posted URLs survive / 301 / 404)
- **TQ** — Target Query check: how `intelligence-engine.js` selects `targetQuery` *(AFTER cutover — informs future generation only)*
- **P1a** — newsletter-issue SSR · **P1b** — `/blog` defensive slug-dedupe · **HEAD** — HEAD mirrors GET on the SSR functions
- **WF** — Writer Fix: `publish.js` `articles:index`-write (dedupe on write, never a null-title stub)
- **RG** — Recurrence Guard: repeatable pre-deploy SEO audit (incl. real-browser render check)
- **M1 / M2 / M3** — Preview checkpoints 1 / 2 / 3 (built + audit-passing on preview; **NOT** live merges — nothing goes live until CUTOVER)
- **CUTOVER** — the single final go-live: archive the live site in full, Redesign **becomes** production (full replacement, not a merge)
- **P2-\*** — Phase 2 sub-steps. DONE (live/preview): **P2-serve**, **P2-collision-guard**, **P2-recover**. **RETIRED** (regionals are kept, not removed): **P2-301**, **P2-idx**, and **P2-gen**/**P2-post** *as removals*. **P2-ui** = DECIDED KEEP (blog region filter is a real feature). **P2-tune** = AFTER-CUTOVER regional-generation fine-tuning + post-gen similarity gate. **P2-audit** = read-only touchpoint map (done). · **CLEAN** — one-time `articles:index` cleanup · **SM-verify** — sitemap verification
- **BK1 / BK2 / BK3** — Backend fixes: **BK1** indexing auto-submit disable (**BEFORE cutover — done ✅**) · **BK2** linkedin-test removal, **BK3** title-rewriter inert (both AFTER cutover)
- **POL** — Polish (single-hop www→apex redirect)
- **EEAT-\*** — E-E-A-T existing-pages work: **EEAT-disclaimer** (/disclaimer page + sitewide footer/article-foot), **EEAT-about** (/about founder page + footer/header About + YouTube), **EEAT-yt** (surface source YouTube video on articles), **EEAT-byline** (article byline → /about)
- **LINK-A / LINK-B** — Internal linking: **LINK-A** = System A (generator in-body contextual links, future articles) · **LINK-B** = System B (rendered "Related articles" footer on existing articles, via `bulk-link-scan`)
- **ORPHAN-AUDIT** — main-vs-Redesign orphan-page reconciliation (301 vs 404 at cutover)

---

# ═══ BEFORE CUTOVER — public-facing / indexing (GATES go-live) ═══

## B1 — PRE-FLIGHT & READ-ONLY GATES (run first)
- [ ] **✅ (done — gate)** **[G0]** Confirm the GSC "Server error (5xx)" URL now serves 200 (read-only). *(gates the M1 checkpoint; findings in GATE-FINDINGS.md — 3ebd4f8)*
- [ ] **✅ (done — gate)** **[GA]** Prove article serving is independent of `articles:index` (read-only). STOP if dependent. *(blocks CLEAN; findings in GATE-FINDINGS.md — 3ebd4f8)*
- [ ] **✅ (done — gate)** **[GB]** Map every socially-shared URL → "still lives" / "must 301-or-404" from the social post logs (read-only). List exactly what will 404. *(findings in GATE-FINDINGS.md — 3ebd4f8; its downstream P2-301/P2-post are now RETIRED — regionals are kept — so GB stands only as a completed read-only record)*

## B2 — PHASE 1: SSR structural fix (URL-safe; → M1 checkpoint)
*Built + verified on Redesign preview, pending the final CUTOVER (NOT merged — nothing goes live until cutover): article SSR, /blog SSR, canonicals, soft-404, sitemap generator dedupe + real lastmod, /blog title, `_middleware.js` deletion, HEAD-mirror, blank-article template-escape fix. Status stays open until reviewed.*
- [ ] **✅** Server-render the full **article** page (`<head>` + body + JSON-LD), zero client-only indexable content. *(§A1)* **(done — preview)**
- [ ] **✅** Fix canonicals: real self-canonical per page from the server-render; eliminate empty `href=""`. *(§B)* **(done — preview)**
- [ ] **✅** Kill the soft-404: bad/unknown `?slug=` returns a real **404**, not a 200 shell. *(§F1)* **(done — preview)**
- [ ] **✅** Server-render the **/blog** list as real `<a href>` links in the bytes (not client `fetch('/articles')`). *(§E)* **(done — preview)**
- [ ] **✅** Dedupe the sitemap at the generator (`publish.js`); every `<loc>` once. *(§D1)* **(done — preview)**
- [ ] **✅** Sitemap `<lastmod>`: real dates, not hardcoded. *(§D2)* **(done — preview)**
- [ ] **✅** Shorten the `/blog` `<title>` (86 → ≤60). *(§F)* **(done — preview)**
- [ ] **✅** **Delete `_middleware.js`** (SSR emits the complete head itself; confirm no other route relied on it). *(§A1/§A2)* **(done — preview)**
- [ ] **✅** **[P1a]** Build **newsletter-issue SSR** (per-issue title/canonical/OG/JSON-LD + body, server-side). *(§A2)* **(done — preview)**
- [ ] **✅** **[P1b]** Add `/blog` defensive slug-dedupe (clean list while production `articles:index` is still dirty). *(EXECUTION-PLAN.md collision 6)* **(done — preview)**
- [ ] **✅** **[HEAD]** HEAD requests mirror GET status/headers (no body) across `article.js`, `blog.js`, `newsletter-issue.js`. *(built + verified on preview — cb45dda)* **(done — preview)**
- [ ] **✅** **[WF]** `[AUTHORIZED — KV write]` `publish.js` writer fix: dedupe `articles:index` on write, never write a `title:null` stub. *(must precede CLEAN; see EXECUTION-PLAN.md)* **(done — preview)**
- [ ] **✅** **[RG]** Build + wire the repeatable **pre-deploy SEO audit** (incl. real-browser render check); reference from `CLAUDE.md`. *(before the M1 checkpoint so every checkpoint is audited)* **(done — preview)**
- [ ] **✅** **[BK1]** Removed the improper Google Indexing-API auto-submit in `indexing-engine.js` (Step 5 + dead helpers `ixSubmitUrl`/`ixGetServiceAccountToken`); URL-Inspection + all diagnostics kept; fixed the stale `publish.js` "pings Google index" comment. *(6c59a7c; guard 33/33; audit confirmed never-fired — GOOGLE_PRIVATE_KEY_PEM unset)* **(done — preview)**
- [ ] **✅** **[M1]** CHECKPOINT 1: all of B2 complete + `seo-audit.js` passing on preview — **checkpoint met** (B2 all ✅; guard 33/33 on preview). **Stays on preview — does NOT go live.** **(done — preview)**

## B3 — PHASE 2: regional pipeline (→ M2 checkpoint)
*✅ **DECIDED (owner) — regionals are KEPT.** They are genuinely distinct, correctly-served localized articles (the serving bug that fed `globalContent.body` for every slug is FIXED — regionals now serve their own body). **The entire remove/301/de-index plan is RETIRED, not pending.** The former removal items are struck below with a one-line reason (P2-301, P2-idx = NOT NEEDED; P2-gen/P2-post as removals = CANCELLED). The blog region filter (P2-ui) is a **decided KEEP** — a real feature now that regional pages have distinct content. The ONLY regional work that remains is: fine-tune generation so new regionals are genuinely differentiated + add a post-generation similarity gate — and that is **AFTER cutover** ([P2-tune] in A3; it improves future content only and has zero effect on what's live). What stays here as ✅ done: the serving fix, the collision guard, and the orphan recovery.*
- [ ] **✅** **[P2-serve]** Fix the serving bug — regional URLs now serve their own distinct `regionalContent.body` (was `globalContent.body` for every slug); global/parent pages unchanged; graceful fallback if regional body missing. *(1618c54; guard hardened for below-fold reveal 0bccbe8; content check 13/13 serve own body + differ from parent; guard 33/33)* **(done — preview)**
- [ ] **✅** **[P2-collision-guard]** `publish.js` blocks a DIFFERENT video from clobbering an existing `article:{slug}` (was a blind overwrite → orphaned 2 articles). Proven video-vs-video collision → 409, writes nothing; same-video re-publish + new slug unchanged. *(bf0442d; local sim a/b/c pass)* **(done — preview)**
- [ ] **✅** **[P2-recover]** `[AUTHORIZED — KV write]` Recovered the 2 collision-orphaned globals to unique slugs: z2RwH06okKQ → `opening-candle-first-candle-sets-session-entry`, zjb6GkFyjjY → `fractal-price-action-multi-timeframe-strategy`. Each serves its OWN body (100% match, ≤3.6% vs colliding); the 2 previously-reachable articles UNCHANGED; both in blog list (index 35→37); guard 33/33. Sitemap includes them on next regen (keys present; not regenerated — avoids touching main). *(shared KV → live on prod too; reversible: delete the 2 `article:` keys + index entries)* **(done — preview)**
- [ ] **✅ (done — gate)** **[P2-audit]** Map every regional touchpoint: `config:regionCycle`/`ffx-config.json`, `ffx-consumer` regional gen, `regionalContent` in `published:{id}`, regional posting, regional slugs in `articles:index`+sitemap, canonical logic. *(read-only map — DONE; it surfaced that regionals are distinct-but-mis-served, which fed the owner's KEEP decision)*
- ~~**[P2-gen]** Remove regional article generation from `ffx-consumer`.~~ **CANCELLED as a removal** — regionals are kept, so generation keeps running. (Superseded by [P2-tune] in A3: fine-tune generation for genuine differentiation + add a similarity gate, AFTER cutover.)
- ~~**[P2-post]** Remove regional posting paths.~~ **CANCELLED as a removal** — regionals are kept, so posting keeps running.
- ~~**[P2-ui]** Remove blog region filters / UI.~~ **DECIDED KEEP** — the blog region filter is a real feature now that regional pages have genuinely distinct content; not removed.
- ~~**[P2-301]** 301 the 13 regional URLs to their global parents.~~ **NOT NEEDED** — regionals are kept; no regional URL is removed, so there is nothing to redirect.
- ~~**[P2-idx]** `[AUTHORIZED — KV write]` Remove regional slugs from `articles:index`.~~ **NOT NEEDED** — regionals are kept; their slugs stay in the index (and the sitemap).
- [ ] **✅** **[M2]** CHECKPOINT 2: Phase-2 is complete on preview — it now consists ONLY of the kept-and-fixed work (**[P2-serve]** ✅, **[P2-collision-guard]** ✅, **[P2-recover]** ✅), all done + audit-passing. No removal/301/de-index code remains. **Checkpoint met.** **Stays on preview — does NOT go live.** **(done — preview)**

## B4 — INDEX CLEANUP + sitemap verify (terminal data step)
- [ ] **✅** **[CLEAN]** One-time `articles:index` dedupe — **verified NO-OP, no write required**: raw index already 37/37, 0 dupes, 0 `title:null`, raw↔projection 1:1; all real articles present (2 recovered + 13 regionals + 22 globals). The WF dedupe-on-write (`2a2388d`) + every publish since had already collapsed the old 58/35/23-null-twin state organically. Guard 33/33. `backfill-articles-index.js` NOT run — it reshapes/rebuilds (adds `hasBody`, resets `publishedAt`, sorts) and never removes twins, so it's the wrong tool. *(verified no-op: index already clean, no write required)* **(done — preview)**
- [ ] **[SM-verify]** Confirm next-publish sitemap: 0 dupes, real lastmod, **regional URLs present by design** (regionals are kept — this is no longer a "no regional URLs" check) (read-only). *(after WF + CLEAN)*
- [ ] **[ORPHAN-AUDIT]** Audit **main-vs-Redesign orphan pages**: list every page in current `main` NOT present/reachable in Redesign that Google may have indexed; decide **per-page 301-redirect vs accept 404** at cutover. *(prevents indexed pages silently 404ing at go-live — pre-cutover, gates CUTOVER. Read-only inventory now; redirects wired before/at cutover. Known example: `pricing.html` — present in the tree but unreferenced + `noindex` + not in sitemap, so it needs no redirect; the audit finds the rest.)*

## B5 — E-E-A-T (existing pages) + full guard sweep
- [ ] **✅** **[STEP-1 minor SEO]** Public-page technical-SEO polish: sitemap generator coverage (adds `/contact` — fixing a latent drop — plus `/newsletter` `/joinfree` `/waitlist`; excludes noindex `/pricing` `/press`), homepage `id="about"` (resolves the pricing/newsletter `#about` anchors), article `<title>` cap ≤60, article meta-description fallback (never `content=""`), vipdiscord meta 177→151, unique per-issue newsletter `<h1>`. Guard 33/33 on preview. *(39ea770)* **(done — preview)**
  - **pricing.html $149 price + `noindex`: RESOLVED — no change needed.** pricing.html is an **orphaned/unreferenced page on Redesign** (present in the tree but no inbound links, `noindex`, absent from sitemap) that is **retired at cutover**, so its price is moot and its noindex is correct. *(covered going forward by [ORPHAN-AUDIT] above.)*
- [ ] **✅** **[EEAT-disclaimer]** Financial **risk disclaimer**: dedicated indexable `/disclaimer` page (cloned from privacy.html shell, registered in publish.js staticPages + indexing-engine.js IX_STATIC_PAGES + sitemap.xml), sitewide footer "Disclaimer" link + short-print small text, and a short disclaimer at each **article foot**. YMYL-required — was entirely absent before. Guard 33/33 on preview. *(ef0daf9)* **(done — preview)**
- [ ] **✅** **[EEAT-about]** Dedicated **/about** founder-story page in the index light aesthetic (no canvas machinery): full SEO (unique title/meta, self-canonical, OG/Twitter, **Person + Organization JSON-LD** with `sameAs` YouTube), one h1 + h2 hierarchy, visible **YouTube channel link** in the body, + the credentials paragraph. Sitewide footer gains an "About" link and a persistent **YouTube** channel link; header nav gains **About** (after Home) on every shared-header page (desktop + mobile), and the nav-center pages' About link repointed from `#about` → `/about`. Guard 33/33 on preview. *(212317a + credentials/nav follow-up)* **(done — preview)** — directly closes the audit's #1 gap (no founder story / author surface).
- [ ] **[EEAT-yt]** **Surface the source YouTube video on each article page** — `youtubeUrl`/`videoId` are stored but NOT rendered today (embed the video or a "Watch the original" link). Strong first-hand-expertise signal; before cutover (indexing-facing). *(from the E-E-A-T audit)*
- [ ] **[EEAT-byline]** **Add a visible author byline on articles linking to `/about`** — author identity is currently only in JSON-LD; add an on-page "By Salman Khan" byline → `/about`. Before cutover. *(from the E-E-A-T audit; /about now exists as the link target)*
- [ ] **[LINK-B]** **System B internal linking (existing articles).** Today: `bulk-link-scan` renders a "Related articles" footer on articles and links are populated for most (uneven coverage — some articles render 0). Base render works ✅. **Deferred enhancement (designed, NOT executed — was Steps 3–4 of the internal-linking plan):** tighten logic (≥2 shared tags, per-article cap, deprioritise regional-variant targets), clean the footer to a single "Related articles" list, wire it to run automatically on publish, and backfill existing articles (`[AUTHORIZED — KV write]`, dry-run + approval first). *(before cutover — indexing-facing; confirm scope with owner)*
- [ ] **Existing public pages pass the E-E-A-T bar** — assessment + fix of the *current* live-bound public pages so they meet the bar before go-live. **Done so far:** /about + /disclaimer (above), homepage/article/blog/bootcamp/vipdiscord technical SEO (B2 + STEP-1). **Remaining:** EEAT-yt + EEAT-byline above, and confirm the rest against the approved criteria. *(this is the existing-pages check, NOT future generation)*
- [ ] **[DECISION]** Pre-cutover E-E-A-T checklist criteria — Claude proposes concrete pass-criteria for owner approval. *(slot held; criteria not invented here)*
- [ ] **Full guard sweep** — whole site verified SEO-complete + optimized via the upgraded `seo-audit.js`, **including the real-browser render check** (body actually visible, no uncaught JS errors). *(catches blind spots like the blank-article bug)*

## B6 — POLISH (public-facing; non-blocking)
- [ ] **[POL]** Collapse `http://www → https://www → apex` to a single hop. Cosmetic; both hops are clean 301s today. **No SEO defect — does not gate cutover.**

## ▶ CUTOVER — the single go-live
*Depends on the BEFORE-CUTOVER group ONLY (B1–B5; B6 optional). The AFTER-CUTOVER group does NOT gate this.*
- [ ] **[CUTOVER]** Clean replacement — archive the current live site in full, then **Redesign becomes production** (full replacement, NOT a normal merge); run `node scripts/seo-audit.js` (incl. real-browser check) against the cutover/production and confirm PASS before declaring go-live. Mechanism: repoint Cloudflare Pages production → Redesign (archive old `main`) OR wholesale-replace `main` with Redesign after tagging/archiving the old version — `[TO CONFIRM against the live Cloudflare project at cutover time]`.

---

# ═══ AFTER CUTOVER — private / backend / future (does NOT gate go-live) ═══

## A1 — BACKEND FIXES (Phase 4; → M3 checkpoint)
- [ ] **[BK2]** Remove orphan `functions/linkedin-test.js` after a read-only "no external monitor hits `/linkedin-test`" check. *(AFTER: purely backend/security cleanup, not a content/indexing page. DECIDED; BACKEND-AUDIT.md §3)*
- [ ] **[BK3]** Make the title-rewrite path **INERT**: disable so it cannot execute via any route/cron/trigger, show it OFF/greyed-out on the internal dashboard, fully **REVERSIBLE** (one toggle to re-enable). *(re-scoped per owner: the rewrite only ever fires on the owner's manual dashboard CTA — NOT automatic — so it cannot affect cutover. Not a pre-cutover blocker — do anytime. `intelligence-engine.js:364-367,:671-677`; `title-test.js:52-54`; §4-B/§4-C)*
- [ ] **[M3]** CHECKPOINT 3: BK2–BK3 complete + audit passing on preview.
- [ ] **[TQ]** Verify `targetQuery` selection (highest-opportunity vs first-in-list) in `intelligence-engine.js` (read-only). *(AFTER: informs future generation only. BACKEND-AUDIT.md §F)*

## A2 — DASHBOARDS + BACKEND PIPELINE REVIEW (private; no indexing effect)
- [ ] Internal **dashboards** review (operator tooling; not public/indexed).
- [ ] Backend **pipeline / workflow / design** review (generation→publish→distribute flow).

## A3 — ENGINE TUNING (improving FUTURE content; needs Salman input)
- [ ] **✅** **[LINK-A]** **System A internal linking fix** (`ffx-consumer` generation) — `fetchRelatedArticles` was emitting 0 links (verbatim full-tag-in-transcript match almost never hit + it could return the article's own slug). Now: IDF-weighted tag-word overlap + phrase bonus, self-exclusion, regional-variant deprioritisation; and `content:link_graph` records only links Claude ACTUALLY wove into the body (honesty fix). Simulated: 0 → 3 relevant contextual candidates on a realistic spoken transcript. Improves FUTURE articles only; deploys with the consumer at cutover (deploy-consumer.yml is main-triggered). *(92e13cd)* **(done — code; effect on future generation)**
- [ ] **[P2-tune]** Fine-tune regional article **generation** in `ffx-consumer` so new regionals are genuinely differentiated (not near-duplicates of the global/parent), **PLUS** add a **post-generation similarity gate** that blocks/flags a new regional too close to its parent or siblings. *(AFTER cutover — improves FUTURE content only; zero effect on what is live. Replaces the retired [P2-gen] "remove generation" plan; regionals are kept — see B3.)*
- [ ] Optimize article naming / title-generation logic. *(BACKEND-AUDIT.md §E)*
- [ ] Refine keyword strategy feeding the intelligence engine. *(BACKEND-AUDIT.md §F)*
- [BLOCKED] **E-E-A-T engine tuning** — harden FUTURE article generation for YMYL/finance scrutiny (distinct from B5's existing-pages check). *Unblocks on Salman's brief; post-cutover. (was Phase-5 E-E-A-T generation hardening.)*
- [BLOCKED] Salman-voice recalibration (Scout Network method) — full voice/engine recalibration. *Unblocks on Salman's brief; post-cutover.*

---

## Open decisions for Salman (each is an action: decide)
- [ ] **[DECISION]** Pre-cutover E-E-A-T checklist criteria (B5) — approve the pass-criteria Claude proposes.
- [ ] **[DECISION]** Title-rewrite model: remove vs constrain (BK3).
- [ ] **[DECISION]** Home → article direct links: add a homepage article section (design change) vs rely on home→/blog→article. *(DEFERRED — EXECUTION-PLAN.md D3; orphan fix does not require it; public-facing so revisit before cutover if pursued.)*
- [ ] **[DECISION]** Guard-on-publish behavior — block vs warn-and-flag, manual gate vs pipeline-integrated. *(must NOT jam the publish pipeline; design later, AFTER cutover.)*
- [ ] **[DECISION]** Brief Claude on Scout Network. *Refined: this no longer fully blocks cutover — only B5's "existing pages pass E-E-A-T" assessment is pre-cutover; full voice/engine recalibration (A3) is post-cutover.*
- [ ] **[DECISION]** ~~Phase 1 vs Phase 2 deploy: combined vs sequential~~ — **superseded by the single-CUTOVER model** (no incremental deploys; resolved).

## Reference / not in this queue
- `CLAUDE.md` — thin behavioral contract. Doc architecture: `CLAUDE.md` → `TASKS.md` → `EXECUTION-PLAN.md` → frozen audits (`SEO-AUDIT.md`, `BACKEND-AUDIT.md`, `GATE-FINDINGS.md`).
