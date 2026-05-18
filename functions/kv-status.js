// ─────────────────────────────────────────────────────────────────────────────
// FFX KV Status — read-only lookup
// POST /kv-status
// Reads video:{videoId} for generated content (24hr TTL)
// Reads published:{videoId} for published status (permanent)
// These two keys are written by different systems and never conflict
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

  const videoId = youtubeUrl ? extractVideoId(youtubeUrl) : null;

  if (!videoId && !slug) {
    return new Response(JSON.stringify(notFound), { status: 200, headers });
  }

  // Read generated content — video:{videoId} — 24hr TTL
  let videoEntry = null;
  if (videoId) {
    try {
      videoEntry = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });
    } catch {}
  }

  // Legacy fallback
  if (!videoEntry && slug) {
    try {
      videoEntry = await env.FFX_KV.get(`video:slug:${slug}`, { type: 'json' });
    } catch {}
  }

  // Read published status — published:{videoId} — permanent
  let publishedEntry = null;
  if (videoId) {
    try {
      publishedEntry = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' });
    } catch {}
  }

  // If neither exists — not found
  if (!videoEntry && !publishedEntry) {
    return new Response(JSON.stringify(notFound), { status: 200, headers });
  }

  // Get published platform status — from published:{videoId}
  const publishedPlatforms = publishedEntry?.platforms || {};

  const getStatus = (key) => {
    const p = publishedPlatforms[key];
    if (!p) return 'pending';
    if (p.status && p.status.startsWith('http')) return p.status;
    if (p.status && p.status.startsWith('Error')) return p.status;
    return 'pending';
  };

  // Build articles array from video:{videoId} generated content
  const platforms = videoEntry?.platforms || {};
  const globalContent = platforms.blog_global?.content || null;
  const regionalContent = platforms.blog_regional?.content || null;

  let articles = null;
  if (globalContent) {
    const global = {
      ...globalContent,
      region: 'Global',
      regionLabel: 'Global',
      youtubeUrl: videoEntry?.youtubeUrl || youtubeUrl || '',
      videoId: videoId || videoEntry?.videoId || '',
    };
    articles = [global];
    if (regionalContent) {
      const regional = {
        ...regionalContent,
        region: videoEntry?.region || 'Regional',
        regionLabel: videoEntry?.region || 'Regional',
        youtubeUrl: videoEntry?.youtubeUrl || youtubeUrl || '',
        videoId: videoId || videoEntry?.videoId || '',
      };
      articles.push(regional);
    }
  }

  // If no generated content but published content exists — build from published
  if (!articles && publishedEntry) {
    const pubBlog = publishedPlatforms.blog?.content;
    if (pubBlog) {
      articles = [{
        ...pubBlog,
        region: 'Global',
        regionLabel: 'Global',
        youtubeUrl: publishedEntry.youtubeUrl || '',
        videoId: publishedEntry.videoId || '',
      }];
    }
  }

  const resolvedSlug = videoEntry?.slug || publishedEntry?.slug || slug || '';
  const resolvedTitle = videoEntry?.title || publishedEntry?.title || globalContent?.title || '';
  const resolvedYoutubeUrl = videoEntry?.youtubeUrl || publishedEntry?.youtubeUrl || youtubeUrl || '';

  console.log('[FFX Status] Found — slug:', resolvedSlug, 'published platforms:', Object.keys(publishedPlatforms).join(','));

  return new Response(JSON.stringify({
    found: true,
    slug: resolvedSlug,
    title: resolvedTitle,
    youtubeUrl: resolvedYoutubeUrl,
    status: {
      blog:     getStatus('blog'),
      x:        getStatus('x'),
      linkedin: getStatus('linkedin'),
      tumblr:   getStatus('tumblr'),
      discord:  getStatus('discord'),
    },
    articles,
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
