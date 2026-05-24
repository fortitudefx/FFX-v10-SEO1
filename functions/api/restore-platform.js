// ─────────────────────────────────────────────────────────────────────────────
// FFX Restore Platform
// POST /api/restore-platform
// Clears ALL staging for one platform — regen:{videoId}:{platform} deleted
// AND pendingEdits cleared for that platform in published:{videoId}
// AND editedFields updated
// Never touches globalContent — source of truth remains intact
// Never affects any other platform
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_FIELDS = {
  article:  ['body'],
  x:        ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6','x_thread'],
  linkedin: ['linkedin'],
  discord:  ['discord'],
  tumblr:   ['tumblr'],
};

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

  const { videoId, platform } = body;
  if (!videoId)  return json({ error: 'videoId is required' }, 400, headers);
  if (!platform) return json({ error: 'platform is required' }, 400, headers);
  if (!PLATFORM_FIELDS[platform]) {
    return json({ error: `Unknown platform: ${platform}. Valid: ${Object.keys(PLATFORM_FIELDS).join(', ')}` }, 400, headers);
  }

  // ── 1. Delete regen:{videoId}:{platform} staging key ─────────────────────
  try {
    await env.FFX_KV.delete(`regen:${videoId}:${platform}`);
    console.log('[FFX] regen key deleted:', videoId, platform);
  } catch (err) {
    console.error('[FFX] regen key delete failed (non-fatal):', err.message);
  }

  // ── 2. Clear pendingEdits + editedFields for this platform ────────────────
  const record = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' }).catch(() => null);
  if (!record) {
    return json({ error: `No published record found for videoId: ${videoId}` }, 404, headers);
  }

  const fieldsToRemove = PLATFORM_FIELDS[platform];

  if (record.pendingEdits) {
    fieldsToRemove.forEach(field => delete record.pendingEdits[field]);
  }

  if (Array.isArray(record.editedFields)) {
    record.editedFields = record.editedFields.filter(f => !fieldsToRemove.includes(f));
  }

  record.updatedAt = new Date().toISOString();
  await env.FFX_KV.put(`published:${videoId}`, JSON.stringify(record));
  console.log('[FFX] pendingEdits cleared for platform:', platform, 'videoId:', videoId);

  // ── 3. Return globalContent fields so UI snaps back to live content ───────
  const globalContent  = record.globalContent || {};
  const restoredFields = {};
  fieldsToRemove.forEach(field => {
    if (globalContent[field] !== undefined) {
      restoredFields[field] = globalContent[field];
    }
  });

  return json({ success: true, platform, restoredFields }, 200, headers);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
