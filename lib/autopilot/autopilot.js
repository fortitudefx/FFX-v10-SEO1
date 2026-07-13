// ═══════════════════════════════════════════════════════════════════════════
// QUALITY AUTOPILOT (FFX) — close the loop: performance + gate warnings → action.
// ───────────────────────────────────────────────────────────────────────────
// The gate keeps bad content OFF the site; the Autopilot keeps published content
// from quietly UNDERPERFORMING. It joins per-page GSC signals (seo:signals, which
// already computes zeroClickOpportunities + page2Opportunities) with each page's
// recorded gate warnings (gate:{slug}.warnings) and decides, per page:
//
//   WINNER            position ≤ 10 with clicks        → never touched
//   DUD + warnings    indexed-but-weak AND has fixable → AUTO-FIX candidate
//                     gate warnings                       (regenerate the specific
//                                                          warning, re-gate, republish
//                                                          SAME URL — the publish gate
//                                                          still enforces quality)
//   DUD, no warnings  weak but gate-clean               → ESCALATE (demand/targeting,
//                                                          not a content-quality fix)
//   too new           < MIN_AGE_DAYS since publish       → wait (don't judge early)
//
// Guardrails so autonomy can't hurt SEO:
//   • CHURN_DAYS      never rewrite the same URL more than once per window.
//   • MIN_AGE_DAYS    give a page time to settle before judging it.
//   • KILL_AFTER      if fixing a page twice didn't help, STOP — it's not a content
//                     problem; escalate instead of churning the URL forever.
//   • 1 fix per run   pacing — never mass-rewrite indexed pages.
//   • re-gate on republish (enforced by publish.js) — a fix can't lower quality.
//
// The brain here is PURE + deterministic (offline-testable). The act (enqueue +
// auto-publish) lives in functions/api/quality-autopilot.js + the consumer.
// State per page: autopilot:{slug}.
// ═══════════════════════════════════════════════════════════════════════════

export const AUTOPILOT = {
  MIN_AGE_DAYS: 35,     // don't judge a page until it has had time to rank
  CHURN_DAYS: 45,       // min gap between fixes to the same URL (no churn)
  VERIFY_AFTER_DAYS: 21,// wait this long after a fix before judging if it helped
  KILL_AFTER_FIXES: 2,  // fixes that didn't help before we stop touching a page
  WINNER_POSITION: 10,  // avg position ≤ this with clicks = leave it alone
  MIN_IMPRESSIONS: 5,   // ignore pages with too little data to judge
};

export function autopilotKey(slug) { return 'autopilot:' + slug; }

