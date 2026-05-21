// Cloudflare Pages Function
// File: /functions/save-edits.js
// Saves inline edits back to KV — video:{videoId} (staging) or published:{videoId} (permanent)

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
    // Published record
    if (!record.globalContent) record.globalContent = {};

    if (field === 'body') {
      record.globalContent.body = value;
    } else if (isTweet) {
      record.globalContent[field] = value;
      const tweetIndex = parseInt(field.replace('tweet', '')) - 1;
      if (Array.isArray(record.globalContent.x_thread)) {
        record.globalContent.x_thread[tweetIndex] = value;
      }
    } else {
      record.globalContent[field] = value;
    }

    record.updatedAt = new Date().toISOString();

    // Track edited fields — so Press can show orange "Edited — republish" chip
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
