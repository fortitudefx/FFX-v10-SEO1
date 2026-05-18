// ─────────────────────────────────────────────────────────────────────────────
// FFX Generate Status
// GET /generate-status?job=JOB_ID → polls KV for generation completion
// When complete: reads video:{videoId} from KV and returns both articles
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV binding not found' }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const jobId = url.searchParams.get('job');

  if (!jobId) {
    return new Response(JSON.stringify({ error: 'job parameter required' }), { status: 400, headers });
  }

  try {
    const job = await env.FFX_KV.get(`job:${jobId}`, { type: 'json' });

    // Job not found yet — still pending
    if (!job) {
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200, headers });
    }

    // Job failed — return step and reason for browser error display
    if (job.status === 'error') {
      return new Response(JSON.stringify({
        status: 'error',
        step: job.step || 'unknown',
        reason: job.reason || 'Unknown error',
      }), { status: 200, headers });
    }

    // Job still processing — return step so browser can update progress indicators
    if (job.status === 'processing') {
      return new Response(JSON.stringify({
        status: 'processing',
        step: job.step || 'transcript',
      }), { status: 200, headers });
    }

    // Job complete — read full content from video:{videoId}
    if (job.status === 'complete') {
      const videoId = job.videoId;

      if (!videoId) {
        return new Response(JSON.stringify({
          status: 'error',
          step: 'unknown',
          reason: 'Job complete but videoId missing',
        }), { status: 200, headers });
      }

      const videoRecord = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });

      if (!videoRecord) {
        return new Response(JSON.stringify({
          status: 'error',
          step: 'kv_read',
          reason: 'Content expired or was not written. Please regenerate.',
        }), { status: 200, headers });
      }

      // Build articles array from video record
      const globalArticle = videoRecord.platforms?.blog_global?.content;
      const regionalArticle = videoRecord.platforms?.blog_regional?.content;

      if (!globalArticle) {
        return new Response(JSON.stringify({
          status: 'error',
          step: 'kv_read',
          reason: 'Global article missing from video record.',
        }), { status: 200, headers });
      }

      // Add region labels for tab display
      globalArticle.region = 'Global';
      globalArticle.regionLabel = 'Global';

      const articles = [globalArticle];

      if (regionalArticle) {
        regionalArticle.region = videoRecord.region || 'Regional';
        regionalArticle.regionLabel = videoRecord.region || 'Regional';
        articles.push(regionalArticle);
      }

      return new Response(JSON.stringify({
        status: 'complete',
        videoId,
        articles,
        generatedAt: videoRecord.generatedAt,
      }), { status: 200, headers });
    }

    // Unknown status — treat as pending
    return new Response(JSON.stringify({ status: 'pending' }), { status: 200, headers });

  } catch (err) {
    console.error('[FFX Generate Status] Error:', err.message);
    return new Response(JSON.stringify({
      status: 'error',
      step: 'unknown',
      reason: err.message,
    }), { status: 200, headers });
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
