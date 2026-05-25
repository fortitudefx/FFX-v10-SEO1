// ─────────────────────────────────────────────────────────────────────────────
// FFX Video Content
// GET /api/video-content?videoId=X
// Reads video:{videoId} directly (24hr TTL staging key written by ffx-consumer)
// Used by Queue page to load generated content before first publish
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  const url     = new URL(request.url);
  const videoId = url.searchParams.get('videoId');
  if (!videoId) return json({ error: 'videoId is required' }, 400, headers);

  const record = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' }).catch(() => null);

  if (!record) {
    return json({
      error: 'Content not found. The 24-hour generation window may have expired, or generation has not completed yet.',
      videoId,
    }, 404, headers);
  }

  return json({ success: true, video: record }, 200, headers);
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

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
