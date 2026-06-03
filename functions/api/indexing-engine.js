// =============================================================================
// FFX Indexing Engine — Pages Function
// GET  /api/indexing-engine            → return latest indexing:status from KV
// GET  /api/indexing-engine?history=1  → return indexing:history records
// GET  /api/indexing-engine?progress=1 → return current scan progress
// POST /api/indexing-engine            → run full scan synchronously, return results
//
// Pattern: identical to intelligence-engine.js
//   POST awaits full scan (client holds connection open)
//   Progress written to KV at each step — dashboard polls ?progress=1
//   Results returned in response body — dashboard renders immediately
//
// Google APIs used:
//   URL Inspection API  — OAuth refresh token (GOOGLE_REFRESH_TOKEN)
//   Indexing API        — Service account JWT (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY_PEM)
// =============================================================================

var CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

var IX_SC_PROPERTY  = 'sc-domain:fortitudefx.com';
var IX_SITE_BASE    = 'https://fortitudefx.com';
var IX_STATUS_KEY   = 'indexing:status';
var IX_PROGRESS_KEY = 'indexing:progress';
var IX_HISTORY_TTL  = 7776000;
var IX_STATUS_TTL   = 90000;
var IX_CLIENT_ID    = '805135063067-mb9ap5knagr29280dmg1s63gcbd2f01t.apps.googleusercontent.com';

var IX_STATIC_PAGES = [
  'https://fortitudefx.com/',
  'https://fortitudefx.com/blog',
  'https://fortitudefx.com/bootcamp',
  'https://fortitudefx.com/vipdiscord',
  'https://fortitudefx.com/waitlist',
  'https://fortitudefx.com/privacy',
];

// ── GET — return KV data ─────────────────────────────────────────────────────

