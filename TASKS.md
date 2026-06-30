# FFX — TASKS.md (live work queue)

**This is the single source of truth for what is left to do. It is the only live document; everything else is frozen reference.**
Read this file first, every session, before acting.
**Canonical execution order lives in `EXECUTION-PLAN.md`** — items below are ordered to match its locked sequence (step IDs in brackets). Don't reorder without updating that doc.

## Operating rules
- Every line here is an **action** with a checkable state. If something is not an action, it does not belong here — it belongs in a reference doc.
- **Never mark an item `[x]` done from memory or assumption.** Verify it in the actually-deployed branch/site first. If you cannot verify, leave it open and say what's needed to confirm.
- One change cluster per deploy. Fix → verify → next. No patches; build the robust version.
- Reference docs for evidence: `SEO-AUDIT.md` (public-page defects), `BACKEND-AUDIT.md` (backend scoring), `EXECUTION-PLAN.md` (order + dependencies).

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
- **TQ** — Target Query check: how `intelligence-engine.js` selects `targetQuery`
- **P1a** — newsletter-issue SSR
- **P1b** — `/blog` defensive slug-dedupe
- **HEAD** — HEAD requests mirror GET status/headers (no body) on the SSR functions
- **WF** — Writer Fix: `publish.js` `articles:index`-write (dedupe on write, never a null-title stub)
- **RG** — Recurrence Guard: repeatable pre-deploy SEO audit
- **M1 / M2 / M3** — Merge 1 / 2 / 3 (Redesign → `main`, PR-only)
- **P2-\*** — Phase 2 sub-steps (audit, gen, post, ui, 301, idx)
- **CLEAN** — one-time `articles:index` data cleanup (authorized KV write)
- **SM-verify** — sitemap verification (0 dupes, no regional, real lastmod)
- **BK1 / BK2 / BK3** — Backend fixes (indexing auto-submit, linkedin-test removal, title-rewriter)
- **POL** — Polish (single-hop www→apex redirect)

---

## 1 — PRE-FLIGHT & READ-ONLY GATES (block later steps; run first)
- [ ] **[G0]** Confirm the GSC "Server error (5xx)" URL now serves 200 (read-only). *(gates Merge 1 confidence; see EXECUTION-PLAN.md)*
- [ ] **[GA]** Prove article serving is independent of `articles:index` (read-only). STOP if dependent. *(blocks CLEAN + P2-idx; see EXECUTION-PLAN.md)*
- [ ] **[GB]** Map every socially-shared URL → "still lives" / "must 301-or-404" from the social post logs (read-only). List exactly what will 404. *(blocks P2-301/P2-post; see EXECUTION-PLAN.md)*
- [ ] **[TQ]** Verify `targetQuery` selection (highest-opportunity vs first-in-list) in `intelligence-engine.js` (read-only). *(BACKEND-AUDIT.md §F)*

## 2 — PHASE 1: finish + ship (URL-safe; → Merge 1)
*Built + verified on Redesign preview, pending merge: article SSR, /blog SSR, canonicals, soft-404, sitemap generator dedupe + real lastmod, /blog title, `_middleware.js` deletion. Status stays open until merged + reviewed.*
- [ ] Server-render the full **article** page (`<head>` + body + JSON-LD), zero client-only indexable content. *(§A1)*
- [ ] Fix canonicals: real self-canonical per page from the server-render; eliminate empty `href=""`. *(§B)*
- [ ] Kill the soft-404: bad/unknown `?slug=` returns a real **404**, not a 200 shell. *(§F1)*
- [ ] Server-render the **/blog** list as real `<a href>` links in the bytes (not client `fetch('/articles')`). *(§E)*
- [ ] Dedupe the sitemap at the generator (`publish.js`); every `<loc>` once. *(§D1)*
- [ ] Sitemap `<lastmod>`: real dates, not hardcoded. *(§D2)*
- [ ] Shorten the `/blog` `<title>` (86 → ≤60). *(§F)*
- [ ] **Delete `_middleware.js`** (SSR emits the complete head itself; confirm no other route relied on it). *(§A1/§A2)*
- [ ] **[P1a]** Build **newsletter-issue SSR** (per-issue title/canonical/OG/JSON-LD + body, server-side). *(§A2; see EXECUTION-PLAN.md)*
- [ ] **[P1b]** Add `/blog` defensive slug-dedupe (clean list while production `articles:index` is still dirty). *(see EXECUTION-PLAN.md collision 6)*
- [ ] **[HEAD]** HEAD requests mirror GET status/headers (no body) across `article.js`, `blog.js`, `newsletter-issue.js` — closes the dishonest 200-on-missing. *(built + verified on preview — cb45dda)*
- [ ] **[WF]** `[AUTHORIZED — KV write]` `publish.js` writer fix: dedupe `articles:index` on write, never write a `title:null` stub. Bundle with the Phase-1 `publish.js` change. *(must precede CLEAN; see EXECUTION-PLAN.md)*
- [ ] **[RG]** Build + wire the repeatable **pre-deploy SEO audit**; reference from `CLAUDE.md`. *(before Merge 1 so the cutover is audited; §SEO-AUDIT)*
- [ ] **[M1]** MERGE 1 → `main` (PR-only): all Phase-1 above, URL-safe. *(after the gates + builds verified on preview)*

