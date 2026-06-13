// functions/api/newsletter-performance.js
// GET  /api/newsletter-performance?date=YYYY-MM-DD — fetch stats for one issue
// POST /api/newsletter-performance — fetch stats for all issues missing stats
// Calls Brevo GET /v3/emailCampaigns/{id} and enriches newsletter:performance:{date}

var BREVO_API     = 'https://api.brevo.com/v3';
var CORS_HEADERS  = {
  'Content-Type':                 'application/json',
  'Access-Control-Allow-Origin':  '*',
};

// ── GET — fetch stats for a single issue by date ──────────────────────────
export async function onRequestGet(context) {
  var env = context.env;
  var url = new URL(context.request.url);
  var date = url.searchParams.get('date');

  if (!date) return new Response(JSON.stringify({ error: 'date param required (YYYY-MM-DD)' }), { status: 400, headers: CORS_HEADERS });
  if (!env.BREVO_API_KEY) return new Response(JSON.stringify({ error: 'BREVO_API_KEY not set' }), { status: 500, headers: CORS_HEADERS });

  try {
    var result = await fetchAndWriteStats(date, env);
    return new Response(JSON.stringify(result), { status: result.error ? 400 : 200, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// ── POST — fetch stats for ALL issues that are missing stats ──────────────
// Run this from dashboard to backfill all past issues
export async function onRequestPost(context) {
  var env = context.env;
  if (!env.BREVO_API_KEY) return new Response(JSON.stringify({ error: 'BREVO_API_KEY not set' }), { status: 500, headers: CORS_HEADERS });

  try {
    var index = await env.FFX_KV.get('newsletter:index', { type: 'json' }).catch(function() { return []; });
    if (!Array.isArray(index) || !index.length) {
      return new Response(JSON.stringify({ message: 'No issues in index yet.' }), { status: 200, headers: CORS_HEADERS });
    }

    var results = [];
    for (var i = 0; i < index.length; i++) {
      var entry = index[i];
      if (!entry.date) continue;

      // Check if stats already fetched
      var perf = await env.FFX_KV.get('newsletter:performance:' + entry.date, { type: 'json' }).catch(function() { return null; });
      if (perf && perf.statsUpdatedAt && perf.openRate !== null) {
        results.push({ date: entry.date, status: 'already_have_stats', openRate: perf.openRate });
        continue;
      }

      // Check if 48hrs have passed since send
      var sentAt = perf && perf.sentAt ? new Date(perf.sentAt) : null;
      if (sentAt && (Date.now() - sentAt.getTime()) < 48 * 3600 * 1000) {
        results.push({ date: entry.date, status: 'too_early', message: 'Less than 48hrs since send' });
        continue;
      }

      var result = await fetchAndWriteStats(entry.date, env);
      results.push(result);

      // Small delay between Brevo API calls
      await new Promise(function(r) { setTimeout(r, 300); });
    }

    return new Response(JSON.stringify({ success: true, results: results }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// ── Core: fetch stats from Brevo and write back to KV ────────────────────
async function fetchAndWriteStats(date, env) {
  // Read existing performance record
  var perf = await env.FFX_KV.get('newsletter:performance:' + date, { type: 'json' }).catch(function() { return null; });
  if (!perf) return { date: date, status: 'error', error: 'No performance record found for ' + date };
  if (!perf.campaignId) return { date: date, status: 'error', error: 'No campaignId in performance record' };

  // Fetch from Brevo
  var res = await fetch(BREVO_API + '/emailCampaigns/' + perf.campaignId, {
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    var errText = await res.text();
    return { date: date, status: 'error', error: 'Brevo API ' + res.status + ': ' + errText.substring(0, 200) };
  }

  var campaign = await res.json();
  var stats    = campaign.statistics && campaign.statistics.campaignStats && campaign.statistics.campaignStats[0];

  if (!stats) return { date: date, status: 'error', error: 'No stats in Brevo response yet — try again later' };

  var delivered    = stats.delivered    || 0;
  var opens        = stats.uniqueViews  || 0;
  var clicks       = stats.uniqueClicks || 0;
  var unsubscribes = stats.unsubscriptions || 0;

  var openRate  = delivered > 0 ? Math.round((opens  / delivered) * 1000) / 10 : 0; // e.g. 42.3
  var clickRate = delivered > 0 ? Math.round((clicks / delivered) * 1000) / 10 : 0;

  // Enrich performance record
  var enriched = Object.assign({}, perf, {
    delivered:        delivered,
    uniqueOpens:      opens,
    uniqueClicks:     clicks,
    unsubscribeCount: unsubscribes,
    openRate:         openRate,
    clickRate:        clickRate,
    statsUpdatedAt:   new Date().toISOString(),
  });

  await env.FFX_KV.put('newsletter:performance:' + date, JSON.stringify(enriched));

  console.log('[newsletter-performance] Stats written for ' + date + ': openRate=' + openRate + '% clickRate=' + clickRate + '%');

  return {
    date:        date,
    status:      'updated',
    issueNumber: perf.issueNumber,
    delivered:   delivered,
    openRate:    openRate,
    clickRate:   clickRate,
    unsubscribeCount: unsubscribes,
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
