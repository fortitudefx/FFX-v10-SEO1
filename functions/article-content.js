// ─────────────────────────────────────────────────────────────────────────────
// FFX Article Content Worker
// GET /article-content?slug=SLUG → returns full article from KV
// Used by article.html to render individual articles
// All articles migrated to KV — no articles.json fallback needed
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

    // 2. Read full body from video:{videoId} content
    const videoId = articleMeta.videoId;
    let body = '';
    let fullContent = {};

    if (videoId) {
      const videoEntry = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });
      if (videoEntry?.content) {
        fullContent = videoEntry.content;
        body = videoEntry.content.body || '';
      }
    }

    // 3. Build article object matching the shape article.html expects
    const article = {
      slug: articleMeta.slug,
      title: articleMeta.title || fullContent.title || '',
      excerpt: articleMeta.excerpt || fullContent.excerpt || '',
      category: articleMeta.category || fullContent.category || 'Strategy',
      tags: Array.isArray(articleMeta.tags) ? articleMeta.tags : (fullContent.tags || []),
      readTime: articleMeta.readTime || fullContent.readTime || '5 min read',
      date: articleMeta.date || fullContent.date || '',
      body: body || fullContent.body || '',
      draft: articleMeta.draft || false,
    };

    console.log('[FFX Article] Served from KV:', slug);
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
