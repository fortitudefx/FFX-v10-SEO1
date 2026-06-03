// ─────────────────────────────────────────────────────────────────────────────
// FFX Indexing Engine — Pages Function (READ-ONLY KV)
// GET  /api/indexing-engine           → return latest indexing:status
// GET  /api/indexing-engine?history=1 → return indexing:history records
// GET  /api/indexing-engine?progress=1 → return current scan progress
// POST /api/indexing-engine           → trigger scan in cron Worker, await result
//
// All scan logic runs in ffx-cron Worker (Paid plan, no CPU limits for HTTP)
// Pages Function never runs crypto or external API calls — zero CPU risk
// ─────────────────────────────────────────────────────────────────────────────

var STATUS_KEY   = 'indexing:status';
var PROGRESS_KEY = 'indexing:progress';
var CRON_WORKER  = 'https://ffx-cron.salmankhanfx.workers.dev';

var CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequestGet(context) {
  var env     = context.env;
  var request = context.request;
  var url     = new URL(request.url);

  try {
    if (url.searchParams.get('progress') === '1') {
      var progress = await env.FFX_KV.get(PROGRESS_KEY, { type: 'json' }).catch(function() { return null; });
      return new Response(JSON.stringify({ progress: progress || null }), { status: 200, headers: CORS_HEADERS });
    }

    if (url.searchParams.get('history') === '1') {
      var list = await env.FFX_KV.list({ prefix: 'indexing:history:' }).catch(function() { return { keys: [] }; });
      var records = [];
      for (var i = 0; i < list.keys.length; i++) {
        var rec = await env.FFX_KV.get(list.keys[i].name, { type: 'json' }).catch(function() { return null; });
        if (rec) records.push(rec);
      }
      records.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
      return new Response(JSON.stringify({ history: records }), { status: 200, headers: CORS_HEADERS });
    }

    var status = await env.FFX_KV.get(STATUS_KEY, { type: 'json' }).catch(function() { return null; });
    return new Response(JSON.stringify({ status: status || null }), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestPost(context) {
  // Forward to cron Worker which runs on Paid plan — await full result
  try {
    var res = await fetch(CRON_WORKER + '/run-indexing', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); } catch(e) {
      return new Response(JSON.stringify({ error: 'Cron worker returned non-JSON: ' + text.substring(0, 200) }), { status: 500, headers: CORS_HEADERS });
    }
    if (data.error) {
      return new Response(JSON.stringify({ error: data.error }), { status: 500, headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
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
