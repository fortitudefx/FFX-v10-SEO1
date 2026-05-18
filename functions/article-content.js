// ─────────────────────────────────────────────────────────────────────────────
// FFX Article Content
// GET /article-content?slug=SLUG → returns full article from KV
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
    // 1. Read article metadata from KV article:{slug}
    const articleMeta = await env.FFX_KV.get(`article:${slug}`, { type: 'json' });

    if (!articleMeta) {
      console.log('[FFX Article] Not found in KV:', slug);
      return new Response(JSON.stringify({ error: 'Article not found' }), { status: 404, headers });
    }

    // 2. Read full body from video:{videoId}
    const videoId = articleMeta.videoId;
    let body = '';
    let fullContent = {};

    if (videoId) {
      const videoEntry = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });

      if (videoEntry) {
        // New structure — consumer Worker writes platforms.blog_global.content
        // Published structure — publish-confirm writes platforms.blog.content
        const blogContent =
          videoEntry?.platforms?.blog?.content ||
          videoEntry?.platforms?.blog_global?.content ||
          null;

        if (blogContent) {
          fullContent = blogContent;
          body = blogContent.body || '';
        }

        // Legacy fallback — old structure had content directly on videoEntry
        if (!body && videoEntry?.content) {
          fullContent = videoEntry.content;
          body = videoEntry.content.body || '';
        }
      }
    }

    // 3. Legacy fallback — video:slug:{slug}
    if (!body) {
      const slugEntry = await env.FFX_KV.get(`video:slug:${slug}`, { type: 'json' });
      if (slugEntry?.content) {
        fullContent = slugEntry.content;
        body = slugEntry.content.body || '';
      }
    }

    // 4. Build article object
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

    console.log('[FFX Article] Served slug:', slug, 'body length:', body.length);
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
