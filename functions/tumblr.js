// Cloudflare Pages Function — FortitudeFX Tumblr poster
// File location in your repo: /functions/tumblr.js
//
// Called by publish-confirm.js via POST to /tumblr
// Receives slug + optional tumblr content directly
// If tumblr content provided in request — uses it directly (no GitHub fetch)
// If not provided — falls back to fetching from articles.json
// Requires: TUMBLR_CONSUMER_KEY, TUMBLR_CONSUMER_SECRET,
//           TUMBLR_ACCESS_TOKEN, TUMBLR_ACCESS_TOKEN_SECRET, TUMBLR_BLOG_NAME

const GITHUB_RAW = 'https://raw.githubusercontent.com/fortitudefx/FFX-v10-SEO1/main/articles.json';

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  const { slug, tumblr: tumblrContent } = body;
  if (!slug) return json({ message: 'Missing slug' }, 400);

  const CONSUMER_KEY    = context.env.TUMBLR_CONSUMER_KEY;
  const CONSUMER_SECRET = context.env.TUMBLR_CONSUMER_SECRET;
  const ACCESS_TOKEN    = context.env.TUMBLR_ACCESS_TOKEN;
  const TOKEN_SECRET    = context.env.TUMBLR_ACCESS_TOKEN_SECRET;
  const BLOG_NAME       = context.env.TUMBLR_BLOG_NAME;

  if (!CONSUMER_KEY || !CONSUMER_SECRET || !ACCESS_TOKEN || !TOKEN_SECRET || !BLOG_NAME) {
    return json({ message: 'Tumblr credentials not configured' }, 500);
  }

  console.log('[FFX] Tumblr slug:', slug);

  // Use content passed directly if available
  let content = tumblrContent || null;
  if (!content) {
    let article;
    try {
      const res = await fetch(GITHUB_RAW, {
        headers: { 'User-Agent': 'FortitudeFX-Tumblr' }
      });
      if (!res.ok) return json({ message: 'Failed to fetch articles.json: ' + res.status }, 500);
      const articles = await res.json();
      article = articles.find(a => a.slug === slug);
    } catch (err) {
      return json({ message: 'Error reading articles.json: ' + err.message }, 500);
    }
    if (!article) return json({ message: 'Article not found for slug: ' + slug }, 404);
    content = article.tumblr;
  }

  if (!content || !content.trim()) {
    return json({ message: 'No tumblr content found for slug: ' + slug }, 400);
  }

  console.log('[FFX] Tumblr content length:', content.trim().length);

  // Build post params
  const apiUrl = `https://api.tumblr.com/v2/blog/${BLOG_NAME}/post`;
  const postParams = {};

  // Build OAuth 1.0a Authorization header — only OAuth params, no body params
  let authHeader;
  try {
    authHeader = await buildOAuthHeader(
      'POST', apiUrl, postParams,
      CONSUMER_KEY, CONSUMER_SECRET,
      ACCESS_TOKEN, TOKEN_SECRET
    );
  } catch (err) {
    console.log('[FFX] Tumblr OAuth error:', err.message);
    return json({ message: 'OAuth signing failed: ' + err.message }, 500);
  }

  // Make the API call using NPF format with JSON body
  const npfPayload = {
    content: [{ type: 'text', text: content.trim() }],
    state: 'published',
  };
  let tumblrRes;
  try {
    tumblrRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(npfPayload),
    });
  } catch (err) {
    console.log('[FFX] Tumblr fetch error:', err.message);
    return json({ message: 'Tumblr API request failed: ' + err.message }, 500);
  }

  const tumblrStatus = tumblrRes.status;
  const tumblrBody = await tumblrRes.json().catch(() => ({}));
  console.log('[FFX] Tumblr status:', tumblrStatus);
  console.log('[FFX] Tumblr body:', JSON.stringify(tumblrBody));

  if (tumblrStatus !== 200 && tumblrStatus !== 201) {
    return json({ message: 'Tumblr API error', status: tumblrStatus, detail: tumblrBody }, tumblrStatus);
  }

  const postId = tumblrBody?.response?.id || tumblrBody?.response?.id_string || 'unknown';
  console.log('[FFX] Tumblr post_id:', postId);

  return json({ success: true, slug, post_id: postId });
}

// ── OAuth 1.0a HMAC-SHA1 signing ──────────────────────────────────────────────
async function buildOAuthHeader(method, url, bodyParams, consumerKey, consumerSecret, accessToken, tokenSecret) {
  const oauthParams = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            accessToken,
    oauth_version:          '1.0',
  };

  // Combine oauth params + body params for signature base
  const allParams = { ...oauthParams, ...bodyParams };

  // Sort and encode
  const sortedParams = Object.keys(allParams)
    .sort()
    .map(k => `${pct(k)}=${pct(allParams[k])}`)
    .join('&');

  const signatureBase = [
    method.toUpperCase(),
    pct(url),
    pct(sortedParams),
  ].join('&');

  const signingKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;

  // HMAC-SHA1 via Web Crypto
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signatureBase));
  const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

  oauthParams.oauth_signature = signature;

  const headerValue = 'OAuth ' + Object.keys(oauthParams)
    .sort()
    .map(k => `${pct(k)}="${pct(oauthParams[k])}"`)
    .join(', ');

  return headerValue;
}

function pct(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function generateNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  const values = new Uint8Array(32);
  crypto.getRandomValues(values);
  for (const v of values) nonce += chars[v % chars.length];
  return nonce;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
