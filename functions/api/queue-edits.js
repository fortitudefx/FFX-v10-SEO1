// ─────────────────────────────────────────────────────────────────────────────
// FFX Queue Edits
// GET  /api/queue-edits?videoId=X  — fetch pending edits for a queue item
// POST /api/queue-edits            — save a field edit for a queue item
//
// KV key: queue-edits:{videoId} — permanent, no TTL
// Written when editing content on a queue item before first publish
// Deleted by publish-confirm.js on successful publish
// Completely separate from published:{videoId} pendingEdits
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  const url     = new URL(request.url);
  const videoId = url.searchParams.get('videoId');
  if (!videoId) return json({ error: 'videoId is required' }, 400, headers);

  const record = await env.FFX_KV.get(`queue-edits:${videoId}`, { type: 'json' }).catch(() => null);
  return json({ success: true, videoId, edits: record?.edits || {}, editedFields: record?.editedFields || [] }, 200, headers);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const { videoId, field, value } = body;
  if (!videoId) return json({ error: 'videoId is required' }, 400, headers);
  if (!field || value === undefined) return json({ error: 'field and value are required' }, 400, headers);

  // Read existing queue-edits record or create fresh
  const existing = await env.FFX_KV.get(`queue-edits:${videoId}`, { type: 'json' }).catch(() => null);
  const record   = existing || { videoId, edits: {}, editedFields: [], createdAt: new Date().toISOString() };

  // Write the field edit
  record.edits[field] = value;
  record.updatedAt    = new Date().toISOString();

  // Keep x_thread in sync for tweet fields
  const isTweet = /^tweet[1-6]$/.test(field);
  if (isTweet) {
    const tweetIndex = parseInt(field.replace('tweet', '')) - 1;
    if (!Array.isArray(record.edits.x_thread)) record.edits.x_thread = [];
    record.edits.x_thread[tweetIndex] = value;
  }

  // Track edited fields
  if (!record.editedFields.includes(field)) record.editedFields.push(field);

  // Write permanently — no TTL
  await env.FFX_KV.put(`queue-edits:${videoId}`, JSON.stringify(record));
  console.log('[FFX] queue-edits written:', videoId, field);

  return json({ success: true, videoId, field }, 200, headers);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