export async function onRequestGet(context) {
  var env     = context.env;
  var request = context.request;
  var url     = new URL(request.url);

  try {
    if (url.searchParams.get('progress') === '1') {
      var progress = await env.FFX_KV.get(IX_PROGRESS_KEY, { type: 'json' }).catch(function() { return null; });
      return new Response(JSON.stringify({ progress: progress || null }), { status: 200, headers: CORS_HEADERS });
    }

    if (url.searchParams.get('history') === '1') {
      var list = await env.FFX_KV.list({ prefix: 'indexing:history:' }).catch(function() { return { keys: [] }; });
      var records = [];
      for (var i = 0; i < list.keys.length; i++) {
        var rec = await env.FFX_KV.get(list.keys[i].name, { type: 'json' }).catch(function() { return null; });
        if (rec) records.push(rec);
      }
      records.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
      return new Response(JSON.stringify({ history: records }), { status: 200, headers: CORS_HEADERS });
    }

    var status = await env.FFX_KV.get(IX_STATUS_KEY, { type: 'json' }).catch(function() { return null; });
    return new Response(JSON.stringify({ status: status || null }), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// ── POST — run full scan synchronously ──────────────────────────────────────

export async function onRequestPost(context) {
  var env = context.env;
  try {
    var result = await runIndexingEngine(env);
    if (!result || result.error) {
      return new Response(JSON.stringify({ error: (result && result.error) || 'Scan failed — check logs' }), { status: 500, headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify(result), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}

// =============================================================================
// ─────────────────────────────────────────────────────────────────────────────
// FULL INDEXING ENGINE — runs directly in Pages Function
// Same logic as cron Worker Step 8 — copied verbatim
// Pages Function handles all Google API calls and KV writes synchronously
// ─────────────────────────────────────────────────────────────────────────────



async function writeIndexProgress(env, step, total, label) {
  try {
    await env.FFX_KV.put(IX_PROGRESS_KEY, JSON.stringify({
      step: step, total: total, label: label,
      updatedAt: new Date().toISOString(),
    }), { expirationTtl: 600 });
  } catch(e) {}
}

async function runIndexingEngine(env) {
  try {
    console.log('[indexing-engine] Starting scan');
    await writeIndexProgress(env, 1, 6, 'Getting Google OAuth token');

    // Step 1: Get OAuth token (refresh token path - same as google-auth.js)
    var oauthToken = await ixGetOAuthToken(env);
    if (!oauthToken) {
      console.error('[indexing-engine] OAuth token failed');
      await writeIndexProgress(env, 1, 6, 'OAuth token failed - check GOOGLE_REFRESH_TOKEN');
      return;
    }
    console.log('[indexing-engine] OAuth token acquired');
    await writeIndexProgress(env, 2, 6, 'Building URL list from KV');

    // Step 2: Build URL list
    var urls = await ixBuildUrlList(env);
    console.log('[indexing-engine] URL list: ' + urls.length + ' URLs');
    await writeIndexProgress(env, 3, 6, 'Inspecting ' + urls.length + ' URLs via Search Console');

    // Step 3: Inspect each URL
    var results = [];
    for (var i = 0; i < urls.length; i++) {
      var inspection = await ixInspectUrl(oauthToken, urls[i]);
      results.push(inspection);
      if (i > 0 && i % 10 === 0) {
        await ixSleep(1000);
      }
    }
    console.log('[indexing-engine] Inspected ' + results.length + ' URLs');
    await writeIndexProgress(env, 4, 6, 'Classifying ' + results.length + ' results');

    // Step 4: Classify
    var indexed    = [];
    var notIndexed = [];
    var errors     = [];

    for (var j = 0; j < results.length; j++) {
      var r = results[j];
      if (r.error) { errors.push({ url: r.url, error: r.error }); continue; }
      if (r.verdict === 'PASS') {
        indexed.push({ url: r.url, lastCrawled: r.lastCrawlTime || null });
      } else {
        var cause = ixClassify(r);
        notIndexed.push({
          url:           r.url,
          verdict:       r.verdict          || 'UNKNOWN',
          indexingState: r.indexingState    || 'UNKNOWN',
          robotsState:   r.robotsTxtState   || 'UNKNOWN',
          cause:         cause,
          lastCrawled:   r.lastCrawlTime    || null,
          rawReason:     r.coverageState    || null,
          canonicalUrl:  r.canonicalUrl     || null,
          userCanonical: r.userCanonical    || null,
        });
      }
    }
    await writeIndexProgress(env, 5, 6, 'Submitting URLs to Google Indexing API');

    // Step 5: Submit fixable URLs via Indexing API (service account)
    var submittedNow = [];
    if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY_PEM) {
      var saToken = await ixGetServiceAccountToken(env);
      if (saToken) {
        for (var k = 0; k < notIndexed.length; k++) {
          var item = notIndexed[k];
          if (item.cause === 'not_submitted' || item.cause === 'canonical_mismatch' || item.cause === 'unknown') {
            var submitted = await ixSubmitUrl(saToken, item.url);
            item.submittedAt   = submitted ? new Date().toISOString() : null;
            item.submitSuccess = submitted;
            if (submitted) submittedNow.push(item.url);
          }
        }
        console.log('[indexing-engine] Submitted ' + submittedNow.length + ' URLs');
      }
    } else {
      console.log('[indexing-engine] No service account — skipping Indexing API submission');
    }
    await writeIndexProgress(env, 6, 6, 'Writing results to KV');

    // Step 6: Compare vs yesterday, write KV
    var prevStatus     = await env.FFX_KV.get(IX_STATUS_KEY, { type: 'json' }).catch(function() { return null; });
    var newlyIndexed   = [];
    var newlyDropped   = [];

    if (prevStatus) {
      var prevNotMap = {};
      var prevIdxMap = {};
      (prevStatus.notIndexed || []).forEach(function(p) { prevNotMap[p.url] = true; });
      (prevStatus.indexed    || []).forEach(function(p) { prevIdxMap[p.url] = true; });
      indexed.forEach(function(p)    { if (prevNotMap[p.url]) newlyIndexed.push(p.url); });
      notIndexed.forEach(function(p) { if (prevIdxMap[p.url]) newlyDropped.push(p.url); });
    }

    // Build pending-verification list — fixes applied but not yet confirmed by Google
    var pendingVerification = await ixBuildPendingVerification(env, notIndexed, submittedNow, prevStatus);

    var today = new Date().toISOString().split('T')[0];
    var statusRecord = {
      date:               today,
      runAt:              new Date().toISOString(),
      totalUrls:          urls.length,
      indexedCount:       indexed.length,
      notIndexedCount:    notIndexed.length,
      submittedCount:     submittedNow.length,
      errorCount:         errors.length,
      indexed:            indexed,
      notIndexed:         notIndexed,
      errors:             errors,
      newlyIndexed:       newlyIndexed,
      newlyDropped:       newlyDropped,
      pendingVerification: pendingVerification,
    };

    await env.FFX_KV.put(IX_STATUS_KEY, JSON.stringify(statusRecord), { expirationTtl: IX_STATUS_TTL });
    await env.FFX_KV.put('indexing:history:' + today, JSON.stringify({
      date:            today,
      totalUrls:       urls.length,
      indexedCount:    indexed.length,
      notIndexedCount: notIndexed.length,
      submittedCount:  submittedNow.length,
      newlyIndexed:    newlyIndexed,
      newlyDropped:    newlyDropped,
    }), { expirationTtl: IX_HISTORY_TTL });

    // Update learning
    try {
      var learning = await env.FFX_KV.get('indexing:learning', { type: 'json' }).catch(function() { return { runs: 0, causeCounts: {} }; });
      learning.runs = (learning.runs || 0) + 1;
      learning.lastRun = today;
      learning.causeCounts = learning.causeCounts || {};
      notIndexed.forEach(function(n) { learning.causeCounts[n.cause] = (learning.causeCounts[n.cause] || 0) + 1; });
      await env.FFX_KV.put('indexing:learning', JSON.stringify(learning));
    } catch(e) {}

    // Clear progress
    try { await env.FFX_KV.delete(IX_PROGRESS_KEY); } catch(e) {}

    console.log('[indexing-engine] Complete — indexed:' + indexed.length + ' not-indexed:' + notIndexed.length + ' submitted:' + submittedNow.length + ' newlyIndexed:' + newlyIndexed.length);

    return statusRecord;

  } catch (err) {
    console.error('[indexing-engine] Fatal:', err.message);
    try { await env.FFX_KV.delete(IX_PROGRESS_KEY); } catch(e) {}
    return { error: err.message };
  }
}

// Build pending-verification list
// Tracks fixes we applied and whether Google has confirmed them yet
async function ixBuildPendingVerification(env, notIndexed, submittedNow, prevStatus) {
  var existing = {};
  try {
    var prev = await env.FFX_KV.get('indexing:pending_verification', { type: 'json' }).catch(function() { return []; });
    (prev || []).forEach(function(p) { existing[p.url] = p; });
  } catch(e) {}

  var submittedSet = {};
  submittedNow.forEach(function(u) { submittedSet[u] = true; });

  var notIndexedSet = {};
  notIndexed.forEach(function(n) { notIndexedSet[n.url] = true; });

  // Add newly submitted URLs to pending list
  for (var i = 0; i < submittedNow.length; i++) {
    var u = submittedNow[i];
    if (!existing[u]) {
      existing[u] = {
        url:          u,
        action:       'submitted_to_google',
        fixedAt:      new Date().toISOString(),
        verifyAfter:  new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
        status:       'pending',
        note:         'Submitted to Google Indexing API — check back in 14 days',
      };
    }
  }

  // Also track canonical fixes (blog.html fix deployed — these should self-resolve)
  // Check if any previously-canonical-mismatch URLs are now indexed
  var result = [];
  var keys = Object.keys(existing);
  for (var j = 0; j < keys.length; j++) {
    var item = existing[keys[j]];
    // If now indexed — mark verified
    if ((prevStatus) && (prevStatus.indexed || []).some(function(idx) { return idx.url === item.url; })) {
      item.status = 'verified_fixed';
      item.verifiedAt = new Date().toISOString();
    }
    // If still not indexed and past verify window — mark needs review
    if (item.status === 'pending' && new Date(item.verifyAfter) < new Date()) {
      if (notIndexedSet[item.url]) {
        item.status = 'still_not_indexed';
        item.note   = 'Fix applied but page still not indexed after 14+ days — needs manual review';
      } else {
        item.status = 'verified_fixed';
        item.verifiedAt = new Date().toISOString();
      }
    }
    result.push(item);
  }

  // Write back
  try { await env.FFX_KV.put('indexing:pending_verification', JSON.stringify(result)); } catch(e) {}
  return result;
}

// OAuth token refresh (replicates google-auth.js logic for cron Worker context)

async function ixGetOAuthToken(env) {
  if (!env.GOOGLE_REFRESH_TOKEN || !env.GOOGLE_CLIENT_SECRET) return null;
  try {
    var cached    = await env.FFX_KV.get('google:access_token',        { type: 'text' }).catch(function() { return null; });
    var cachedExp = await env.FFX_KV.get('google:access_token_expiry', { type: 'text' }).catch(function() { return null; });
    if (cached && cachedExp && Date.now() < parseInt(cachedExp) - 60000) return cached;

    var body = 'client_id='     + encodeURIComponent(env.GOOGLE_CLIENT_ID || IX_CLIENT_ID) +
               '&client_secret=' + encodeURIComponent(env.GOOGLE_CLIENT_SECRET) +
               '&refresh_token=' + encodeURIComponent(env.GOOGLE_REFRESH_TOKEN) +
               '&grant_type=refresh_token';
    var res  = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
    });
    if (!res.ok) return null;
    var data = await res.json();
    if (!data.access_token) return null;
    var exp = Date.now() + (data.expires_in || 3600) * 1000;
    await env.FFX_KV.put('google:access_token',        data.access_token, { expirationTtl: 3300 });
    await env.FFX_KV.put('google:access_token_expiry', String(exp),       { expirationTtl: 3300 });
    return data.access_token;
  } catch(e) { return null; }
}

// Service account token (JWT) for Google Indexing API
async function ixGetServiceAccountToken(env) {
  var serviceAccountEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  var privateKeyPem       = env.GOOGLE_PRIVATE_KEY_PEM;
  if (!serviceAccountEmail || !privateKeyPem) return null;
  try {
    var now     = Math.floor(Date.now() / 1000);
    var header  = { alg: 'RS256', typ: 'JWT' };
    var payload = {
      iss:   serviceAccountEmail,
      scope: 'https://www.googleapis.com/auth/indexing',
      aud:   'https://oauth2.googleapis.com/token',
      exp:   now + 3600,
      iat:   now,
    };
    var encode = function(obj) {
      return btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    };
    var unsignedToken = encode(header) + '.' + encode(payload);
    var pemContents = privateKeyPem
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\n/g, '').replace(/\r/g, '').trim();

    var binaryKey = Uint8Array.from(atob(pemContents), function(c) { return c.charCodeAt(0); });
    var cryptoKey = await crypto.subtle.importKey(
      'pkcs8', binaryKey.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
    );
    var encoder   = new TextEncoder();
    var signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(unsignedToken));
    var sigB64    = btoa(String.fromCharCode.apply(null, new Uint8Array(signature)))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    var jwt = unsignedToken + '.' + sigB64;
    var tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
    });
    var tokenData = await tokenRes.json();
    return tokenData.access_token || null;
  } catch(e) { console.error('[indexing-engine] SA token error:', e.message); return null; }
}

