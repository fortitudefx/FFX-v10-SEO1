// functions/api/seed-demand-map.js
// POST /api/seed-demand-map?key=GATE_AUDIT_KEY  → writes the keyword demand map to
// demand:map (KV) from the committed lib/keyword/seed-data.js. Run ONCE to arm
// SOURCE_MODE=keyword. Thereafter the cron claims targets from it each weekday.
//
// Key-guarded (reuses GATE_AUDIT_KEY). Refuses to clobber a seeded map unless
// &force=1 is passed — re-seeding would reset every target's claimed/done status
// and re-generate articles already made. GET returns the map's status without
// writing (open/claimed/done counts), so you can inspect runway any time.
//
// This writes ONLY demand:map. It touches no article, no live page, nothing
// publishable. Nothing here can publish.

import { SEED_TARGETS, WINNABLE_TOPIC_COUNT } from '../../lib/keyword/seed-data.js';

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

function guard(env, url) {
  if (!env.GATE_AUDIT_KEY) return json({ error: 'GATE_AUDIT_KEY not set — set it in the Cloudflare dashboard, then call with ?key=' }, 500, HEADERS);
  if (url.searchParams.get('key') !== env.GATE_AUDIT_KEY) return json({ error: 'forbidden — valid ?key= required' }, 403, HEADERS);
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, HEADERS);
  return null;
}

// GET — inspect the live map without writing (runway check).
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const blocked = guard(env, url);
  if (blocked) return blocked;

  const existing = await env.FFX_KV.get(DEMAND_MAP_KEY, { type: 'json' }).catch(() => null);
  if (!Array.isArray(existing)) return json({ seeded: false, seedSize: SEED_TARGETS.length, winnableTopicsInSeed: WINNABLE_TOPIC_COUNT }, 200, HEADERS);
  return json({ seeded: true, live: summarise(existing) }, 200, HEADERS);
}

// POST — seed (or, with &force=1, re-seed) demand:map from the committed data.
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const blocked = guard(env, url);
  if (blocked) return blocked;

  const force = url.searchParams.get('force') === '1';
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
