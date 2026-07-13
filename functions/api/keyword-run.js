// functions/api/keyword-run.js
// POST /api/keyword-run          → generate the next N keyword targets NOW.
// POST /api/keyword-run?n=2      → how many (default 2).
// POST /api/keyword-run?dry=1    → generate + gate but keep out of the live queue.
// POST /api/keyword-run?reseed=1 → force re-seed demand:map first.
// GET  /api/keyword-run          → status (seeded? runway? what's claimed).
//
// No key — this is your own trigger. It self-seeds demand:map + gate:corpus on
// first use, picks the next winnable distinct-topic targets, grounds each in
// Salman's nuggets, and enqueues them to the consumer (same path as the cron).
// Nothing here publishes; jobs land in the queue for review.

import {
  readDemandMap, writeDemandMap, selectTargets, markClaimed,
  retrieveNuggetIds, keywordId,
} from '../../lib/keyword/select.js';
import { ensureDemandMap, ensureCorpus } from '../../lib/keyword/seed.js';

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const json = (b, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: HEADERS });

function summarise(map) {
  const openTopics = new Set();
  const byStatus = {};
  for (const r of map) {
    const st = r.status || 'open';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (r.verdict === 'WINNABLE' && st === 'open') openTopics.add(r.canonical || r.keyword);
  }
  return { total: map.length, byStatus, winnableOpenTopics: openTopics.size };
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  const map = await readDemandMap(env);
  return json({ seeded: map.length > 0, map: map.length ? summarise(map) : null });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  if (!env.ffx_generate_queue) return json({ error: 'Queue binding ffx_generate_queue not found' }, 500);

  const n = Math.max(1, Math.min(10, parseInt(url.searchParams.get('n') || '2', 10) || 2));
  const dryRun = url.searchParams.get('dry') === '1';
  const reseed = url.searchParams.get('reseed') === '1';

  // Self-seed (idempotent).
  const seededMap = await ensureDemandMap(env, { force: reseed });
  const seededCorpus = await ensureCorpus(env, url.origin, fetch.bind(globalThis));

  const map = await readDemandMap(env);
  const { picks, winnableRemaining, ambiguousRemaining } = selectTargets(map, n);
  if (!picks.length) {
    return json({
      seed: { demandMap: seededMap, corpus: seededCorpus },
      enqueued: 0,
      message: 'No winnable unclaimed targets left. Widen the demand map or switch to enrichment.',
      ambiguousRemaining,
    });
  }

  const nowIso = new Date().toISOString();
  const enqueued = [];
  const queue = (await env.FFX_KV.get('queue:index', { type: 'json' }).catch(() => null)) || [];

  for (const target of picks) {
    const nuggetIds = await retrieveNuggetIds(env, target, 8);
    const jobId = `${Date.now()}-${keywordId(target.keyword)}`;

    await env.FFX_KV.put(`job:${jobId}`, JSON.stringify({
      status: 'pending', keyword: target.keyword, targetQuery: target.keyword,
      createdAt: nowIso, source: 'cron-keyword', dryRun,
    }), { expirationTtl: 86400 });

    await env.ffx_generate_queue.send({
      jobId, source: 'cron-keyword',
      keyword: target.keyword, targetQuery: target.keyword,
      canonical: target.canonical, cluster: target.cluster,
      proprietaryTerm: target.proprietary_term, nuggetTags: target.nugget_tags,
      nuggetIds, dryRun,
    });

    if (!dryRun) {
      const vid = keywordId(target.keyword);
      if (!queue.some(q => q.videoId === vid)) {
        queue.push({
          videoId: vid, source: 'keyword', keyword: target.keyword, targetQuery: target.keyword,
          canonical: target.canonical, cluster: target.cluster, volume: target.volume, kd: target.kd,
          nuggetCount: nuggetIds.length, title: target.keyword,
          addedAt: nowIso, addedBy: 'keyword-run', jobId, wasGenerated: false,
        });
      }
    }
    markClaimed(target, { at: nowIso });
    enqueued.push({ keyword: target.keyword, topic: target.canonical, nuggets: nuggetIds.length, jobId });
  }

  await writeDemandMap(env, map);
  if (!dryRun) await env.FFX_KV.put('queue:index', JSON.stringify(queue));

  return json({
    seed: { demandMap: seededMap, corpus: seededCorpus },
    enqueued: enqueued.length,
    dryRun,
    targets: enqueued,
    winnableRemaining,
    note: dryRun
      ? 'DRY RUN — generated + gated to dryrun:keyword:{slug}, not in the live queue.'
      : 'Enqueued. The consumer is generating + gating now; watch the dashboard queue (~1–2 min each).',
  });
}