// Build full URL list from KV article records + static pages
async function ixBuildUrlList(env) {
  var urls = IX_STATIC_PAGES.slice();
  try {
    var kvList      = await env.FFX_KV.list({ prefix: 'article:' });
    var articleKeys = kvList.keys.filter(function(k) { return k.name.indexOf('article:links:') === -1; });
    for (var i = 0; i < articleKeys.length; i++) {
      var meta = await env.FFX_KV.get(articleKeys[i].name, { type: 'json' }).catch(function() { return null; });
      if (!meta || !meta.slug) continue;
      var articleUrl = IX_SITE_BASE + '/article?slug=' + meta.slug;
      if (urls.indexOf(articleUrl) === -1) urls.push(articleUrl);
    }
  } catch(e) { console.error('[indexing-engine] URL list error (non-fatal):', e.message); }
  return urls;
}

// Inspect a single URL via Search Console URL Inspection API
async function ixInspectUrl(oauthToken, pageUrl) {
  try {
    var res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + oauthToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl: IX_SC_PROPERTY }),
    });
    if (!res.ok) { return { url: pageUrl, error: 'HTTP ' + res.status }; }
    var data        = await res.json();
    var idxResult   = data.inspectionResult || {};
    var idxStatus   = idxResult.indexStatusResult || {};
    return {
      url:            pageUrl,
      verdict:        idxStatus.verdict          || 'VERDICT_UNSPECIFIED',
      coverageState:  idxStatus.coverageState    || null,
      robotsTxtState: idxStatus.robotsTxtState   || null,
      indexingState:  idxStatus.indexingState    || null,
      lastCrawlTime:  idxStatus.lastCrawlTime    || null,
      pageFetchState: idxStatus.pageFetchState   || null,
      canonicalUrl:   idxStatus.googleCanonical  || null,
      userCanonical:  idxStatus.userCanonical    || null,
    };
  } catch(e) { return { url: pageUrl, error: e.message }; }
}

