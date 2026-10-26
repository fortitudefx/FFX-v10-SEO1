// functions/api/seed-demand-map.js
// POST /api/seed-demand-map  → writes the keyword demand map to demand:map (KV)
// from the committed lib/keyword/seed-data.js. The cron self-seeds too, so you
// rarely need this; it stays as a manual seed/inspect tool.
//
// No key — it only ever writes demand:map from committed data (no user input, no
// article, no live page, nothing publishable).
//   &append=1  — ADDITIVE. Carries only NEW topics from seed-data.js into an
//                already-live map; every existing row (open/claimed/done) is left
//                untouched. This is how an approved demand-map widening
//                (scripts/demand/merge.py) actually reaches production — the
//                plain POST below refuses once a map exists, specifically so a
//                routine re-run of this endpoint can never reset live state.
//   &force=1   — DESTRUCTIVE. Full overwrite; resets every row's status to
//                'open', which makes the cron re-select and re-generate every
//                already-published topic (selectTargets only knows a topic is
//                taken via its row's own status — see select.js takenTopics).
//                Use append, not force, to land new keywords.
// GET returns the map's open/claimed/winnable counts so you can check runway any time.

import { SEED_TARGETS, WINNABLE_TOPIC_COUNT } from '../../lib/keyword/seed-data.js';
import { appendDemandTargets } from '../../lib/keyword/seed.js';

const DEMAND_MAP_KEY = 'demand:map';

function json(body, status, headers) {
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function summarise(map) {
  const s = { total: map.length, byVerdict: {}, byStatus: {}, winnableOpenTopics: 0 };
  const openTopics = new Set();
  for (const r of map) {
    s.byVerdict[r.verdict] = (s.byVerdict[r.verdict] || 0) + 1;
    const st = r.status || 'open';
    s.byStatus[st] = (s.byStatus[st] || 0) + 1;
    if (r.verdict === 'WINNABLE' && st === 'open') openTopics.add(r.canonical || r.keyword);
  }
  s.winnableOpenTopics = openTopics.size;
  return s;
}

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

// GET — inspect the live map without writing (runway check).
export async function onRequestGet(context) {
  const { env } = context;
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, HEADERS);
  const existing = await env.FFX_KV.get(DEMAND_MAP_KEY, { type: 'json' }).catch(() => null);
  if (!Array.isArray(existing)) return json({ seeded: false, seedSize: SEED_TARGETS.length, winnableTopicsInSeed: WINNABLE_TOPIC_COUNT }, 200, HEADERS);
  return json({ seeded: true, live: summarise(existing) }, 200, HEADERS);
}

// POST — seed, append (&append=1), or re-seed (&force=1) demand:map.
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, HEADERS);
  const append = url.searchParams.get('append') === '1';
  const force = url.searchParams.get('force') === '1';

  if (append) {
    const result = await appendDemandTargets(env);
    const live = await env.FFX_KV.get(DEMAND_MAP_KEY, { type: 'json' }).catch(() => null);
    return json({ ...result, live: Array.isArray(live) ? summarise(live) : null }, 200, HEADERS);
  }

  const existing = await env.FFX_KV.get(DEMAND_MAP_KEY, { type: 'json' }).catch(() => null);
  if (Array.isArray(existing) && existing.length && !force) {
    return json({
      error: 'demand:map already seeded — re-seeding would reset claimed/done status and re-generate articles. Pass &force=1 to overwrite deliberately.',
      live: summarise(existing),
    }, 409, HEADERS);
  }

  // Materialise the KV shape: static seed fields + runtime status.
  const now = new Date().toISOString();
  const map = SEED_TARGETS.map(t => ({
    keyword: t.keyword, volume: t.volume, kd: t.kd, verdict: t.verdict,
    cluster: t.cluster, canonical: t.canonical,
    proprietary_term: t.proprietary_term, nugget_tags: t.nugget_tags,
    status: 'open', article_slug: null, claimedAt: null,
  }));

  await env.FFX_KV.put(DEMAND_MAP_KEY, JSON.stringify(map));
  return json({ seeded: true, seededAt: now, forced: force, summary: summarise(map) }, 200, HEADERS);
}
