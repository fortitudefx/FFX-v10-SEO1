// functions/_seo-pages.js
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the public static-page set and the "is this article
// indexable?" predicate. Imported by:
//   - functions/publish.js            (sitemap generation: static locs + article filter)
//   - functions/api/indexing-engine.js (IX_STATIC_PAGES)
// so the sitemap, the sitemap's static list, and the indexing engine's static list
// can NEVER drift apart again. Underscore-prefixed → excluded from Pages routing.
// ─────────────────────────────────────────────────────────────────────────────

export const BASE = 'https://fortitudefx.com';

// Indexable public static pages (index,follow). Deliberately EXCLUDES /pricing and
// /press (both meta noindex) so the sitemap never advertises a non-indexable URL.
// The URL SET here is authoritative for both consumers; changefreq/priority are the
// sitemap's per-page hints.
export const STATIC_PAGES = [
  { path: '/',           changefreq: 'weekly',  priority: '1.0' },
  { path: '/bootcamp',   changefreq: 'weekly',  priority: '0.9' },
  { path: '/vipdiscord', changefreq: 'weekly',  priority: '0.9' },
  { path: '/blog',       changefreq: 'weekly',  priority: '0.8' },
  { path: '/about',      changefreq: 'monthly', priority: '0.7' },
  { path: '/newsletter', changefreq: 'weekly',  priority: '0.7' },
  { path: '/waitlist',   changefreq: 'weekly',  priority: '0.7' },
  { path: '/joinfree',   changefreq: 'monthly', priority: '0.6' },
  { path: '/contact',    changefreq: 'yearly',  priority: '0.6' },
  { path: '/privacy',    changefreq: 'yearly',  priority: '0.3' },
  { path: '/disclaimer', changefreq: 'yearly',  priority: '0.3' },
];

// Full absolute URLs — the form the indexing engine inspects.
export const STATIC_PAGE_URLS = STATIC_PAGES.map(function (p) { return BASE + p.path; });

// An article is indexable (belongs in the sitemap AND is served index,follow) iff it
// is NOT a draft and is Global (or region-less). This MUST mirror the robots decision
// in functions/article.js buildPage():
//     var isRegional = !a.draft && !!a.region && a.region !== 'Global';
//     robots = a.draft ? 'noindex,nofollow' : (isRegional ? 'noindex,follow' : 'index,follow');
// Regionals + drafts are noindex there, so they must be excluded from the sitemap here.
export function isIndexableArticle(a) {
  if (!a) return false;
  if (a.draft) return false;
  if (a.region && a.region !== 'Global') return false;
  return true;
}
