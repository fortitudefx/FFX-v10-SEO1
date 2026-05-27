// functions/api/queue-remove.js
// POST /api/queue-remove → removes a videoId from queue:index

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const body    = await request.json();
    const videoId = body.videoId;
    if (!videoId) return new Response(JSON.stringify({ error: 'videoId required' }), { status: 400, headers });
    const raw   = await env.FFX_KV.get('queue:index', { type: 'json' }).catch(() => null);
    const queue = Array.isArray(raw) ? raw : [];
    const updated = queue.filter(q => q.videoId !== videoId);
    await env.FFX_KV.put('queue:index', JSON.stringify(updated));
    return new Response(JSON.stringify({ success: true, removed: queue.length - updated.length }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
