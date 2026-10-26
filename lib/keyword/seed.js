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
import { DEMAND_MAP_KEY, readDemandMap, writeDemandMap, rowTopic } from './select.js';

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

// Append NEW rows from the committed seed-data.js to an already-live demand:map,
// without touching a single existing row. This is the safe counterpart to
// ensureDemandMap's `force` path: a forced re-seed resets every row's status to
// 'open', which would make the cron re-select and re-generate every already-
// published topic (selectTargets has no other way to know a topic is covered —
// see select.js takenTopics). Scripts/demand/merge.py regenerates seed-data.js
// from an approved widening and expects this function to carry the new rows
// into the live map; nothing else does.
//
// A target is "new" iff BOTH its raw keyword and its normalised head topic are
// absent from the live map — matching takenTopics/selectTargets' own notion of
// topic ownership, so an append can never create a second row for a topic
// already open, claimed, or done.
// Returns { appended, addedCount, totalBefore, totalAfter }.
export async function appendDemandTargets(env) {
  const existing = await readDemandMap(env);
  if (!existing.length) {
    const map = materializeTargets();
    await writeDemandMap(env, map);
    return { appended: true, addedCount: map.length, totalBefore: 0, totalAfter: map.length };
  }

  const existingKeywords = new Set(existing.map(r => String((r && r.keyword) || '').toLowerCase().trim()));
  const existingTopics = new Set(existing.map(r => rowTopic(r)).filter(Boolean));

  const toAdd = [];
  const addedTopics = new Set();
  for (const t of SEED_TARGETS) {
    const kw = String(t.keyword || '').toLowerCase().trim();
    if (!kw || existingKeywords.has(kw)) continue;
    const topic = rowTopic({ canonical: t.canonical, keyword: t.keyword });
    if (!topic || existingTopics.has(topic) || addedTopics.has(topic)) continue;
    addedTopics.add(topic);
    toAdd.push({
      keyword: t.keyword, volume: t.volume, kd: t.kd, verdict: t.verdict,
      cluster: t.cluster, canonical: t.canonical,
      proprietary_term: t.proprietary_term, nugget_tags: t.nugget_tags,
      status: 'open', article_slug: null, claimedAt: null,
    });
  }

  if (!toAdd.length) return { appended: false, addedCount: 0, totalBefore: existing.length, totalAfter: existing.length };

  const merged = existing.concat(toAdd);
  await writeDemandMap(env, merged);
  return { appended: true, addedCount: toAdd.length, totalBefore: existing.length, totalAfter: merged.length };
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
