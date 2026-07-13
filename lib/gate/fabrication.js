// ═══════════════════════════════════════════════════════════════════════════
// ANTI-FABRICATION CHECK (FFX) — the real gap (B2).
// ───────────────────────────────────────────────────────────────────────────
// FFX enforces voice/quality PREVENTIVELY (tuned prompts, banned openings, CTW
// grounding, a learned correction loop). What it has NEVER had is a check that
// detects an INVENTED performance claim after generation. The live "95% probability
// edge" article — an unsourced win-rate stated as fact on a money page — is the
// proof, and this is the single highest YMYL penalty vector on the site.
//
// This is a single Haiku judge, retuned for forex claims. It is FAIL-CLOSED: a flag
// blocks publish, AND an unverifiable result (Haiku unreachable after retries) also
// blocks publish. Nothing ships on a fabrication flag — or on an inability to check.
//
// detectFabrication(html, meta, env) → { status, fabricated, claim, note }
//   status: 'clean' | 'flagged' | 'unverified'
// ═══════════════════════════════════════════════════════════════════════════

import { htmlToPlainText } from './html.js';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_ATTEMPTS = 2;   // bounded retry so a transient blip isn't a hard block, but a real outage still fails closed

export async function detectFabrication(html, meta, env) {
  const text = htmlToPlainText(html);
  if (!env || !env.ANTHROPIC_API_KEY) {
    // No key = cannot verify = FAIL-CLOSED (never silently pass a money page).
    return { status: 'unverified', fabricated: true, claim: '', note: 'no ANTHROPIC_API_KEY — cannot verify (fail-closed)' };
  }

  let lastErr = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await callJudge(text, meta, env);
      return {
        status: r.fabricated ? 'flagged' : 'clean',
        fabricated: r.fabricated,
        claim: r.claim || '',
        note: r.note || '',
      };
    } catch (err) {
      lastErr = err.message;
    }
  }
  // Exhausted retries — fail closed.
  return { status: 'unverified', fabricated: true, claim: '', note: `fabrication check unavailable after ${MAX_ATTEMPTS} attempts: ${lastErr}`.slice(0, 120) };
}

async function callJudge(text, meta, env) {
  const topic = meta?.title || meta?.targetQuery || 'a forex trading setup';
  const excerpt = text.slice(0, 6000);

  const prompt = `You are auditing a forex trading education article for FABRICATED performance claims. Forex is YMYL (Your Money Your Life) — be strict.

Article is about: ${topic}

Flag "fabricated": true if the article states ANY of the following WITHOUT a stated credible source OR a sample the author actually ran:
- a win rate or success probability ("95% of the time", "wins 80%", "5 out of 6 setups", "high-probability" quantified)
- a backtest result or a count of trades ("over 200 trades", "backtested to X%")
- an average return, profit, or R-multiple expectancy stated as fact
- any performance statistic presented with confidence as if measured

It is NOT fabrication when such a number is (a) attributed to a named, checkable source, (b) accompanied by the sample size / date range the author states they ran, or (c) clearly framed as a hypothetical illustration ("for example, imagine a setup that..."). A bare, confident number with no source and no sample IS fabrication. Also flag a precise price/date sequence dressed as a real personal trade with false confidence.

Respond ONLY with JSON, no preamble:
{"fabricated": <bool>, "claim": "<the single worst offending phrase, <=15 words, or empty>", "note": "<=10 word reason>"}

Article:
${excerpt}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Haiku ${resp.status}: ${body.slice(0, 160)}`);
  }
  const data = await resp.json();
  const out = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const parsed = JSON.parse((out.match(/\{[\s\S]*\}/) || [out])[0].replace(/```json|```/g, '').trim());
  return {
    fabricated: !!parsed.fabricated,
    claim: String(parsed.claim || '').slice(0, 120),
    note: String(parsed.note || '').slice(0, 80),
  };
}
