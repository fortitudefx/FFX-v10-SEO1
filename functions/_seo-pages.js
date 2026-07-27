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
  if (DROP_CONSOLIDATED_FROM_SITEMAP && CONSOLIDATED[a.slug]) return false;
  return true;
}

// ── TOPIC CONSOLIDATION (cannibalization merge, 2026-07-28) ──────────────────
// WHY: 45 article URLs covered only ~20 real topics. Seven pages each told Google
// "I am fortitudefx's opening-candle page"; six did the same for liquidity sweep.
// Facing several candidates from a young domain, Google split the signal and
// ranked none of them — the site sat at average position 40 with 191 impressions
// in 16 months.
//
// MECHANISM — canonical ONLY, deliberately NOT noindex. Google treats
// noindex + canonical as contradictory and usually drops the page WITHOUT passing
// its accumulated signal to the survivor. A bare canonical merges the duplicate
// into the survivor and transfers the signal, which is the entire point here.
// (The regional block in article.js legitimately uses noindex+canonical: there we
// want the variant gone, not merged. Different intent, different tool.)
//
// Nothing is deleted and no URL 301s — every one of these pages stays live and
// readable. Only what Google COUNTS changes: 45 competing entries become 24.
// REVERT: empty this map.
//
// Survivor rule: the page targeting the highest-volume head term wins; where no
// page in the cluster has measured demand, the longest/most established wins.
export const CONSOLIDATED = {
  // ── Fair value gap → survivor targets "fair value gap" (9,900/mo) ──────────
  'how-to-trade-fair-value-gap-imbalance':                    'fair-value-gap-imbalance-forex-trading',
  'how-to-trade-fair-value-gaps-imbalance':                   'fair-value-gap-imbalance-forex-trading',

  // ── Liquidity sweep → survivor targets "liquidity sweep" (6,600/mo) ────────
  'two-candle-liquidity-sweep-framework':                     'liquidity-sweep-forex-entry-strategy',
  'how-to-trade-liquidity-sweep-forex':                       'liquidity-sweep-forex-entry-strategy',
  'what-is-liquidity-sweep-in-trading':                       'liquidity-sweep-forex-entry-strategy',
  'liquidity-sweep-entry-strategy-bearish-momentum':          'liquidity-sweep-forex-entry-strategy',
  'liquidity-sweep-mechanical-forex-entry':                   'liquidity-sweep-forex-entry-strategy',

  // ── ICT → survivor targets "ict trading" (5,400/mo) ────────────────────────
  'what-is-ict-trading-catch-the-wick':                       'ict-trading-what-it-is-catch-the-wick',

  // ── Break of structure → survivor targets "break of structure" (1,900/mo).
  //    BOS and CHOCH are the same structural event described from two sides.
  'bos-vs-choch-2-candles-1-story':                           'break-of-structure-forex-liquidity-trading',

  // ── Liquidity grab → survivor targets "liquidity grab" (480/mo) ────────────
  'mechanical-forex-trading-liquidity-grab-strategy':         'liquidity-grab-forex-catch-the-wick-entry',

  // ── Risk management → survivor targets "forex risk management" (170/mo) ────
  'forex-risk-management-rules-that-matter':                  'forex-risk-management-structure-based-stops',

  // ── Opening candle (0/mo — proprietary framing, no measured demand). Kept as
  //    ONE brand pillar rather than seven competing pages.
  'opening-candle-continuation-strategy-session-direction':   'opening-candle-continuation-strategy-forex',
  'opening-candle-session-direction-institutional-intent':    'opening-candle-continuation-strategy-forex',
  'opening-candle-first-candle-sets-session-entry':           'opening-candle-continuation-strategy-forex',
  'opening-candle-continuation-strategy-direction':           'opening-candle-continuation-strategy-forex',
  'open-candle-trading-strategy-institutional-intent':        'opening-candle-continuation-strategy-forex',
  'opening-candle-continuation-setup-forex-session-direction':'opening-candle-continuation-strategy-forex',

  // ── Remaining same-topic pairs (0/mo). The first was a 96% textual clone.
  'every-candle-tells-story-color-matters':                   'why-every-candle-tells-story',
  'why-your-trading-strategy-fails':                          'why-trading-strategy-fails-execution-not-strategy',
  'trading-strategy-works-all-timeframes':                    'fortitude-fx-strategy-works-any-timeframe',
  'fractal-trading-strategy-multiple-timeframes':             'fractal-price-action-multi-timeframe-strategy',
};

// Consolidated URLs stay in the sitemap DURING the merge window — Googlebot has to
// recrawl them to SEE the canonical tag, and this domain gets ~26 Googlebot
// requests/day, so we want them advertised until the merge lands. Flip to true once
// GSC reports them as "Duplicate, Google chose a different canonical" (2-6 weeks);
// after that a sitemap should list canonical URLs only.
export const DROP_CONSOLIDATED_FROM_SITEMAP = false;

// The survivor a duplicate canonicalises to, or null when the slug is not merged.
// Self-references and chains (A→B→C) are refused so a bad edit can never point a
// page at itself or build a canonical loop.
export function consolidationTarget(slug) {
  const t = CONSOLIDATED[slug];
  if (!t || t === slug) return null;
  if (CONSOLIDATED[t]) return null;   // target is itself merged → chain, refuse
  return t;
}