// Classify root cause from inspection result
function ixClassify(r) {
  var coverage = (r.coverageState    || '').toLowerCase();
  var robots   = (r.robotsTxtState   || '').toLowerCase();
  var fetch_   = (r.pageFetchState   || '').toLowerCase();
  var indexing = (r.indexingState    || '').toLowerCase();
  if (robots   === 'blocked')                                           return 'robots_blocked';
  if (fetch_.indexOf('redirect')     !== -1)                           return 'redirect';
  if (fetch_.indexOf('not_found')    !== -1 || coverage.indexOf('not found') !== -1) return 'soft_404';
  if (indexing  === 'indexing_not_allowed' || coverage.indexOf('noindex') !== -1) return 'noindex';
  if (r.canonicalUrl && r.userCanonical && r.canonicalUrl !== r.userCanonical) return 'canonical_mismatch';
  if (coverage.indexOf('crawled') !== -1 && coverage.indexOf('not indexed') !== -1) return 'thin_content';
  if (coverage.indexOf('duplicate') !== -1)                            return 'thin_content';
  if (coverage.indexOf('discovered') !== -1)                           return 'not_submitted';
  if (!r.lastCrawlTime)                                                return 'not_submitted';
  return 'unknown';
}

// Submit URL to Google Indexing API
async function ixSubmitUrl(saToken, pageUrl) {
  try {
    var res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + saToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pageUrl, type: 'URL_UPDATED' }),
    });
    if (!res.ok) { console.error('[indexing-engine] Submit failed for ' + pageUrl + ': ' + res.status); return false; }
    return true;
  } catch(e) { return false; }
}

function ixSleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
