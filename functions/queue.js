// ─────────────────────────────────────────────────────────────────────────────
// FFX Queue — manages the content production queue
// GET    /queue          → returns full queue with content status per item
// POST   /queue          → add a video to queue (manual)
// DELETE /queue          → remove a videoId from queue
// POST   /queue/reorder  → persist new order after drag-drop
// POST   /queue/topup    → called by cron — ensures queue stays at 10
//
// KV structure:
//   queue:index → [ {videoId, title, youtubeUrl, addedAt, addedBy}, ... ]
//   video:{videoId} → generated content (24hr TTL) — written by ffx-consumer
//   published:{videoId} → published content (permanent) — written by publish-confirm
//
// Queue item states (derived at read time, never stored):
//   grey   → in queue:index, no video: KV content
//   orange → in queue:index, video: KV content exists (hasContent: true)
//   red    → in queue:index, video: KV expired (hasContent: false, wasGenerated: true)
// ─────────────────────────────────────────────────────────────────────────────

const QUEUE_KEY    = 'queue:index';
const QUEUE_TARGET = 10;
const QUEUE_TOPUP_THRESHOLD = 3;

// ── Routing ───────────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;
  const method  = request.method.toUpperCase();
  const url     = new URL(request.url);
  const path    = url.pathname;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }});
  }

  if (!env.FFX_KV) return resp({ error: 'FFX_KV not bound' }, 500, headers);

  if (path.endsWith('/reorder') && method === 'POST') return handleReorder(request, env, headers);
  if (path.endsWith('/topup')   && method === 'POST') return handleTopup(request, env, headers);
  if (method === 'GET')    return handleGet(request, env, headers);
  if (method === 'POST')   return handleAdd(request, env, headers);
  if (method === 'DELETE') return handleRemove(request, env, headers);

  return resp({ error: 'Method not allowed' }, 405, headers);
}

// ── GET /queue ────────────────────────────────────────────────────────────────
// Returns queue items enriched with content state

async function handleGet(request, env, headers) {
  try {
    const queue = await getQueue(env);
    const now   = Date.now();

    // Enrich each item with content state
    const enriched = await Promise.all(queue.map(async item => {
      const videoEntry = await env.FFX_KV.get(`video:${item.videoId}`, { type: 'json' }).catch(() => null);
      const hasContent = !!videoEntry;

      // Calculate expiry if content exists
      let expiresAt   = null;
      let expiresInMs = null;
      if (hasContent && videoEntry.generatedAt) {
        const generatedMs = new Date(videoEntry.generatedAt).getTime();
        expiresAt   = new Date(generatedMs + 24 * 60 * 60 * 1000).toISOString();
        expiresInMs = generatedMs + 24 * 60 * 60 * 1000 - now;
      }

      // Determine state
      let state = 'grey';
if (hasContent) state = 'orange';
if (!hasContent && item.wasGenerated) {
  // Check if job is still active before showing red
  if (item.jobId) {
    const job = await env.FFX_KV.get(`job:${item.jobId}`, { type: 'json' }).catch(() => null);
    if (job && (job.status === 'pending' || job.status === 'processing')) {
      state = 'generating';
    } else {
      state = 'red';
    }
  } else {
    state = 'red';
  }
}

      return {
        ...item,
        hasContent,
        state,
        expiresAt,
        expiresInMs,
        // Include content summary if available
        title:      videoEntry?.title || item.title || '',
        youtubeUrl: videoEntry?.youtubeUrl || item.youtubeUrl || '',
      };
    }));

    return resp({ success: true, queue: enriched, count: enriched.length }, 200, headers);
  } catch (err) {
    return resp({ error: err.message }, 500, headers);
  }
}

// ── POST /queue ───────────────────────────────────────────────────────────────
// Add a video manually — goes to TOP of queue

async function handleAdd(request, env, headers) {
  let body;
  try { body = await request.json(); } catch { return resp({ error: 'Invalid JSON' }, 400, headers); }

  const { videoId, youtubeUrl, title } = body;
  if (!videoId && !youtubeUrl) return resp({ error: 'videoId or youtubeUrl required' }, 400, headers);

  const resolvedVideoId = videoId || extractVideoId(youtubeUrl);
  if (!resolvedVideoId) return resp({ error: 'Could not extract videoId from URL' }, 400, headers);

  const queue = await getQueue(env);

  // Deduplicate — don't add if already in queue
  if (queue.find(i => i.videoId === resolvedVideoId)) {
    return resp({ error: 'Video already in queue', videoId: resolvedVideoId }, 409, headers);
  }

  const item = {
    videoId:    resolvedVideoId,
    youtubeUrl: youtubeUrl || `https://www.youtube.com/watch?v=${resolvedVideoId}`,
    title:      title || '',
    addedAt:    new Date().toISOString(),
    addedBy:    'manual',
    wasGenerated: false,
  };

  // Manual adds go to TOP
  queue.unshift(item);
  await saveQueue(env, queue);

  return resp({ success: true, videoId: resolvedVideoId, position: 0, queueLength: queue.length }, 200, headers);
}

