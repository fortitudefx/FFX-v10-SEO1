// functions/api/thumbnail-proxy.js
// GET /api/thumbnail-proxy?url=https://cdn.leonardo.ai/...
//
// Fetches an external image server-side and returns it as a blob.
// This bypasses browser CORS restrictions that prevent canvas.toDataURL()
// from working on cross-origin images (Leonardo CDN).
//
// Without this proxy:
//   img.crossOrigin = 'anonymous' → Leonardo CDN rejects → onerror fires
//   → canvas never runs → no hook text, no branding, raw image returned
//
// With this proxy:
//   Browser loads image from /api/thumbnail-proxy (same origin as fortitudefx.com)
//   → canvas treats it as same-origin → toDataURL() works → compositing works

export async function onRequestGet(context) {
  var url = new URL(context.request.url);
  var imageUrl = url.searchParams.get('url');

  if (!imageUrl) {
    return new Response('url parameter required', { status: 400 });
  }

  // Only allow Leonardo CDN URLs — security guard
  var allowedHosts = [
    'cdn.leonardo.ai',
    'storage.googleapis.com',
    'cloud.leonardo.ai',
  ];

  var parsed;
  try { parsed = new URL(imageUrl); } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  var allowed = allowedHosts.some(function(host) {
    return parsed.hostname === host || parsed.hostname.endsWith('.' + host);
  });

  if (!allowed) {
    return new Response('URL not from allowed host', { status: 403 });
  }

  try {
    var res = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'FFX-Thumbnail-Proxy/1.0',
      },
    });

    if (!res.ok) {
      return new Response('Failed to fetch image: ' + res.status, { status: 502 });
    }

    var contentType = res.headers.get('content-type') || 'image/png';
    var imageData   = await res.arrayBuffer();

    return new Response(imageData, {
      status: 200,
      headers: {
        'Content-Type':                contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=86400', // cache 24h
        'Content-Length':              String(imageData.byteLength),
      },
    });

  } catch(err) {
    return new Response('Proxy error: ' + err.message, { status: 500 });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
