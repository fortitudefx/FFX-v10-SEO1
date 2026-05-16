// ─────────────────────────────────────────────────────────────────────────────
// FFX Generate Status Worker
// GET /generate-status?job=JOB_ID → polls KV for generation completion
// Returns { status: 'pending' } while generating
// Returns { status: 'complete', content } when done
// Returns { status: 'error', error } if generation failed
// Used by press.html to poll after triggering generation
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

    if (!job) {
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200, headers });
    }

    if (job.status === 'error') {
      return new Response(JSON.stringify({
        status: 'error',
        error: job.error || 'Generation failed',
      }), { status: 200, headers });
    }

    if (job.status === 'complete') {
      return new Response(JSON.stringify({
        status: 'complete',
        content: job.content,
        videoId: job.videoId,
        slug: job.slug,
      }), { status: 200, headers });
    }

    // Job exists but status unknown — still pending
    return new Response(JSON.stringify({ status: 'pending' }), { status: 200, headers });

  } catch (err) {
    console.log('[FFX Generate Status] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
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
