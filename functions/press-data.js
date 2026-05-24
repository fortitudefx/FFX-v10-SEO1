// ─────────────────────────────────────────────────────────────────────────────
// FFX Press Data
// GET /press-data → lists all published:* entries + queue items
// GET /press-data?video=VIDEO_ID → returns single published entry
// Press is the republish dashboard — reads published:* only
// published:{videoId} is permanent — written by publish-confirm on first publish
// queue:index is managed by /queue function
// ─────────────────────────────────────────────────────────────────────────────

const QUEUE_KEY = 'queue:index';

export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV binding not found' }), { status: 500, headers });
  }

  const url     = new URL(request.url);
  const videoId = url.searchParams.get('video');

  // ── Single video fetch ─────────────────────────────────────────────────────
  if (videoId) {
    try {
      let entry = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' });
      if (!entry) entry = await env.FFX_KV.get(`published:slug:${videoId}`, { type: 'json' });
      if (!entry) {
        return new Response(JSON.stringify({ error: 'Video not found in published records' }), { status: 404, headers });
      }
      return new Response(JSON.stringify({ success: true, video: entry }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  // ── Full list ──────────────────────────────────────────────────────────────
  try {

    // ── 1. Published videos ──────────────────────────────────────────────────
    const allKeys = [];
    let cursor    = undefined;
    let done      = false;
    while (!done) {
      const result = await env.FFX_KV.list({ prefix: 'published:', cursor, limit: 1000 });
      allKeys.push(...result.keys);
      if (result.list_complete) { done = true; } else { cursor = result.cursor; }
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

    videos.sort((a, b) => {
      const dateA = new Date(a.updatedAt || 0).getTime();
      const dateB = new Date(b.updatedAt || 0).getTime();
      return dateB - dateA;
    });

    // ── 2. Queue items — enriched with content state ─────────────────────────
    const queueRaw  = await env.FFX_KV.get(QUEUE_KEY, { type: 'json' }).catch(() => null);
    const queueList = Array.isArray(queueRaw) ? queueRaw : [];
    const now       = Date.now();

    const queue = await Promise.all(queueList.map(async item => {
      const videoEntry  = await env.FFX_KV.get(`video:${item.videoId}`, { type: 'json' }).catch(() => null);
      const hasContent  = !!videoEntry;

      let expiresAt   = null;
      let expiresInMs = null;
      if (hasContent && videoEntry.generatedAt) {
        const generatedMs = new Date(videoEntry.generatedAt).getTime();
        expiresAt         = new Date(generatedMs + 24 * 60 * 60 * 1000).toISOString();
        expiresInMs       = generatedMs + 24 * 60 * 60 * 1000 - now;
      }

      let state = 'grey';
      if (hasContent) state = 'orange';
      if (!hasContent && item.wasGenerated) state = 'red';

      return {
        ...item,
        hasContent,
        state,
        expiresAt,
        expiresInMs,
        title:      videoEntry?.title      || item.title      || '',
        youtubeUrl: videoEntry?.youtubeUrl || item.youtubeUrl || '',
        // Include full video content for orange items so press can expand them
        videoContent: hasContent ? videoEntry : null,
      };
    }));

    console.log('[FFX Press] Returning', videos.length, 'published videos,', queue.length, 'queue items');

    return new Response(JSON.stringify({
      success: true,
      count:  videos.length,
      videos,
      queue,
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
