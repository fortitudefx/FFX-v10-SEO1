// Cloudflare Pages Function — FFX Publish Confirm
// File location in your repo: /functions/publish-confirm.js
//
// Called by generate.html publish button via POST to /publish-confirm
// Reads content from KV by slug → fires Make webhook → deletes from KV

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  console.log('[FFX] publish-confirm: request received');

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { slug } = body;
  if (!slug) {
    return new Response(JSON.stringify({ error: 'slug is required' }), { status: 400, headers });
  }

  console.log('[FFX] publish-confirm slug:', slug);

  // Read generated content from KV
  const stored = await env.FFX_CONTENT.get(slug);
  if (!stored) {
    return new Response(JSON.stringify({ error: 'Content not found or expired. Please generate again.' }), { status: 404, headers });
  }

  let content;
  try { content = JSON.parse(stored); } catch {
    return new Response(JSON.stringify({ error: 'Stored content is corrupted. Please generate again.' }), { status: 500, headers });
  }

  console.log('[FFX] publish-confirm: firing Make webhook for slug:', slug);

  // Fire Make FFX LIVE webhook
  let makeRes;
  try {
    makeRes = await fetch('https://hook.eu1.make.com/0iwx8y8ufy318mfml1jmgs1cjjeii388', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(content),
    });
  } catch (err) {
    console.log('[FFX] publish-confirm: Make webhook network error:', err.message);
    return new Response(JSON.stringify({ error: `Make webhook network error: ${err.message}` }), { status: 502, headers });
  }

  if (!makeRes.ok) {
    const makeErr = await makeRes.text();
    console.log('[FFX] publish-confirm: Make webhook rejected:', makeErr);
    return new Response(JSON.stringify({ error: `Make webhook rejected the request: ${makeErr}` }), { status: 502, headers });
  }

  // Clean up KV
  await env.FFX_CONTENT.delete(slug);
  console.log('[FFX] publish-confirm: KV deleted, publish complete');

  return new Response(JSON.stringify({ success: true, slug }), { status: 200, headers });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
