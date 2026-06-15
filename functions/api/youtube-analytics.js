// functions/api/youtube-analytics.js
// POST /api/youtube-analytics — fetch YouTube Analytics data
//   - Traffic source breakdown (search vs suggested vs browse vs external)
//   - Watch time by content topic/category
//   - Audience retention data
//   - Top performing videos by watch time and CTR
//
// Requires: GOOGLE_REFRESH_TOKEN with scope yt-analytics.readonly
// If scope not present: returns auth_required flag — NO silent failure
//
// KV keys written:
//   youtube:analytics:signals     — channel analytics snapshot
//   youtube:analytics:auth_required — set to true if 403, cleared on success
//
// OAuth scope needed (add to Google Cloud Console OAuth consent screen):
//   https://www.googleapis.com/auth/yt-analytics.readonly
//
// After adding scope: delete GOOGLE_REFRESH_TOKEN from Cloudflare Pages env vars,
// re-authorise via Google OAuth, add new refresh token back.

const YT_ANALYTICS_BASE = 'https://youtubeanalytics.googleapis.com/v2';
const CHANNEL_ID        = 'UConuNkzv83jBubkaQpXwXjQ';
const HEADERS_JSON      = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: HEADERS_JSON });
}

// ── GET — return stored analytics ────────────────────────────────────────
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const signals     = await env.FFX_KV.get('youtube:analytics:signals',      { type: 'json' }).catch(function() { return null; });
    const authRequired = await env.FFX_KV.get('youtube:analytics:auth_required').catch(function() { return null; });
    return json({
      signals:      signals || null,
      authRequired: authRequired === 'true',
      scopeNeeded:  'https://www.googleapis.com/auth/yt-analytics.readonly',
    });
  } catch(err) {
    return json({ error: err.message }, 500);
  }
}

