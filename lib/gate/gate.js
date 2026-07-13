// ═══════════════════════════════════════════════════════════════════════════
// THE GATE (FFX) — minimum-acceptable, penalty-avoidance calibration.
// ───────────────────────────────────────────────────────────────────────────
// The goal is NOT literary quality — it is: don't earn a Google penalty, index
// correctly, and protect YMYL/E-E-A-T. So the gate BLOCKS only on things that
// genuinely threaten that, and merely WARNS on brand-voice preferences (a warning
// is recorded and visible but does NOT fail the article or trigger a regen).
//
// BLOCKS (publish-blocking):
//   • FABRICATION — an invented performance NUMBER stated as measured fact (YMYL).
//   • QUOTE-VERIFY — a <blockquote> attributed to Salman that isn't in his library
//                    (E-E-A-T: fake attribution). Keyword mode only.
//   • SIMILARITY  — near-duplicate of an existing page (thin/cannibalization).
//   • THIN/PADDING — near-empty output, or heavy word-repetition padding with no
//                    value-add. NOT a length target (a tight short article passes).
//
// WARNS (recorded, non-blocking):
//   • BANNED OPENINGS ("Most traders…") · VOICE SCORE · STRUCTURAL sameness.
//     These are FFX brand-voice signals, not Google/YMYL issues.
//
// runGate(article, ctx, env) → { status, reason, warnings, similarity, structural,
//   voice, bannedOpenings, quotes, fabrication, wordCount, at }.
// publish.js blocks unless status === 'passed'.
// ═══════════════════════════════════════════════════════════════════════════

import { htmlToStructuralText, countWords, wordsOf } from './html.js';
import { termVector, buildIdf, tfidfCosine } from './similarity.js';
import { structuralFingerprint, compositeStructuralSimilarity } from './structure.js';
import { canonicalRole } from './blueprints.js';
import { bannedOpeningsCheck, voiceScore, VOICE_THRESHOLD } from './voice.js';
import { detectFabrication } from './fabrication.js';
import { verifyQuotes } from './quote-verify.js';

