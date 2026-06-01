// ─────────────────────────────────────────────────────────────────────────────
// FFX Video Content
// GET /api/video-content?videoId=X
// Reads video:{videoId} from KV (24hr TTL staging key written by ffx-consumer)
// Also checks regen:{videoId}:{platform} keys and merges over base content
// so per-platform regenerated content is reflected immediately after regen
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

  // ── 1. Read base video record ─────────────────────────────────────────────
  const record = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' }).catch(() => null);

  if (!record) {
    return json({
      error: 'Content not found. The 24-hour generation window may have expired, or generation has not completed yet.',
      videoId,
    }, 404, headers);
  }

  // ── 2. Check all regen staging keys and merge over base content ───────────
  // regen:{videoId}:{platform} is written by /api/regenerate-platform
  // Fields are merged into the relevant platform section of the video record
  const regenChecks = await Promise.all(
    PLATFORMS.map(p =>
      env.FFX_KV.get(`regen:${videoId}:${p}`, { type: 'json' }).catch(() => null)
    )
  );

  PLATFORMS.forEach((platform, i) => {
    const regen = regenChecks[i];
    if (!regen || !regen.fields) return;

    if (platform === 'article') {
      // Merge body into blog_global content
      if (!record.platforms) record.platforms = {};
      if (!record.platforms.blog_global) record.platforms.blog_global = { content: {} };
      if (!record.platforms.blog_global.content) record.platforms.blog_global.content = {};
      if (regen.fields.body) {
        record.platforms.blog_global.content.body = regen.fields.body;
      }
    } else if (platform === 'x') {
      // Merge tweet1-6 into blog_global content
      if (!record.platforms) record.platforms = {};
      if (!record.platforms.blog_global) record.platforms.blog_global = { content: {} };
      if (!record.platforms.blog_global.content) record.platforms.blog_global.content = {};
      ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6'].forEach(f => {
        if (regen.fields[f]) record.platforms.blog_global.content[f] = regen.fields[f];
      });
    } else {
      // linkedin, discord, tumblr — merge into their platform content
      const platformKey = platform;
      if (!record.platforms) record.platforms = {};
      if (!record.platforms[platformKey]) record.platforms[platformKey] = { content: {} };
      if (!record.platforms[platformKey].content) record.platforms[platformKey].content = {};
      if (regen.fields[platform]) {
        record.platforms[platformKey].content.text = regen.fields[platform];
      }
    }
  });

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
