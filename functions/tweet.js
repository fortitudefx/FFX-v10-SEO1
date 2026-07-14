// Cloudflare Pages Function — FortitudeFX X (Twitter) thread poster
// File location in your repo: /functions/tweet.js
//
// Called by publish-confirm.js via POST to /tweet
// Receives slug + optional tweet1-6 content directly
// If tweet content provided in request — uses it directly (no GitHub fetch)
// If not provided — falls back to fetching from articles.json
// Requires: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
//
// OG CARD FIX: tweet2 (index 1) always ends with article URL on its own line
// This ensures Twitter renders the OG card on the first reply — highest visibility

const GITHUB_RAW = 'https://raw.githubusercontent.com/fortitudefx/FFX-v10-SEO1/main/articles.json';

export async function onRequestPost(context) {

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  const { slug, tweet1, tweet2, tweet3, tweet4, tweet5, tweet6, articleUrl } = body;
  if (!slug) return json({ message: 'Missing slug' }, 400);

  const API_KEY             = context.env.X_API_KEY;
  const API_SECRET          = context.env.X_API_SECRET;
  const ACCESS_TOKEN        = context.env.X_ACCESS_TOKEN;
  const ACCESS_TOKEN_SECRET = context.env.X_ACCESS_TOKEN_SECRET;

  if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
    return json({ message: 'X credentials not configured' }, 500);
  }

  // Build the canonical article URL for OG card
  // Passed from publish-confirm if available, otherwise constructed from slug
  const canonicalUrl = articleUrl || `https://fortitudefx.com/article?slug=${slug}`;

  let tweets = null;

  if (tweet1) {
    const rawTweets = [tweet1, tweet2, tweet3, tweet4, tweet5, tweet6];
    tweets = rawTweets
      .filter(t => t && t.trim())
      .map(t => t.replace(/[\r\n\t]+/g, ' ').trim());
  } else {
    let article;
    try {
      const res = await fetch(GITHUB_RAW, {
        headers: { 'User-Agent': 'FortitudeFX-Tweet' }
      });
      if (!res.ok) return json({ message: 'Failed to fetch articles.json: ' + res.status }, 500);
      const articles = await res.json();
      article = articles.find(a => a.slug === slug);
    } catch (err) {
      return json({ message: 'Error reading articles.json: ' + err.message }, 500);
    }

    if (!article) return json({ message: 'Article not found for slug: ' + slug }, 404);

    const { tweet1: t1, tweet2: t2, tweet3: t3, tweet4: t4, tweet5: t5, tweet6: t6 } = article;
    if (!t1) return json({ message: 'No tweet content found for slug: ' + slug }, 400);

    const rawTweets = [t1, t2, t3, t4, t5, t6];
    tweets = rawTweets
      .filter(t => t && t.trim())
      .map(t => t.replace(/[\r\n\t]+/g, ' ').trim());
  }

  if (!tweets || tweets.length === 0) {
    return json({ message: 'No tweet content found for slug: ' + slug }, 400);
  }

  // ── OG CARD FIX: inject article URL into tweet2 (index 1) ──────────────
  // Twitter only renders OG cards when the URL is the final element of a tweet
  // with no trailing text. Tweet2 (first reply) = highest visibility position.
  // Also ensure tweet6 (last tweet) keeps its YouTube URL clean.
  // Skip this injection when the THREAD already places the link intentionally
  // (keyword threads carry the homepage in tweet 5 and the article link in tweet 6).
  // Injecting a 3rd link into tweet 2 duplicates it and clutters a tweet not written
  // for a link. Only auto-inject when NO tweet already contains a fortitudefx.com link.
  const threadHasLink = tweets.some(t => /fortitudefx\.com/i.test(String(t || '')));
  if (tweets.length > 1 && !threadHasLink) {
    const t2Content = tweets[1];
    // Only append if the canonical URL is not already at the end of tweet2
    const alreadyHasUrl = t2Content.trim().endsWith(canonicalUrl) ||
                          t2Content.includes('fortitudefx.com/article?slug=');
    if (!alreadyHasUrl) {
      // Trim tweet2 to leave room for URL (Twitter max 280 chars, URL = 23 chars)
      const maxContentLength = 280 - 23 - 2; // 2 for \n\n
      const trimmedContent   = t2Content.length > maxContentLength
        ? t2Content.substring(0, maxContentLength - 1) + '…'
        : t2Content;
      tweets[1] = `${trimmedContent}\n\n${canonicalUrl}`;
    }
    console.log('[FFX] X tweet2 with OG URL:', tweets[1].substring(0, 80) + '...');
  }

  console.log('[FFX] X thread slug:', slug, 'tweets:', tweets.length);

  // Post thread to X — continue on failure, log all errors
  const results = [];
  let previousTweetId = null;
  let firstError = null;

  for (let i = 0; i < tweets.length; i++) {
    const text = tweets[i];
    const tweetPayload = { text };
    if (previousTweetId) {
      tweetPayload.reply = { in_reply_to_tweet_id: previousTweetId };
    }

    const url = 'https://api.x.com/2/tweets';
    let oauthHeader;
    try {
      oauthHeader = await buildOAuthHeader('POST', url, API_KEY, API_SECRET, ACCESS_TOKEN, ACCESS_TOKEN_SECRET);
    } catch (err) {
      console.log('[FFX] X OAuth error on tweet', i + 1, ':', err.message);
      results.push({ tweet_num: i + 1, success: false, error: err.message });
      if (!firstError) firstError = err.message;
      continue;
    }

    let xRes;
    try {
      xRes = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': oauthHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(tweetPayload)
      });
    } catch (err) {
      console.log('[FFX] X fetch error on tweet', i + 1, ':', err.message);
      results.push({ tweet_num: i + 1, success: false, error: err.message });
      if (!firstError) firstError = err.message;
      continue;
    }

    const xData = await xRes.json().catch(() => ({}));
    console.log('[FFX] X tweet', i + 1, 'status:', xRes.status);

    if (!xRes.ok) {
      const errDetail = xData?.detail || xData?.title || xData?.errors?.[0]?.message || JSON.stringify(xData);
      console.log('[FFX] X tweet', i + 1, 'failed:', errDetail);
      results.push({ tweet_num: i + 1, success: false, error: errDetail });
      if (!firstError) firstError = errDetail;
      continue;
    }

    previousTweetId = xData?.data?.id;
    console.log('[FFX] X tweet', i + 1, 'posted, id:', previousTweetId);
    results.push({ tweet_num: i + 1, success: true, tweet_id: previousTweetId });
  }

  const successCount = results.filter(r => r.success).length;
  const failCount    = results.filter(r => !r.success).length;

  console.log('[FFX] X thread complete — success:', successCount, 'failed:', failCount);

  if (successCount === 0) {
    return json({ message: 'X API error — all tweets failed', first_error: firstError, results }, 500);
  }

  return json({ success: true, slug, tweet_count: successCount, failed_count: failCount, results });
}

// ─── OAuth 1.0a signature builder ─────────────────────────────────────────────

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
  const encoder    = new TextEncoder();

  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
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