// Extract the article slug from a GSC page URL (/article?slug=X or /article/X).
export function slugFromUrl(url) {
  const u = String(url || '');
  let m = u.match(/[?&]slug=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  m = u.match(/\/article\/([^/?#]+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

export async function readState(env, slug) {
  return await env.FFX_KV.get(autopilotKey(slug), { type: 'json' }).catch(() => null);
}
export async function writeState(env, slug, state) {
  await env.FFX_KV.put(autopilotKey(slug), JSON.stringify(state));
}

const daysSince = (iso, nowMs) => iso ? (nowMs - new Date(iso).getTime()) / 86400000 : Infinity;

// ── VERIFY: did prior fixes help? Update state, apply the kill-switch. ────────
// A fixed page that has LEFT the dud set (no longer zero-click / page-2) counts as
// improved. Still a dud after VERIFY_AFTER_DAYS → no_change; after KILL_AFTER_FIXES
// unhelpful fixes → killed (never auto-fixed again; escalated instead).
export async function verifyPriorFixes(env, signals, nowMs) {
  const dudUrls = new Map(); // slug → {position, impressions}
  for (const p of (signals.zeroClickOpportunities || [])) { const s = slugFromUrl(p.url); if (s) dudUrls.set(s, p); }
  for (const p of (signals.page2Opportunities || []))     { const s = slugFromUrl(p.url); if (s && !dudUrls.has(s)) dudUrls.set(s, p); }

  const list = await env.FFX_KV.list({ prefix: 'autopilot:' }).catch(() => ({ keys: [] }));
  const verified = [];
  for (const k of (list.keys || [])) {
    const state = await env.FFX_KV.get(k.name, { type: 'json' }).catch(() => null);
    if (!state || state.lastOutcome !== 'pending') continue;
    if (daysSince(state.lastFixAt, nowMs) < AUTOPILOT.VERIFY_AFTER_DAYS) continue;

    const stillDud = dudUrls.get(state.slug);
    const pre = state.preFixMetric || {};
    let outcome;
    if (!stillDud) outcome = 'improved';                                  // left the dud set
    else if (pre.position && stillDud.position <= pre.position - 2) outcome = 'improved'; // rank up ≥2
    else outcome = 'no_change';

    state.lastOutcome = outcome;
    state.history = (state.history || []).concat([{ at: new Date(nowMs).toISOString(), outcome, metric: stillDud || null }]);
    if (outcome === 'no_change' && (state.fixCount || 0) >= AUTOPILOT.KILL_AFTER_FIXES) {
      state.killed = true; // content isn't the problem — stop churning, escalate
    }
    await writeState(env, state.slug, state);
    verified.push({ slug: state.slug, outcome, killed: !!state.killed });
  }
  return verified;
}

// ── DIAGNOSE: classify underperformers into fix candidates + escalations. ────
// perfBySlug: optional map slug → { publishedAt } for age gating (from
// content:performance). gateBySlug: slug → gate verdict ({status, warnings}).
export function diagnose({ signals, gateBySlug, stateBySlug, perfBySlug = {}, nowMs }) {
  const candidates = [];
  const escalations = [];
  const seen = new Set();

  const consider = (p, kind) => {
    const slug = slugFromUrl(p.url);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    if ((p.impressions || 0) < AUTOPILOT.MIN_IMPRESSIONS) return;

    const age = daysSince(perfBySlug[slug]?.publishedAt, nowMs);
    if (age < AUTOPILOT.MIN_AGE_DAYS) return; // too new to judge

    const state = stateBySlug[slug] || null;
    if (state?.killed) { escalations.push({ slug, reason: 'fixed but did not improve — not a content problem (demand/targeting/off-page)', metric: p }); return; }
    if (state && daysSince(state.lastFixAt, nowMs) < AUTOPILOT.CHURN_DAYS) return; // churn cap

    const targetQuery = perfBySlug[slug]?.targetQuery || null; // the keyword this page targets
    const gate = gateBySlug[slug] || {};
    const warnings = Array.isArray(gate.warnings) ? gate.warnings : [];
    if (warnings.length > 0) {
      candidates.push({ slug, kind, warnings, targetQuery, metric: p, priority: p.impressions || 0 });
    } else {
      // Content is gate-clean but the page underperforms → the KEYWORD/demand is the
      // suspect, not the writing. This is the keyword-layer feedback signal.
      escalations.push({ slug, targetQuery, reason: 'underperforms but gate-clean — likely demand/targeting, not content quality', metric: p });
    }
  };

  for (const p of (signals.zeroClickOpportunities || [])) consider(p, 'zero_click');
  for (const p of (signals.page2Opportunities || []))     consider(p, 'page_2');

  candidates.sort((a, b) => b.priority - a.priority);
  return { candidates, escalations };
}

// The single fix to act on this run (highest-impact candidate), or null.
export function selectCandidate(diagnosis) {
  return (diagnosis.candidates && diagnosis.candidates[0]) || null;
}

// ── KEYWORD-LAYER FEEDBACK ───────────────────────────────────────────────────
// "No data without a feedback destination." Push page OUTCOMES back into the
// keyword demand map so selection LEARNS: a keyword whose page is gate-clean but
// underperforms (or was fixed twice with no help) had its demand/winnability
// mis-estimated — deprioritise it so the cron stops picking that losing intent and
// its near-duplicates. Winners are marked so the intent can be mined for siblings.
// Also writes autopilot:signals, which the intelligence-engine reads alongside its
// other signals — so the keyword injection into the brief accounts for real results.
export async function applyKeywordFeedback(env, { escalations = [], verified = [], winnerQuery = null }) {
  const { readDemandMap, writeDemandMap } = await import('../keyword/select.js');
  const map = await readDemandMap(env);
  const byKw = new Map(map.map(r => [(r.keyword || '').toLowerCase(), r]));
  const deprioritized = [], marked = [];

  const norm = s => String(s || '').toLowerCase().trim();
  const killedSlugs = new Set(verified.filter(v => v.killed).map(v => v.slug));

  // Underperforming (gate-clean) keywords → strike; deprioritise on repeat.
  for (const e of escalations) {
    const row = e.targetQuery && byKw.get(norm(e.targetQuery));
    if (!row) continue;
    row.dudStrikes = (row.dudStrikes || 0) + 1;
    row.outcome = 'underperformed';
    row.outcomeAt = new Date().toISOString();
    if (row.dudStrikes >= 2 && (row.status === 'open' || row.status === 'claimed' || row.status === 'done')) {
      row.status = 'deprioritized'; // selectTargets only picks status==='open'
      deprioritized.push(row.keyword);
    }
    marked.push(row.keyword);
  }

  // Winner → mark the intent as won (mine for siblings later).
  if (winnerQuery && byKw.get(norm(winnerQuery))) {
    const w = byKw.get(norm(winnerQuery));
    w.outcome = 'won'; w.outcomeAt = new Date().toISOString();
  }

  if (marked.length || winnerQuery) await writeDemandMap(env, map);

  // Signal the intelligence-engine reads (keyword injection now accounts for results).
  const signal = {
    generatedAt: new Date().toISOString(),
    deprioritizedKeywords: deprioritized,
    underperformingKeywords: marked,
    killedPages: [...killedSlugs],
    winnerQuery: winnerQuery || null,
  };
  await env.FFX_KV.put('autopilot:signals', JSON.stringify(signal));
  return signal;
}

// Turn a page's gate warnings into a concrete regeneration directive.
export function fixDirective(warnings) {
  const parts = [];
  for (const w of warnings) {
    if (w.includes('[voice]'))    parts.push('Sharpen the voice to Salman\'s register (direct, calm, institutional); fix the flagged voice issues.');
    if (w.includes('[sections]')) parts.push('Add/expand the missing or thin sections with genuine, specific substance — do not pad.');
    if (w.includes('[filler]'))   parts.push('Remove filler phrases; replace with direct statements.');
    if (w.includes('[structural]')) parts.push('Vary the structure/skeleton so it does not mirror sibling pages.');
  }
  return parts.length ? parts.join(' ') : 'Improve depth and specificity where the page reads generic.';
}
