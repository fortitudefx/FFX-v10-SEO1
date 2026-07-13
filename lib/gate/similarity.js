// ═══════════════════════════════════════════════════════════════════════════
// CONTENT SIMILARITY — TF-IDF over unigrams + bigrams.
// ───────────────────────────────────────────────────────────────────────────
// The batch test proved raw unigram cosine is too blunt for FFX: every forex
// article shares the same vocabulary ("candle", "price", "trade", "liquidity"),
// so genuinely distinct articles floored at ~0.81 and legitimately-new pages
// false-failed at 0.90. This fixes it two ways:
//   1. TF-IDF — a term's weight is scaled by how RARE it is across the corpus, so
//      the shared forex vocabulary (high document-frequency → low IDF) stops
//      inflating similarity, and the distinctive terms that actually make two
//      pages the same (or different) dominate.
//   2. BIGRAMS — adjacent word pairs. Two articles on different topics almost
//      never share bigrams even when they share every individual word, so bigram
//      overlap is a much sharper duplicate signal than unigram overlap.
//
// buildIdf(corpusVecs) computes IDF from the published corpus; tfidfCosine weights
// both vectors by it. Pure + dependency-free.
// ═══════════════════════════════════════════════════════════════════════════

import { wordsOf } from './html.js';

// Term-count map over unigrams + bigrams for an HTML body.
export function termVector(html) {
  const w = wordsOf(html);
  const v = Object.create(null);
  for (let i = 0; i < w.length; i++) {
    const u = w[i];
    v[u] = (v[u] || 0) + 1;
    if (i < w.length - 1) { const b = u + ' ' + w[i + 1]; v['_' + b] = (v['_' + b] || 0) + 1; } // '_' marks a bigram
  }
  return v;
}

// IDF from a set of term vectors (the published corpus). idf = ln(N / (1 + df)) + 1,
// so a term in every doc → ~ln(1)+1 ≈ small; a term in one doc → large.
export function buildIdf(corpusVecs) {
  const N = corpusVecs.length || 1;
  const df = Object.create(null);
  for (const v of corpusVecs) for (const k in v) df[k] = (df[k] || 0) + 1;
  const idf = Object.create(null);
  for (const k in df) idf[k] = Math.log(N / (1 + df[k])) + 1;
  return { idf, N };
}

// TF-IDF-weighted cosine between two term vectors, given a prebuilt IDF.
// Unseen terms (not in corpus IDF) get a default high weight (they're distinctive).
export function tfidfCosine(vecA, vecB, idfModel) {
  const idf = idfModel?.idf || {};
  const defaultIdf = Math.log((idfModel?.N || 2)) + 1;   // treat unseen as rare
  const wt = k => (idf[k] != null ? idf[k] : defaultIdf);
  let dot = 0, magA = 0, magB = 0;
  for (const k in vecA) { const a = vecA[k] * wt(k); magA += a * a; if (vecB[k]) dot += a * (vecB[k] * wt(k)); }
  for (const k in vecB) { const b = vecB[k] * wt(k); magB += b * b; }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
