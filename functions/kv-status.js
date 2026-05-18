// ─────────────────────────────────────────────────────────────────────────────
// FFX KV Status — read-only lookup
// POST /kv-status
// Accepts: { youtubeUrl } or { slug }
// Returns: platform statuses + full content if found
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

  // Lookup by videoId from youtubeUrl
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

  // Lookup by slug fallback
  if (!videoEntry && slug) {
    try {
      videoEntry = await env.FFX_KV.get(`video:slug:${slug}`, { type: 'json' });
    } catch (err) {
      console.log('[FFX Status] KV get slug failed:', err.message);
    }
  }

  if (!videoEntry) {
    return new Response(JSON.stringify(notFound), { status: 200, headers });
  }

  const platforms = videoEntry.platforms || {};

  // Platform status — check both new keys (blog_global) and published keys (blog)
  const getBlogStatus = () => {
    if (platforms.blog?.status && !platforms.blog.status.startsWith('generated')) return platforms.blog.status;
    if (platforms.blog_global?.status === 'generated') return 'pending';
    return 'pending';
  };

  const getStatus = (key) => {
    const p = platforms[key];
    if (!p) return 'pending';
    if (p.status && p.status !== 'generated') return p.status;
    return 'pending';
  };

  // Build full content for Load Existing — global article from blog_global or blog
  const globalContent = platforms.blog_global?.content || platforms.blog?.content || null;
  const regionalContent = platforms.blog_regional?.content || null;

  // Build articles array matching generate-status.js format
  let articles = null;
  if (globalContent) {
    const global = { ...globalContent, region: 'Global', regionLabel: 'Global' };
    articles = [global];
    if (regionalContent) {
      const regional = { ...regionalContent, region: videoEntry.region || 'Regional', regionLabel: videoEntry.region || 'Regional' };
      articles.push(regional);
    }
  }

  console.log('[FFX Status] Found in KV:', videoEntry.slug, 'articles:', articles ? articles.length : 0);

  return new Response(JSON.stringify({
    found: true,
    slug: videoEntry.slug || '',
    title: videoEntry.title || globalContent?.title || '',
    youtubeUrl: videoEntry.youtubeUrl || '',
    status: {
      blog:     getBlogStatus(),
      x:        getStatus('x'),
      linkedin: getStatus('linkedin'),
      tumblr:   getStatus('tumblr'),
      discord:  getStatus('discord'),
    },
    articles,
    // Legacy content field for backwards compatibility
    content: globalContent,
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