// ── POST — fetch fresh YouTube Analytics data ─────────────────────────────
export async function onRequestPost(context) {
  var env     = context.env;
  var request = context.request;

  if (!env.GOOGLE_REFRESH_TOKEN) return json({ error: 'GOOGLE_REFRESH_TOKEN not set' }, 500);
  if (!env.GOOGLE_CLIENT_SECRET) return json({ error: 'GOOGLE_CLIENT_SECRET not set' }, 500);

  // Get access token
  var token;
  try {
    token = await getAccessToken(env);
  } catch(authErr) {
    return json({ error: 'Token refresh failed: ' + authErr.message }, 500);
  }

  // Date range — last 28 days
  var now      = new Date();
  var endDate  = new Date(now); endDate.setDate(endDate.getDate() - 1);
  var start28  = new Date(endDate); start28.setDate(start28.getDate() - 28);
  var start90  = new Date(endDate); start90.setDate(start90.getDate() - 90);
  var fmt      = function(d) { return d.toISOString().split('T')[0]; };

  var results = {};
  var authError = false;

  // ── Fetch 1: Traffic sources (search vs suggested vs browse vs external) ──
  try {
    var tsRes = await ytAnalyticsQuery(token, {
      ids:        'channel==' + CHANNEL_ID,
      startDate:  fmt(start28),
      endDate:    fmt(endDate),
      metrics:    'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage',
      dimensions: 'insightTrafficSourceType',
      sort:       '-views',
    });
    results.trafficSources = parseRows(tsRes, ['trafficSourceType'], ['views','watchTime','avgDuration','avgViewPct']);
    console.log('[youtube-analytics] Traffic sources fetched:', results.trafficSources.length);
  } catch(err) {
    if (isAuthError(err)) {
      authError = true;
    } else {
      console.error('[youtube-analytics] Traffic sources failed (non-fatal):', err.message);
      results.trafficSourcesError = err.message;
    }
  }

  if (authError) {
    await env.FFX_KV.put('youtube:analytics:auth_required', 'true');
    return json({
      error: 'YouTube Analytics API returned 403 — yt-analytics.readonly scope not authorised.',
      authRequired: true,
      scopeNeeded: 'https://www.googleapis.com/auth/yt-analytics.readonly',
      howToFix: [
        '1. Go to Google Cloud Console → APIs & Services → OAuth consent screen',
        '2. Add scope: https://www.googleapis.com/auth/yt-analytics.readonly',
        '3. Delete GOOGLE_REFRESH_TOKEN from Cloudflare Pages environment variables',
        '4. Re-run OAuth flow to generate new refresh token with the new scope',
        '5. Add new refresh token back to Cloudflare Pages environment variables',
      ],
    }, 403);
  }

  // ── Fetch 2: YouTube search queries driving traffic to your videos ────────
  try {
    var sqRes = await ytAnalyticsQuery(token, {
      ids:        'channel==' + CHANNEL_ID,
      startDate:  fmt(start28),
      endDate:    fmt(endDate),
      metrics:    'views',
      dimensions: 'insightTrafficSourceDetail',
      filters:    'insightTrafficSourceType==YT_SEARCH',
      sort:       '-views',
      maxResults: 25,
    });
    results.youtubeSearchQueries = parseRows(sqRes, ['searchQuery'], ['views']);
    console.log('[youtube-analytics] YT search queries fetched:', results.youtubeSearchQueries.length);
  } catch(err) {
    console.error('[youtube-analytics] Search queries failed (non-fatal):', err.message);
    results.youtubeSearchQueriesError = err.message;
  }

  // ── Fetch 3: Top videos by watch time (90 days) ───────────────────────────
  try {
    var tvRes = await ytAnalyticsQuery(token, {
      ids:        'channel==' + CHANNEL_ID,
      startDate:  fmt(start90),
      endDate:    fmt(endDate),
      metrics:    'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments',
      dimensions: 'video',
      sort:       '-estimatedMinutesWatched',
      maxResults: 20,
    });
    results.topVideosByWatchTime = parseRows(tvRes, ['videoId'], ['views','watchTime','avgDuration','avgViewPct','likes','comments']);
    console.log('[youtube-analytics] Top videos fetched:', results.topVideosByWatchTime.length);
  } catch(err) {
    console.error('[youtube-analytics] Top videos failed (non-fatal):', err.message);
    results.topVideosByWatchTimeError = err.message;
  }

  // ── Fetch 4: Audience geography (last 28 days) ────────────────────────────
  try {
    var geoRes = await ytAnalyticsQuery(token, {
      ids:        'channel==' + CHANNEL_ID,
      startDate:  fmt(start28),
      endDate:    fmt(endDate),
      metrics:    'views,estimatedMinutesWatched',
      dimensions: 'country',
      sort:       '-views',
      maxResults: 10,
    });
    results.topCountries = parseRows(geoRes, ['country'], ['views','watchTime']);
    console.log('[youtube-analytics] Geography fetched:', results.topCountries.length);
  } catch(err) {
    console.error('[youtube-analytics] Geography failed (non-fatal):', err.message);
  }

  // ── Fetch 5: Device types ─────────────────────────────────────────────────
  try {
    var devRes = await ytAnalyticsQuery(token, {
      ids:        'channel==' + CHANNEL_ID,
      startDate:  fmt(start28),
      endDate:    fmt(endDate),
      metrics:    'views,estimatedMinutesWatched',
      dimensions: 'deviceType',
      sort:       '-views',
    });
    results.deviceTypes = parseRows(devRes, ['deviceType'], ['views','watchTime']);
  } catch(err) {
    console.error('[youtube-analytics] Device types failed (non-fatal):', err.message);
  }

  // ── Derive intelligence signals ────────────────────────────────────────────
  var signals = buildSignals(results, fmt(start28), fmt(endDate));

  // Write to KV permanently
  try {
    await env.FFX_KV.put('youtube:analytics:signals', JSON.stringify(signals));
    // Clear auth_required flag since this succeeded
    try { await env.FFX_KV.delete('youtube:analytics:auth_required'); } catch {}
    console.log('[youtube-analytics] Signals written to KV');
  } catch(kvErr) {
    console.error('[youtube-analytics] KV write failed:', kvErr.message);
  }

  return json({ success: true, signals });
}

