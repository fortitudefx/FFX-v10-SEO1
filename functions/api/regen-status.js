// ─────────────────────────────────────────────────────────────────────────────
// FFX Regen Status
// GET    /api/regen-status?videoId=X         — returns all active regen keys for a video
// DELETE /api/regen-status?videoId=X&platform=Y — deletes one regen key only
// Called on row expand (GET) and after Save (DELETE)
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORMS = ['article', 'x', 'linkedin', 'discord', 'tumblr'];

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

  // Read all platform regen keys in parallel
  const results = await Promise.all(
    PLATFORMS.map(async platform => {
      try {
        const raw = await env.FFX_KV.get(`regen:${videoId}:${platform}`, { type: 'json' });
        if (!raw) return null;
        return { platform, generatedAt: raw.generatedAt, expiresAt: raw.expiresAt, fields: raw.fields };
      } catch { return null; }
    })
  );

  const regenMap = {};
  results.forEach(r => { if (r) regenMap[r.platform] = r; });

  return json({ success: true, videoId, regen: regenMap }, 200, headers);
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  const url      = new URL(request.url);
  const videoId  = url.searchParams.get('videoId');
  const platform = url.searchParams.get('platform');

  if (!videoId)  return json({ error: 'videoId is required' }, 400, headers);
  if (!platform) return json({ error: 'platform is required' }, 400, headers);
  if (!PLATFORMS.includes(platform)) {
    return json({ error: `Unknown platform: ${platform}` }, 400, headers);
  }

  try {
    await env.FFX_KV.delete(`regen:${videoId}:${platform}`);
    console.log('[FFX] regen key deleted:', videoId, platform);
  } catch (err) {
    return json({ error: 'Failed to delete regen key: ' + err.message }, 500, headers);
  }

  return json({ success: true, videoId, platform }, 200, headers);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
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
