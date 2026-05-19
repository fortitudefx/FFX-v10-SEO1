// ─────────────────────────────────────────────────────────────────────────────
// FFX Fix Dates — ONE TIME USE ONLY
// GET /fix-dates → reads original dates from video:* and updates published:*
// DELETE THIS FILE IMMEDIATELY AFTER RUNNING
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV binding not found' }), { status: 500, headers });
  }

  const report = { fixed: [], skipped: [], errors: [] };

  try {
    // List all video:* keys — still exist with 24hr TTL, run this now
    const allKeys = [];
    let cursor = undefined;
    let done = false;
    while (!done) {
      const result = await env.FFX_KV.list({ prefix: 'video:', cursor, limit: 1000 });
      allKeys.push(...result.keys);
      if (result.list_complete) { done = true; } else { cursor = result.cursor; }
    }

    for (const key of allKeys) {
      try {
        const videoEntry = await env.FFX_KV.get(key.name, { type: 'json' });
        if (!videoEntry) { report.skipped.push({ key: key.name, reason: 'Empty' }); continue; }

        // Get original date from video entry
        const originalDate = videoEntry.generatedAt || videoEntry.createdAt || null;
        if (!originalDate) { report.skipped.push({ key: key.name, reason: 'No original date' }); continue; }

        // Find corresponding published:* key
        const videoId = videoEntry.videoId;
        const slug    = videoEntry.slug;
        const isSlugKey = key.name.startsWith('video:slug:');

        let publishedKey = null;
        if (!isSlugKey && videoId) {
          publishedKey = `published:${videoId}`;
        } else if (slug) {
          publishedKey = `published:slug:${slug}`;
        }

        if (!publishedKey) { report.skipped.push({ key: key.name, reason: 'Cannot determine published key' }); continue; }

        // Read published entry
        const publishedEntry = await env.FFX_KV.get(publishedKey, { type: 'json' });
        if (!publishedEntry) { report.skipped.push({ key: key.name, reason: `published key not found: ${publishedKey}` }); continue; }

        // Update updatedAt with original date — preserve everything else
        // Also update platform publishedAt dates where they exist
        const updatedEntry = {
          ...publishedEntry,
          updatedAt: originalDate,
        };

        // Update platform publishedAt dates if they were set to today
        if (updatedEntry.platforms) {
          Object.keys(updatedEntry.platforms).forEach(p => {
            if (updatedEntry.platforms[p]?.publishedAt) {
              updatedEntry.platforms[p].publishedAt = originalDate;
            }
          });
        }

        // Write back — permanent, no TTL
        await env.FFX_KV.put(publishedKey, JSON.stringify(updatedEntry));

        report.fixed.push({
          key: key.name,
          publishedKey,
          originalDate,
          title: publishedEntry.title || '',
        });

        console.log('[FFX Fix Dates]', key.name, '→', publishedKey, 'date:', originalDate);

      } catch (err) {
        report.errors.push({ key: key.name, error: err.message });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      summary: { fixed: report.fixed.length, skipped: report.skipped.length, errors: report.errors.length },
      fixed:   report.fixed,
      skipped: report.skipped,
      errors:  report.errors,
      next: 'Delete functions/fix-dates.js from repo immediately.',
    }, null, 2), { status: 200, headers });

  } catch (err) {
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
