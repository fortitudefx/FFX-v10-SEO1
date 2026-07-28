// ═══════════════════════════════════════════════════════════════════════════
// ENRICHMENT PLAN — which measured keywords belong on which EXISTING page
// ───────────────────────────────────────────────────────────────────────────
// The generation pipeline only ever created NEW articles. That is why 12,690
// searches/month of already-measured demand sat unused: every one of those
// keywords normalises to a head topic that is already claimed, so selectTargets
// correctly refuses to spawn an article for it — and nothing else ever picked
// them up. The original design called this "enrichment" and it was never built.
//
// Enrichment is the other half of consolidation. We merged 6 liquidity-sweep
// pages into 1; that survivor should now cover what all 6 were reaching for.
//
// NO new URLs, no new crawl budget, no cannibalization risk — the same page
// answers more questions.
// ═══════════════════════════════════════════════════════════════════════════

import { headTopic } from '../keyword/select.js';

// Head topic -> the live page that owns it. These are the consolidation
// survivors, so enrichment always lands on the canonical page of a cluster.
export const TOPIC_OWNER = {
  'fair value gap':         'fair-value-gap-imbalance-forex-trading',
  'liquidity sweep':        'liquidity-sweep-forex-entry-strategy',
  'ict':                    'ict-trading-what-it-is-catch-the-wick',
  'order block':            'order-block-blue-box-forex-trading',
  'break of structure':     'break-of-structure-forex-liquidity-trading',
  'bos':                    'break-of-structure-forex-liquidity-trading',
  'smart money concept':    'smart-money-concepts-catch-the-wick-forex',
  'liquidity grab':         'liquidity-grab-forex-catch-the-wick-entry',
  'market structure shift': 'market-structure-shift-2-candles-1-story',
  'mitigation block':       'mitigation-block-blue-box-forex-trading',
  'prop firm challenge':    'prop-firm-challenge-survival-guide',
  'best prop firm':         'best-prop-firm-for-beginners-risk-structure',
  'risk management':        'forex-risk-management-structure-based-stops',
  'ict killzone':           'ict-killzone-times-time-fractal-trading',
};

// Searcher wants a file or a tool, not prose. Covering these in an article is an
// intent mismatch — it satisfies nobody and dilutes the page.
const TOOL_INTENT = /\b(pdf|indicator|ea|bot|template|script|download|login|dashboard|course|signal)\b/i;

// Build { slug: { topic, head, targets[] } } from the live demand map.
// Derived, never hand-maintained, so it stays true as the map is refreshed.
export function buildEnrichmentPlan(demandMap, { minVolume = 10 } = {}) {
  const bySlug = {};
  for (const r of (Array.isArray(demandMap) ? demandMap : [])) {
    if (!r || !r.keyword) continue;
    const slug = TOPIC_OWNER[headTopic(r.canonical || r.keyword)];
    if (!slug) continue;
    (bySlug[slug] = bySlug[slug] || { slug, topic: headTopic(r.canonical || r.keyword), rows: [] }).rows.push(r);
  }

  const plan = {};
  for (const [slug, entry] of Object.entries(bySlug)) {
    const rows = entry.rows.slice().sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const head = rows[0];
    const targets = rows.slice(1)
      .filter(r => (r.volume || 0) >= minVolume)
      .filter(r => !TOOL_INTENT.test(r.keyword))
      .map(r => ({
        keyword: r.keyword,
        volume: r.volume || 0,
        // Definitional queries Google answers inline. Still worth a short, direct
        // paragraph for completeness — never the lead, the click is often gone.
        aiAnswered: r.verdict === 'AI_CANNIBALIZED',
      }));
    if (!targets.length) continue;
    plan[slug] = {
      slug,
      topic: entry.topic,
      headKeyword: head.keyword,
      headVolume: head.volume || 0,
      targets,
      addedVolume: targets.reduce((n, t) => n + t.volume, 0),
    };
  }
  return plan;
}

// Pages ordered by the demand they unlock — biggest win first.
export function planByPriority(plan) {
  return Object.values(plan).sort((a, b) => b.addedVolume - a.addedVolume);
}
