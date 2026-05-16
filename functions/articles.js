// ─────────────────────────────────────────────────────────────────────────────
// FFX Articles Worker
// GET /articles → returns all articles from KV for blog listing
// GET /articles?region=Global → filter by region
// GET /articles?category=Strategy → filter by category
// GET /articles?region=Global&category=Strategy → combined filter
// Used by blog.html (new version)
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV binding not found' }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const regionFilter   = url.searchParams.get('region')   || null;
  const categoryFilter = url.searchParams.get('category') || null;

  try {
    // List all article: keys with pagination
    const allKeys = [];
    let cursor = undefined;
    let done = false;

    while (!done) {
      const result = await env.FFX_KV.list({ prefix: 'article:', cursor, limit: 1000 });
      allKeys.push(...result.keys);
      if (result.list_complete) {
        done = true;
      } else {
        cursor = result.cursor;
      }
    }

    console.log('[FFX Articles] Found', allKeys.length, 'article keys');

    // Fetch each article entry
    const articles = [];
    for (const key of allKeys) {
      try {
        const entry = await env.FFX_KV.get(key.name, { type: 'json' });
        if (!entry) continue;

        // Apply filters
        if (regionFilter && entry.region !== regionFilter) continue;
        if (categoryFilter && entry.category !== categoryFilter) continue;

        articles.push(entry);
      } catch (err) {
        console.log('[FFX Articles] Failed to fetch key:', key.name, err.message);
      }
    }

    // Sort newest first by date
    articles.sort((a, b) => {
      const dateA = new Date(a.date || a.createdAt || 0).getTime();
      const dateB = new Date(b.date || b.createdAt || 0).getTime();
      return dateB - dateA;
    });

    console.log('[FFX Articles] Returning', articles.length, 'articles');

    return new Response(JSON.stringify({
      success: true,
      count: articles.length,
      articles,
    }), { status: 200, headers });

  } catch (err) {
    console.log('[FFX Articles] Error:', err.message);
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
