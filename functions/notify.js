// ─────────────────────────────────────────────────────────────────────────────
// FFX Notify
// POST /notify → triggers generation via queue only
// Email is sent by ffx-consumer after generation completes — NOT here
// Accepts: { youtubeUrl }
// Used by: notify.html (manual) and Cron (future)
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { youtubeUrl } = body;
  if (!youtubeUrl) {
    return new Response(JSON.stringify({ error: 'youtubeUrl is required' }), { status: 400, headers });
  }

  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    return new Response(JSON.stringify({ error: 'Could not parse YouTube video ID from URL' }), { status: 400, headers });
  }

  console.log('[FFX Notify] Received youtubeUrl:', youtubeUrl, 'videoId:', videoId);

  // Check for existing generating lock
  try {
    const lock = await env.FFX_KV.get('lock:generating');
    if (lock) {
      const lockData = JSON.parse(lock);
      if (lockData.videoId === videoId) {
        // Same video already generating — return success, consumer will send email on completion
        return new Response(JSON.stringify({
          success: true,
          message: 'Generation already in progress — email will arrive when content is ready'
        }), { status: 200, headers });
      }
      return new Response(JSON.stringify({
        error: 'Another video is currently being generated. Please wait a few minutes and try again.'
      }), { status: 429, headers });
    }
  } catch {}

  // Generate jobId
  const jobId = `${Date.now()}-${videoId}`;

  // Write pending job to KV — 24hr TTL
  try {
    await env.FFX_KV.put(
      `job:${jobId}`,
      JSON.stringify({ status: 'pending', videoId, createdAt: new Date().toISOString() }),
      { expirationTtl: 86400 }
    );
  } catch (err) {
    console.error('[FFX Notify] KV job write failed:', err.message);
    return new Response(JSON.stringify({ error: 'Failed to create job. Try again.' }), { status: 500, headers });
  }

  // Send to queue
  try {
    await env.ffx_generate_queue.send({
      jobId,
      videoId,
      youtubeUrl,
      existingSlug: null,
    });
    console.log('[FFX Notify] Job queued:', jobId, '— email will be sent by consumer on completion');
  } catch (err) {
    console.error('[FFX Notify] Queue send failed:', err.message);
    try { await env.FFX_KV.delete(`job:${jobId}`); } catch {}
    return new Response(JSON.stringify({ error: 'Failed to queue generation. Try again.' }), { status: 500, headers });
  }

  return new Response(JSON.stringify({
    success: true,
    message: 'Generation started — email will arrive when content is ready (2-3 minutes)'
  }), { status: 200, headers });
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

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT VIDEO ID
// ─────────────────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const parts = u.pathname.split('/');
      const si = parts.indexOf('shorts');
      if (si !== -1) return parts[si + 1];
    }
  } catch {}
  return null;
}
