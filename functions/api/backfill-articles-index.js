// functions/api/backfill-articles-index.js
// POST /api/backfill-articles-index — one-time backfill of articles:index from all article:{slug} KV keys
// Safe to run multiple times — updates existing entries, adds missing ones
// Returns { added, updated, total, skipped }

export async function onRequestPost(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  try {
    // ── Read all article:{slug} keys ──────────────────────────────────────
    const list = await env.FFX_KV.list({ prefix: 'article:' });
    if (!list || !list.keys.length) {
      return json({ success: true, message: 'No article keys found in KV', added: 0, updated: 0, total: 0 }, 200, headers);
    }

    console.log('[backfill] Found', list.keys.length, 'article keys');

    // ── Read all article metadata ─────────────────────────────────────────
    const metas = (await Promise.all(
      list.keys.map(function(k){ return env.FFX_KV.get(k.name, { type: 'json' }).catch(function(){ return null; }); })
    )).filter(Boolean);

    // ── Read existing articles:index ──────────────────────────────────────
    const existingIndex = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(function(){ return null; });
    const index = Array.isArray(existingIndex) ? existingIndex : [];

    var added   = 0;
    var updated = 0;
    var skipped = 0;

    for (var i = 0; i < metas.length; i++) {
      var meta = metas[i];
      if (!meta.slug || !meta.title) { skipped++; continue; }

      // Verify article has a published body before indexing
      // Articles without body cannot receive title rewrites or internal links
      var hasBody = false;
      if (meta.videoId) {
        try {
          var pub = await env.FFX_KV.get('published:' + meta.videoId, { type: 'json' }).catch(function(){ return null; });
          // Read-only check — never write to published
          hasBody = !!(pub && pub.globalContent && pub.globalContent.body);
        } catch(pubErr) {
          console.error('[backfill] published check failed for ' + meta.slug + ' (non-fatal):', pubErr.message);
        }
      } else {
        // No videoId — served from articles.json via GitHub fallback
        // These are valid articles, mark as has body
        hasBody = true;
      }

      if (!hasBody) {
        console.log('[backfill] Skipping ' + meta.slug + ' — no published body found');
        skipped++;
        continue;
      }

      var entry = {
        slug:        meta.slug,
        title:       meta.title,
        excerpt:     meta.excerpt    || '',
        category:    meta.category   || 'Strategy',
        tags:        Array.isArray(meta.tags) ? meta.tags : (meta.tags ? meta.tags.split(',').map(function(t){ return t.trim(); }) : []),
        publishedAt: meta.createdAt  || meta.date || new Date().toISOString(),
        youtubeUrl:  meta.youtubeUrl || meta.yt_url || '',
        hasBody:     true,
      };

      var existingIdx = index.findIndex(function(a){ return a.slug === meta.slug; });
      if (existingIdx !== -1) {
        // Update existing — preserve any internalLinks already recorded
        var existing = index[existingIdx];
        entry.internalLinks = existing.internalLinks || [];
        index[existingIdx] = entry;
        updated++;
      } else {
        index.unshift(entry);
        added++;
      }
    }

    // Sort by publishedAt descending — newest first
    index.sort(function(a, b){ return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0); });

    await env.FFX_KV.put('articles:index', JSON.stringify(index));
    console.log('[backfill] articles:index written — added:', added, 'updated:', updated, 'total:', index.length);

    return json({
      success: true, added, updated, skipped,
      total:   index.length,
      message: 'articles:index backfilled. ' + added + ' added, ' + updated + ' updated, ' + skipped + ' skipped.',
    }, 200, headers);

  } catch(err) {
    console.error('[backfill] Error:', err.message);
    return json({ error: err.message }, 500, headers);
  }
}

export async function onRequestGet(context) {
  // GET returns current articles:index stats without modifying anything
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const index = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(function(){ return null; });
    return new Response(JSON.stringify({
      exists: !!index,
      count:  Array.isArray(index) ? index.length : 0,
      slugs:  Array.isArray(index) ? index.map(function(a){ return a.slug; }) : [],
    }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
