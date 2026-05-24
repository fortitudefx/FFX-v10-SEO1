// Cloudflare Pages Function
// File: /functions/save-edits.js
// Saves inline edits back to KV — video:{videoId} (staging) or published:{videoId} (permanent)
// For published records: edits go to pendingEdits — never overwrites globalContent
// globalContent = source of truth = what is actually live on platforms
// pendingEdits = staged edits awaiting republish
// publish-confirm.js merges pendingEdits into globalContent on successful publish

export async function onRequestPost(context) {
  const KV = context.env.FFX_KV;
  if (!KV) return json({ error: 'KV not bound.' }, 500);

  let payload;
  try { payload = await context.request.json(); }
  catch { return json({ error: 'Invalid JSON.' }, 400); }

  const { videoId, slug, kvType, field, value } = payload;
  if (!field || value === undefined) return json({ error: 'Missing field or value.' }, 400);
  if (!kvType || !['video', 'published'].includes(kvType)) return json({ error: 'Invalid kvType.' }, 400);

  let kvKey;
  if (kvType === 'video') {
    if (!videoId) return json({ error: 'videoId required for video kvType.' }, 400);
    kvKey = `video:${videoId}`;
  } else {
    if (!videoId && !slug) return json({ error: 'videoId or slug required for published kvType.' }, 400);
    kvKey = videoId ? `published:${videoId}` : `published:slug:${slug}`;
  }

  const raw = await KV.get(kvKey, { type: 'text' }).catch(() => null);
  if (!raw) return json({ error: `KV record not found: ${kvKey}` }, 404);

  let record;
  try { record = JSON.parse(raw); }
  catch { return json({ error: 'KV record is malformed JSON.' }, 500); }

  const isTweet = /^tweet[1-6]$/.test(field);

  if (kvType === 'video') {
    // video: KV — staging record, write directly as before
    if (field === 'body') {
      if (!record.platforms) record.platforms = {};
      if (!record.platforms.blog_global) record.platforms.blog_global = {};
      record.platforms.blog_global.body = value;
    } else if (isTweet) {
      if (!record.platforms) record.platforms = {};
      if (!record.platforms.x) record.platforms.x = {};
      record.platforms.x[field] = value;
      const tweetIndex = parseInt(field.replace('tweet', '')) - 1;
      if (Array.isArray(record.platforms?.x_thread)) {
        record.platforms.x_thread[tweetIndex] = value;
      }
    } else {
      if (!record.platforms) record.platforms = {};
      if (!record.platforms[field]) record.platforms[field] = {};
      record.platforms[field][field] = value;
    }

  } else {
    // published: KV — write to pendingEdits ONLY
    // globalContent is never touched here — it stays as the source of truth
    if (!record.pendingEdits) record.pendingEdits = {};
    record.pendingEdits[field] = value;

    // Keep x_thread in sync within pendingEdits
    if (isTweet) {
      const tweetIndex = parseInt(field.replace('tweet', '')) - 1;
      // Build x_thread from pendingEdits tweets, falling back to globalContent
      const gc = record.globalContent || {};
      const pe = record.pendingEdits;
      record.pendingEdits.x_thread = [1,2,3,4,5,6].map(i => {
        const key = `tweet${i}`;
        return pe[key] !== undefined ? pe[key] : (gc[key] || '');
      });
    }

    record.updatedAt = new Date().toISOString();

    // Track edited fields — press.html uses this to show orange "Edited — republish" chip
    // publish-confirm.js clears relevant fields from this array on successful publish
    if (!Array.isArray(record.editedFields)) record.editedFields = [];
    if (!record.editedFields.includes(field)) record.editedFields.push(field);
  }

  if (kvType === 'video') {
    await KV.put(kvKey, JSON.stringify(record), { expirationTtl: 86400 });
  } else {
    await KV.put(kvKey, JSON.stringify(record));
  }

  return json({ success: true, kvKey, field });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
