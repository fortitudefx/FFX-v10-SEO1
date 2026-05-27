// functions/api/title-test.js
// POST /api/title-test → writes seo:title_tests:{slug} to KV
// GET  /api/title-test?slug=X → returns title test record for a slug

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const body = await request.json();
    const { slug, videoId, oldTitle, newTitle, changedAt, positionAtChange,
            ctrAtChange, clicksAtChange, impressionsAtChange } = body;

    if (!slug || !newTitle) {
      return new Response(JSON.stringify({ error: 'slug and newTitle required' }), { status: 400, headers });
    }

    const record = {
      slug,
      videoId:             videoId || null,
      oldTitle:            oldTitle || '',
      newTitle,
      changedAt:           changedAt || new Date().toISOString(),
      positionAtChange:    positionAtChange || null,
      ctrAtChange:         ctrAtChange || 0,
      clicksAtChange:      clicksAtChange || 0,
      impressionsAtChange: impressionsAtChange || 0,
      status:              'monitoring',
      // Populated by signals worker after 14 days
      result: null,
      positionAfter:  null,
      ctrAfter:       null,
      clicksAfter:    null,
      impressionsAfter: null,
      improvement:    null, // true/false/null
      completedAt:    null,
      // Intelligence engine outcome tracking
      briefLogId:     null, // set if this came from a brief recommendation
    };

    await env.FFX_KV.put(`seo:title_tests:${slug}`, JSON.stringify(record));
    console.log('[title-test] Written for slug:', slug, '| new title:', newTitle);

    return new Response(JSON.stringify({ success: true, slug }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const slug   = new URL(request.url).searchParams.get('slug');
    if (!slug) {
      // Return all title tests
      const list = await env.FFX_KV.list({ prefix: 'seo:title_tests:' });
      const records = await Promise.all(
        list.keys.map(k => env.FFX_KV.get(k.name, { type: 'json' }).catch(() => null))
      );
      return new Response(JSON.stringify({ tests: records.filter(Boolean) }), { status: 200, headers });
    }
    const record = await env.FFX_KV.get(`seo:title_tests:${slug}`, { type: 'json' }).catch(() => null);
    return new Response(JSON.stringify({ test: record }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
