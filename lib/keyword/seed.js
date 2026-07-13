// ═══════════════════════════════════════════════════════════════════════════
// KEYWORD SOURCE — self-seeding (no key, no manual curl)
// ───────────────────────────────────────────────────────────────────────────
// Arms the keyword pipeline on first use, idempotently:
//   • demand:map   — from the committed seed-data.js (instant, deterministic).
//   • gate:corpus  — the 26 published articles' structural + TF-IDF vectors, so
//                    similarity/structural have the live corpus to judge against.
//                    Deterministic (no LLM) — built from article bodies.
// Both are no-ops once populated. Called by the cron and the keyword-run endpoint.
// ═══════════════════════════════════════════════════════════════════════════

import { SEED_TARGETS } from './seed-data.js';
import { loadCorpus, corpusEntry } from '../gate/verdict.js';
import { deriveTopicTokens } from '../gate/gate.js';
import { DEMAND_MAP_KEY, readDemandMap, writeDemandMap } from './select.js';

// The KV shape: static seed fields + runtime status.
export function materializeTargets() {
  return SEED_TARGETS.map(t => ({
    keyword: t.keyword, volume: t.volume, kd: t.kd, verdict: t.verdict,
    cluster: t.cluster, canonical: t.canonical,
    proprietary_term: t.proprietary_term, nugget_tags: t.nugget_tags,
    status: 'open', article_slug: null, claimedAt: null,
  }));
}

// Seed demand:map if it is empty. Returns { seeded, count }.
export async function ensureDemandMap(env, { force = false } = {}) {
  const existing = await readDemandMap(env);
  if (existing.length && !force) return { seeded: false, count: existing.length };
  const map = materializeTargets();
  await writeDemandMap(env, map);
  return { seeded: true, count: map.length };
}

// Seed gate:corpus from the published set if it is empty. Deterministic — no LLM.
// Needs an `origin` (e.g. https://fortitudefx.com) and a fetch implementation to
// pull each article body via /article-content. Best-effort: skips bodies it can't
// fetch and still writes what it has. Returns { seeded, count, attempted }.
export async function ensureCorpus(env, origin, fetchImpl, { force = false } = {}) {
  const existing = await loadCorpus(env);
  if (existing.length && !force) return { seeded: false, count: existing.length, attempted: 0 };

  const index = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(() => null);
  const metas = Array.isArray(index) ? index.filter(a => a && a.slug) : [];
  const seen = new Set();
  const slugs = metas.filter(a => !seen.has(a.slug) && seen.add(a.slug));

  const corpus = [];
  for (const s of slugs) {
    try {
      const r = await fetchImpl(`${origin}/article-content?slug=${encodeURIComponent(s.slug)}`, { headers: { 'User-Agent': 'FFX-keyword-seed' } });
      if (!r.ok) continue;
      const j = await r.json();
      const art = j.article || j;
      const body = art.body || j.body || (j.content && j.content.body) || '';
      if (!body) continue;
      corpus.push(corpusEntry(s.slug, body, deriveTopicTokens({ title: s.title || art.title, tags: s.tags })));
    } catch { /* skip this one */ }
  }

  if (corpus.length) await env.FFX_KV.put('gate:corpus', JSON.stringify(corpus));
  return { seeded: corpus.length > 0, count: corpus.length, attempted: slugs.length };
}
