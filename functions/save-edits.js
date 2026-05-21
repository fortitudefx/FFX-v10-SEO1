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
  // kvType: 'video' (24hr staging) or 'published' (permanent)
  // field: 'body' | 'linkedin' | 'discord' | 'tumblr' | 'mediumIntro' | 'tweet1'..'tweet6'

  if (!field || value === undefined) return json({ error: 'Missing field or value.' }, 400);
  if (!kvType || !['video', 'published'].includes(kvType)) return json({ error: 'Invalid kvType.' }, 400);

  // Resolve KV key
  let kvKey;
  if (kvType === 'video') {
    if (!videoId) return json({ error: 'videoId required for video kvType.' }, 400);
    kvKey = `video:${videoId}`;
  } else {
    if (!videoId && !slug) return json({ error: 'videoId or slug required for published kvType.' }, 400);
    kvKey = videoId ? `published:${videoId}` : `published:slug:${slug}`;
  }

  // Read existing record
  const raw = await KV.get(kvKey, { type: 'text' }).catch(() => null);
  if (!raw) return json({ error: `KV record not found: ${kvKey}` }, 404);

  let record;
  try { record = JSON.parse(raw); }
  catch { return json({ error: 'KV record is malformed JSON.' }, 500); }

  // Resolve which content object to update
  // video:{videoId} stores: { platforms: { blog_global, blog_regional, x, linkedin, discord, tumblr } }
  // published:{videoId} stores: { globalContent: { body, linkedin, discord, tumblr, tweet1..6 } }
  const isTweet = /^tweet[1-6]$/.test(field);

  if (kvType === 'video') {
    // Staging record — content lives in platforms.blog_global for article,
    // and top-level for social fields
    if (field === 'body') {
      if (!record.platforms) record.platforms = {};
      if (!record.platforms.blog_global) record.platforms.blog_global = {};
      record.platforms.blog_global.body = value;
    } else if (isTweet) {
      if (!record.platforms) record.platforms = {};
      if (!record.platforms.x) record.platforms.x = {};
      record.platforms.x[field] = value;
    } else {
      // linkedin, discord, tumblr, mediumIntro
      if (!record.platforms) record.platforms = {};
      if (!record.platforms[field]) record.platforms[field] = {};
      record.platforms[field][field] = value;
    }
  } else {
    // Published record — content lives in globalContent
    if (!record.globalContent) record.globalContent = {};
    if (field === 'body') {
      record.globalContent.body = value;
    } else if (isTweet) {
      record.globalContent[field] = value;
    } else {
      record.globalContent[field] = value;
    }
    record.updatedAt = new Date().toISOString();
  }

  // Write back — preserve TTL for video keys (24hr = 86400s)
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
