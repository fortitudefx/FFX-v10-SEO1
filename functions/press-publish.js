// ─────────────────────────────────────────────────────────────────────────────
// FFX Press Publish Worker
// POST /press-publish → publishes selected platforms for a video
// Reads content from video:{videoId}.platforms.blog_global.content
// Passes both global + regional content to publish-confirm for dual blog publish
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

  const { videoId, platforms } = body;

  if (!videoId) {
    return new Response(JSON.stringify({ error: 'videoId is required' }), { status: 400, headers });
  }

  if (!platforms || typeof platforms !== 'object') {
    return new Response(JSON.stringify({ error: 'platforms object is required' }), { status: 400, headers });
  }

  console.log('[FFX Press Publish] videoId:', videoId, 'platforms:', platforms);

  // ── Fetch video record from KV ─────────────────────────────────────────────
  let videoEntry;
  try {
    videoEntry = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });
    if (!videoEntry) {
      return new Response(JSON.stringify({ error: 'Video not found in KV — content may have expired (24hr limit). Regenerate.' }), { status: 404, headers });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: `KV read failed: ${err.message}` }), { status: 500, headers });
  }

  // ── Extract content from correct KV structure ──────────────────────────────
  // Consumer writes: video.platforms.blog_global.content = globalContent
  //                  video.platforms.blog_regional.content = regionalContent
  const globalContent   = videoEntry.platforms?.blog_global?.content;
  const regionalContent = videoEntry.platforms?.blog_regional?.content || null;

  if (!globalContent || !globalContent.slug) {
    return new Response(JSON.stringify({ error: 'Global content missing or malformed in KV. Regenerate.' }), { status: 400, headers });
  }

  console.log('[FFX Press Publish] Global slug:', globalContent.slug, 'Regional:', regionalContent?.slug || 'none');

  // ── Call publish-confirm ───────────────────────────────────────────────────
  const baseUrl = new URL(request.url).origin;
  let publishResult;
  try {
    const res = await fetch(`${baseUrl}/publish-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: globalContent,
        regionalContent,
        platforms,
      }),
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

  return new Response(JSON.stringify({
    success: true,
    videoId,
    slug: globalContent.slug,
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
