// functions/api/article-link.js
// POST /api/article-link — inserts an internal link into a published article body
// Reads published:{videoId} from KV, finds articleMeta to get videoId from slug,
// inserts link into body HTML, writes back to published:{videoId}
// Records outcome in intelligence:directive_outcome

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
    // ── Step 1: Find videoId for sourceSlug via article:{slug} KV ────────
    const articleMeta = await env.FFX_KV.get('article:' + sourceSlug, { type: 'json' }).catch(function(){ return null; });
    if (!articleMeta) {
      return json({ error: 'Source article not found in KV for slug: ' + sourceSlug, step: 'lookup' }, 404, headers);
    }

    const videoId = articleMeta.videoId;
    if (!videoId) {
      return json({ error: 'Source article has no videoId — cannot locate published body', step: 'lookup' }, 400, headers);
    }

    // ── Step 2: Read published:{videoId} ─────────────────────────────────
    const publishedEntry = await env.FFX_KV.get('published:' + videoId, { type: 'json' }).catch(function(){ return null; });
    if (!publishedEntry || !publishedEntry.globalContent || !publishedEntry.globalContent.body) {
      return json({ error: 'Published body not found for videoId: ' + videoId, step: 'read_body' }, 404, headers);
    }

    // ── Step 3: Insert internal link into body ────────────────────────────
    // Strategy: find the last </p> tag and insert a natural link sentence before it
    // This is the safest insertion — avoids breaking existing HTML structure
    const originalBody = publishedEntry.globalContent.body;
    const linkHtml = ' For further reading, see <a href="' + targetUrl + '">' + targetTitle + '</a>.';

    // Find a good paragraph to insert into — look for </p> that isn't the last one
    // and isn't inside the CTA section (which contains 'discord.gg/fortitudefx')
    var insertIdx = -1;
    var searchFrom = 0;
    var occurrences = [];

    // Find all </p> positions
    while (true) {
      var idx = originalBody.indexOf('</p>', searchFrom);
      if (idx === -1) break;
      occurrences.push(idx);
      searchFrom = idx + 4;
    }

    // Use the second-to-last </p> that is not in the CTA block
    // CTA is usually the last paragraph containing 'discord.gg'
    var ctaStart = originalBody.indexOf('discord.gg/fortitudefx');
    var candidates = occurrences.filter(function(idx) {
      // Skip if inside or after the CTA section
      return ctaStart === -1 || idx < ctaStart;
    });

    if (candidates.length >= 2) {
      // Insert after second-to-last candidate paragraph
      insertIdx = candidates[candidates.length - 2] + 4; // after </p>
    } else if (candidates.length === 1) {
      insertIdx = candidates[0] + 4;
    } else if (occurrences.length > 0) {
      // Fallback: second-to-last </p> anywhere
      insertIdx = occurrences[Math.max(0, occurrences.length - 2)] + 4;
    }

    if (insertIdx === -1) {
      return json({ error: 'Could not find a safe insertion point in article body', step: 'insert' }, 422, headers);
    }

    // Check if link already exists — avoid duplicates
    if (originalBody.includes(targetUrl)) {
      return json({
        success: true, skipped: true,
        message: 'Link to ' + targetUrl + ' already exists in this article',
        slug: sourceSlug,
      }, 200, headers);
    }

    const newBody = originalBody.slice(0, insertIdx) + '<p>' + linkHtml + '</p>' + originalBody.slice(insertIdx);

    // ── Step 4: Write updated body back to published:{videoId} ───────────
    publishedEntry.globalContent.body = newBody;
    publishedEntry.linkInsertedAt     = new Date().toISOString();
    if (!publishedEntry.internalLinks) publishedEntry.internalLinks = [];
    publishedEntry.internalLinks.push({
      targetSlug, targetTitle, targetUrl,
      insertedAt: new Date().toISOString(),
    });

    await env.FFX_KV.put('published:' + videoId, JSON.stringify(publishedEntry));
    console.log('[article-link] Link inserted:', sourceSlug, '->', targetSlug);

    // ── Step 5: Update articles:index entry for sourceSlug ───────────────
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
      const today = (directiveDate || new Date().toISOString().split('T')[0]);
      await env.FFX_KV.put(
        'intelligence:directive_outcome:' + today + ':retroactive_link',
        JSON.stringify({
          directiveType: 'retroactive_link',
          actedOn:       true,
          actedOnAt:     new Date().toISOString(),
          sourceSlug, targetSlug, targetTitle,
          outcome:   null, // populated by future signal analysis
          accurate:  null,
        })
      );
    } catch(outcomeErr) {
      console.error('[article-link] Directive outcome write failed (non-fatal):', outcomeErr.message);
    }

    return json({
      success:     true,
      sourceSlug,
      targetSlug,
      insertedAt:  new Date().toISOString(),
      message:     'Link to "' + targetTitle + '" inserted into "' + (articleMeta.title || sourceSlug) + '"',
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
