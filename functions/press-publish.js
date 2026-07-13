// ─────────────────────────────────────────────────────────────────────────────
// FFX Press Publish
// POST /press-publish → publishes selected platforms
//
// Two modes:
// 1. source:'queue' — content passed in body directly (first publish from queue)
//    Cleans up queue-edits:{videoId} and removes from queue:index on success
// 2. (default) — reads globalContent from published:{videoId} (republish from Press)
//
// QUALITY GATE (Step 1): this is the single point where the FINAL merged body is
// assembled (queue-edits or regen staging already applied) before the publish chain.
// We (re)gate here so edited content is re-scored and bound to its new hash — the
// consumer's verdict only covers the as-generated body. A failing gate refuses the
// WHOLE publish (article AND socials), so nothing ungated reaches any platform.
// ─────────────────────────────────────────────────────────────────────────────
import { runGate } from '../lib/gate/gate.js';
import { writeVerdict, readVerdict, loadCorpus, hashContent } from '../lib/gate/verdict.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV binding not found' }), { status: 500, headers });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { videoId, slug, platforms, source, content: bodyContent, regionalContent: bodyRegional } = body;

  if (!videoId && !slug) {
    return new Response(JSON.stringify({ error: 'videoId or slug is required' }), { status: 400, headers });
  }
  if (!platforms || typeof platforms !== 'object') {
    return new Response(JSON.stringify({ error: 'platforms object is required' }), { status: 400, headers });
  }

  console.log('[FFX Press Publish] source:', source || 'press', 'videoId:', videoId, 'platforms:', platforms);

  let globalContent, regionalContent;

  if (source === 'queue') {
    // ── Queue publish — content passed directly in body ───────────────────
    // bodyContent is already merged (gc + queueEdits) by the dashboard
    if (!bodyContent || !bodyContent.slug) {
      return new Response(JSON.stringify({ error: 'content with slug is required for queue publish' }), { status: 400, headers });
    }
    globalContent   = bodyContent;
    regionalContent = bodyRegional || null;
    console.log('[FFX Press Publish] Queue publish — slug:', globalContent.slug);

  } else {
    // ── Press republish — read from published:{videoId} ───────────────────
    let publishedEntry;
    try {
      if (videoId) {
        publishedEntry = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' });
      }
      if (!publishedEntry && slug) {
        publishedEntry = await env.FFX_KV.get(`published:slug:${slug}`, { type: 'json' });
      }
      if (!publishedEntry && videoId) {
        publishedEntry = await env.FFX_KV.get(`published:slug:${videoId}`, { type: 'json' });
      }
      if (!publishedEntry) {
        return new Response(JSON.stringify({ error: 'Video not found in published records.' }), { status: 404, headers });
      }
    } catch (err) {
      return new Response(JSON.stringify({ error: `KV read failed: ${err.message}` }), { status: 500, headers });
    }

  globalContent   = publishedEntry.globalContent;
regionalContent = publishedEntry.regionalContent || null;

// Merge any regen staging content into globalContent before publishing
// This ensures published:{videoId} becomes the source of truth FIRST
if (videoId) {
  const REGEN_PLATFORMS = ['article','x','linkedin','discord','tumblr'];
  const REGEN_FIELD_MAP = {
    article:  ['body'],
    x:        ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6'],
    linkedin: ['linkedin'],
    discord:  ['discord'],
    tumblr:   ['tumblr'],
  };
  for (const platform of REGEN_PLATFORMS) {
    if (!platforms[platform === 'article' ? 'blog' : platform]) continue;
    try {
      const regenData = await env.FFX_KV.get(`regen:${videoId}:${platform}`, { type: 'json' });
      if (regenData && regenData.fields) {
        Object.assign(globalContent, regenData.fields);
        console.log('[FFX Press Publish] Merged regen staging for platform:', platform);
      }
    } catch {}
  }
}

    if (!globalContent || !globalContent.slug) {
      return new Response(JSON.stringify({ error: 'Full content not found in published record. Please regenerate.' }), { status: 400, headers });
    }

    console.log('[FFX Press Publish] Press republish — slug:', globalContent.slug);
  }

  // ── QUALITY GATE (Step 1) — ensure the FINAL merged body has a PASSING verdict
  //    bound to its exact hash before ANYTHING publishes. Skips the paid re-gate
  //    when the consumer's verdict already matches this body (fresh, unedited).
  //    A failing/erroring gate refuses the whole publish — no article, no socials.
  try {
    const freshHash = await hashContent(globalContent.body || '');
    const existing  = await readVerdict(env, globalContent.slug);
    const alreadyPassed = existing && existing.status === 'passed' && existing.contentHash === freshHash;
    if (!alreadyPassed) {
      const corpus  = await loadCorpus(env);
      const verdict = await runGate(
        { slug: globalContent.slug, title: globalContent.title, tags: globalContent.tags, body: globalContent.body, targetQuery: globalContent.targetQuery || null },
        { corpus, pageType: 'article' },
        env
      );
      await writeVerdict(env, globalContent.slug, globalContent.body, verdict);
      if (verdict.status !== 'passed') {
        console.error('[FFX Press Publish] QUALITY GATE FAILED for', globalContent.slug, '—', verdict.reason);
        return new Response(JSON.stringify({ error: 'Quality gate: publish refused', slug: globalContent.slug, reason: verdict.reason }), { status: 403, headers });
      }
      console.log('[FFX Press Publish] Re-gated final content — passed:', globalContent.slug, `(similarity ${verdict.similarity}, structural ${verdict.structural}, voice ${verdict.voice}, fabrication ${verdict.fabrication?.status})`);
    } else {
      console.log('[FFX Press Publish] Existing gate verdict matches body — skipping re-gate:', globalContent.slug);
    }
  } catch (gErr) {
    console.error('[FFX Press Publish] Gate error (fail-closed — publish refused):', gErr.message);
    return new Response(JSON.stringify({ error: 'Quality gate error — publish refused', slug: globalContent.slug, reason: gErr.message }), { status: 500, headers });
  }

  // ── Call publish-confirm ───────────────────────────────────────────────────
  const baseUrl = new URL(request.url).origin;
  let publishResult;
  try {
    const res = await fetch(`${baseUrl}/publish-confirm`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: globalContent, regionalContent, platforms }),
    });

    publishResult = await res.json();

    if (!res.ok) {
      return new Response(JSON.stringify({
        error: publishResult.error || `publish-confirm failed: ${res.status}`,
      }), { status: 500, headers });
    }

    console.log('[FFX Press Publish] Result:', JSON.stringify(publishResult.status));

  } catch (err) {
    return new Response(JSON.stringify({ error: `publish-confirm error: ${err.message}` }), { status: 500, headers });
  }

  // ── Queue cleanup on successful publish ───────────────────────────────────
  if (source === 'queue' && videoId) {
    // Delete queue-edits permanent staging key
    try { await env.FFX_KV.delete(`queue-edits:${videoId}`); } catch {}

    // Remove from queue:index
    try {
      const queueRaw = await env.FFX_KV.get('queue:index', { type: 'json' });
      if (Array.isArray(queueRaw)) {
        const updated = queueRaw.filter(q => q.videoId !== videoId);
        await env.FFX_KV.put('queue:index', JSON.stringify(updated));
      }
    } catch {}

    console.log('[FFX Press Publish] Queue cleanup done for videoId:', videoId);
  }

  return new Response(JSON.stringify({
    success: true,
    videoId: videoId || slug,
    slug:    globalContent.slug,
    status:  publishResult.status,
  }), { status: 200, headers });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
