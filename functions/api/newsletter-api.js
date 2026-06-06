// ─────────────────────────────────────────────────────────────────────────────
// FFX Newsletter API — Pages Function
// GET /api/newsletter              → returns newsletter:index (all issues)
// GET /api/newsletter?date=YYYY-MM-DD → returns specific issue
// GET /api/newsletter?progress=1   → returns generation progress
// Read-only. No writes. No side effects.
// ─────────────────────────────────────────────────────────────────────────────

var CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequestGet(context) {
  var env = context.env;
  try {
    var url    = new URL(context.request.url);
    var date   = url.searchParams.get('date');
    var prog   = url.searchParams.get('progress');

    // Progress polling — dashboard polls this during generation
    if (prog === '1') {
      var progress = await env.FFX_KV.get('newsletter:generate:progress', { type: 'json' }).catch(function() { return null; });
      return new Response(JSON.stringify({ progress: progress || null }), { status: 200, headers: CORS_HEADERS });
    }

    // Specific issue by date
    if (date) {
      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(JSON.stringify({ error: 'Invalid date format. Use YYYY-MM-DD.' }), { status: 400, headers: CORS_HEADERS });
      }
      var issue = await env.FFX_KV.get('newsletter:issue:' + date, { type: 'json' }).catch(function() { return null; });
      if (!issue) {
        return new Response(JSON.stringify({ error: 'Issue not found for date: ' + date }), { status: 404, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify({ issue: issue }), { status: 200, headers: CORS_HEADERS });
    }

    // Full index — all issues
    var index = await env.FFX_KV.get('newsletter:index', { type: 'json' }).catch(function() { return null; });
    if (!index) index = [];

    // Also return current draft status
    var draft = await env.FFX_KV.get('newsletter:draft', { type: 'json' }).catch(function() { return null; });
    var lastSent = await env.FFX_KV.get('newsletter:last_sent', { type: 'json' }).catch(function() { return null; });

    return new Response(JSON.stringify({
      issues:   Array.isArray(index) ? index : [],
      total:    Array.isArray(index) ? index.length : 0,
      hasDraft: !!draft,
      draftDate: draft ? draft.issueDate : null,
      lastSent: lastSent || null,
    }), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
