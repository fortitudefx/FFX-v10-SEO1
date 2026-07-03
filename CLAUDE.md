# CLAUDE.md — FFX project contract

Read this first, then read `TASKS.md`, before doing anything.
This file is **rules and pointers only**, and is intentionally thin. It does not describe how the system works — the code and the audits do that.

## Session start (every session, in order)
1. Read `TASKS.md` (repo root) — the single live source of truth for what to do, in execution order.
2. Do not act on a task until its design is agreed. Salman directs; confirm scope before changing code.
3. **Never mark a `TASKS.md` item done from memory.** Verify it in the deployed branch/site first. If you can't verify, leave it open and state what's needed to confirm.

## Cardinal rules (apply to all work)
- **No patches. Build the permanent, architecturally sound version.** If a fix transfers a defect or will need redoing later, it is wrong.
- **Never change the domain, page names, or any URL slug.** Fixes are internal to existing pages.
- **No public page is deleted with `rm`.** A removed public URL must be 301-redirected to the correct page AND removed from the sitemap. Dead *backend* code (unreferenced) is safe to remove; public *pages* are not.
- **No indexable content behind client-side JS.** Public pages render complete HTML server-side (head + body + JSON-LD). No edge-rewrite / middleware patching of metadata.

## Git & deploy discipline
- Active branch is **`Redesign`** (capital R).
- Commit by **filename** (`git add <file>`), never `git add .` — it sweeps in unrelated files.
- **Never force-push.**
- **No incremental merges to `main` during the build.** All work stays on Redesign/preview until ONE final clean **CUTOVER** (archive the live site; Redesign *becomes* production — a full replacement, not a merge). Do not merge Redesign → `main` as routine progress. See EXECUTION-PLAN.md §CUTOVER (exact mechanism `[TO CONFIRM]` at cutover time).
- **The cutover line:** anything Google can SEE or INDEX (public pages, SSR, sitemap, regional removal, index cleanup, existing-pages E-E-A-T, full guard sweep) is fixed + verified **BEFORE** cutover and gates go-live; anything private/backend or that only improves FUTURE content (dashboards, backend pipeline, engine tuning, E-E-A-T *engine* work, voice recalibration) happens **AFTER** cutover and does NOT gate it. See `TASKS.md` / `EXECUTION-PLAN.md`.
- Verify branch + `git status` before any commit; show `git log -1 --stat` after.
- **The pre-deploy SEO audit must pass against preview at each checkpoint (M1/M2/M3) AND against the cutover/production before go-live.** `node scripts/seo-audit.js <baseUrl>` — read-only checks: GET/raw-bytes crawler checks **AND a real-browser render check** (no uncaught JS/console errors; main body actually VISIBLE — not opacity:0/display:none — so a page present in bytes but blank in a browser FAILS). Browser engine is dev/audit-only (puppeteer-core + a local Chrome via `SEO_AUDIT_PUPPETEER`/`SEO_AUDIT_CHROME`; never a shipped dependency), with a DOM-shim fallback when no browser is present. A non-zero exit blocks that checkpoint or the cutover.

## Frozen reference docs (never overwrite)
- `SEO-AUDIT.md` — public-page SEO defect baseline (pre-fix).
- `BACKEND-AUDIT.md` — backend-function SEO scoring baseline (pre-fix).
- These are **frozen baselines**. Post-fix audits are **new dated files** (e.g. `SEO-AUDIT-YYYY-MM-DD.md`), never edits to the originals — they are the before/after comparison.

## Operational facts (verified; extend only from the repo, never from memory)
- The sitemap is **rebuilt by `publish.js`** via the GitHub Contents API — editing `sitemap.xml` directly is overwritten on the next publish; fix it at the generator. *(BACKEND-AUDIT.md §1)*
- The four Workers (`ffx-consumer`, `ffx-cron`, `ffx-email-worker`, `ffx-social-scanner`) deploy via their own paths-filtered GitHub Actions; Pages auto-deploys on push. *(BACKEND-AUDIT.md §1)*
- Before editing or diffing any file, confirm you are working from the **deployed** version, not a stale copy.
- *Append further operational gotchas here only after verifying them directly in the repo.*
