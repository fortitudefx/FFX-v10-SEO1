// functions/api/title-test.js
// POST /api/title-test — applies a title change AND records test for outcome tracking
// GET  /api/title-test?slug=X — returns title test record for a slug
// GET  /api/title-test — returns all title tests

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const { slug, oldTitle, newTitle, directiveDate,
          positionAtChange, ctrAtChange, clicksAtChange, impressionsAtChange } = body;

  if (!slug || !newTitle) {
    return json({ error: 'slug and newTitle are required' }, 400, headers);
  }

  try {
    // ── Step 1: Read current article:{slug} from KV ───────────────────────
    const articleMeta = await env.FFX_KV.get('article:' + slug, { type: 'json' }).catch(function(){ return null; });
    if (!articleMeta) {
      return json({ error: 'Article not found in KV for slug: ' + slug, step: 'lookup' }, 404, headers);
    }

    const resolvedOldTitle = oldTitle || articleMeta.title || '';

    // ── Step 2: Update article:{slug} with new title ──────────────────────
    articleMeta.title     = newTitle;
    articleMeta.updatedAt = new Date().toISOString();
    await env.FFX_KV.put('article:' + slug, JSON.stringify(articleMeta));
    console.log('[title-test] article:' + slug + ' title updated:', resolvedOldTitle, '->', newTitle);

    // ── Step 3: Update articles:index entry ───────────────────────────────
    try {
      const indexRaw = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(function(){ return null; });
      if (Array.isArray(indexRaw)) {
        var idx = indexRaw.findIndex(function(a){ return a.slug === slug; });
        if (idx !== -1) {
          indexRaw[idx].title = newTitle;
          await env.FFX_KV.put('articles:index', JSON.stringify(indexRaw));
          console.log('[title-test] articles:index updated for slug:', slug);
        }
      }
    } catch(idxErr) {
      console.error('[title-test] articles:index update failed (non-fatal):', idxErr.message);
    }

    // ── Step 4: Update published:{videoId} globalContent.title ───────────
    try {
      const videoId = articleMeta.videoId;
      if (videoId) {
        const published = await env.FFX_KV.get('published:' + videoId, { type: 'json' }).catch(function(){ return null; });
        if (published && published.globalContent) {
          published.globalContent.title = newTitle;
          await env.FFX_KV.put('published:' + videoId, JSON.stringify(published));
          console.log('[title-test] published:' + videoId + ' title updated');
        }
      }
    } catch(pubErr) {
      console.error('[title-test] published record update failed (non-fatal):', pubErr.message);
    }

    // ── Step 5: Write seo:title_tests:{slug} for outcome tracking ─────────
    const testRecord = {
      slug,
      oldTitle:            resolvedOldTitle,
      newTitle,
      changedAt:           new Date().toISOString(),
      positionAtChange:    positionAtChange    || null,
      ctrAtChange:         ctrAtChange         || 0,
      clicksAtChange:      clicksAtChange      || 0,
      impressionsAtChange: impressionsAtChange || 0,
      status:              'monitoring',
      result:              null,
      positionAfter:       null,
      ctrAfter:            null,
      clicksAfter:         null,
      impressionsAfter:    null,
      improvement:         null,
      completedAt:         null,
      briefLogId:          directiveDate ? (directiveDate + '_title_0') : null,
    };
    await env.FFX_KV.put('seo:title_tests:' + slug, JSON.stringify(testRecord));
    console.log('[title-test] Test record written for slug:', slug);

    // ── Step 6: Record directive outcome for feedback loop ─────────────────
    try {
      const today = (directiveDate || new Date().toISOString().split('T')[0]);
      await env.FFX_KV.put(
        'intelligence:directive_outcome:' + today + ':title_rewrite',
        JSON.stringify({
          directiveType: 'title_rewrite',
          actedOn:       true,
          actedOnAt:     new Date().toISOString(),
          slug, oldTitle: resolvedOldTitle, newTitle,
          outcome:   null, // populated after 14 days by SEO signals
          accurate:  null,
        })
      );
    } catch(outcomeErr) {
      console.error('[title-test] Directive outcome write failed (non-fatal):', outcomeErr.message);
    }

    return json({
      success:   true, slug, newTitle,
      updatedAt: new Date().toISOString(),
      message:   'Title updated across all KV records. Monitoring CTR for 14 days.',
    }, 200, headers);

  } catch(err) {
    console.error('[title-test] Error:', err.message);
    return json({ error: err.message, step: 'unknown' }, 500, headers);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    const slug = new URL(request.url).searchParams.get('slug');
    if (!slug) {
      const list    = await env.FFX_KV.list({ prefix: 'seo:title_tests:' });
      const records = await Promise.all(
        list.keys.map(function(k){ return env.FFX_KV.get(k.name, { type: 'json' }).catch(function(){ return null; }); })
      );
      return new Response(JSON.stringify({ tests: records.filter(Boolean) }), { status: 200, headers });
    }
    const record = await env.FFX_KV.get('seo:title_tests:' + slug, { type: 'json' }).catch(function(){ return null; });
    return new Response(JSON.stringify({ test: record }), { status: 200, headers });
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
