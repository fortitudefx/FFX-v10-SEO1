# FFX — TASKS.md (live work queue)

**This is the single source of truth for what is left to do. It is the only live document; everything else is frozen reference.**
Read this file first, every session, before acting.

## Operating rules
- Every line here is an **action** with a checkable state. If something is not an action, it does not belong here — it belongs in a reference doc.
- **Never mark an item `[x]` done from memory or assumption.** Verify it in the actually-deployed branch/site first (Rule 25/26). If you cannot verify, leave it open and say what's needed to confirm.
- One change cluster per deploy. Fix → verify → next. No patches; build the robust version.
- Reference docs for evidence: `SEO-AUDIT.md` (public-page defects), `BACKEND-AUDIT.md` (backend function scoring).

## Status legend
`[ ]` open · `[~]` in progress · `[x]` done (verified deployed) · `[BLOCKED]` waiting on input · `[DECISION]` needs Salman's call before execution

## Hard constraints (apply to every task)
- **Never change the domain, page names, or any URL slug.** Fixes are internal to existing pages.
- **No public page is deleted with `rm`.** Any removed public URL must be 301-redirected to the right page AND removed from the sitemap.
- Dead **backend** code (orphaned/unreferenced) is safe to remove; dead **pages** are not.
- Any removal touching a KV key other functions read must list what breaks and handle it first.

---

## PHASE 0 — PRE-FLIGHT (gates Phase 1)
- [ ] Identify the GSC "Server error (5xx)" URL: GSC → Pages → 5xx → See Details. Confirm whether it currently returns 200 or still errors.

*(Deploy-drift / middleware-deployment check removed: it only mattered if we intended to keep the middleware. We are deleting it and server-rendering instead, so the question is moot.)*

## PHASE 1 — STOP THE BLEEDING (structural public-page SEO fix; no URL changes)
*Nothing else moves traffic until this ships. Source: `SEO-AUDIT.md` priority order.*

**Architecture rule for this phase:** the route renders complete HTML natively, server-side. No edge `<head>`-injection patch. `_middleware.js` is **deleted as part of this work**, not depended on. This is replace-and-remove in one atomic change — never remove-then-rebuild (removing it before the server-render replacement is live would serve crawlers a raw empty shell, strictly worse than today).

- [ ] Server-render the full **article** page — `<head>` + body + JSON-LD — server-side. Zero indexable content behind client JS, zero dependency on any edge rewrite. *(§A1)*
- [ ] Server-render the full **newsletter-issue** page the same way — per-issue title/canonical/OG/JSON-LD + body, server-side. *(§A2)*
- [ ] **Delete `_middleware.js`** in the same deploy, once both routes above render complete HTML on their own. The page now does natively what the middleware patched; keeping both is redundant. Confirm no other route relied on it.
- [ ] Fix canonicals: real self-canonical per page, emitted by the server-render itself (not by middleware). Eliminate empty `href=""`. *(§B)*
- [ ] Kill the soft-404: a bad/unknown `?slug=` returns a real **404**, not a 200 shell. *(§F1)*
- [ ] Fix internal linking: home and `/blog` link to articles in **server HTML** (not client `fetch('/articles')`). Resolve the 34-URL orphan set. *(§E)*
- [ ] Dedupe the sitemap: remove the 23 duplicate `<loc>` entries; fix generation in `publish.js` so it dedupes. *(§D1)*
- [ ] Fix sitemap `<lastmod>`: stop hardcoding static `2026-04-26`; emit real dates. *(§D2)*
- [ ] Fix `/blog` title length (86 chars → ≤60). *(§F)*

