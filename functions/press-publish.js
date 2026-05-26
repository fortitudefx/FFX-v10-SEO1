// ─────────────────────────────────────────────────────────────────────────────
// FFX Press Publish
// POST /press-publish → publishes selected platforms
//
// Two modes:
// 1. source:'queue' — content passed in body directly (first publish from queue)
//    Cleans up queue-edits:{videoId} and removes from queue:index on success
// 2. (default) — reads globalContent from published:{videoId} (republish from Press)
// ─────────────────────────────────────────────────────────────────────────────

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
