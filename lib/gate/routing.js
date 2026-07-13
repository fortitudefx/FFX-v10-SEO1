// ═══════════════════════════════════════════════════════════════════════════
// OVERLAP ROUTING (FFX) — many sources, one page.
// ───────────────────────────────────────────────────────────────────────────
// The root cause of "26 articles on 4 concepts" was one-video-one-article with no
// check for whether the topic was already covered. This is the fix: before a
// keyword-driven draft is published as a NEW slug, check whether it overlaps an
// existing canonical page. If it does, it ENRICHES that page (same slug, re-gated)
// instead of spawning a rival that cannibalizes it.
//
// The enrich line IS the gate's near-duplicate line: content too similar to publish
// as new is, by definition, content that belongs to the page it's too similar to.
//
// routeTarget(article, corpus, {overlapThreshold}) →
//   { mode:'new'|'enrich', canonicalSlug, similarity, nearest, reason }
// The keyword-driven generation orchestrator consumes this: mode 'enrich' updates
// canonicalSlug's body (merging the new source material) and re-gates it under that
// slug; mode 'new' mints a fresh slug. Either way the gate still runs.
// ═══════════════════════════════════════════════════════════════════════════

import { termVector, buildIdf, tfidfCosine } from './similarity.js';
import { THRESHOLDS } from './gate.js';

const round2 = x => Math.round(x * 100) / 100;

export function routeTarget(article, corpus = [], opts = {}) {
  const overlapThreshold = opts.overlapThreshold != null ? opts.overlapThreshold : THRESHOLDS.similarityMax;
  const peers = corpus.filter(e => e && e.slug !== article.slug);
  const vec = termVector(article.body || '');
  const idf = buildIdf(peers.map(e => e.vec || {}));
  let maxSim = 0, nearest = null;
  for (const e of peers) { const s = tfidfCosine(vec, e.vec || {}, idf); if (s > maxSim) { maxSim = s; nearest = e.slug; } }
  maxSim = round2(maxSim);

  if (maxSim > overlapThreshold) {
    return {
      mode: 'enrich',
      canonicalSlug: nearest,
      similarity: maxSim,
      nearest,
      reason: `overlaps "${nearest}" at ${maxSim} > ${overlapThreshold} — enrich the canonical page; do not add a rival`,
    };
  }
  return {
    mode: 'new',
    canonicalSlug: null,
    similarity: maxSim,
    nearest,
    reason: `distinct enough to stand alone (max ${maxSim} <= ${overlapThreshold} vs "${nearest}")`,
  };
}