## 3 — PHASE 2: eliminate the regional pipeline (URL removal; → Merge 2)
*DECIDED (BACKEND-AUDIT.md §D: prompt orders "core trading insight identical"). Redirect stance: EXECUTION-PLAN.md D2.*
- [ ] **[P2-audit]** Map every regional touchpoint: `config:regionCycle`/`ffx-config.json`, `ffx-consumer` regional gen, `regionalContent` in `published:{id}`, regional posting, regional slugs in `articles:index`+sitemap, canonical logic. *(read-only map first)*
- [ ] **[P2-gen]** Remove regional article **generation** from `ffx-consumer`. *(stop the source first)*
- [ ] **[P2-post]** Remove regional **posting** paths. *(after GB)*
- [ ] **[P2-ui]** Remove **blog region filters / UI** without breaking list render or leaving dead region `fetch` params.
- [ ] **[P2-301]** 301 all 13 shared regional URLs to their global parents (all parents exist); build the map from each record's `globalContent.slug ↔ regionalContent.slug` pairing, **NOT** suffix-strip. *(after GB; before P2-idx; see GATE-FINDINGS.md — `match-…-personality` exception 301s to a 404 if stripped naively)*
- [ ] **[M2]** MERGE 2 → `main` (PR-only): Phase-2 code. *(after P2-audit…P2-301 verified)*
- [ ] **[P2-idx]** `[AUTHORIZED — KV write]` Remove regional slugs from `articles:index`. *(after M2 so 301s are live; before CLEAN)*

## 4 — INDEX CLEANUP (terminal data step)
- [ ] **[CLEAN]** `[AUTHORIZED — KV write]` One-time `articles:index` dedupe to unique real records (drop `title:null` twins); verify unique=total, 0 dupes, 0 null titles. Tool likely `backfill-articles-index.js`. *(after WF live AND P2-idx; see EXECUTION-PLAN.md collisions 1–2)*
- [ ] **[SM-verify]** Confirm next-publish sitemap: 0 dupes, no regional URLs, real lastmod (read-only). *(after WF + P2-idx + CLEAN)*

## 5 — BACKEND FIXES (independent; any time after Merge 1; → Merge 3)
- [ ] **[BK1]** Disable the article auto-submit in `indexing-engine.js` (`:536`, `:590`); keep URL-Inspection. *(DECIDED; BACKEND-AUDIT.md §4-A)*
- [ ] **[BK2]** Remove orphan `functions/linkedin-test.js` after a read-only "no external monitor hits `/linkedin-test`" check. *(DECIDED; BACKEND-AUDIT.md §3)*
- [ ] **[DECISION] [BK3]** Title-rewrite model: **remove** the `title_rewrite` path (`intelligence-engine.js:364-367,:671-677`; `title-test.js:52-54`) and freeze titles — OR constrain frequency. *(leaning remove; BACKEND-AUDIT.md §4-B/§4-C)*
- [ ] **[M3]** MERGE 3 → `main` (PR-only): BK1–BK3.

## 6 — PHASE 5: engine tuning (last; needs Salman input)
- [BLOCKED] Salman-voice recalibration (Scout Network method). *Unblocks on Salman's brief.*
- [BLOCKED] E-E-A-T generation hardening (YMYL/finance). *Same brief.*
- [ ] Optimize article naming / title-generation logic. *(BACKEND-AUDIT.md §E)*
- [ ] Refine keyword strategy feeding the intelligence engine. *(BACKEND-AUDIT.md §F)*

## 7 — POLISH (lowest priority)
- [ ] **[POL]** Collapse `http://www → https://www → apex` to a single hop. Cosmetic; both hops are clean 301s today. No SEO defect.

---

## Open decisions for Salman (each is an action: decide)
- [ ] **[DECISION]** Phase 1 vs Phase 2 deploy: combined vs sequential. *(EXECUTION-PLAN.md recommends sequential — M1 URL-safe first, then M2.)*
- [ ] **[DECISION]** Title-rewrite model: remove vs constrain (BK3).
- [ ] **[DECISION]** Home → article direct links: add a homepage article section (design change) vs rely on home→/blog→article. *(DEFERRED — EXECUTION-PLAN.md D3; orphan fix does not require it.)*
- [ ] **[DECISION]** Brief Claude on Scout Network to unblock Phase 5 voice + E-E-A-T.

## Reference / not in this queue
- `CLAUDE.md` — thin behavioral contract; committed to Redesign (84ae2ef). Doc architecture: `CLAUDE.md` → `TASKS.md` → `EXECUTION-PLAN.md` → frozen audits (`SEO-AUDIT.md`, `BACKEND-AUDIT.md`).
