// ═══════════════════════════════════════════════════════════════════════════
// THE GATE (FFX) — similarity · structural · voice · fabrication.
// ───────────────────────────────────────────────────────────────────────────
// A backstop to FFX's preventive voice/quality system. Checks, cheap → expensive:
//   1. SIMILARITY  — TF-IDF (uni+bigram) cosine vs the published corpus. Down-weights
//                    shared forex vocabulary so genuinely-new pages don't false-fail.
//   2. STRUCTURAL  — composite skeleton similarity <= 0.55 vs the corpus.
//   3. VOICE       — (a) banned-openings HARD veto (full-body sentence scan) and
//                    (b) a deterministic compliance score that VERIFIES FFX's
//                    preventive voice system held (register, restraint, corrections).
//   4. FABRICATION — invented-stat hard-fail, FAIL-CLOSED (LLM, last).
//
// runGate(article, ctx, env) → { status, reason, similarity, structural, voice,
//   bannedOpenings, fabrication, at }. publish.js is the sole enforcement point.
// ═══════════════════════════════════════════════════════════════════════════

import { htmlToStructuralText } from './html.js';
import { termVector, buildIdf, tfidfCosine } from './similarity.js';
import { structuralFingerprint, compositeStructuralSimilarity } from './structure.js';
import { canonicalRole } from './blueprints.js';
import { bannedOpeningsCheck, voiceScore, VOICE_THRESHOLD } from './voice.js';
import { detectFabrication } from './fabrication.js';
import { verifyQuotes } from './quote-verify.js';

export const THRESHOLDS = {
  similarityMax: 0.55,     // TF-IDF uni+bigram cosine (recalibrated for FFX — see docs)
  structuralMax: 0.55,
  voiceMin: VOICE_THRESHOLD, // 70
  structuralMinCorpus: 4,
};

const STOP = new Set(['the','and','for','that','this','with','your','you','are','was','how','why','what','when','not','but','from','has','have','will','can','into','out','its','a','an','of','to','in','is','on','trading','forex','trade','trades']);

export function deriveTopicTokens(article) {
  const raw = [article?.title, article?.targetQuery, ...(Array.isArray(article?.tags) ? article.tags : String(article?.tags || '').split(','))]
    .filter(Boolean).join(' ').toLowerCase();
  const words = raw.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));
  const titleWords = String(article?.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const bigrams = [];
  for (let i = 0; i < titleWords.length - 1; i++) bigrams.push(titleWords[i] + ' ' + titleWords[i + 1]);
  return [...new Set([...bigrams, ...words])];
}

const round2 = x => (x == null ? null : Math.round(x * 100) / 100);

export async function runGate(article, ctx = {}, env = {}) {
  const body = article.body || '';
  const corpus = (Array.isArray(ctx.corpus) ? ctx.corpus : []).filter(e => e && e.slug !== article.slug);
  const topicTokens = deriveTopicTokens(article);
  const v = { status: 'passed', reason: null, similarity: null, structural: null, voice: null, bannedOpenings: null, quotes: null, fabrication: null, at: new Date().toISOString() };
  const done = extra => ({ ...v, ...extra, at: new Date().toISOString() });

  // 1. CONTENT SIMILARITY (TF-IDF uni+bigram) — HARD, fail-CLOSED on error.
  try {
    const vec = termVector(body);
    const idf = buildIdf(corpus.map(e => e.vec || {}));
    let maxSim = 0, nearest = null;
    for (const e of corpus) { const s = tfidfCosine(vec, e.vec || {}, idf); if (s > maxSim) { maxSim = s; nearest = e.slug; } }
    v.similarity = round2(maxSim);
    v.nearest = nearest;
    if (v.similarity > THRESHOLDS.similarityMax) return done({ status: 'failed', reason: `[similarity] ${v.similarity} > ${THRESHOLDS.similarityMax} vs "${nearest}" (near-duplicate)` });
  } catch (err) {
    return done({ status: 'failed', reason: `[similarity] lookup errored (fail-closed): ${err.message}` });
  }

  // 2. STRUCTURAL DIVERSITY — HARD, fail-OPEN on error.
  try {
    if (corpus.length >= THRESHOLDS.structuralMinCorpus) {
      const fp = structuralFingerprint(htmlToStructuralText(body), topicTokens, canonicalRole);
      let maxSim = 0, nearest = null;
      for (const e of corpus) { if (!e.fp) continue; const s = compositeStructuralSimilarity(fp, e.fp); if (s > maxSim) { maxSim = s; nearest = e.slug; } }
      v.structural = round2(maxSim);
      if (v.structural > THRESHOLDS.structuralMax) return done({ status: 'failed', reason: `[structural] ${v.structural} > ${THRESHOLDS.structuralMax} vs "${nearest}" (same skeleton)` });
    } else v.structural = null;
  } catch { v.structural = null; }

  // 3a. BANNED OPENINGS — HARD veto (deterministic, full-body).
  const banned = bannedOpeningsCheck(body);
  v.bannedOpenings = { pass: banned.pass, violations: banned.violations };
  if (!banned.pass) return done({ status: 'failed', reason: `[voice] banned opening(s): ${banned.violations.map(x => `"${x.phrase}"`).join(', ')}` });

  // 3b. VOICE SCORE — deterministic; verifies the preventive system held.
  let corrections = [];
  try {
    const cal = env.FFX_KV ? await env.FFX_KV.get('intelligence:voice_calibration', { type: 'json' }).catch(() => null) : null;
    corrections = (cal && Array.isArray(cal.corrections)) ? cal.corrections : [];
  } catch {}
  const vs = voiceScore(body, { corrections });
  v.voice = vs.total;
  if (!vs.pass) return done({ status: 'failed', reason: `[voice] score ${vs.total} < ${THRESHOLDS.voiceMin} (${Object.entries(vs.components).filter(([, c]) => !c.ok).map(([k]) => k).join(', ')})` });

  // 3c. QUOTE VERIFICATION — HARD (keyword source mode only). Every <blockquote>
  //     must trace VERBATIM to a nugget used to ground the article. Skipped when
  //     no nuggetTexts are supplied (video mode) — behaviour unchanged there.
  if (Array.isArray(ctx.nuggetTexts) && ctx.nuggetTexts.length) {
    const q = verifyQuotes(body, ctx.nuggetTexts);
    v.quotes = { pass: q.pass, checked: q.checked, note: q.note };
    if (!q.pass) return done({ status: 'failed', reason: `[quotes] ${q.violations.length} blockquote(s) not traceable to the nugget library — possible fabricated quote: "${q.violations[0]}"` });
  }

  // 4. ANTI-FABRICATION (LLM) — HARD, FAIL-CLOSED.
  const fab = await detectFabrication(body, { title: article.title, targetQuery: article.targetQuery }, env);
  v.fabrication = { status: fab.status, claim: fab.claim || '', note: fab.note || '' };
  if (fab.status !== 'clean') {
    const why = fab.status === 'flagged'
      ? `FABRICATION_DETECTED${fab.claim ? ` — "${fab.claim}"` : ''}${fab.note ? ` (${fab.note})` : ''}`
      : `fabrication UNVERIFIED (fail-closed) — ${fab.note}`;
    return done({ status: 'failed', reason: `[fabrication] ${why}` });
  }

  return done({ status: 'passed', reason: null });
}
