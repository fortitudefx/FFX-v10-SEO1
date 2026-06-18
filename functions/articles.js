// ─────────────────────────────────────────────────────────────────────────────
// FFX Articles Worker — v2
// GET /articles → returns all articles from KV for blog listing
// GET /articles?region=Global → filter by region
// GET /articles?category=Strategy → filter by category
// GET /articles?region=Global&category=Strategy → combined filter
//
// CHANGE FROM v1:
// v1 listed individual article:{slug} keys and fetched each one.
// Problem: older article:{slug} entries were written before title/excerpt/
// category/readTime fields were added to publish.js — causing undefined
// in the blog list even though clicking through to the article works fine.
//
// v2 reads articles:index as primary source. articles:index is always
// complete because:
//   - publish.js writes it on every publish
//   - title-test.js updates it on every title change
//
// Missing fields (date, readTime, region) are merged from article:{slug}
// in a single parallel batch — no sequential loop of 46+ individual reads.
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
    // ── Step 1: Read articles:index — single KV read, always complete ────
    const index = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(function() { return null; });

    if (!index || !Array.isArray(index) || index.length === 0) {
      console.log('[FFX Articles] articles:index empty or missing');
      return new Response(JSON.stringify({ success: true, count: 0, articles: [] }), { status: 200, headers });
    }

    console.log('[FFX Articles] articles:index has', index.length, 'entries');

    // ── Step 2: Batch-fetch article:{slug} for date/readTime/region ──────
    // These fields are not in articles:index but are needed for the blog list.
    // Fetch all in parallel — not sequential — so 46 articles = 1 round trip.
    const metaEntries = await Promise.all(
      index.map(function(item) {
        return env.FFX_KV.get('article:' + item.slug, { type: 'json' }).catch(function() { return null; });
      })
    );

    // ── Step 3: Merge index (authoritative for title/excerpt/category)
    //            with meta entry (for date/readTime/region) ────────────────
    const merged = index.map(function(item, i) {
      const meta = metaEntries[i] || {};
      return {
        slug:     item.slug     || '',
        title:    item.title    || meta.title    || '',
        excerpt:  item.excerpt  || meta.excerpt  || '',
        category: item.category || meta.category || 'Strategy',
        tags:     item.tags     || meta.tags     || [],
        date:     meta.date     || meta.createdAt || item.publishedAt || '',
        readTime: meta.readTime || '7 min read',
        region:   meta.region   || 'Global',
      };
    });

    // ── Step 4: Filter ───────────────────────────────────────────────────
    const filtered = merged.filter(function(a) {
      if (!a.slug || !a.title) return false; // skip any still-incomplete entries
      if (regionFilter   && a.region   !== regionFilter)   return false;
      if (categoryFilter && a.category !== categoryFilter) return false;
      return true;
    });

    // ── Step 5: Sort newest first ────────────────────────────────────────
    filtered.sort(function(a, b) {
      const dateA = new Date(a.date || 0).getTime();
      const dateB = new Date(b.date || 0).getTime();
      return dateB - dateA;
    });

    console.log('[FFX Articles] Returning', filtered.length, 'articles');

    return new Response(JSON.stringify({
      success: true,
      count:   filtered.length,
      articles: filtered,
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
