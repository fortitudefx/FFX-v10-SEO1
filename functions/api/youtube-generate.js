// functions/api/youtube-generate.js
// POST /api/youtube-generate — queue producer for new unlisted YouTube videos
//   Phase 1: pushes to ffx_generate_queue (same as /generate) → consumer Worker
//            runs transcript fetch, article, platforms, library, KV writes
//   Phase 2: after Phase 1 complete, calls /api/youtube-metadata internally
//            to generate SEO package from the now-stored transcript
//
// GET /api/youtube-generate?videoId=xxx
//   Returns combined status: phase1 job status + phase2 SEO package status
//   Dashboard polls this every 3s during generation
//
// KV keys read:
//   lock:generating          — prevent duplicate jobs
//   job:{jobId}              — phase 1 status written by consumer Worker
//   video:{videoId}          — phase 1 complete flag
//   youtube:metadata:{videoId} — phase 2 complete flag
//
// KV keys written:
//   job:{jobId}              — pending job (written here, updated by consumer)
//   youtube:yt:jobId:{videoId} — maps videoId to jobId for status polling

var CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: CORS });
}

function extractVideoId(url) {
  try {
    var u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) {
      var v = u.searchParams.get('v');
      if (v) return v;
      var parts = u.pathname.split('/');
      var si = parts.indexOf('shorts');
      if (si !== -1) return parts[si + 1];
    }
  } catch(e) {}
  return null;
}

// ── GET — poll combined phase 1 + phase 2 status ─────────────────────────
export async function onRequestGet(context) {
  var env = context.env;
  var url = new URL(context.request.url);
  var videoId = url.searchParams.get('videoId');

  if (!videoId) return json({ error: 'videoId required' }, 400);

  try {
    // Read jobId for this videoId
    var jobId = await env.FFX_KV.get('youtube:yt:jobId:' + videoId).catch(function() { return null; });

    // ── Phase 1 complete check — only based on video:{videoId} existing ──
    // SEO package (youtube:metadata) is NEVER used to determine phase — it always regenerates
    var videoRecord = await env.FFX_KV.get('video:' + videoId, { type: 'json' }).catch(function() { return null; });
    if (videoRecord && videoRecord.slug && videoRecord.platforms) {
      // Phase 1 is fully done — article + platforms + library all in KV
      // Dashboard should skip Phase 1 and go straight to Phase 2 (SEO regenerates fresh)
      return json({
        phase1Complete: true,
        phase: 'phase2_ready',
        status: 'phase1_complete',
        videoId: videoId,
        jobId: jobId || null,
        videoTitle: videoRecord.title || null,
        articleSlug: videoRecord.slug || null,
      });
    }

    // Phase 1 check — no jobId yet, nothing in KV
    if (!jobId) {
      return json({ phase: 'idle', status: 'idle', videoId: videoId, phase1Complete: false });
    }

    // Read job record for in-progress job
    var job = await env.FFX_KV.get('job:' + jobId, { type: 'json' }).catch(function() { return null; });

    if (!job) {
      return json({ phase: 'phase1', status: 'pending', step: 'transcript', jobId: jobId, videoId: videoId, phase1Complete: false });
    }

    if (job.status === 'error') {
      return json({
        phase: 'phase1',
        status: 'error',
        step: job.step || 'unknown',
        reason: job.reason || 'Generation failed',
        jobId: jobId,
        videoId: videoId,
        phase1Complete: false,
      });
    }

    if (job.status === 'complete') {
      // Job just completed — video: may not be written yet, re-check
      var freshVideo = await env.FFX_KV.get('video:' + videoId, { type: 'json' }).catch(function() { return null; });
      if (freshVideo && freshVideo.slug) {
        return json({
          phase1Complete: true,
          phase: 'phase2_ready',
          status: 'phase1_complete',
          videoId: videoId,
          jobId: jobId,
          videoTitle: freshVideo.title || null,
        });
      }
      // Job complete but video: not written yet — treat as phase2
      return json({
        phase: 'phase2',
        status: 'processing',
        step: 'reading_signals',
        jobId: jobId,
        videoId: videoId,
        phase1Complete: true,
      });
    }

    // Phase 1 still processing
    return json({
      phase: 'phase1',
      status: 'processing',
      step: job.step || 'transcript',
      jobId: jobId,
      videoId: videoId,
      phase1Complete: false,
    });

  } catch(err) {
    return json({ error: err.message }, 500);
  }
}

// ── POST — trigger full generation pipeline ───────────────────────────────
export async function onRequestPost(context) {
  var env     = context.env;
  var request = context.request;

  var body;
  try { body = await request.json(); } catch(e) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  var youtubeUrl = body.youtubeUrl || '';
  if (!youtubeUrl) return json({ error: 'youtubeUrl required' }, 400);

  var videoId = extractVideoId(youtubeUrl);
  if (!videoId) return json({ error: 'Could not extract YouTube video ID from URL' }, 400);

  if (!env.ffx_generate_queue) return json({ error: 'Queue binding ffx_generate_queue not found' }, 500);
  if (!env.FFX_KV) return json({ error: 'FFX_KV binding not found' }, 500);

  // Check lock — prevent duplicate jobs
  try {
    var lock = await env.FFX_KV.get('lock:generating');
    if (lock) {
      var lockData = JSON.parse(lock);
      if (lockData.videoId === videoId) {
        // Same video already generating — return existing jobId so dashboard can poll
        return json({
          success: true,
          queued: false,
          jobId: lockData.jobId,
          videoId: videoId,
          message: 'Generation already in progress for this video',
        });
      }
      return json({
        error: 'Another video is currently generating. Wait a few minutes and try again.',
      }, 429);
    }
  } catch(e) {}

  // Create jobId
  var jobId = Date.now() + '-' + videoId;

  // Write pending job to KV
  try {
    await env.FFX_KV.put(
      'job:' + jobId,
      JSON.stringify({ status: 'pending', videoId: videoId, createdAt: new Date().toISOString() }),
      { expirationTtl: 86400 }
    );
  } catch(err) {
    return json({ error: 'Failed to create job record: ' + err.message }, 500);
  }

  // Map videoId → jobId so GET can poll without needing jobId from client
  try {
    await env.FFX_KV.put('youtube:yt:jobId:' + videoId, jobId, { expirationTtl: 86400 });
  } catch(err) {
    console.error('[youtube-generate] jobId map write failed (non-fatal):', err.message);
  }

  // Push to queue — consumer Worker handles everything
  try {
    await env.ffx_generate_queue.send({
      jobId:        jobId,
      videoId:      videoId,
      youtubeUrl:   youtubeUrl,
      existingSlug: null,
    });
    console.log('[youtube-generate] Job queued:', jobId, 'videoId:', videoId);
  } catch(err) {
    try { await env.FFX_KV.delete('job:' + jobId); } catch(e) {}
    try { await env.FFX_KV.delete('youtube:yt:jobId:' + videoId); } catch(e) {}
    return json({ error: 'Failed to queue job: ' + err.message }, 500);
  }

  return json({
    success: true,
    queued:  true,
    jobId:   jobId,
    videoId: videoId,
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
