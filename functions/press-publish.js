// ─────────────────────────────────────────────────────────────────────────────
// FFX Press Publish Worker
// POST /press-publish → publishes selected platforms for a video
// Calls publish-confirm internally, writes status back to KV
// Used by press.html publish button
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

  const { videoId, jobId, platforms } = body;

  if (!videoId && !jobId) {
    return new Response(JSON.stringify({ error: 'videoId or jobId is required' }), { status: 400, headers });
  }

  if (!platforms || typeof platforms !== 'object') {
    return new Response(JSON.stringify({ error: 'platforms object is required' }), { status: 400, headers });
  }

  console.log('[FFX Press Publish] jobId:', jobId || 'none', 'videoId:', videoId || 'none', 'platforms:', platforms);

  // ── Fetch content from KV ──────────────────────────────────────────────────
  // jobId — new generation flow: read from temporary job key (24hr TTL)
  // videoId — republish flow: read from permanent video entry
  let contentObj;
  let resolvedVideoId = videoId;

  try {
    if (jobId) {
      // New generation — read from job key
      const jobEntry = await env.FFX_KV.get(`job:${jobId}`, { type: 'json' });
      if (!jobEntry) {
        return new Response(JSON.stringify({ error: 'Job not found — link may have expired (24hr limit)' }), { status: 404, headers });
      }
      contentObj = jobEntry.content;
      resolvedVideoId = jobEntry.videoId || videoId;
    } else {
      // Republish — read from permanent video entry
      let videoEntry = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });
      if (!videoEntry) {
        videoEntry = await env.FFX_KV.get(`video:slug:${videoId}`, { type: 'json' });
      }
      if (!videoEntry) {
        return new Response(JSON.stringify({ error: 'Video not found in KV' }), { status: 404, headers });
      }
      contentObj = videoEntry.content;
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: `KV read failed: ${err.message}` }), { status: 500, headers });
  }

  const content = contentObj;
  if (!content || !content.slug) {
    return new Response(JSON.stringify({ error: 'No content found' }), { status: 400, headers });
  }

  console.log('[FFX Press Publish] Content found, slug:', content.slug, 'videoId:', resolvedVideoId);

  // ── Call publish-confirm ───────────────────────────────────────────────────
  const baseUrl = new URL(request.url).origin;
  let publishResult;
  try {
    const res = await fetch(`${baseUrl}/publish-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, platforms }),
    });

    publishResult = await res.json();

    if (!res.ok) {
      return new Response(JSON.stringify({
        error: publishResult.error || `publish-confirm failed: ${res.status}`,
      }), { status: 500, headers });
    }

    console.log('[FFX Press Publish] publish-confirm result:', JSON.stringify(publishResult.status));

  } catch (err) {
    return new Response(JSON.stringify({ error: `publish-confirm error: ${err.message}` }), { status: 500, headers });
  }

  // ── KV is already updated by publish-confirm.js ───────────────────────────
  // publish-confirm.js writes platform status to KV video:{videoId} directly
  // No additional KV write needed here

  return new Response(JSON.stringify({
    success: true,
    videoId: resolvedVideoId,
    slug: content.slug,
    status: publishResult.status,
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
