// ═══════════════════════════════════════════════════════════════════════════
// TRUST / E-E-A-T SCORER (FFX) — forex-retuned rubric, threshold 70.
// ───────────────────────────────────────────────────────────────────────────
// Re-added for the full-gate acceptance standard: trust >= 70. Separate from the
// anti-fabrication hard-fail (lib/gate/fabrication.js) — fabrication is a veto;
// trust is a weighted E-E-A-T score. Weights mirror Scout; signals are forex-tuned,
// and Scout's "synthesises user signals" criterion is repurposed to DEMONSTRATES
// FIRST-HAND (real trades / entries / losses) — FFX's actual moat.
//
// Four criteria are deterministic (evidence 25, uncertainty 20, first-hand 20,
// opinion-voice 10). The fifth — factOpinionSeparated (25) — is an LLM judgment;
// pass it in via opts.factOpinionSeparated (from the deployed Haiku judge) or it
// falls back to the deterministic opinion-voice proxy.
//
// scoreTrust(html, opts) → { total, passed, criteria, failureReasons, detail }
// ═══════════════════════════════════════════════════════════════════════════

import { htmlToPlainText } from './html.js';

export const TRUST_THRESHOLD = 70;

export function scoreTrust(html, opts = {}) {
  const text = htmlToPlainText(html);
  const lower = text.toLowerCase();

  // (a) cites concrete trade evidence — pairs, price/pip levels, sessions, R, backtest
  const evidenceHits = countMatches(text, [
    /\b(EUR|GBP|USD|JPY|AUD|NZD|CAD|CHF|XAU|XAG)\s?\/\s?(USD|JPY|GBP|CHF|CAD|AUD|NZD|EUR)\b/gi,
    /\b(gold|nas100|us30|ger40|spx|dax|nasdaq|dxy)\b/gi,
    /\b\d+(\.\d+)?\s?(pips?|points?)\b/gi,
    /\b\d\.\d{2,5}\b/g,
    /\b\d+\s?:\s?\d+\b|\b\d+\s?r\b|\brisk[- ]?reward\b/gi,
    /\b(london|new york|asian|tokyo|frankfurt)\s+(open|session|killzone|close)\b/gi,
    /\b\d{1,2}[:.]\d{2}\s?(am|pm)?\b|\bgmt\b|\best\b|\butc\b/gi,
  ]);
  const citesEvidence = evidenceHits >= 2;

  // (b) admits uncertainty / YMYL honesty
  const uncertaintyHits = countMatches(lower, [
    /\b(no setup is (ever )?100|not 100 ?%|nothing is guaranteed|no guarantee)\b/g,
    /\b(you will (have|take) losing trades|losing trades are|this doesn'?t always work|won'?t win every time|not every trade)\b/g,
    /\b(not financial advice|do your own|past performance|trade at your own risk|risk of loss|you can lose)\b/g,
    /\b(i (couldn'?t|can'?t) (confirm|guarantee|promise)|no way to know for sure|sometimes (this )?fails)\b/g,
  ]);
  const admitsUncertainty = uncertaintyHits >= 1;

  // (c) demonstrates FIRST-HAND trading — the moat
  const firstHandHits = countMatches(lower, [
    /\b(the trade i took|a trade i took|i took this|i entered|i placed|i closed|i exited|i shorted|i bought|i sold)\b/g,
    /\b(my (entry|stop|target|position)|when i traded|i was (long|short|in)|i watched|i waited for)\b/g,
    /\b(a trade that (did not|didn'?t) work|one that didn'?t work|i lost|this trade lost|it stopped me out)\b/g,
    /\b(these are the trades|no hindsight|no cherry.?pick)\b/g,
  ]);
  const demonstratesFirstHand = firstHandHits >= 2;

  // (d) first-person opinion voice
  const opinionMarkers = countMatches(lower, [
    /\b(in my (view|experience|opinion)|my (take|read|process|way)|the way i (trade|see) it|i think|i'?d (say|argue))\b/g,
    /\b(honestly|here'?s the thing|my honest take|the bottom line for me)\b/g,
  ]);
  const hasOpinionVoice = opinionMarkers >= 2;

  // (e) fact/opinion separation — LLM judgment (deployed Haiku) or deterministic proxy
  const factOpinionSeparated = (opts.factOpinionSeparated != null) ? !!opts.factOpinionSeparated : hasOpinionVoice;

  const criteria = {
    citesEvidence:          { pass: citesEvidence,          weight: 25 },
    admitsUncertainty:      { pass: admitsUncertainty,      weight: 20 },
    factOpinionSeparated:   { pass: factOpinionSeparated,   weight: 25 },
    demonstratesFirstHand:  { pass: demonstratesFirstHand,  weight: 20 },
    opinionVoicePresent:    { pass: hasOpinionVoice,        weight: 10 },
  };

  let total = 0;
  const failureReasons = [];
  for (const [name, c] of Object.entries(criteria)) {
    if (c.pass) total += c.weight; else failureReasons.push(name);
  }
  return {
    total,
    passed: total >= TRUST_THRESHOLD,
    threshold: TRUST_THRESHOLD,
    criteria: Object.fromEntries(Object.entries(criteria).map(([k, v]) => [k, v.pass])),
    failureReasons,
    detail: { evidenceHits, uncertaintyHits, firstHandHits, opinionMarkers, factOpinionSource: opts.factOpinionSeparated != null ? 'llm' : 'proxy' },
  };
}

function countMatches(text, patterns) {
  let n = 0;
  for (const p of patterns) { const m = text.match(p); if (m) n += m.length; }
  return n;
}