// ── DELETE /queue ─────────────────────────────────────────────────────────────
// Remove a videoId from queue

async function handleRemove(request, env, headers) {
  let body;
  try { body = await request.json(); } catch { return resp({ error: 'Invalid JSON' }, 400, headers); }

  const { videoId } = body;
  if (!videoId) return resp({ error: 'videoId required' }, 400, headers);

  const queue   = await getQueue(env);
  const updated = queue.filter(i => i.videoId !== videoId);

  if (updated.length === queue.length) {
    return resp({ error: 'videoId not found in queue' }, 404, headers);
  }

  await saveQueue(env, updated);
  return resp({ success: true, videoId, queueLength: updated.length }, 200, headers);
}

// ── POST /queue/reorder ───────────────────────────────────────────────────────
// Persists new order after drag-drop
// Receives: { order: ['videoId1', 'videoId2', ...] }

async function handleReorder(request, env, headers) {
  let body;
  try { body = await request.json(); } catch { return resp({ error: 'Invalid JSON' }, 400, headers); }

  const { order } = body;
  if (!Array.isArray(order)) return resp({ error: 'order must be an array of videoIds' }, 400, headers);

  const queue = await getQueue(env);

  // Rebuild queue in new order — preserve all item data, just reorder
  const queueMap  = Object.fromEntries(queue.map(i => [i.videoId, i]));
  const reordered = order.map(id => queueMap[id]).filter(Boolean);

  // Append any items that weren't in the order array (safety net)
  queue.forEach(item => {
    if (!order.includes(item.videoId)) reordered.push(item);
  });

  await saveQueue(env, reordered);
  return resp({ success: true, queueLength: reordered.length }, 200, headers);
}

// ── POST /queue/topup ─────────────────────────────────────────────────────────
// Called by cron — fetches back-catalogue videos and appends to bottom of queue
// Only adds videos not already in queue and not already published

async function handleTopup(request, env, headers) {
  if (!env.YOUTUBE_API_KEY) return resp({ error: 'YOUTUBE_API_KEY not configured' }, 500, headers);
  if (!env.YOUTUBE_CHANNEL_ID) return resp({ error: 'YOUTUBE_CHANNEL_ID not configured' }, 500, headers);

  try {
    const queue = await getQueue(env);

    if (queue.length >= QUEUE_TARGET) {
      return resp({ success: true, message: 'Queue already at target', queueLength: queue.length }, 200, headers);
    }

    const needed      = QUEUE_TARGET - queue.length;
    const queuedIds   = new Set(queue.map(i => i.videoId));

    // Fetch back-catalogue from YouTube — oldest first, unpublished
    const added = [];
    let pageToken = undefined;
    let attempts  = 0;

    while (added.length < needed && attempts < 10) {
      attempts++;
      const ytUrl = new URL('https://www.googleapis.com/youtube/v3/search');
      ytUrl.searchParams.set('part', 'snippet');
      ytUrl.searchParams.set('channelId', env.YOUTUBE_CHANNEL_ID);
      ytUrl.searchParams.set('order', 'date');
      ytUrl.searchParams.set('maxResults', '50');
      ytUrl.searchParams.set('type', 'video');
      ytUrl.searchParams.set('key', env.YOUTUBE_API_KEY);
      if (pageToken) ytUrl.searchParams.set('pageToken', pageToken);

      const ytRes  = await fetch(ytUrl.toString());
      if (!ytRes.ok) break;
      const ytData = await ytRes.json();

      for (const item of (ytData.items || [])) {
        if (added.length >= needed) break;
        const vid   = item.id?.videoId;
        const title = item.snippet?.title || '';
        if (!vid) continue;
        if (queuedIds.has(vid)) continue;

        // Skip if already published
        const published = await env.FFX_KV.get(`published:${vid}`, { type: 'json' }).catch(() => null);
        if (published) continue;

        const queueItem = {
          videoId:      vid,
          youtubeUrl:   `https://www.youtube.com/watch?v=${vid}`,
          title,
          addedAt:      new Date().toISOString(),
          addedBy:      'cron',
          wasGenerated: false,
        };
        queue.push(queueItem); // cron always appends to bottom
        queuedIds.add(vid);
        added.push(vid);
      }

      pageToken = ytData.nextPageToken;
      if (!pageToken) break;
    }

    if (added.length > 0) await saveQueue(env, queue);

    return resp({ success: true, added: added.length, queueLength: queue.length }, 200, headers);
  } catch (err) {
    return resp({ error: err.message }, 500, headers);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getQueue(env) {
  const raw = await env.FFX_KV.get(QUEUE_KEY, { type: 'json' }).catch(() => null);
  return Array.isArray(raw) ? raw : [];
}

async function saveQueue(env, queue) {
  await env.FFX_KV.put(QUEUE_KEY, JSON.stringify(queue));
}

function extractVideoId(url) {
  try {
    const u = new URL(url || '');
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const parts = u.pathname.split('/');
      const si    = parts.indexOf('shorts');
      if (si !== -1) return parts[si + 1];
    }
  } catch {}
  return null;
}

function resp(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
