// ─────────────────────────────────────────────────────────────────────────────
// FFX Newsletter Generate — Pages Function (Queue Producer)
// POST /api/newsletter-generate
//   Pushes newsletter job to queue — returns immediately (no timeout risk)
//   Consumer Worker processes all Claude calls asynchronously
//   Dashboard polls newsletter:generate:progress via GET /api/newsletter?progress=1
//
// GET /api/newsletter-generate
//   Returns current draft from KV
// ─────────────────────────────────────────────────────────────────────────────

var CORS_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
var DRAFT_KEY    = 'newsletter:draft';
var PROGRESS_KEY = 'newsletter:generate:progress';

export async function onRequestGet(context) {
  var env = context.env;
  try {
    var draft = await env.FFX_KV.get(DRAFT_KEY, { type: 'json' }).catch(function() { return null; });
    return new Response(JSON.stringify({ draft: draft || null }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestPost(context) {
  var env = context.env;
  try {
    var body = await context.request.json().catch(function() { return {}; });
    var setupNote     = body.setupNote     || '';
    var setupImageUrl = body.setupImageUrl || '';

    if (!env.ffx_generate_queue) {
      return new Response(JSON.stringify({ error: 'Queue binding ffx_generate_queue not found' }), { status: 500, headers: CORS_HEADERS });
    }
    if (!env.FFX_KV) {
      return new Response(JSON.stringify({ error: 'FFX_KV binding not found' }), { status: 500, headers: CORS_HEADERS });
    }

    // Get current issue number
    var lastSent    = await env.FFX_KV.get('newsletter:last_sent', { type: 'json' }).catch(function() { return null; });
    var issueNumber = lastSent ? (lastSent.issueNumber + 1) : 1;
    var issueDate   = new Date().toISOString().split('T')[0];

    // Clear old draft so dashboard poll does not find stale data
    try { await env.FFX_KV.delete('newsletter:draft'); } catch(e) {}

    // Write initial progress so dashboard shows immediately
    await env.FFX_KV.put(PROGRESS_KEY, JSON.stringify({
      step: 1, total: 8, label: 'Job queued — starting generation',
      updatedAt: new Date().toISOString()
    }), { expirationTtl: 600 });

    // Push to queue — consumer Worker handles all Claude calls
    await env.ffx_generate_queue.send({
      type:         'newsletter',
      issueNumber:  issueNumber,
      issueDate:    issueDate,
      setupNote:    setupNote,
      setupImageUrl: setupImageUrl,
    });

    return new Response(JSON.stringify({
      success:     true,
      queued:      true,
      issueNumber: issueNumber,
      issueDate:   issueDate,
      message:     'Newsletter generation queued. Poll progress at /api/newsletter?progress=1',
    }), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
