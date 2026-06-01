// functions/api/directive-history.js
// GET /api/directive-history — returns all directive outcomes for history panel

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    const list = await env.FFX_KV.list({ prefix: 'intelligence:directive_outcome:' }).catch(function(){ return null; });
    if (!list || !list.keys.length) {
      return new Response(JSON.stringify({ outcomes: [] }), { status: 200, headers });
    }

    const outcomes = (await Promise.all(
      list.keys.slice(-30).map(function(k){ // Last 30 outcomes
        var parts = k.name.split(':'); // intelligence:directive_outcome:{date}:{type}
        var date  = parts[3] || '';
        var type  = parts[4] || '';
        return env.FFX_KV.get(k.name, { type: 'json' }).catch(function(){ return null; });
      })
    )).filter(Boolean);

    // Sort by actedOnAt descending
    outcomes.sort(function(a, b){ return new Date(b.actedOnAt || 0) - new Date(a.actedOnAt || 0); });

    return new Response(JSON.stringify({ outcomes }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
