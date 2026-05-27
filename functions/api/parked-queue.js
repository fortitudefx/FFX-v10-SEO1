// functions/api/parked-queue.js
// GET  /api/parked-queue → returns parked list
// POST /api/parked-queue → saves parked list

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const raw    = await env.FFX_KV.get('queue:parked', { type: 'json' }).catch(() => null);
    const parked = Array.isArray(raw) ? raw : [];
    return new Response(JSON.stringify({ parked }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ parked: [], error: err.message }), { status: 200, headers });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const body   = await request.json();
    const parked = Array.isArray(body.parked) ? body.parked : [];
    await env.FFX_KV.put('queue:parked', JSON.stringify(parked));
    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
