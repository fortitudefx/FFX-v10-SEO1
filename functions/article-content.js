// ─────────────────────────────────────────────────────────────────────────────
// FFX Article Content
// GET /article-content?slug=SLUG → returns full article from KV
// Reads published:{videoId} first (permanent), falls back to video:{videoId} (24hr TTL)
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV not bound' }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return new Response(JSON.stringify({ error: 'slug is required' }), { status: 400, headers });
  }

  try {
    // 1. Read article metadata
    const articleMeta = await env.FFX_KV.get(`article:${slug}`, { type: 'json' });

    if (!articleMeta) {
      return new Response(JSON.stringify({ error: 'Article not found' }), { status: 404, headers });
    }

    const videoId = articleMeta.videoId;
    let body = '';
    let fullContent = {};

    if (videoId) {
      // 2a. Check published:{videoId} first — permanent, written by publish-confirm
      // Full content lives in globalContent — not in platforms.blog.content
      try {
        const publishedEntry = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' });
        if (publishedEntry?.globalContent?.body) {
          fullContent = publishedEntry.globalContent;
          body = fullContent.body;
          console.log('[FFX Article] Served from published globalContent:', slug);
        } else if (publishedEntry?.platforms?.blog?.content?.body) {
          // Legacy fallback — old entries stored content inside platforms.blog.content
          fullContent = publishedEntry.platforms.blog.content;
          body = fullContent.body;
          console.log('[FFX Article] Served from published platforms.blog.content:', slug);
        }
      } catch {}

      // 2b. Fallback to video:{videoId} — generated content, 24hr TTL
      if (!body) {
        try {
          const videoEntry = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });
          if (videoEntry) {
            const blogContent =
              videoEntry?.platforms?.blog_global?.content ||
              videoEntry?.content ||
              null;
            if (blogContent) {
              fullContent = blogContent;
              body = blogContent.body || '';
              console.log('[FFX Article] Served from video KV:', slug);
            }
          }
        } catch {}
      }
    }

    // 3. Legacy fallback — video:slug:{slug}
    if (!body) {
      try {
        const slugEntry = await env.FFX_KV.get(`video:slug:${slug}`, { type: 'json' });
        if (slugEntry?.content) {
          fullContent = slugEntry.content;
          body = slugEntry.content.body || '';
        }
      } catch {}
    }

    const article = {
      slug: articleMeta.slug,
      title: articleMeta.title || fullContent.title || '',
      excerpt: articleMeta.excerpt || fullContent.excerpt || '',
      category: articleMeta.category || fullContent.category || 'Strategy',
      tags: Array.isArray(articleMeta.tags) ? articleMeta.tags : (fullContent.tags || []),
      readTime: articleMeta.readTime || fullContent.readTime || '5 min read',
      date: articleMeta.date || fullContent.date || '',
      body: body || fullContent.body || '',
      youtubeUrl: articleMeta.youtubeUrl || fullContent.youtubeUrl || '',
      videoId: articleMeta.videoId || '',
      draft: articleMeta.draft || false,
    };

    return new Response(JSON.stringify({ success: true, article }), { status: 200, headers });

  } catch (err) {
    console.log('[FFX Article] Error:', err.message);
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
