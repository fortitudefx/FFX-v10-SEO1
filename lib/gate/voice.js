// ═══════════════════════════════════════════════════════════════════════════
// VOICE ENFORCEMENT (FFX) — verify the preventive system, don't fight it.
// ───────────────────────────────────────────────────────────────────────────
// FFX enforces voice PREVENTIVELY (tuned prompts, banned openings, CTW grounding,
// the intelligence:voice_calibration correction loop). The batch test proved that
// a prompt alone is not enough — 2 of 5 articles used banned phrases mid-body. So
// this module VERIFIES the preventive rules held; it does NOT run an independent
// LLM re-grade that could contradict the tuned prompts.
//
// Two exports, both deterministic (cheap, no LLM):
//   bannedOpeningsCheck(html) → { pass, violations }  — HARD veto. Scans the FULL
//     body: every heading, paragraph, list item, and SENTENCE opener (the 2 leaks
//     were mid-paragraph sentence starts, which a first-line check misses).
//   voiceScore(html, opts) → { total, pass, components } — compliance score that
//     confirms the output is Salman's register (first-person, real trading
//     vocabulary), stays restrained (no hype), and respects the correction loop.
// ═══════════════════════════════════════════════════════════════════════════

import { htmlToPlainText, htmlToStructuralText } from './html.js';

export const VOICE_THRESHOLD = 70;

// The canonical banned-openings list (mirrors the platform/regen prompts). An FFX
// article — like an FFX post — must never START a heading or sentence with these.
const BANNED = [
  /^most traders\b/i,
  /^the reality is\b/i,
  /^one thing i.?ve learned\b/i,
  /^the market doesn.?t care\b/i,
  /^this is why\b/i,
  /^here.?s the truth\b/i,
  /^trading is\b/i,
  /^many traders\b/i,
  /^many people\b/i,
];

// Split the body into openers to test: each heading/paragraph/list-item block, and
// each sentence inside it. Returns the leading text of every such unit.
function openers(html) {
  const blocks = htmlToStructuralText(html)
    .split('\n')
    .map(l => l.replace(/^#{2,3}\s+/, '').trim())
    .filter(Boolean);
  const out = [];
  for (const b of blocks) {
    for (const s of b.split(/(?<=[.!?])\s+/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export function bannedOpeningsCheck(html) {
  const violations = [];
  for (const o of openers(html)) {
    for (const re of BANNED) {
      if (re.test(o)) { violations.push({ phrase: re.source.replace(/^\^|\\b.*$/g, '').replace(/\\/g, ''), snippet: o.slice(0, 60) }); break; }
    }
  }
  return { pass: violations.length === 0, violations };
}

function countMatches(text, patterns) {
  let n = 0;
  for (const p of patterns) { const m = text.match(p); if (m) n += m.length; }
  return n;
}

// opts.corrections: array of strings from intelligence:voice_calibration.corrections.
// We honour quoted "..." phrases inside a correction as things to NOT reintroduce.
export function voiceScore(html, opts = {}) {
  const text = htmlToPlainText(html);
  const lower = text.toLowerCase();

  // (1) First-person register — Salman speaks in the first person.
  const firstPerson = countMatches(lower, [/\bi\b/g, /\bi'?m\b/g, /\bi'?ve\b/g, /\bmy\b/g, /\bi'?d\b/g]);
  const firstPersonOk = firstPerson >= 4;

  // (2) FFX trading register — proves it is FFX-native, not a generic forex explainer.
  const register = countMatches(lower, [
    /\b(momentum candle|liquidity sweep|catch the wick|2 candle|order flow|order block|displacement)\b/g,
    /\b(wick|liquidity|momentum|candle|sweep|structure|fractal|session|killzone)\b/g,
  ]);
  const registerOk = register >= 5;

  // (3) Restraint — no hype, within the exclamation limit. Require >=2 hype signals
  // to fail: a single hype word is often a DEBUNK ("treat it as guaranteed. It isn't"),
  // which is Salman's voice, not a claim. Genuine hype clusters multiple signals.
  const exclamations = (text.match(/!/g) || []).length;
  const hype = countMatches(lower, [/\b(guaranteed|get rich|risk[- ]free|can'?t lose|easy money|secret (system|strategy)|100% win|never lose)\b/g]);
  const restraintOk = exclamations <= 1 && hype < 2;

  // (4) Correction-loop respected — no reintroduced quoted phrase from the corrections.
  let correctionsOk = true;
  const reintroduced = [];
  for (const c of (opts.corrections || [])) {
    const m = String(c).match(/"([^"]{3,60})"|'([^']{3,60})'/);
    const phrase = m && (m[1] || m[2]);
    if (phrase && lower.includes(phrase.toLowerCase())) { correctionsOk = false; reintroduced.push(phrase); }
  }

  const components = {
    firstPerson:  { ok: firstPersonOk, weight: 30, detail: firstPerson },
    register:     { ok: registerOk,    weight: 30, detail: register },
    restraint:    { ok: restraintOk,   weight: 20, detail: { exclamations, hype } },
    corrections:  { ok: correctionsOk, weight: 20, detail: reintroduced },
  };
  let total = 0;
  for (const c of Object.values(components)) if (c.ok) total += c.weight;

  return { total, pass: total >= VOICE_THRESHOLD, threshold: VOICE_THRESHOLD, components };
}
