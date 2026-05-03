// Cloudflare Pages Function — FortitudeFX X (Twitter) tweet poster
// File location in your repo: /functions/tweet.js
//
// SANDBOX MODE: Send {"slug": "...", "_sandbox": true} → reads from articles-test.json
// PRODUCTION MODE: Send {"slug": "..."} → reads from articles.json
//
// Requires: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, GITHUB_TOKEN

const GITHUB_BASE = 'https://api.github.com/repos/fortitudefx/FFX-v10-SEO1/contents/';
const ARTICLES_PROD = GITHUB_BASE + 'articles.json';
const ARTICLES_TEST = GITHUB_BASE + 'articles-test.json';

export async function onRequestPost(context) {

  // 1. Parse request
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  const { slug, _sandbox } = body;
  if (!slug) return json({ message: 'Missing slug' }, 400);

  const isSandbox = _sandbox === true;
  const GITHUB_API = isSandbox ? ARTICLES_TEST : ARTICLES_PROD;

  // 2. Get credentials
  const API_KEY             = context.env.X_API_KEY;
  const API_SECRET          = context.env.X_API_SECRET;
  const ACCESS_TOKEN        = context.env.X_ACCESS_TOKEN;
  const ACCESS_TOKEN_SECRET = context.env.X_ACCESS_TOKEN_SECRET;
  const GITHUB_TOKEN        = context.env.GITHUB_TOKEN;

  if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
    return json({ message: 'X credentials not configured' }, 500);
  }
  if (!GITHUB_TOKEN) {
    return json({ message: 'GITHUB_TOKEN not configured' }, 500);
  }

  // 3. Fetch correct articles JSON from GitHub
  let getRes;
  try {
    getRes = await fetch(GITHUB_API, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'FortitudeFX-Publisher'
      }
    });
  } catch (err) {
    return json({ message: 'GitHub fetch failed: ' + err.message }, 500);
  }

  if (!getRes.ok) {
    return json({ message: `GitHub fetch error: ${getRes.status} — ${isSandbox ? 'articles-test.json' : 'articles.json'} not found?` }, 500);
  }

  const fileData = await getRes.json();
  const decoded = atob(fileData.content.replace(/\n/g, ''));
  let articles;
  try {
    articles = JSON.parse(decoded);
  } catch {
    return json({ message: 'Failed to parse articles JSON' }, 500);
  }

  // 4. Find article by slug
  const article = articles.find(a => a.slug === slug);
  if (!article) {
    return json({ message: `Article not found for slug: ${slug} in ${isSandbox ? 'articles-test.json' : 'articles.json'}` }, 404);
  }

  // 5. Build tweets array — sanitise each one
  const tweetFields = ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6'];
  const tweets = tweetFields
    .map(f => article[f])
    .filter(t => t && t.trim())
    .map(t => t.replace(/[\r\n\t]+/g, ' ').trim());

  if (tweets.length === 0) {
    return json({ message: 'No tweet fields found in article. Add tweet1-tweet6 fields.' }, 400);
  }

  // 6. Post thread to X
  const results = [];
  let previousTweetId = null;

  for (const text of tweets) {
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

  return json({
    success: true,
    mode: isSandbox ? 'sandbox' : 'production',
    slug,
    tweet_count: results.length,
    results
  });
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
