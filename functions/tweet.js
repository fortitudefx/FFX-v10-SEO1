// Cloudflare Pages Function — FortitudeFX X (Twitter) tweet poster
// File location in your repo: /functions/tweet.js
// Receives all 6 tweets in one call, handles threading internally
// Requires: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET

export async function onRequestPost(context) {

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  const { tweet1, tweet2, tweet3, tweet4, tweet5, tweet6 } = body;
  const tweets = [tweet1, tweet2, tweet3, tweet4, tweet5, tweet6];

  if (!tweet1) return json({ message: 'Missing tweet1' }, 400);

  const API_KEY             = context.env.X_API_KEY;
  const API_SECRET          = context.env.X_API_SECRET;
  const ACCESS_TOKEN        = context.env.X_ACCESS_TOKEN;
  const ACCESS_TOKEN_SECRET = context.env.X_ACCESS_TOKEN_SECRET;

  if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
    return json({ message: 'X credentials not configured' }, 500);
  }

  const results = [];
  let previousTweetId = null;

  for (const rawText of tweets) {
    if (!rawText || !rawText.trim()) continue;

    // Sanitise — strip control characters that break JSON
    const text = rawText.replace(/[\r\n\t]+/g, ' ').trim();

    const tweetPayload = { text };
    if (previousTweetId) {
      tweetPayload.reply = { in_reply_to_tweet_id: previousTweetId };
    }

    const url = 'https://api.x.com/2/tweets';
    const oauthHeader = await buildOAuthHeader('POST', url, API_KEY, API_SECRET, ACCESS_TOKEN, ACCESS_TOKEN_SECRET);

    let xRes;
    try {
      xRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': oauthHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(tweetPayload)
      });
    } catch (err) {
      return json({ message: 'X API request failed: ' + err.message, results }, 500);
    }

    const xData = await xRes.json().catch(() => ({}));

    if (!xRes.ok) {
      return json({ message: 'X API error', detail: xData, results }, xRes.status);
    }

    previousTweetId = xData?.data?.id;
    results.push({ tweet_id: previousTweetId, text });
  }

  return json({ success: true, results });
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
  const paramString = Object.keys(oauthParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join('&');

  const signatureBase = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(paramString)
  ].join('&');

  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(tokenSecret)}`;

  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(signatureBase));
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
