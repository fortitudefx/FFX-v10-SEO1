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
import { runGate } from '../../lib/gate/gate.js';
import { loadCorpus, writeVerdict } from '../../lib/gate/verdict.js';
import { loadNuggetTexts } from '../../lib/keyword/grounding.js';

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

  // ── REGATE: re-run the gate on EXISTING article bodies (no regeneration) ────
  // Use after tuning the gate — re-scores the stored bodies and rewrites the
  // verdict + queue row, without burning a new generation or risking new prose.
  if (url.searchParams.get('regate') === '1') {
    const only = (url.searchParams.get('keywords') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const corpus = await loadCorpus(env);
    const queue = (await env.FFX_KV.get('queue:index', { type: 'json' }).catch(() => null)) || [];
    const out = [];
    const targetVids = only.length ? only.map(keywordId) : queue.filter(q => q.source === 'keyword').map(q => q.videoId);
    for (const vid of targetVids) {
      const rec = await env.FFX_KV.get(`video:${vid}`, { type: 'json' }).catch(() => null);
      const content = rec && rec.platforms && rec.platforms.blog_global && rec.platforms.blog_global.content;
      if (!content || !content.body) { out.push({ videoId: vid, error: 'no stored body' }); continue; }
      const nuggets = await loadNuggetTexts(env, rec.nuggetIds || []);
      const v = await runGate(
        { slug: content.slug, title: content.title, tags: content.tags, body: content.body, targetQuery: rec.keyword },
        { corpus, pageType: 'article', nuggetTexts: nuggets.map(n => n.text) },
        env
      );
      await writeVerdict(env, content.slug, content.body, v);
      rec.gateStatus = v.status; rec.gateReason = v.reason;
      rec.gateFabrication = v.fabrication; rec.gateSimilarity = v.similarity;
      rec.gateStructural = v.structural; rec.gateVoice = v.voice; rec.gateQuotes = v.quotes;
      await env.FFX_KV.put(`video:${vid}`, JSON.stringify(rec));
      const row = queue.find(q => q.videoId === vid);
      if (row) row.gateStatus = v.status;
      out.push({ videoId: vid, slug: content.slug, gate: v.status, reason: v.reason || null });
    }
    await env.FFX_KV.put('queue:index', JSON.stringify(queue));
    return json({ regated: out.length, results: out });
  }

  const n = Math.max(1, Math.min(10, parseInt(url.searchParams.get('n') || '2', 10) || 2));
  const dryRun = url.searchParams.get('dry') === '1';
  const reseed = url.searchParams.get('reseed') === '1';
  const force  = url.searchParams.get('force') === '1';
  // Optional: regenerate specific keywords (comma-separated), ignoring claimed status.
  const only = (url.searchParams.get('keywords') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  // Self-seed (idempotent).
  const seededMap = await ensureDemandMap(env, { force: reseed });
  const seededCorpus = await ensureCorpus(env, url.origin, fetch.bind(globalThis));

  const map = await readDemandMap(env);

  let picks, winnableRemaining, ambiguousRemaining;
  if (only.length) {
    // Targeted (re)generation of named keywords, regardless of claimed status.
    picks = map.filter(r => only.includes((r.keyword || '').toLowerCase())).slice(0, n);
    const openTopics = new Set(map.filter(r => r.verdict === 'WINNABLE' && (r.status || 'open') === 'open').map(r => r.canonical || r.keyword));
    winnableRemaining = openTopics.size;
    ambiguousRemaining = map.filter(r => r.verdict === 'AMBIGUOUS' && (r.status || 'open') === 'open').length;
  } else {
    ({ picks, winnableRemaining, ambiguousRemaining } = selectTargets(map, n));
  }

  // Force regen: clear the prior article + verdict so the consumer doesn't skip it.
  if (force && picks.length) {
    for (const t of picks) {
      const vid = keywordId(t.keyword);
      try {
        const prev = await env.FFX_KV.get(`video:${vid}`, { type: 'json' }).catch(() => null);
        const slug = prev && prev.slug;
        await env.FFX_KV.delete(`video:${vid}`).catch(() => {});
        if (slug) {
          await env.FFX_KV.delete(`gate:${slug}`).catch(() => {});
          await env.FFX_KV.delete(`content:performance:${slug}`).catch(() => {});
        }
      } catch {}
      t.status = 'open'; t.article_slug = null; t.claimedAt = null; // allow re-claim
    }
    try { await env.FFX_KV.delete('lock:generating'); } catch {}
  }
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
      const existingRow = queue.find(q => q.videoId === vid);
      if (existingRow) {
        // Regen: reset the row so the dashboard shows it working, not the stale verdict.
        existingRow.wasGenerated = false;
        existingRow.gateStatus = null;
        existingRow.jobId = jobId;
        existingRow.nuggetCount = nuggetIds.length;
      } else {
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
