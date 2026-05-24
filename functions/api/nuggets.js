/**
 * functions/api/nuggets.js
 * GET    /api/nuggets          — list all nuggets
 * POST   /api/nuggets          — create or update
 * DELETE /api/nuggets?id=X     — delete
 *
 * KV structure:
 *   nugget:{id}     → { id, text, category, tags[], sourceVideoId, publishedTo{}, createdAt, updatedAt }
 *   nuggets:index   → [ id1, id2, ... ]  newest first
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url    = new URL(request.url);
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let response;
    if      (method === 'GET')    response = await getNuggets(env);
    else if (method === 'POST')   response = await saveNugget(request, env);
    else if (method === 'DELETE') response = await deleteNugget(url, env);
    else return json({ error: 'Method not allowed' }, 405, corsHeaders);

    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k,v]) => newHeaders.set(k,v));
    return new Response(response.body, { status: response.status, headers: newHeaders });

  } catch (err) {
    return json({ error: err.message }, 500, corsHeaders);
  }
}

async function getNuggets(env) {
  const indexRaw = await env.FFX_KV.get('nuggets:index');
  const index    = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.length) return json({ nuggets: [] });

  const nuggets = (await Promise.all(
    index.map(async id => {
      try {
        const raw = await env.FFX_KV.get('nugget:' + id);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    })
  )).filter(Boolean);

  return json({ nuggets });
}

async function saveNugget(request, env) {
  const body = await request.json();
  const { id, text, category, tags, sourceVideoId, publishedTo } = body;

  if (!text || !category) return json({ error: 'text and category required' }, 400);

  const isUpdate = !!id;
  const nuggetId = id || (Date.now() + '-' + Math.random().toString(36).slice(2,7));
  const now      = new Date().toISOString();

  let existing = {};
  if (isUpdate) {
    const raw = await env.FFX_KV.get('nugget:' + nuggetId);
    existing  = raw ? JSON.parse(raw) : {};
  }

  const nugget = {
    id:            nuggetId,
    text:          text.trim(),
    category,
    tags:          Array.isArray(tags) ? tags : [],
    sourceVideoId: sourceVideoId || existing.sourceVideoId || null,
    publishedTo:   publishedTo   || existing.publishedTo   || {},
    createdAt:     existing.createdAt || now,
    updatedAt:     now,
  };

  await env.FFX_KV.put('nugget:' + nuggetId, JSON.stringify(nugget));

  if (!isUpdate) {
    const indexRaw = await env.FFX_KV.get('nuggets:index');
    const index    = indexRaw ? JSON.parse(indexRaw) : [];
    if (!index.includes(nuggetId)) {
      index.unshift(nuggetId);
      await env.FFX_KV.put('nuggets:index', JSON.stringify(index));
    }
  }

  return json({ ok: true, nugget });
}

async function deleteNugget(url, env) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  await env.FFX_KV.delete('nugget:' + id);

  const indexRaw = await env.FFX_KV.get('nuggets:index');
  if (indexRaw) {
    const index = JSON.parse(indexRaw).filter(x => x !== id);
    await env.FFX_KV.put('nuggets:index', JSON.stringify(index));
  }

  return json({ ok: true });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}