// ── Build intelligence signals from raw results ───────────────────────────
function buildSignals(results, startDate, endDate) {
  var signals = {
    fetchedAt: new Date().toISOString(),
    period: { start: startDate, end: endDate },
  };

  // Traffic source breakdown
  if (results.trafficSources && results.trafficSources.length > 0) {
    var totalViews = results.trafficSources.reduce(function(sum, r) { return sum + (r.views || 0); }, 0);
    signals.trafficSourceBreakdown = results.trafficSources.map(function(r) {
      return {
        source:  r.trafficSourceType,
        views:   r.views,
        pct:     totalViews > 0 ? Math.round((r.views / totalViews) * 100) : 0,
        watchTime: r.watchTime,
      };
    });

    // Find dominant source
    var ytSearch  = results.trafficSources.find(function(r) { return r.trafficSourceType === 'YT_SEARCH'; });
    var suggested = results.trafficSources.find(function(r) { return r.trafficSourceType === 'SUGGESTED'; });
    var browse    = results.trafficSources.find(function(r) { return r.trafficSourceType === 'BROWSE'; });

    signals.searchPct    = ytSearch  ? (totalViews > 0 ? Math.round((ytSearch.views  / totalViews) * 100) : 0) : 0;
    signals.suggestedPct = suggested ? (totalViews > 0 ? Math.round((suggested.views / totalViews) * 100) : 0) : 0;
    signals.browsePct    = browse    ? (totalViews > 0 ? Math.round((browse.views    / totalViews) * 100) : 0) : 0;

    // Key insight: if search > 30%, title/keyword optimisation matters a lot
    // If suggested > 40%, thumbnail CTR matters more than title
    signals.dominantDiscovery = signals.suggestedPct > signals.searchPct ? 'suggested' : 'search';
    signals.titleVsThumbnailPriority = signals.dominantDiscovery === 'suggested'
      ? 'THUMBNAIL_FIRST — 70%+ discovery is suggested, thumbnail CTR dominates. Title is secondary.'
      : 'TITLE_FIRST — YouTube search drives majority of discovery. Keyword-optimised titles matter most.';
  }

  // YouTube search queries — what people actually type to find your videos
  if (results.youtubeSearchQueries && results.youtubeSearchQueries.length > 0) {
    signals.topYouTubeSearchQueries = results.youtubeSearchQueries
      .slice(0, 15)
      .map(function(r) { return { query: r.searchQuery, views: r.views }; });
  }

  // Top videos by watch time
  if (results.topVideosByWatchTime && results.topVideosByWatchTime.length > 0) {
    signals.topVideosByWatchTime = results.topVideosByWatchTime.slice(0, 10).map(function(r) {
      return {
        videoId:    r.videoId,
        views:      r.views,
        watchTime:  r.watchTime,
        avgDuration: r.avgDuration,
        avgViewPct:  r.avgViewPct,
      };
    });
    // Channel average view percentage (audience retention)
    var totalWatchTime = results.topVideosByWatchTime.reduce(function(s, r) { return s + (r.watchTime || 0); }, 0);
    signals.channelAvgWatchTime = results.topVideosByWatchTime.length > 0
      ? Math.round(totalWatchTime / results.topVideosByWatchTime.length)
      : 0;
    signals.channelAvgViewPct = results.topVideosByWatchTime.length > 0
      ? Math.round(results.topVideosByWatchTime.reduce(function(s, r) { return s + (r.avgViewPct || 0); }, 0) / results.topVideosByWatchTime.length)
      : 0;
  }

  // Geography
  if (results.topCountries) signals.topCountries = results.topCountries;

  // Device
  if (results.deviceTypes) signals.deviceTypes = results.deviceTypes;

  return signals;
}

// ── Helpers ───────────────────────────────────────────────────────────────
async function ytAnalyticsQuery(token, params) {
  var qs = Object.keys(params).map(function(k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var res = await fetch(YT_ANALYTICS_BASE + '/reports?' + qs, {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (!res.ok) {
    var errText = await res.text();
    throw new Error('YT Analytics ' + res.status + ': ' + errText);
  }
  return res.json();
}

function isAuthError(err) {
  return err.message && (err.message.includes('403') || err.message.includes('401') || err.message.toLowerCase().includes('insufficient'));
}

function parseRows(data, dimKeys, metricKeys) {
  if (!data || !data.rows) return [];
  return data.rows.map(function(row) {
    var obj = {};
    var dims = row.slice(0, dimKeys.length);
    var mets = row.slice(dimKeys.length);
    dimKeys.forEach(function(k, i) { obj[k] = dims[i]; });
    metricKeys.forEach(function(k, i) { obj[k] = parseFloat(mets[i]) || 0; });
    return obj;
  });
}

async function getAccessToken(env) {
  // Check cache first
  try {
    var cached = await env.FFX_KV.get('google:access_token', { type: 'text' }).catch(function() { return null; });
    var expiry = await env.FFX_KV.get('google:access_token_expiry', { type: 'text' }).catch(function() { return null; });
    if (cached && expiry && Date.now() < parseInt(expiry) - 60000) return cached;
  } catch(e) {}

  var res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID || '805135063067-mb9ap5knagr29280dmg1s63gcbd2f01t.apps.googleusercontent.com',
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }).toString(),
  });
  if (!res.ok) throw new Error('Token refresh ' + res.status + ': ' + await res.text());
  var data = await res.json();
  var expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  try {
    await env.FFX_KV.put('google:access_token',        data.access_token, { expirationTtl: 3300 });
    await env.FFX_KV.put('google:access_token_expiry', String(expiresAt), { expirationTtl: 3300 });
  } catch(e) {}
  return data.access_token;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
