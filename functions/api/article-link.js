// functions/api/article-link.js
// POST /api/article-link — records an internal link for an article
// Writes to article:links:{slug} KV key ONLY
// article-content.js reads this key and appends links to body on the fly
// published:{videoId} is NEVER touched — it is permanent and immutable
//
// KV key: article:links:{slug}
// Structure: { slug, links: [{ targetSlug, targetTitle, targetUrl, insertedAt }], updatedAt }

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const { sourceSlug, targetSlug, targetTitle, targetUrl, directiveDate } = body;

  if (!sourceSlug || !targetSlug || !targetTitle || !targetUrl) {
    return json({ error: 'sourceSlug, targetSlug, targetTitle and targetUrl are required' }, 400, headers);
  }

  try {
    // ── Step 1: Verify source article exists and has a published body ─────
    const articleMeta = await env.FFX_KV.get('article:' + sourceSlug, { type: 'json' }).catch(function(){ return null; });
    if (!articleMeta) {
      return json({ error: 'Source article not found: ' + sourceSlug, step: 'verify_source' }, 404, headers);
    }

    // Check published body exists — only link from articles with real content
    const videoId = articleMeta.videoId;
    let hasBody = false;
    if (videoId) {
      const published = await env.FFX_KV.get('published:' + videoId, { type: 'json' }).catch(function(){ return null; });
      // Read-only check — never write to published
      hasBody = !!(published && published.globalContent && published.globalContent.body);
    }
    // Also accept articles served from articles.json (no videoId) — they have body via GitHub fallback
    if (!hasBody && !videoId) hasBody = true; // Will be served via GitHub fallback

    if (!hasBody && videoId) {
      return json({
        error: 'Source article has no published body. Cannot add internal link to an article without content.',
        step: 'verify_body', sourceSlug,
      }, 422, headers);
    }

    // ── Step 2: Read existing article:links:{sourceSlug} ─────────────────
    const existing = await env.FFX_KV.get('article:links:' + sourceSlug, { type: 'json' }).catch(function(){ return null; });
    const record = existing || { slug: sourceSlug, links: [], updatedAt: null };

    // ── Step 3: Check if link to this target already exists ──────────────
    const alreadyExists = record.links.some(function(l){ return l.targetSlug === targetSlug; });
    if (alreadyExists) {
      return json({
        success: true, skipped: true,
        message: 'Link from "' + sourceSlug + '" to "' + targetTitle + '" already exists.',
        sourceSlug, targetSlug,
      }, 200, headers);
    }

    // ── Step 4: Add link to record ────────────────────────────────────────
    record.links.push({
      targetSlug,
      targetTitle,
      targetUrl,
      insertedAt: new Date().toISOString(),
    });
    record.updatedAt = new Date().toISOString();

    await env.FFX_KV.put('article:links:' + sourceSlug, JSON.stringify(record));
    console.log('[article-link] Written article:links:' + sourceSlug + ' -> ' + targetSlug);

    // ── Step 5: Update articles:index entry with link record ──────────────
    try {
      const indexRaw = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(function(){ return null; });
      if (Array.isArray(indexRaw)) {
        var idx = indexRaw.findIndex(function(a){ return a.slug === sourceSlug; });
        if (idx !== -1) {
          if (!indexRaw[idx].internalLinks) indexRaw[idx].internalLinks = [];
          indexRaw[idx].internalLinks.push({ targetSlug, targetUrl, insertedAt: new Date().toISOString() });
          await env.FFX_KV.put('articles:index', JSON.stringify(indexRaw));
        }
      }
    } catch(idxErr) {
      console.error('[article-link] articles:index update failed (non-fatal):', idxErr.message);
    }

    // ── Step 6: Record directive outcome for feedback loop ────────────────
    try {
      const today = directiveDate || new Date().toISOString().split('T')[0];
      await env.FFX_KV.put(
        'intelligence:directive_outcome:' + today + ':retroactive_link',
        JSON.stringify({
          directiveType: 'retroactive_link', actedOn: true,
          actedOnAt: new Date().toISOString(),
          sourceSlug, targetSlug, targetTitle,
          outcome: null, accurate: null, date: today,
        })
      );
    } catch(outcomeErr) {
      console.error('[article-link] Directive outcome write failed (non-fatal):', outcomeErr.message);
    }

    return json({
      success: true, sourceSlug, targetSlug,
      insertedAt: new Date().toISOString(),
      message: 'Link to "' + targetTitle + '" added to "' + (articleMeta.title || sourceSlug) + '". '
        + 'Link will appear on next page load via article:links:' + sourceSlug + ' KV key.',
    }, 200, headers);

  } catch(err) {
    console.error('[article-link] Error:', err.message);
    return json({ error: err.message }, 500, headers);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
