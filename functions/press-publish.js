// ─────────────────────────────────────────────────────────────────────────────
// FFX Press Publish
// POST /press-publish → republishes selected platforms for a published video
// Reads globalContent + regionalContent from published:{videoId}
// Full content always available — migrated permanently on first publish
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

  const { videoId, slug, platforms } = body;

  if (!videoId && !slug) {
    return new Response(JSON.stringify({ error: 'videoId or slug is required' }), { status: 400, headers });
  }

  if (!platforms || typeof platforms !== 'object') {
    return new Response(JSON.stringify({ error: 'platforms object is required' }), { status: 400, headers });
  }

  console.log('[FFX Press Publish] videoId:', videoId || 'none', 'slug:', slug || 'none', 'platforms:', platforms);

  // ── Read from published:* — permanent, always available ───────────────────
  let publishedEntry;
  try {
    if (videoId) {
      publishedEntry = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' });
    }
    // Fall back to slug-keyed entry for legacy entries
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

  const globalContent   = publishedEntry.globalContent;
  const regionalContent = publishedEntry.regionalContent || null;

  if (!globalContent || !globalContent.slug) {
    return new Response(JSON.stringify({ error: 'Full content not found in published record. Please regenerate from generate.html.' }), { status: 400, headers });
  }

  console.log('[FFX Press Publish] slug:', globalContent.slug, 'regional:', regionalContent?.slug || 'none');

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

    console.log('[FFX Press Publish] Result:', JSON.stringify(publishResult.status));

  } catch (err) {
    return new Response(JSON.stringify({ error: `publish-confirm error: ${err.message}` }), { status: 500, headers });
  }

  return new Response(JSON.stringify({
    success: true,
    videoId: videoId || slug,
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
