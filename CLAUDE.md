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
- **Never force-push.** Merge to `main` is **PR-only** — force-push silently drops infrastructure files.
- Verify branch + `git status` before any commit; show `git log -1 --stat` after.
- **Run the pre-deploy SEO audit before any merge to `main`; it must pass.** `node scripts/seo-audit.js <baseUrl>` (preview, then production) — read-only, GET/raw-bytes crawler checks; a non-zero exit must block the merge.

## Frozen reference docs (never overwrite)
- `SEO-AUDIT.md` — public-page SEO defect baseline (pre-fix).
- `BACKEND-AUDIT.md` — backend-function SEO scoring baseline (pre-fix).
- These are **frozen baselines**. Post-fix audits are **new dated files** (e.g. `SEO-AUDIT-YYYY-MM-DD.md`), never edits to the originals — they are the before/after comparison.

## Operational facts (verified; extend only from the repo, never from memory)
- The sitemap is **rebuilt by `publish.js`** via the GitHub Contents API — editing `sitemap.xml` directly is overwritten on the next publish; fix it at the generator. *(BACKEND-AUDIT.md §1)*
- The four Workers (`ffx-consumer`, `ffx-cron`, `ffx-email-worker`, `ffx-social-scanner`) deploy via their own paths-filtered GitHub Actions; Pages auto-deploys on push. *(BACKEND-AUDIT.md §1)*
- Before editing or diffing any file, confirm you are working from the **deployed** version, not a stale copy.
- *Append further operational gotchas here only after verifying them directly in the repo.*
