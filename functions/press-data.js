// ─────────────────────────────────────────────────────────────────────────────
// FFX Press Data
// GET /press-data → lists all published:{videoId} entries from KV
// Only videos with at least one platform published appear in Press
// Press is the republish dashboard — generate.html is the review dashboard
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV binding not found' }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const videoId = url.searchParams.get('video');

  // ── Single video fetch ─────────────────────────────────────────────────────
  if (videoId) {
    try {
      const entry = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' });
      if (!entry) {
        return new Response(JSON.stringify({ error: 'Video not found in published records' }), { status: 404, headers });
      }
      return new Response(JSON.stringify({ success: true, video: entry }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  // ── Full list — published:* keys only ─────────────────────────────────────
  try {
    const allKeys = [];
    let cursor = undefined;
    let done = false;

    while (!done) {
      const result = await env.FFX_KV.list({ prefix: 'published:', cursor, limit: 1000 });
      allKeys.push(...result.keys);
      if (result.list_complete) {
        done = true;
      } else {
        cursor = result.cursor;
      }
    }

    console.log('[FFX Press] Found', allKeys.length, 'published keys');

    const videos = [];
    for (const key of allKeys) {
      try {
        const entry = await env.FFX_KV.get(key.name, { type: 'json' });
        if (entry) videos.push(entry);
      } catch (err) {
        console.log('[FFX Press] Failed to fetch key:', key.name, err.message);
      }
    }

    // Sort newest first by updatedAt
    videos.sort((a, b) => {
      const dateA = new Date(a.updatedAt || 0).getTime();
      const dateB = new Date(b.updatedAt || 0).getTime();
      return dateB - dateA;
    });

    console.log('[FFX Press] Returning', videos.length, 'published videos');

    return new Response(JSON.stringify({
      success: true,
      count: videos.length,
      videos,
    }), { status: 200, headers });

  } catch (err) {
    console.log('[FFX Press] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
