// ─────────────────────────────────────────────────────────────────────────────
// FFX KV Status — read-only lookup
// POST /excel-status
// Accepts: { slug } or { youtubeUrl }
// Returns: platform statuses + existing article content if found
// Reads from KV FFX_KV — no Excel dependency
// Used by generate.html to check if video was published before
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV not bound' }), { status: 500, headers });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
  }

  const { slug, youtubeUrl } = body;
  if (!slug && !youtubeUrl) {
    return new Response(JSON.stringify({ error: 'slug or youtubeUrl required' }), { status: 400, headers });
  }

  const notFound = {
    found: false,
    status: { blog: 'pending', x: 'pending', linkedin: 'pending', tumblr: 'pending', discord: 'pending' }
  };

  // Extract videoId from youtubeUrl
  const extractVideoId = (url) => {
    try {
      const u = new URL(url);
      if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
      if (u.hostname.includes('youtube.com')) {
        const v = u.searchParams.get('v');
        if (v) return v;
        const parts = u.pathname.split('/');
        const si = parts.indexOf('shorts');
        if (si !== -1) return parts[si + 1];
      }
    } catch {}
    return null;
  };

  let videoEntry = null;

  // Try lookup by videoId first
  if (youtubeUrl) {
    const videoId = extractVideoId(youtubeUrl);
    if (videoId) {
      try {
        videoEntry = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });
      } catch (err) {
        console.log('[FFX Status] KV get video failed:', err.message);
      }
    }
  }

  // Try lookup by slug if not found yet
  if (!videoEntry && slug) {
    try {
      videoEntry = await env.FFX_KV.get(`video:slug:${slug}`, { type: 'json' });
    } catch (err) {
      console.log('[FFX Status] KV get slug failed:', err.message);
    }
  }

  // If still not found by videoId, try slug from youtubeUrl via article metadata
  if (!videoEntry && youtubeUrl) {
    try {
      // List all article keys to find by youtubeUrl
      const list = await env.FFX_KV.list({ prefix: 'article:' });
      for (const key of list.keys) {
        const article = await env.FFX_KV.get(key.name, { type: 'json' });
        if (article && article.youtubeUrl) {
          const articleVideoId = extractVideoId(article.youtubeUrl);
          const searchVideoId = extractVideoId(youtubeUrl);
          if (articleVideoId && searchVideoId && articleVideoId === searchVideoId) {
            // Found matching article — try video:slug key
            videoEntry = await env.FFX_KV.get(`video:slug:${article.slug}`, { type: 'json' });
            break;
          }
        }
      }
    } catch (err) {
      console.log('[FFX Status] KV article list failed (non-fatal):', err.message);
    }
  }

  if (!videoEntry) {
    return new Response(JSON.stringify(notFound), { status: 200, headers });
  }

  // Build platform status from KV — same shape as Excel version
  const platforms = videoEntry.platforms || {};
  const getStatus = (p) => platforms[p]?.status || 'pending';

  // Get full content — from video entry content field
  const content = videoEntry.content || null;

  console.log('[FFX Status] Found in KV:', videoEntry.slug);

  return new Response(JSON.stringify({
    found: true,
    slug: videoEntry.slug || '',
    title: videoEntry.title || content?.title || '',
    ytUrl: videoEntry.youtubeUrl || '',
    status: {
      blog:     getStatus('blog'),
      x:        getStatus('x'),
      linkedin: getStatus('linkedin'),
      tumblr:   getStatus('tumblr'),
      discord:  getStatus('discord'),
    },
    content,
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
