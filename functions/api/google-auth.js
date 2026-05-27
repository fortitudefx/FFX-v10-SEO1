// functions/api/google-auth.js
// GET /api/google-auth?scope=seo|ga4|both
// Returns a fresh access token using the stored refresh token
// Used by SEO and Audience dashboards to avoid browser OAuth flow

const CLIENT_ID     = '805135063067-mb9ap5knagr29280dmg1s63gcbd2f01t.apps.googleusercontent.com';
const SC_SCOPE      = 'https://www.googleapis.com/auth/webmasters.readonly';
const GA4_SCOPE     = 'https://www.googleapis.com/auth/analytics.readonly';
const BOTH_SCOPE    = SC_SCOPE + ' ' + GA4_SCOPE;
const TOKEN_CACHE_KEY = 'google:access_token';
const TOKEN_EXPIRY_KEY = 'google:access_token_expiry';

export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.GOOGLE_REFRESH_TOKEN) return new Response(JSON.stringify({ error: 'GOOGLE_REFRESH_TOKEN not set' }), { status: 500, headers });
  if (!env.GOOGLE_CLIENT_SECRET) return new Response(JSON.stringify({ error: 'GOOGLE_CLIENT_SECRET not set' }), { status: 500, headers });

  try {
    // Check KV cache first — avoid unnecessary token refreshes
    const cachedToken  = await env.FFX_KV.get(TOKEN_CACHE_KEY, { type: 'text' }).catch(() => null);
    const cachedExpiry = await env.FFX_KV.get(TOKEN_EXPIRY_KEY, { type: 'text' }).catch(() => null);

    if (cachedToken && cachedExpiry && Date.now() < parseInt(cachedExpiry) - 60000) {
      return new Response(JSON.stringify({ access_token: cachedToken }), { status: 200, headers });
    }

    // Refresh the token
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     env.GOOGLE_CLIENT_ID || CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        grant_type:    'refresh_token',
      }).toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: 'Token refresh failed: ' + err }), { status: 500, headers });
    }

    const data        = await res.json();
    const accessToken = data.access_token;
    const expiresAt   = Date.now() + (data.expires_in || 3600) * 1000;

    // Cache in KV for 55 minutes (tokens last 60 min)
    await env.FFX_KV.put(TOKEN_CACHE_KEY,  accessToken,         { expirationTtl: 3300 });
    await env.FFX_KV.put(TOKEN_EXPIRY_KEY, String(expiresAt),   { expirationTtl: 3300 });

    return new Response(JSON.stringify({ access_token: accessToken }), { status: 200, headers });

  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
