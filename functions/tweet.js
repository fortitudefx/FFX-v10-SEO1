// Cloudflare Pages Function — FortitudeFX X (Twitter) tweet poster
// File location in your repo: /functions/tweet.js
//
// Called by Make.com scenario via POST to /tweet
// Requires these env vars in Cloudflare Pages → Settings → Environment Variables:
//   X_API_KEY
//   X_API_SECRET
//   X_ACCESS_TOKEN
//   X_ACCESS_TOKEN_SECRET

export async function onRequestPost(context) {

  // 1. Parse incoming data from Make
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  const { text, reply_to_tweet_id } = body;

  if (!text) {
    return json({ message: 'Missing tweet text' }, 400);
  }

  // 2. Get credentials from environment
  const API_KEY            = context.env.X_API_KEY;
  const API_SECRET         = context.env.X_API_SECRET;
  const ACCESS_TOKEN       = context.env.X_ACCESS_TOKEN;
  const ACCESS_TOKEN_SECRET = context.env.X_ACCESS_TOKEN_SECRET;

  if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
    return json({ message: 'X credentials not configured' }, 500);
  }

  // 3. Build tweet payload
  const tweetPayload = { text };
  if (reply_to_tweet_id) {
    tweetPayload.reply = { in_reply_to_tweet_id: reply_to_tweet_id };
  }

  // 4. Generate OAuth 1.0 signature
  const url = 'https://api.x.com/2/tweets';
  const method = 'POST';
  const oauthHeader = await buildOAuthHeader(method, url, API_KEY, API_SECRET, ACCESS_TOKEN, ACCESS_TOKEN_SECRET);

  // 5. POST to X API
  let xRes;
  try {
    xRes = await fetch(url, {
      method,
      headers: {
        'Authorization': oauthHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(tweetPayload)
    });
  } catch (err) {
    return json({ message: 'X API request failed: ' + err.message }, 500);
  }

  const xData = await xRes.json().catch(() => ({}));

  if (!xRes.ok) {
    return json({ message: 'X API error', detail: xData }, xRes.status);
  }

  // 6. Return tweet ID to Make for thread chaining
  const tweetId = xData?.data?.id;
  return json({ success: true, tweet_id: tweetId });
}

// ─── OAuth 1.0a signature builder ───────────────────────────────────────────

async function buildOAuthHeader(method, url, apiKey, apiSecret, accessToken, accessTokenSecret) {
  const oauthParams = {
    oauth_consumer_key:     apiKey,
    oauth_nonce:            generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            accessToken,
    oauth_version:          '1.0'
  };

  const signature = await generateSignature(method, url, oauthParams, apiSecret, accessTokenSecret);
  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return `OAuth ${headerParts}`;
}

async function generateSignature(method, url, oauthParams, apiSecret, tokenSecret) {
  // Build parameter string — only OAuth params for POST with JSON body
  const paramString = Object.keys(oauthParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join('&');

  // Build signature base string
  const signatureBase = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(paramString)
  ].join('&');

  // Build signing key
  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(tokenSecret)}`;

  // HMAC-SHA1 using Web Crypto API (available in Cloudflare Workers)
  const encoder = new TextEncoder();
  const keyData = encoder.encode(signingKey);
  const messageData = encoder.encode(signatureBase);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);

  // Base64 encode the signature
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function generateNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  const randomValues = new Uint8Array(32);
  crypto.getRandomValues(randomValues);
  randomValues.forEach(v => nonce += chars[v % chars.length]);
  return nonce;
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