## PHASE 2 — ELIMINATE THE REGIONAL PIPELINE *(DECIDED — confirmed by `BACKEND-AUDIT.md` §D: prompt orders "core trading insight identical")*
- [ ] Audit every regional touchpoint: config rotation (`config:regionCycle` / `ffx-config.json`), consumer regional generation (`ffx-consumer` §D), `regionalContent` in `published:{id}` records, regional posting, regional slugs in sitemap + `articles:index`, canonical logic.
- [ ] Remove regional article **generation** from `ffx-consumer`.
- [ ] Remove regional **posting** paths.
- [ ] Remove **blog region filters / UI** — without breaking list render or leaving dead `fetch` params expecting region.
- [ ] 301-redirect every known regional URL → its Global parent.
- [ ] Remove all regional slugs from `sitemap.xml` and `articles:index`.

> [DECISION] Ship Phase 1 + Phase 2 as **one combined deploy** (they touch the same files — article rendering, canonicals, sitemap), or strictly sequential? *Recommended: combined single launch, every URL unchanged.*

## PHASE 3 — RECURRENCE GUARD (so SEO never silently drifts again)
- [ ] Build a **repeatable pre-deploy SEO audit** (the `SEO-AUDIT.md` check, reusable) that runs against the code before every deploy.
- [ ] Wire the audit into the launch process and reference it from `CLAUDE.md` (CLAUDE.md authored separately).

## PHASE 4 — BACKEND FIXES *(audit complete — `BACKEND-AUDIT.md`; these are the confirmed actions)*
- [ ] **Disable** the article auto-submit in `indexing-engine.js` (`:536`, `:590`). Keep URL-Inspection diagnostics + status tracking. *(DECIDED — Google Indexing API is JobPosting/BroadcastEvent only; article pings are ignored, violate ToS since May-2025 clarification, risk access revocation, and may harm evergreen indexing. §4-A.)*
- [ ] Remove `linkedin-test.js` — orphaned (0 refs) debug route that also leaks LinkedIn token info publicly. *(DECIDED — §3 REMOVE; confirm no external monitor hits `/linkedin-test` first.)*
- [ ] [DECISION] Title-rewrite model: **remove** the `title_rewrite` path from `intelligence-engine.js` (`:364-367`, `:671-677`) and `title-test.js` (live-title write `:52-54`) and freeze published titles — OR constrain frequency. *(HURTS by reasoned judgment; bounded by gate `:879` + per-slug suppression `:636-637`. Leaning remove, per "never drift again." §4-B/§4-C.)*
- [ ] Close [UNVERIFIED]: confirm whether `targetQuery` selection picks the highest-opportunity term or just first-in-list in `intelligence-engine.js`. *(§F)*

## PHASE 5 — ENGINE TUNING (after the above; needs Salman input)
- [BLOCKED] Salman-voice recalibration (Scout Network method). *Unblocks when Salman briefs Claude on what was done in Scout Network.*
- [BLOCKED] E-E-A-T generation hardening (YMYL/finance — harshest scrutiny). *Same brief.*
- [ ] Optimize article naming / title-generation logic. *(BACKEND-AUDIT.md §E — title spec sound; revisit within the fixes above.)*
- [ ] Refine keyword strategy / what feeds the intelligence engine (lean, remove waste). *(BACKEND-AUDIT.md §F — keyword sourcing is grounded; tune downstream.)*

---

## Open decisions for Salman (each is an action: decide)
- [ ] Phase 1 + Phase 2 combined deploy vs sequential.
- [ ] Title-rewrite model: remove vs constrain.
- [ ] Brief Claude on Scout Network to unblock Phase 5 voice + E-E-A-T work.

## Authored separately (not in this queue)
- `CLAUDE.md` — thin behavioral contract; committed to Redesign (84ae2ef). Doc architecture complete: `CLAUDE.md` → `TASKS.md` → frozen audits.

---

## POLISH (lowest priority)
- [ ] Collapse the http://www → https://www → apex redirect chain to a single hop (http://www straight to https://fortitudefx.com/). Cosmetic; both hops are clean 301s today. Cloudflare redirect-rule tweak. No SEO defect.
