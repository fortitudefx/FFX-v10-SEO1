// ─────────────────────────────────────────────────────────────────────────────
// FFX Indexing Engine
// POST /api/indexing-engine → run full indexing scan (called by cron Step 8)
// GET  /api/indexing-engine → return latest indexing:status from KV
// GET  /api/indexing-engine?history=1 → return indexing:history records
//
// Auth:
//   URL Inspection API  — OAuth refresh token (same as google-auth.js)
//   Google Indexing API — Service account JWT (GOOGLE_SERVICE_ACCOUNT_EMAIL +
//                         GOOGLE_PRIVATE_KEY_PEM env vars on cron Worker,
//                         passed via request body from cron Step 8)
//
// KV keys written:
//   indexing:status           — current run results (25hr TTL)
//   indexing:history:{date}   — daily snapshot (90 day TTL)
//   indexing:queue            — URLs pending resubmission (permanent)
//   indexing:learning         — fix success patterns (permanent)
// ─────────────────────────────────────────────────────────────────────────────

const SC_PROPERTY         = 'sc-domain:fortitudefx.com';
const SITE_BASE           = 'https://fortitudefx.com';
const STATUS_KEY          = 'indexing:status';
const LEARNING_KEY        = 'indexing:learning';
const QUEUE_KEY           = 'indexing:queue';
const STATUS_TTL          = 90000;   // 25 hours
const HISTORY_TTL         = 7776000; // 90 days

// Static pages that should always be indexed
const STATIC_PAGES = [
  SITE_BASE + '/',
  SITE_BASE + '/blog',
  SITE_BASE + '/bootcamp',
  SITE_BASE + '/vipdiscord',
  SITE_BASE + '/waitlist',
  SITE_BASE + '/privacy',
];

// Root cause labels
var CAUSE_NOT_SUBMITTED      = 'not_submitted';
var CAUSE_CANONICAL_MISMATCH = 'canonical_mismatch';
var CAUSE_THIN_CONTENT       = 'thin_content';
var CAUSE_ROBOTS_BLOCKED     = 'robots_blocked';
var CAUSE_REDIRECT           = 'redirect';
var CAUSE_SOFT_404           = 'soft_404';
var CAUSE_NOINDEX            = 'noindex';
var CAUSE_OTHER              = 'other';
var CAUSE_UNKNOWN            = 'unknown';

var CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// ─────────────────────────────────────────────────────────────────────────────
// GET — return status or history
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  var env     = context.env;
  var request = context.request;
  var url     = new URL(request.url);

  try {
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

    var status = await env.FFX_KV.get(STATUS_KEY, { type: 'json' }).catch(function() { return null; });
    return new Response(JSON.stringify({ status: status || null }), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — run full indexing scan
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  var env     = context.env;
  var request = context.request;
  var baseUrl = new URL(request.url).origin;

  try {
    var body = await request.json().catch(function() { return {}; });
    // Service account credentials passed from cron worker env vars
    var serviceAccountEmail = body.serviceAccountEmail || null;
    var privateKeyPem       = body.privateKeyPem       || null;

    console.log('[indexing-engine] Starting indexing scan');

    // ── Step 1: Get OAuth token for URL Inspection API ────────────────────
    var authRes  = await fetch(baseUrl + '/api/google-auth');
    var authData = await authRes.json();
    if (!authData.access_token) {
      return new Response(JSON.stringify({ error: 'Google auth failed: ' + (authData.error || 'unknown') }), { status: 500, headers: CORS_HEADERS });
    }
    var oauthToken = authData.access_token;
    console.log('[indexing-engine] OAuth token acquired');

    // ── Step 2: Build full URL list ───────────────────────────────────────
    var urls = await buildUrlList(env);
    console.log('[indexing-engine] URL list built: ' + urls.length + ' URLs');

    // ── Step 3: Inspect each URL via Search Console URL Inspection API ────
    var results = [];
    for (var i = 0; i < urls.length; i++) {
      var url = urls[i];
      var inspection = await inspectUrl(oauthToken, url);
      results.push(inspection);
      // Throttle — URL Inspection API is rate limited (600 req/min)
      if (i > 0 && i % 10 === 0) {
        await sleep(1000);
      }
    }
    console.log('[indexing-engine] Inspected ' + results.length + ' URLs');

    // ── Step 4: Classify each non-indexed URL ─────────────────────────────
    var indexed       = [];
    var notIndexed    = [];
    var submittedNow  = [];
    var errors        = [];

    for (var j = 0; j < results.length; j++) {
      var r = results[j];
      if (r.error) {
        errors.push({ url: r.url, error: r.error });
        continue;
      }
      if (r.verdict === 'PASS' || r.indexingState === 'INDEXING_ALLOWED' && r.verdict !== 'FAIL') {
        indexed.push({ url: r.url, lastCrawled: r.lastCrawlTime || null });
      } else {
        var cause = classifyRootCause(r);
        notIndexed.push({
          url:         r.url,
          verdict:     r.verdict        || 'UNKNOWN',
          indexingState: r.indexingState || 'UNKNOWN',
          robotsState: r.robotsTxtState  || 'UNKNOWN',
          cause:       cause,
          lastCrawled: r.lastCrawlTime   || null,
          rawReason:   r.coverageState   || null,
        });
      }
    }

    // ── Step 5: Submit fixable URLs to Google Indexing API ────────────────
    var indexingApiAvailable = !!(serviceAccountEmail && privateKeyPem);
    if (indexingApiAvailable) {
      console.log('[indexing-engine] Service account available — submitting URLs');
      var saToken = await getGoogleAccessToken(serviceAccountEmail, privateKeyPem);
      if (saToken) {
        for (var k = 0; k < notIndexed.length; k++) {
          var item = notIndexed[k];
          // Submit: not yet found, or canonical mismatch (now fixed), or discovered not indexed
          if (
            item.cause === CAUSE_NOT_SUBMITTED ||
            item.cause === CAUSE_CANONICAL_MISMATCH ||
            item.cause === CAUSE_UNKNOWN
          ) {
            var submitted = await submitToIndexingApi(saToken, item.url);
            item.submittedAt   = submitted ? new Date().toISOString() : null;
            item.submitSuccess = submitted;
            if (submitted) submittedNow.push(item.url);
          }
        }
        console.log('[indexing-engine] Submitted ' + submittedNow.length + ' URLs to Indexing API');
      } else {
        console.error('[indexing-engine] Service account token failed — skipping Indexing API submission');
      }
    } else {
      console.log('[indexing-engine] No service account credentials — skipping Indexing API submission');
    }

    // ── Step 6: Detect newly indexed and newly dropped vs yesterday ───────
    var prevStatus = await env.FFX_KV.get(STATUS_KEY, { type: 'json' }).catch(function() { return null; });
    var newlyIndexed  = [];
    var newlyDropped  = [];

    if (prevStatus && Array.isArray(prevStatus.notIndexed)) {
      var prevNotIndexedUrls = {};
      for (var pi = 0; pi < prevStatus.notIndexed.length; pi++) {
        prevNotIndexedUrls[prevStatus.notIndexed[pi].url] = true;
      }
      var prevIndexedUrls = {};
      if (Array.isArray(prevStatus.indexed)) {
        for (var pj = 0; pj < prevStatus.indexed.length; pj++) {
          prevIndexedUrls[prevStatus.indexed[pj].url] = true;
        }
      }
      // Newly indexed = was not indexed yesterday, is indexed today
      for (var ni = 0; ni < indexed.length; ni++) {
        if (prevNotIndexedUrls[indexed[ni].url]) {
          newlyIndexed.push(indexed[ni].url);
        }
      }
      // Newly dropped = was indexed yesterday, is not indexed today
      for (var nd = 0; nd < notIndexed.length; nd++) {
        if (prevIndexedUrls[notIndexed[nd].url]) {
          newlyDropped.push(notIndexed[nd].url);
        }
      }
    }

    // ── Step 7: Write indexing:status ─────────────────────────────────────
    var today = new Date().toISOString().split('T')[0];
    var statusRecord = {
      date:          today,
      runAt:         new Date().toISOString(),
      totalUrls:     urls.length,
      indexedCount:  indexed.length,
      notIndexedCount: notIndexed.length,
      submittedCount: submittedNow.length,
      errorCount:    errors.length,
      indexed:       indexed,
      notIndexed:    notIndexed,
      errors:        errors,
      newlyIndexed:  newlyIndexed,
      newlyDropped:  newlyDropped,
      indexingApiAvailable: indexingApiAvailable,
    };

    await env.FFX_KV.put(STATUS_KEY, JSON.stringify(statusRecord), { expirationTtl: STATUS_TTL });

    // ── Step 8: Write indexing:history:{date} ─────────────────────────────
    var historyRecord = {
      date:           today,
      totalUrls:      urls.length,
      indexedCount:   indexed.length,
      notIndexedCount: notIndexed.length,
      submittedCount: submittedNow.length,
      newlyIndexed:   newlyIndexed,
      newlyDropped:   newlyDropped,
      causes:         summariseCauses(notIndexed),
    };
    await env.FFX_KV.put('indexing:history:' + today, JSON.stringify(historyRecord), { expirationTtl: HISTORY_TTL });

    // ── Step 9: Update indexing:queue — remove submitted URLs ─────────────
    try {
      var queueRaw = await env.FFX_KV.get(QUEUE_KEY, { type: 'json' }).catch(function() { return []; });
      var queue    = Array.isArray(queueRaw) ? queueRaw : [];
      var submittedSet = {};
      for (var si = 0; si < submittedNow.length; si++) submittedSet[submittedNow[si]] = true;
      var remaining = queue.filter(function(u) { return !submittedSet[u.url]; });
      // Add newly identified fixable URLs not yet in queue
      for (var qi = 0; qi < notIndexed.length; qi++) {
        var ni2 = notIndexed[qi];
        if (
          (ni2.cause === CAUSE_NOT_SUBMITTED || ni2.cause === CAUSE_CANONICAL_MISMATCH) &&
          !ni2.submittedAt
        ) {
          var alreadyQueued = remaining.some(function(u) { return u.url === ni2.url; });
          if (!alreadyQueued) {
            remaining.push({ url: ni2.url, cause: ni2.cause, addedAt: new Date().toISOString() });
          }
        }
      }
      await env.FFX_KV.put(QUEUE_KEY, JSON.stringify(remaining));
    } catch (qErr) {
      console.error('[indexing-engine] Queue update failed (non-fatal):', qErr.message);
    }

    // ── Step 10: Update indexing:learning ────────────────────────────────
    try {
      var learning = await env.FFX_KV.get(LEARNING_KEY, { type: 'json' }).catch(function() { return { runs: 0, causeCounts: {}, fixSuccessRates: {} }; });
      learning.runs = (learning.runs || 0) + 1;
      learning.lastRun = today;
      learning.causeCounts = learning.causeCounts || {};
      for (var li = 0; li < notIndexed.length; li++) {
        var cause = notIndexed[li].cause;
        learning.causeCounts[cause] = (learning.causeCounts[cause] || 0) + 1;
      }
      // Track submission success rate
      if (submittedNow.length > 0) {
        learning.fixSuccessRates = learning.fixSuccessRates || {};
        learning.fixSuccessRates.totalSubmitted = (learning.fixSuccessRates.totalSubmitted || 0) + submittedNow.length;
      }
      await env.FFX_KV.put(LEARNING_KEY, JSON.stringify(learning));
    } catch (lErr) {
      console.error('[indexing-engine] Learning update failed (non-fatal):', lErr.message);
    }

    console.log(
      '[indexing-engine] Run complete. ' +
      'Indexed: ' + indexed.length +
      ' | Not indexed: ' + notIndexed.length +
      ' | Submitted: ' + submittedNow.length +
      ' | Newly indexed: ' + newlyIndexed.length +
      ' | Newly dropped: ' + newlyDropped.length
    );

    return new Response(JSON.stringify({
      success:        true,
      date:           today,
      indexedCount:   indexed.length,
      notIndexedCount: notIndexed.length,
      submittedCount: submittedNow.length,
      newlyIndexed:   newlyIndexed,
      newlyDropped:   newlyDropped,
    }), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    console.error('[indexing-engine] Fatal error:', err.message);
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

// ─────────────────────────────────────────────────────────────────────────────
// BUILD URL LIST
// Reads article:{slug} KV keys + static pages
// ─────────────────────────────────────────────────────────────────────────────

async function buildUrlList(env) {
  var urls = STATIC_PAGES.slice(); // copy static pages

  try {
    var kvList = await env.FFX_KV.list({ prefix: 'article:' });
    // Filter out article:links: keys — only want article:{slug} metadata keys
    var articleKeys = kvList.keys.filter(function(k) {
      return k.name.indexOf('article:links:') === -1;
    });

    for (var i = 0; i < articleKeys.length; i++) {
      var meta = await env.FFX_KV.get(articleKeys[i].name, { type: 'json' }).catch(function() { return null; });
      if (!meta || !meta.slug) continue;
      var articleUrl = SITE_BASE + '/article?slug=' + meta.slug;
      if (urls.indexOf(articleUrl) === -1) urls.push(articleUrl);
    }
  } catch (err) {
    console.error('[indexing-engine] KV article list failed (non-fatal):', err.message);
  }

  return urls;
}

// ─────────────────────────────────────────────────────────────────────────────
// INSPECT URL via Search Console URL Inspection API
// Uses OAuth token (same as google-auth.js / seo-signals.js)
// ─────────────────────────────────────────────────────────────────────────────

async function inspectUrl(oauthToken, pageUrl) {
  try {
    var res = await fetch(
      'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + oauthToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inspectionUrl: pageUrl,
          siteUrl:       SC_PROPERTY,
        }),
      }
    );

    if (!res.ok) {
      var errText = await res.text();
      console.error('[indexing-engine] URL inspection failed for ' + pageUrl + ': ' + res.status + ' ' + errText);
      return { url: pageUrl, error: 'HTTP ' + res.status };
    }

    var data         = await res.json();
    var indexResult  = data.inspectionResult || {};
    var indexStatus  = indexResult.indexStatusResult || {};
    var mobileResult = indexResult.mobileUsabilityResult || {};

    return {
      url:           pageUrl,
      verdict:       indexStatus.verdict         || 'VERDICT_UNSPECIFIED',
      coverageState: indexStatus.coverageState   || null,
      robotsTxtState: indexStatus.robotsTxtState || null,
      indexingState: indexStatus.indexingState   || null,
      lastCrawlTime: indexStatus.lastCrawlTime   || null,
      pageFetchState: indexStatus.pageFetchState || null,
      canonicalUrl:  indexStatus.googleCanonical || null,
      userCanonical: indexStatus.userCanonical   || null,
      mobileVerdict: mobileResult.verdict        || null,
    };

  } catch (err) {
    return { url: pageUrl, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFY ROOT CAUSE from inspection result
// ─────────────────────────────────────────────────────────────────────────────

function classifyRootCause(r) {
  var coverage = (r.coverageState || '').toLowerCase();
  var robots   = (r.robotsTxtState || '').toLowerCase();
  var fetch_   = (r.pageFetchState || '').toLowerCase();
  var indexing = (r.indexingState  || '').toLowerCase();

  if (robots === 'blocked') return CAUSE_ROBOTS_BLOCKED;
  if (fetch_.indexOf('redirect') !== -1) return CAUSE_REDIRECT;
  if (fetch_.indexOf('not_found') !== -1 || coverage.indexOf('not found') !== -1) return CAUSE_SOFT_404;
  if (indexing === 'indexing_not_allowed' || coverage.indexOf('noindex') !== -1) return CAUSE_NOINDEX;

  // Canonical mismatch: Google's canonical differs from user-declared canonical
  if (r.canonicalUrl && r.userCanonical && r.canonicalUrl !== r.userCanonical) {
    return CAUSE_CANONICAL_MISMATCH;
  }

  if (
    coverage.indexOf('crawled') !== -1 && coverage.indexOf('not indexed') !== -1 ||
    coverage.indexOf('duplicate') !== -1 ||
    coverage.indexOf('thin') !== -1
  ) {
    return CAUSE_THIN_CONTENT;
  }

  // Discovered or never submitted
  if (coverage.indexOf('discovered') !== -1 || coverage.indexOf('not crawled') !== -1) {
    return CAUSE_NOT_SUBMITTED;
  }

  if (!r.lastCrawlTime) return CAUSE_NOT_SUBMITTED;

  return CAUSE_UNKNOWN;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBMIT URL to Google Indexing API
// ─────────────────────────────────────────────────────────────────────────────

async function submitToIndexingApi(saToken, pageUrl) {
  try {
    var res = await fetch(
      'https://indexing.googleapis.com/v3/urlNotifications:publish',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + saToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url:  pageUrl,
          type: 'URL_UPDATED',
        }),
      }
    );

    if (!res.ok) {
      var errText = await res.text();
      console.error('[indexing-engine] Indexing API failed for ' + pageUrl + ': ' + res.status + ' ' + errText);
      return false;
    }

    console.log('[indexing-engine] Submitted: ' + pageUrl);
    return true;

  } catch (err) {
    console.error('[indexing-engine] Indexing API error for ' + pageUrl + ': ' + err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARISE CAUSES — for history record
// ─────────────────────────────────────────────────────────────────────────────

function summariseCauses(notIndexed) {
  var counts = {};
  for (var i = 0; i < notIndexed.length; i++) {
    var cause = notIndexed[i].cause;
    counts[cause] = (counts[cause] || 0) + 1;
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLEEP HELPER
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET GOOGLE ACCESS TOKEN — service account JWT
// Copied verbatim from publish.js — do not modify
// ─────────────────────────────────────────────────────────────────────────────

async function getGoogleAccessToken(serviceAccountEmail, privateKeyPem) {
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
    return btoa(JSON.stringify(obj))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  };

  var unsignedToken = encode(header) + '.' + encode(payload);

  var pemContents = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\\n/g, '').replace(/\n/g, '').trim();

  var binaryKey = Uint8Array.from(atob(pemContents), function(c) { return c.charCodeAt(0); });
  var cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );

  var encoder   = new TextEncoder();
  var signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(unsignedToken));
  var signatureB64 = btoa(String.fromCharCode.apply(null, new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  var jwt = unsignedToken + '.' + signatureB64;

  var tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });

  var tokenData = await tokenRes.json();
  return tokenData.access_token || null;
}