export const THRESHOLDS = {
  similarityMax: 0.55,       // near-duplicate vs corpus → BLOCK (thin/cannibalization)
  minWords: 200,             // below this = broken/stub generation → BLOCK
  minUniqueRatio: 0.22,      // heavy repetition (padding, no value-add) → BLOCK. Real
                             //   forex articles sit ~0.31–0.34; genuine padding ~0.01.

  structuralMax: 0.55,       // WARN only — soft skeleton-sameness signal
  voiceMin: VOICE_THRESHOLD, // WARN only — brand voice, not a Google/YMYL issue
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
  const v = { status: 'passed', reason: null, warnings: [], similarity: null, structural: null, voice: null, bannedOpenings: null, quotes: null, fabrication: null, wordCount: null, at: new Date().toISOString() };
  const done = extra => ({ ...v, ...extra, at: new Date().toISOString() });

  v.wordCount = countWords(body);

  // ── BLOCK 1: THIN / PADDING ─────────────────────────────────────────────────
  // Not a length target — a tight short article passes. This catches only broken/
  // near-empty output and heavy word-repetition padding with no value-add.
  const words = wordsOf(body);
  const uniqueRatio = words.length ? Math.round((new Set(words).size / words.length) * 100) / 100 : 0;
  v.uniqueRatio = uniqueRatio;
  if (v.wordCount < THRESHOLDS.minWords) {
    return done({ status: 'failed', reason: `[thin] ${v.wordCount} words < ${THRESHOLDS.minWords} — empty/broken generation, no substance` });
  }
  if (uniqueRatio < THRESHOLDS.minUniqueRatio) {
    return done({ status: 'failed', reason: `[thin] unique-word ratio ${uniqueRatio} < ${THRESHOLDS.minUniqueRatio} — padded/repetitive with no value-add` });
  }

  // ── BLOCK 2: NEAR-DUPLICATE (TF-IDF uni+bigram) — fail-CLOSED on error ───────
  try {
    const vec = termVector(body);
    const idf = buildIdf(corpus.map(e => e.vec || {}));
    let maxSim = 0, nearest = null;
    for (const e of corpus) { const s = tfidfCosine(vec, e.vec || {}, idf); if (s > maxSim) { maxSim = s; nearest = e.slug; } }
    v.similarity = round2(maxSim);
    v.nearest = nearest;
    if (v.similarity > THRESHOLDS.similarityMax) return done({ status: 'failed', reason: `[similarity] ${v.similarity} > ${THRESHOLDS.similarityMax} vs "${nearest}" (near-duplicate — cannibalization/thin risk)` });
  } catch (err) {
    return done({ status: 'failed', reason: `[similarity] lookup errored (fail-closed): ${err.message}` });
  }

  // ── BLOCK 3: QUOTE VERIFICATION (keyword mode only) — E-E-A-T fake attribution.
  if (Array.isArray(ctx.nuggetTexts) && ctx.nuggetTexts.length) {
    const q = verifyQuotes(body, ctx.nuggetTexts);
    v.quotes = { pass: q.pass, checked: q.checked, note: q.note };
    if (!q.pass) return done({ status: 'failed', reason: `[quotes] ${q.violations.length} blockquote(s) not traceable to the nugget library — possible fabricated quote: "${q.violations[0]}"` });
  }

  // ── BLOCK 4: ANTI-FABRICATION (LLM) — YMYL invented-number, FAIL-CLOSED ──────
  const fab = await detectFabrication(body, { title: article.title, targetQuery: article.targetQuery }, env);
  v.fabrication = { status: fab.status, claim: fab.claim || '', note: fab.note || '' };
  if (fab.status !== 'clean') {
    const why = fab.status === 'flagged'
      ? `FABRICATION_DETECTED${fab.claim ? ` — "${fab.claim}"` : ''}${fab.note ? ` (${fab.note})` : ''}`
      : `fabrication UNVERIFIED (fail-closed) — ${fab.note}`;
    return done({ status: 'failed', reason: `[fabrication] ${why}` });
  }

  // ── WARN (non-blocking): brand-voice + structural signals ───────────────────
  // Recorded on the verdict for visibility; they NEVER fail the article or trigger
  // a regen. Loosen or re-promote to blocking by moving a line back above.
  try {
    if (corpus.length >= THRESHOLDS.structuralMinCorpus) {
      const fp = structuralFingerprint(htmlToStructuralText(body), topicTokens, canonicalRole);
      let maxSim = 0, nearest = null;
      for (const e of corpus) { if (!e.fp) continue; const s = compositeStructuralSimilarity(fp, e.fp); if (s > maxSim) { maxSim = s; nearest = e.slug; } }
      v.structural = round2(maxSim);
      if (v.structural > THRESHOLDS.structuralMax) v.warnings.push(`[structural] ${v.structural} vs "${nearest}" (similar skeleton)`);
    }
  } catch { v.structural = null; }

  const banned = bannedOpeningsCheck(body);
  v.bannedOpenings = { pass: banned.pass, violations: banned.violations };
  if (!banned.pass) v.warnings.push(`[voice] banned opening(s): ${banned.violations.map(x => `"${x.phrase}"`).join(', ')}`);

  let corrections = [];
  try {
    const cal = env.FFX_KV ? await env.FFX_KV.get('intelligence:voice_calibration', { type: 'json' }).catch(() => null) : null;
    corrections = (cal && Array.isArray(cal.corrections)) ? cal.corrections : [];
  } catch {}
  const vs = voiceScore(body, { corrections });
  v.voice = vs.total;
  if (!vs.pass) v.warnings.push(`[voice] score ${vs.total} < ${THRESHOLDS.voiceMin}`);

  return done({ status: 'passed', reason: v.warnings.length ? `passed with ${v.warnings.length} warning(s)` : null });
}
