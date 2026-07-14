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
import { callKeywordPlatforms } from '../../lib/keyword/platforms.js';

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

  // ── PUBLISH BLOG (catch-up): publish already-generated, gate-PASSED keyword
  //    articles to the BLOG ONLY (moves them to press; social stays manual). This is
  //    the one-time catch-up for items generated before blog-auto-publish; the
  //    consumer now does this automatically for new gate-passed articles.
  if (url.searchParams.get('publishblog') === '1') {
    const only = (url.searchParams.get('keywords') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const queue = (await env.FFX_KV.get('queue:index', { type: 'json' }).catch(() => null)) || [];
    const targets = queue.filter(q => q.source === 'keyword'
      && (only.length ? only.includes((q.keyword || '').toLowerCase()) : q.gateStatus === 'passed'));
    const out = [];
    for (const q of targets) {
      const rec = await env.FFX_KV.get(`video:${q.videoId}`, { type: 'json' }).catch(() => null);
      const content = rec && rec.platforms && rec.platforms.blog_global && rec.platforms.blog_global.content;
      if (!content) { out.push({ keyword: q.keyword, error: 'no content' }); continue; }
      if ((rec.gateStatus || q.gateStatus) !== 'passed') { out.push({ keyword: q.keyword, skipped: 'gate not passed' }); continue; }
      try {
        const r = await fetch(`${url.origin}/press-publish`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: q.videoId, slug: content.slug, source: 'queue', platforms: { blog: true, x: false, linkedin: false, discord: false, tumblr: false }, content }),
        });
        const b = await r.json().catch(() => ({}));
        out.push({ keyword: q.keyword, slug: content.slug, published: r.ok, status: r.status, warning: b.warning || b.error || null });
      } catch (e) { out.push({ keyword: q.keyword, error: e.message }); }
    }
    return json({ publishedBlog: out.filter(o => o.published).length, note: 'Blog only — social stays manual in press.', results: out });
  }

  // ── CLEAR SOURCE VIDEO: null the (misleading) footer youtubeUrl on keyword
  //    articles across every KV read key. No API, no regen — the video is a stored
  //    field, not part of the article body. article-content.js reads article:{slug}
  //    (KV) first, so this fixes the LIVE page for published items too.
  if (url.searchParams.get('clearvideo') === '1') {
    const kws = (url.searchParams.get('keywords') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!kws.length) return json({ error: 'clearvideo needs ?keywords=a,b' }, 400);
    const out = [];
    for (const kw of kws) {
      const vid = keywordId(kw);
      const rec = await env.FFX_KV.get(`video:${vid}`, { type: 'json' }).catch(() => null);
      if (!rec) { out.push({ keyword: kw, error: 'no record for ' + vid }); continue; }
      const content = (rec.platforms && rec.platforms.blog_global && rec.platforms.blog_global.content) || {};
      const slug = content.slug || rec.slug;
      rec.youtubeUrl = null;
      if (content) content.youtubeUrl = null;
      if (rec.platforms && rec.platforms.blog_global) rec.platforms.blog_global.content = content;
      await env.FFX_KV.put(`video:${vid}`, JSON.stringify(rec));
      // Null across the other live-read keys (whichever exist).
      const patched = ['video:' + vid];
      for (const key of [`article:${slug}`, `published:${vid}`, `published:slug:${slug}`, `video:slug:${slug}`]) {
        const r = await env.FFX_KV.get(key, { type: 'json' }).catch(() => null);
        if (r) { r.youtubeUrl = null; if (r.content) r.content.youtubeUrl = null; await env.FFX_KV.put(key, JSON.stringify(r)); patched.push(key); }
      }

      // CRITICAL: a published article may be keyed under a DIFFERENT videoId (extracted
      // from the baked youtubeUrl at publish time — e.g. published:0_YybIdgkFo instead
      // of published:kw-order-block). The live page + press read THAT record. Find it
      // by SLUG and fix it: null the video everywhere + tag it as keyword so the press
      // dashboard renders the SEO card instead of the (wrong) video thumbnail.
      const kwField = rec.keyword || kw;
      let cursor;
      do {
        const res = await env.FFX_KV.list({ prefix: 'published:', cursor, limit: 1000 }).catch(() => ({ keys: [] }));
        for (const k of (res.keys || [])) {
          const pe = await env.FFX_KV.get(k.name, { type: 'json' }).catch(() => null);
          if (pe && pe.slug === slug) {
            pe.youtubeUrl = null;
            if (pe.globalContent) pe.globalContent.youtubeUrl = null;
            if (pe.content)       pe.content.youtubeUrl = null;
            if (pe.platforms && pe.platforms.blog_global && pe.platforms.blog_global.content) pe.platforms.blog_global.content.youtubeUrl = null;
            pe.source = 'keyword'; pe.keyword = kwField; pe.cluster = rec.cluster || ''; pe.gateStatus = rec.gateStatus || null;
            await env.FFX_KV.put(k.name, JSON.stringify(pe));
            patched.push(k.name);
          }
        }
        cursor = res.list_complete ? null : res.cursor;
      } while (cursor);

      out.push({ keyword: kw, slug, keysPatched: patched });
    }
    return json({ clearedVideo: out.length, note: 'Footer source video removed from records (live page reads article:{slug} KV). No API used.', results: out });
  }

  // ── SOCIAL-ONLY REGEN: refresh X/LinkedIn/Discord on stored articles, WITHOUT
  //    regenerating the article or touching the gate verdict. Cheap (1 call/item)
  //    and safe — a gate-passed page stays passed. Defaults to all gate-passed
  //    keyword items; ?keywords=a,b limits it.
  if (url.searchParams.get('social') === '1') {
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);
    const only = (url.searchParams.get('keywords') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const queue = (await env.FFX_KV.get('queue:index', { type: 'json' }).catch(() => null)) || [];
    const targets = queue.filter(q => q.source === 'keyword'
      && (only.length ? only.includes((q.keyword || '').toLowerCase()) : q.gateStatus === 'passed'));
    const out = [];
    for (const q of targets) {
      const rec = await env.FFX_KV.get(`video:${q.videoId}`, { type: 'json' }).catch(() => null);
      const content = rec && rec.platforms && rec.platforms.blog_global && rec.platforms.blog_global.content;
      if (!content || !content.body) { out.push({ videoId: q.videoId, error: 'no stored article' }); continue; }
      try {
        const blogUrl = 'https://fortitudefx.com/article?slug=' + content.slug;
        const p = await callKeywordPlatforms(content, rec.keyword || q.keyword, blogUrl, env.ANTHROPIC_API_KEY, env);
        content.linkedin = p.linkedin; content.discord = p.discord;
        for (let i = 0; i < 6; i++) content['tweet' + (i + 1)] = p.tweets[i] || '';
        rec.platforms.blog_global.content = content;
        rec.platforms.x        = { status: 'generated', content: { tweets: p.tweets }, updatedAt: new Date().toISOString() };
        rec.platforms.linkedin = { status: 'generated', content: { text: p.linkedin }, updatedAt: new Date().toISOString() };
        rec.platforms.discord  = { status: 'generated', content: { text: p.discord },  updatedAt: new Date().toISOString() };
        await env.FFX_KV.put(`video:${q.videoId}`, JSON.stringify(rec));
        out.push({ videoId: q.videoId, keyword: rec.keyword || q.keyword, tweets: p.tweets.length, tweet5: p.tweets[4] || '', gateUntouched: rec.gateStatus });
      } catch (e) { out.push({ videoId: q.videoId, error: e.message }); }
    }
    return json({ socialRegenerated: out.length, note: 'Article + gate untouched; social refreshed with tweet-5 homepage CTA.', results: out });
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
        queue.unshift({   // newest keyword articles to the TOP for review
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
