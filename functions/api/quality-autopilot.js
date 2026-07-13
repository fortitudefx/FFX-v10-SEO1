// functions/api/quality-autopilot.js
// GET  /api/quality-autopilot        → report only (verify + diagnose + digest). No action.
// POST /api/quality-autopilot        → run the loop: verify prior fixes, diagnose,
//                                       feed keyword outcomes back, and enqueue ONE fix.
// POST /api/quality-autopilot?dry=1   → run + report but enqueue nothing.
//
// The Quality Autopilot closes the loop: published pages that underperform (GSC
// zero-click / page-2) AND carry fixable gate warnings get regenerated on the SAME
// URL, re-gated, and auto-republished (the consumer does the publish; publish.js
// still enforces the gate, so a fix can never lower quality). Pages that are
// gate-clean but underperform feed the KEYWORD layer instead (demand:map +
// autopilot:signals) — no wasted rewrite. One fix per run; churn-capped; a page
// that doesn't respond to fixing is killed and escalated, never churned.
//
// Called by ffx-cron (no new scheduler). Keyless — it only acts within guardrails.

import {
  verifyPriorFixes, diagnose, selectCandidate, fixDirective,
  applyKeywordFeedback, writeState, readState, AUTOPILOT, slugFromUrl,
} from '../../lib/autopilot/autopilot.js';
import { retrieveNuggetIds, keywordId } from '../../lib/keyword/select.js';

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const json = (b, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: HEADERS });

// Build slug → { publishedAt, targetQuery, videoId, source } from content:performance.
async function loadPerf(env) {
  const out = {};
  let cursor;
  do {
    const res = await env.FFX_KV.list({ prefix: 'content:performance:', cursor, limit: 1000 }).catch(() => ({ keys: [] }));
    for (const k of (res.keys || [])) {
      const p = await env.FFX_KV.get(k.name, { type: 'json' }).catch(() => null);
      if (!p || !p.slug) continue;
      out[p.slug] = { publishedAt: p.publishedAt || p.generatedAt || null, targetQuery: p.targetQuery || null, videoId: p.videoId || null, source: p.source || 'video' };
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return out;
}

// gate:{slug} → { status, warnings } for just the dud slugs (cheap).
async function loadGates(env, slugs) {
  const out = {};
  await Promise.all([...new Set(slugs)].map(async slug => {
    const g = await env.FFX_KV.get('gate:' + slug, { type: 'json' }).catch(() => null);
    if (g) out[slug] = { status: g.status, warnings: g.warnings || [] };
  }));
  return out;
}

async function runLoop(env, { act }) {
  if (env.AUTOPILOT_ENABLED === '0') return { skipped: 'AUTOPILOT_ENABLED=0' };
  const nowMs = Date.now();
  const signals = await env.FFX_KV.get('seo:signals', { type: 'json' }).catch(() => null);
  if (!signals) return { error: 'no seo:signals yet — run the SEO signals collector first' };

  // 1. VERIFY prior fixes (did they help? kill-switch).
  const verified = await verifyPriorFixes(env, signals, nowMs);

  // 2. DIAGNOSE current underperformers.
  const dudSlugs = [...(signals.zeroClickOpportunities || []), ...(signals.page2Opportunities || [])]
    .map(p => slugFromUrl(p.url)).filter(Boolean);
  const perfBySlug = await loadPerf(env);
  const gateBySlug = await loadGates(env, dudSlugs);
  const stateBySlug = {};
  await Promise.all(dudSlugs.map(async s => { const st = await readState(env, s); if (st) stateBySlug[s] = st; }));

  const diagnosis = diagnose({ signals, gateBySlug, stateBySlug, perfBySlug, nowMs });

  // 3. KEYWORD-LAYER FEEDBACK — outcomes → demand:map + autopilot:signals.
  const winnerQuery = signals.bestPage ? (perfBySlug[slugFromUrl(signals.bestPage.url)]?.targetQuery || null) : null;
  const keywordFeedback = await applyKeywordFeedback(env, { escalations: diagnosis.escalations, verified, winnerQuery });

  // 4. ACT — enqueue ONE fix (highest-impact candidate), unless dry/report.
  let actedOn = null;
  const candidate = selectCandidate(diagnosis);
  if (act && candidate) {
    const perf = perfBySlug[candidate.slug] || {};
    const jobId = `${nowMs}-autopilot-${candidate.slug}`.slice(0, 90);
    const directive = fixDirective(candidate.warnings);
    let job;
    if (perf.source === 'keyword' && perf.targetQuery) {
      const nuggetIds = await retrieveNuggetIds(env, { keyword: perf.targetQuery, canonical: perf.targetQuery, nugget_tags: '' }, 8);
      job = { jobId, source: 'cron-keyword', keyword: perf.targetQuery, targetQuery: perf.targetQuery, existingSlug: candidate.slug, autopilot: true, fixDirective: directive, nuggetIds, dryRun: false };
    } else if (perf.videoId) {
      job = { jobId, videoId: perf.videoId, youtubeUrl: `https://www.youtube.com/watch?v=${perf.videoId}`, existingSlug: candidate.slug, autopilot: true, fixDirective: directive };
    }
    if (job && env.ffx_generate_queue) {
      await env.FFX_KV.put('job:' + jobId, JSON.stringify({ status: 'pending', autopilot: true, slug: candidate.slug, createdAt: new Date(nowMs).toISOString() }), { expirationTtl: 86400 });
      await env.ffx_generate_queue.send(job);
      const prior = await readState(env, candidate.slug);
      await writeState(env, candidate.slug, {
        slug: candidate.slug,
        fixCount: (prior?.fixCount || 0) + 1,
        lastFixAt: new Date(nowMs).toISOString(),
        preFixMetric: { position: candidate.metric.position, impressions: candidate.metric.impressions, source: candidate.kind, at: new Date(nowMs).toISOString() },
        lastOutcome: 'pending',
        targetQuery: perf.targetQuery || null,
        history: (prior?.history || []).concat([{ at: new Date(nowMs).toISOString(), action: 'fix_enqueued', warnings: candidate.warnings }]),
      });
      actedOn = { slug: candidate.slug, jobId, directive, via: job.source === 'cron-keyword' ? 'keyword' : 'video' };
    } else {
      actedOn = { slug: candidate.slug, skipped: 'no source (videoId/targetQuery) or queue binding' };
    }
  }

  return {
    ranAt: new Date(nowMs).toISOString(),
    verified,
    fixCandidates: diagnosis.candidates.map(c => ({ slug: c.slug, targetQuery: c.targetQuery, warnings: c.warnings, position: c.metric.position, impressions: c.metric.impressions })),
    escalations: diagnosis.escalations,          // decisions that need a human
    keywordFeedback,
    actedOn,
    guardrails: { minAgeDays: AUTOPILOT.MIN_AGE_DAYS, churnDays: AUTOPILOT.CHURN_DAYS, killAfter: AUTOPILOT.KILL_AFTER_FIXES, oneFixPerRun: true },
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  return json(await runLoop(env, { act: false }));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  const dry = new URL(request.url).searchParams.get('dry') === '1';
  return json(await runLoop(env, { act: !dry }));
}
