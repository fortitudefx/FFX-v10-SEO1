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

## Status legend
`[ ]` open · `[~]` in progress · `[x]` done (verified deployed) · `[BLOCKED]` waiting on input · `[DECISION]` needs Salman's call before execution

## Hard constraints (apply to every task)
- **Never change the domain, page names, or any URL slug.** Fixes are internal to existing pages. (Phase 2 regional-URL removal is the one sanctioned exception — handled via 301/404 per `EXECUTION-PLAN.md` D2.)
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
- **P2-\*** — Phase 2 sub-steps (audit, gen, post, ui, 301, idx) · **CLEAN** — one-time `articles:index` cleanup · **SM-verify** — sitemap verification
- **BK1 / BK2 / BK3** — Backend fixes (indexing auto-submit, linkedin-test removal, title-rewriter) — all AFTER cutover (see placement notes)
- **POL** — Polish (single-hop www→apex redirect)

---

# ═══ BEFORE CUTOVER — public-facing / indexing (GATES go-live) ═══

## B1 — PRE-FLIGHT & READ-ONLY GATES (run first)
- [ ] **[G0]** Confirm the GSC "Server error (5xx)" URL now serves 200 (read-only). *(gates the M1 checkpoint; see EXECUTION-PLAN.md)*
- [ ] **[GA]** Prove article serving is independent of `articles:index` (read-only). STOP if dependent. *(blocks CLEAN + P2-idx; see EXECUTION-PLAN.md)*
- [ ] **[GB]** Map every socially-shared URL → "still lives" / "must 301-or-404" from the social post logs (read-only). List exactly what will 404. *(blocks P2-301/P2-post; see GATE-FINDINGS.md)*

## B2 — PHASE 1: SSR structural fix (URL-safe; → M1 checkpoint)
*Built + verified on Redesign preview, pending the final CUTOVER (NOT merged — nothing goes live until cutover): article SSR, /blog SSR, canonicals, soft-404, sitemap generator dedupe + real lastmod, /blog title, `_middleware.js` deletion, HEAD-mirror, blank-article template-escape fix. Status stays open until reviewed.*
- [ ] Server-render the full **article** page (`<head>` + body + JSON-LD), zero client-only indexable content. *(§A1)*
- [ ] Fix canonicals: real self-canonical per page from the server-render; eliminate empty `href=""`. *(§B)*
- [ ] Kill the soft-404: bad/unknown `?slug=` returns a real **404**, not a 200 shell. *(§F1)*
- [ ] Server-render the **/blog** list as real `<a href>` links in the bytes (not client `fetch('/articles')`). *(§E)*
- [ ] Dedupe the sitemap at the generator (`publish.js`); every `<loc>` once. *(§D1)*
- [ ] Sitemap `<lastmod>`: real dates, not hardcoded. *(§D2)*
- [ ] Shorten the `/blog` `<title>` (86 → ≤60). *(§F)*
- [ ] **Delete `_middleware.js`** (SSR emits the complete head itself; confirm no other route relied on it). *(§A1/§A2)*
- [ ] **[P1a]** Build **newsletter-issue SSR** (per-issue title/canonical/OG/JSON-LD + body, server-side). *(§A2)*
- [ ] **[P1b]** Add `/blog` defensive slug-dedupe (clean list while production `articles:index` is still dirty). *(EXECUTION-PLAN.md collision 6)*
- [ ] **[HEAD]** HEAD requests mirror GET status/headers (no body) across `article.js`, `blog.js`, `newsletter-issue.js`. *(built + verified on preview — cb45dda)*
- [ ] **[WF]** `[AUTHORIZED — KV write]` `publish.js` writer fix: dedupe `articles:index` on write, never write a `title:null` stub. *(must precede CLEAN; see EXECUTION-PLAN.md)*
- [ ] **[RG]** Build + wire the repeatable **pre-deploy SEO audit** (incl. real-browser render check); reference from `CLAUDE.md`. *(before the M1 checkpoint so every checkpoint is audited)*
- [ ] **[BK1]** Disable the article auto-submit in `indexing-engine.js` (`:536`, `:590`); keep URL-Inspection. *(BEFORE per owner: it fires at Google automatically — we want a clean handshake at relaunch. DECIDED; BACKEND-AUDIT.md §4-A)*
- [ ] **[M1]** CHECKPOINT 1: all of B2 complete + `seo-audit.js` passing on preview. **Stays on preview — does NOT go live.**

## B3 — PHASE 2: eliminate the regional pipeline (URL removal; → M2 checkpoint)
*DECIDED (BACKEND-AUDIT.md §D). Redirect stance: EXECUTION-PLAN.md D2.*
- [ ] **[P2-audit]** Map every regional touchpoint: `config:regionCycle`/`ffx-config.json`, `ffx-consumer` regional gen, `regionalContent` in `published:{id}`, regional posting, regional slugs in `articles:index`+sitemap, canonical logic. *(read-only map first)*
- [ ] **[P2-gen]** Remove regional article **generation** from `ffx-consumer`. *(stop the source first)*
- [ ] **[P2-post]** Remove regional **posting** paths. *(after GB)*
- [ ] **[P2-ui]** Remove **blog region filters / UI** without breaking list render or leaving dead region `fetch` params.
- [ ] **[P2-301]** 301 all 13 shared regional URLs to their global parents (all parents exist); build the map from each record's `globalContent.slug ↔ regionalContent.slug` pairing, **NOT** suffix-strip. *(after GB; before P2-idx; GATE-FINDINGS.md — `match-…-personality` exception)*
- [ ] **[M2]** CHECKPOINT 2: Phase-2 code complete + audit passing on preview. **Stays on preview — does NOT go live.**
- [ ] **[P2-idx]** `[AUTHORIZED — KV write]` Remove regional slugs from `articles:index`. *(after P2-301 live on preview; before CLEAN)*

## B4 — INDEX CLEANUP + sitemap verify (terminal data step)
- [ ] **[CLEAN]** `[AUTHORIZED — KV write]` One-time `articles:index` dedupe to unique real records (drop `title:null` twins); verify unique=total, 0 dupes, 0 null titles. Tool likely `backfill-articles-index.js`. *(after WF + P2-idx; EXECUTION-PLAN.md collisions 1–2)*
- [ ] **[SM-verify]** Confirm next-publish sitemap: 0 dupes, no regional URLs, real lastmod (read-only). *(after WF + P2-idx + CLEAN)*

## B5 — E-E-A-T (existing pages) + full guard sweep
- [ ] **Existing public pages pass the E-E-A-T bar** — assessment + fix of the *current* live-bound public pages (homepage, articles, /blog, bootcamp, vipdiscord, pricing, etc.) so they meet the bar before they go live. *(criteria: see the [DECISION] below — this is the existing-pages check, NOT future generation)*
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
