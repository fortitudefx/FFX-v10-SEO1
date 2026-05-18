// ─────────────────────────────────────────────────────────────────────────────
// FFX Generate — Queue Producer
// POST /generate → writes job to KV → sends to queue → returns jobId immediately
// All Claude/Supadata logic lives in ffx-consumer Worker
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

  const { youtubeUrl, existingSlug } = body;
  if (!youtubeUrl) {
    return new Response(JSON.stringify({ error: 'youtubeUrl is required' }), { status: 400, headers });
  }

  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    return new Response(JSON.stringify({ error: 'Could not parse YouTube video ID from URL' }), { status: 400, headers });
  }

  console.log('[FFX] /generate queue producer — videoId:', videoId);

  // Check for existing generating lock — prevent duplicate jobs
  try {
    const lock = await env.FFX_KV.get('lock:generating');
    if (lock) {
      const lockData = JSON.parse(lock);
      // If lock is for same video return the existing jobId
      if (lockData.videoId === videoId) {
        return new Response(JSON.stringify({
          success: true,
          jobId: lockData.jobId,
          videoId,
          queued: false,
          message: 'Generation already in progress for this video'
        }), { status: 200, headers });
      }
      // Different video is generating — reject
      return new Response(JSON.stringify({
        error: 'Another video is currently being generated. Please wait a few minutes and try again.'
      }), { status: 429, headers });
    }
  } catch {}

  // Generate unique jobId
  const jobId = `${Date.now()}-${videoId}`;

  // Write pending job to KV — 24hr TTL
  try {
    await env.FFX_KV.put(
      `job:${jobId}`,
      JSON.stringify({ status: 'pending', videoId, createdAt: new Date().toISOString() }),
      { expirationTtl: 86400 }
    );
  } catch (err) {
    console.error('[FFX] KV job write failed:', err.message);
    return new Response(JSON.stringify({ error: 'Failed to create job. Try again.' }), { status: 500, headers });
  }

  // Send message to queue
  try {
    await env.ffx_generate_queue.send({
      jobId,
      videoId,
      youtubeUrl,
      existingSlug: existingSlug || null,
    });
    console.log('[FFX] Job queued:', jobId);
  } catch (err) {
    console.error('[FFX] Queue send failed:', err.message);
    // Clean up the pending job
    try { await env.FFX_KV.delete(`job:${jobId}`); } catch {}
    return new Response(JSON.stringify({ error: 'Failed to queue job. Try again.' }), { status: 500, headers });
  }

  return new Response(JSON.stringify({
    success: true,
    jobId,
    videoId,
    queued: true,
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
// EXTRACT VIDEO ID — carried forward exactly
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
