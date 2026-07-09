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
//   URL Inspection API  — OAuth refresh token (GOOGLE_REFRESH_TOKEN) — diagnostic reads only
//   (Indexing API auto-submit REMOVED — BK1; it was improper for article URLs and never fired.
//    Submission to Google is now the operator's manual GSC Request-Indexing action.)
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

// Static page set now comes from the SINGLE shared source of truth
// (functions/_seo-pages.js) so it can never drift from the sitemap generator.
// The previous hardcoded list was missing /newsletter, /joinfree, /contact.
import { STATIC_PAGE_URLS } from '../_seo-pages.js';
var IX_STATIC_PAGES = STATIC_PAGE_URLS;

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

// ── PATCH — mark a URL as submitted to GSC ──────────────────────────────────
// Body: { url: 'https://...', action: 'mark_submitted' }
// Writes to indexing:pending_verification KV
// Removes URL from notIndexed in indexing:status so it leaves Action Required

export async function onRequestPatch(context) {
  var env = context.env;
  try {
    var body   = await context.request.json().catch(function() { return {}; });
    var url    = body.url;
    var action = body.action || 'mark_submitted';
    if (!url) return new Response(JSON.stringify({ error: 'url required' }), { status: 400, headers: CORS_HEADERS });

    var existing = await env.FFX_KV.get('indexing:pending_verification', { type: 'json' }).catch(function() { return []; });
    var list = Array.isArray(existing) ? existing : [];
    var idx  = -1;
    for (var i = 0; i < list.length; i++) { if (list[i].url === url) { idx = i; break; } }

    if (action === 'mark_submitted') {
      var now2 = new Date().toISOString();
      var entry = {
        url:                 url,
        action:              'submitted_to_gsc_manually',
        fixedAt:             now2,
        submittedAt:         now2,
        manuallySubmittedAt: now2,
        verifyAfter:         new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        status:              'pending',
        note:                'Manually submitted via GSC Request Indexing',
      };
      if (idx === -1) { list.push(entry); }
      else {
        // Resubmit — reset the clock, keep history, preserve first submission date
        list[idx].submittedAt         = now2;
        list[idx].manuallySubmittedAt = now2;
        list[idx].verifyAfter         = entry.verifyAfter;
        list[idx].status              = 'pending';
        list[idx].resubmittedAt       = now2;
        list[idx].note                = 'Resubmitted via GSC Request Indexing';
        delete list[idx].overdueAt;
        delete list[idx].currentCause;
        delete list[idx].currentVerdict;
        delete list[idx].currentReason;
      }
    } else if (action === 'snooze') {
      var days = body.days || 7;
      if (idx !== -1) {
        list[idx].status       = 'snoozed';
        list[idx].snoozedUntil = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
        list[idx].snoozedAt    = new Date().toISOString();
        list[idx].note         = 'Snoozed for ' + days + ' days';
      }
    } else if (action === 'ignore') {
      if (idx !== -1) {
        list[idx].status   = 'ignored';
        list[idx].ignoredAt = new Date().toISOString();
        list[idx].note     = 'Manually ignored — will not surface again';
      }
    }

    await env.FFX_KV.put('indexing:pending_verification', JSON.stringify(list));

    // Sync to indexing:status — update notIndexed and pendingVerification
    var status = await env.FFX_KV.get(IX_STATUS_KEY, { type: 'json' }).catch(function() { return null; });
    if (status) {
      if (action === 'mark_submitted' && Array.isArray(status.notIndexed)) {
        status.notIndexed      = status.notIndexed.filter(function(p) { return p.url !== url; });
        status.notIndexedCount = status.notIndexed.length;
      }
      if (!Array.isArray(status.pendingVerification)) status.pendingVerification = [];
      var pidx = -1;
      for (var pi = 0; pi < status.pendingVerification.length; pi++) {
        if (status.pendingVerification[pi].url === url) { pidx = pi; break; }
      }
      var matched = list.filter(function(p) { return p.url === url; })[0] || null;
      if (matched) {
        if (pidx === -1) status.pendingVerification.push(matched);
        else status.pendingVerification[pidx] = matched;
      }
      await env.FFX_KV.put(IX_STATUS_KEY, JSON.stringify(status), { expirationTtl: IX_STATUS_TTL });
    }

    return new Response(JSON.stringify({ success: true, url: url, action: action }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
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

    // Step 3: Inspect all URLs in parallel — CF batches at 6 concurrent, no timeout risk
    var results = await Promise.all(
      urls.map(function(url) { return ixInspectUrl(oauthToken, url); })
    );
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
    await writeIndexProgress(env, 5, 6, 'Finalizing analysis');

    // Step 5 (removed — BK1): the Google Indexing-API auto-submit was improper
    // (article URLs are not eligible — the Indexing API only supports JobPosting /
    // BroadcastEvent) and never actually fired (GOOGLE_PRIVATE_KEY_PEM is not set).
    // Removed. `submittedNow` stays an empty array so Step 6 and
    // ixBuildPendingVerification keep working unchanged (submittedCount 0, graceful).
    // Eligible pages are submitted MANUALLY by the operator via GSC Request-Indexing;
    // the dashboard "Mark Submitted" button (PATCH) records that in KV — no Google call.
    var submittedNow = [];
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
    var pendingVerification = await ixBuildPendingVerification(env, notIndexed, submittedNow, prevStatus, indexed);

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
async function ixBuildPendingVerification(env, notIndexed, submittedNow, prevStatus, indexed) {
  var existing = {};
  try {
    var prev = await env.FFX_KV.get('indexing:pending_verification', { type: 'json' }).catch(function() { return []; });
    (prev || []).forEach(function(p) { existing[p.url] = p; });
  } catch(e) {}

  var submittedSet = {};
  submittedNow.forEach(function(u) { submittedSet[u] = true; });

  var notIndexedSet = {};
  notIndexed.forEach(function(n) { notIndexedSet[n.url] = true; });

  // Only mark verified if Google EXPLICITLY confirmed indexing — not just absence from notIndexed
  var confirmedIndexedSet = {};
  (indexed || []).forEach(function(p) { confirmedIndexedSet[p.url] = true; });

  // FIX: Reset any falsely verified_fixed records — if Google still says not indexed, revert to pending
  var keys0 = Object.keys(existing);
  for (var fi = 0; fi < keys0.length; fi++) {
    var fitem = existing[keys0[fi]];
    if (fitem.status === 'verified_fixed' && notIndexedSet[fitem.url]) {
      // Was marked verified but Google still says not indexed — restore to pending
      fitem.status      = 'pending';
      fitem.verifyAfter = new Date(new Date(fitem.manuallySubmittedAt || fitem.fixedAt || Date.now()).getTime() + 3 * 24 * 3600 * 1000).toISOString();
      fitem.note        = 'Restored from incorrect verified_fixed status — still not indexed per Google';
      delete fitem.verifiedAt;
    }
  }

  // Add newly submitted URLs to pending list
  for (var i = 0; i < submittedNow.length; i++) {
    var u = submittedNow[i];
    if (!existing[u]) {
      existing[u] = {
        url:          u,
        action:       'submitted_to_google',
        fixedAt:      new Date().toISOString(),
        verifyAfter:  new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        status:       'pending',
        note:         'Submitted to Google Indexing API — check back in 3 days',
      };
    }
  }

  // Build notIndexed lookup map with full cause/verdict data for overdue context
  var notIndexedMap = {};
  notIndexed.forEach(function(n) { notIndexedMap[n.url] = n; });

  var result = [];
  var keys = Object.keys(existing);
  for (var j = 0; j < keys.length; j++) {
    var item = existing[keys[j]];

    // Skip permanently ignored items
    if (item.status === 'ignored') { result.push(item); continue; }

    // If snoozed — check if snooze period has passed
    if (item.status === 'snoozed' && item.snoozedUntil) {
      if (new Date(item.snoozedUntil) > new Date()) {
        result.push(item); continue; // still snoozed — skip processing
      } else {
        item.status = 'pending'; // snooze expired — back to pending
        delete item.snoozedUntil;
      }
    }

    // If Google explicitly confirmed indexed — mark verified
    var currentlySeen = notIndexedMap[item.url];
    var isIndexedNow  = confirmedIndexedSet[item.url] === true;
    if (isIndexedNow) {
      item.status = 'verified_fixed';
      item.verifiedAt = new Date().toISOString();
    }

    // If still not indexed and past verify window — mark overdue with current Google verdict
    if (item.status === 'pending' && new Date(item.verifyAfter) < new Date()) {
      if (notIndexedSet[item.url]) {
        item.status      = 'still_not_indexed';
        item.overdueAt   = item.overdueAt || new Date().toISOString();
        // Attach current Google verdict so dashboard can show the actual error
        if (currentlySeen) {
          item.currentCause   = currentlySeen.cause   || null;
          item.currentVerdict = currentlySeen.verdict || null;
          item.currentReason  = currentlySeen.rawReason || null;
        }
        item.note = 'Still not indexed after 3+ days — see current Google status below';
      } else {
        item.status = 'verified_fixed';
        item.verifiedAt = new Date().toISOString();
      }
    }

    // Refresh current cause even for already-overdue items (updates each scan)
    if (item.status === 'still_not_indexed' && currentlySeen) {
      item.currentCause   = currentlySeen.cause   || null;
      item.currentVerdict = currentlySeen.verdict || null;
      item.currentReason  = currentlySeen.rawReason || null;
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

// (removed — BK1) ixGetServiceAccountToken: minted the service-account JWT used only
// by the removed Indexing-API auto-submit. No remaining callers.

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

// (removed — BK1) ixSubmitUrl: the improper POST to Google's Indexing API
// (urlNotifications:publish) for article URLs. Removed; no remaining callers.

function ixSleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
