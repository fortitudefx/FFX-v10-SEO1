// functions/api/gate-audit.js
// GET /api/gate-audit?key=GATE_AUDIT_KEY  → runs the full quality gate (similarity +
// structural + fabrication) over every published article and returns a report.
//
// Runs server-side where env.ANTHROPIC_API_KEY already lives (the fabrication judge
// needs it) — no key in a local env. Key-guarded against env.GATE_AUDIT_KEY.
//
// READ-ONLY BY DEFAULT: it computes and returns; it writes NOTHING and publishes /
// unpublishes / rewrites NOTHING. Pass &commit=1 to ALSO persist each verdict to
// gate:{slug} (so the corpus gets real verdict records) — off by default so an audit
// never changes state. Reusable, not a one-off scan.
//
// Response (fabrication failures first — the live YMYL risk):
//   { summary:{ total, passed, failed, fabricationFlagged, similarityFailed,
//               structuralFailed, unverified }, thresholds, articles:[ ... ] }

import { runGate, deriveTopicTokens } from '../../lib/gate/gate.js';
import { corpusEntry, writeVerdict } from '../../lib/gate/verdict.js';
import { THRESHOLDS } from '../../lib/gate/gate.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

  // ── Guard ──────────────────────────────────────────────────────────────────
  if (!env.GATE_AUDIT_KEY) return json({ error: 'GATE_AUDIT_KEY not set — set it in the Cloudflare dashboard, then call with ?key=' }, 500, headers);
  if (url.searchParams.get('key') !== env.GATE_AUDIT_KEY) return json({ error: 'forbidden — valid ?key= required' }, 403, headers);
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set — fabrication cannot be verified' }, 500, headers);

  const commit = url.searchParams.get('commit') === '1';
  const origin = url.origin;

  try {
    // ── 1. Enumerate published articles (indexable only) ─────────────────────
    const index = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(() => null);
    const metas = Array.isArray(index) ? index.filter(a => a && a.slug) : [];
    // Dedupe by slug
    const seen = new Set();
    const slugs = metas.filter(a => !seen.has(a.slug) && seen.add(a.slug)).map(a => ({ slug: a.slug, title: a.title, tags: a.tags }));

    // ── 2. Fetch each body via the canonical resolver (/article-content) ─────
    const arts = [];
    for (const s of slugs) {
      try {
        const r = await fetch(`${origin}/article-content?slug=${encodeURIComponent(s.slug)}`, { headers: { 'User-Agent': 'FFX-gate-audit' } });
        if (!r.ok) { arts.push({ ...s, error: `article-content ${r.status}` }); continue; }
        const j = await r.json();
        // /article-content returns { success, article:{ slug, title, body, ... } }
        const art = j.article || j;
        const body = art.body || j.body || j.content?.body || '';
        if (!body) { arts.push({ ...s, error: 'no body' }); continue; }
        arts.push({ ...s, title: s.title || art.title, body });
      } catch (e) { arts.push({ ...s, error: e.message }); }
    }

    // ── 3. Build the comparison corpus from all fetched bodies ───────────────
    const corpus = arts.filter(a => a.body).map(a => corpusEntry(a.slug, a.body, deriveTopicTokens(a)));

    // ── 4. Gate each article against the corpus (minus itself) ───────────────
    const results = [];
    for (const a of arts) {
      if (!a.body) { results.push({ slug: a.slug, status: 'error', reason: a.error }); continue; }
      const v = await runGate({ slug: a.slug, title: a.title, tags: a.tags, body: a.body }, { corpus }, env);
      if (commit) { try { await writeVerdict(env, a.slug, a.body, v); } catch (e) { v._commitError = e.message; } }
      results.push({
        slug: a.slug,
        status: v.status,
        reason: v.reason,
        fabrication: v.fabrication,       // { status, claim, note }
        similarity: v.similarity,
        structural: v.structural,
      });
    }

    // ── 5. Summarise, fabrication failures first (the live YMYL risk) ─────────
    const rank = (r) => {
      if (r.fabrication?.status === 'flagged') return 0;
      if (r.fabrication?.status === 'unverified') return 1;
      if (r.status === 'failed' && /similarity/.test(r.reason || '')) return 2;
      if (r.status === 'failed') return 3;
      if (r.status === 'error') return 4;
      return 5;
    };
    results.sort((x, y) => rank(x) - rank(y) || (y.similarity || 0) - (x.similarity || 0));

    const summary = {
      total: results.length,
      passed: results.filter(r => r.status === 'passed').length,
      failed: results.filter(r => r.status === 'failed').length,
      errored: results.filter(r => r.status === 'error').length,
      fabricationFlagged: results.filter(r => r.fabrication?.status === 'flagged').length,
      unverified: results.filter(r => r.fabrication?.status === 'unverified').length,
      similarityFailed: results.filter(r => /\[similarity\]/.test(r.reason || '')).length,
      structuralFailed: results.filter(r => /\[structural\]/.test(r.reason || '')).length,
      committed: commit,
    };

    return json({ summary, thresholds: THRESHOLDS, articles: results }, 200, headers);
  } catch (err) {
    return json({ error: String(err.message || err) }, 500, headers);
  }
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers });
}
