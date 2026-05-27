// functions/api/seo-signals.js
// GET /api/seo-signals → returns latest seo:signals from KV
// POST /api/seo-signals → triggers fresh signal collection (called by cron)

const SC_PROPERTY = 'sc-domain:fortitudefx.com';
const SIGNALS_KEY  = 'seo:signals';
const LEARNING_KEY = 'seo:learning';

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const signals = await env.FFX_KV.get(SIGNALS_KEY, { type: 'json' }).catch(() => null);
    return new Response(JSON.stringify({ signals: signals || null }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    const baseUrl   = new URL(request.url).origin;
    const authRes   = await fetch(`${baseUrl}/api/google-auth`);
    const authData  = await authRes.json();
    if (!authData.access_token) return new Response(JSON.stringify({ error: 'Auth failed: ' + (authData.error||'unknown') }), { status: 500, headers });
    const token = authData.access_token;

    const now     = new Date();
    const endDate = new Date(now); endDate.setDate(endDate.getDate() - 1);
    const start7  = new Date(endDate); start7.setDate(start7.getDate() - 7);
    const start28 = new Date(endDate); start28.setDate(start28.getDate() - 28);
    const prevEnd = new Date(start7);  prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 7);

    const fmt = d => d.toISOString().split('T')[0];

    const [curr7, prev7, pages28, queries28, countries7] = await Promise.all([
      scQuery(token, { startDate: fmt(start7),  endDate: fmt(endDate), dimensions: [] }),
      scQuery(token, { startDate: fmt(prevStart), endDate: fmt(prevEnd), dimensions: [] }),
      scQuery(token, { startDate: fmt(start28), endDate: fmt(endDate), dimensions: ['page'], rowLimit: 25 }),
      scQuery(token, { startDate: fmt(start28), endDate: fmt(endDate), dimensions: ['query'], rowLimit: 20 }),
      scQuery(token, { startDate: fmt(start7),  endDate: fmt(endDate), dimensions: ['country'], rowLimit: 5 }),
    ]);

    const currRow   = curr7.rows?.[0]   || {};
    const prevRow   = prev7.rows?.[0]   || {};
    const pages     = pages28.rows      || [];
    const queries   = queries28.rows    || [];
    const countries = countries7.rows   || [];

    const [prevQueries] = await Promise.all([
      scQuery(token, { startDate: fmt(prevStart), endDate: fmt(prevEnd), dimensions: ['query'], rowLimit: 20 }),
    ]);
    const prevQMap = {};
    (prevQueries.rows||[]).forEach(r => { prevQMap[r.keys[0]] = r.impressions; });
    const risingQueries = queries
      .filter(r => r.impressions > 0)
      .map(r => ({ query: r.keys[0], impressions: r.impressions, clicks: r.clicks, position: r.position, prevImpressions: prevQMap[r.keys[0]] || 0 }))
      .filter(r => r.impressions > (r.prevImpressions || 0))
      .sort((a,b) => (b.impressions - b.prevImpressions) - (a.impressions - a.prevImpressions))
      .slice(0, 5);

    const zeroClick = pages
      .filter(r => r.impressions >= 3 && r.clicks === 0)
      .map(r => ({ url: r.keys[0].replace('https://fortitudefx.com','') || '/', impressions: r.impressions, position: r.position }))
      .slice(0, 5);

    const page2 = pages
      .filter(r => r.position > 10 && r.position <= 20)
      .map(r => ({ url: r.keys[0].replace('https://fortitudefx.com','') || '/', position: r.position, impressions: r.impressions, clicks: r.clicks }))
      .slice(0, 5);

    const bestPage   = pages.filter(r => r.clicks > 0).sort((a,b) => b.clicks - a.clicks)[0] || null;
    const articles   = pages.filter(r => r.keys[0].includes('/article'));

    const imprDelta  = prevRow.impressions ? ((currRow.impressions||0) - prevRow.impressions) / prevRow.impressions * 100 : null;
    const clickDelta = prevRow.clicks      ? ((currRow.clicks||0)      - prevRow.clicks)      / prevRow.clicks      * 100 : null;
    let momentum = 'stable';
    if (imprDelta > 15)  momentum = 'accelerating';
    else if (imprDelta > 0)   momentum = 'growing';
    else if (imprDelta < -10) momentum = 'declining';

    const signals = {
      generatedAt: now.toISOString(),
      period:      { start: fmt(start7), end: fmt(endDate) },
      totals: {
        clicks:      currRow.clicks      || 0,
        impressions: currRow.impressions  || 0,
        ctr:         currRow.ctr         || 0,
        position:    currRow.position    || 0,
      },
      prevTotals: {
        clicks:      prevRow.clicks      || 0,
        impressions: prevRow.impressions  || 0,
        ctr:         prevRow.ctr         || 0,
        position:    prevRow.position    || 0,
      },
      momentum,
      imprDelta,
      clickDelta,
      risingQueries,
      zeroClickOpportunities: zeroClick,
      page2Opportunities:     page2,
      bestPage: bestPage ? { url: bestPage.keys[0].replace('https://fortitudefx.com',''), clicks: bestPage.clicks, position: bestPage.position } : null,
      articleCount:      articles.length,
      topCountries:      countries.map(r => ({ country: r.keys[0], clicks: r.clicks, impressions: r.impressions })),
      totalIndexedPages: pages.length,
    };

    await env.FFX_KV.put(SIGNALS_KEY, JSON.stringify(signals));
    await updateLearning(env, signals);

    // ── SURGICAL ADDITION: Check title tests daily ────────────────────────
    await checkTitleTests(env, token, pages);

    console.log('[ffx-seo-signals] Signals written:', JSON.stringify({ momentum, risingQueries: risingQueries.length, zeroClick: zeroClick.length }));
    return new Response(JSON.stringify({ success: true, signals }), { status: 200, headers });

  } catch(err) {
    console.error('[ffx-seo-signals] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

// ── TITLE TEST MONITORING ─────────────────────────────────────────────────
// Runs daily — checks all monitoring title tests, writes result at 14 days

async function checkTitleTests(env, token, pages) {
  try {
    // List all title tests with status: monitoring
    const list = await env.FFX_KV.list({ prefix: 'seo:title_tests:' }).catch(() => null);
    if (!list || !list.keys.length) return;

    const now = new Date();

    for (const key of list.keys) {
      try {
        const test = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
        if (!test || test.status !== 'monitoring') continue;

        const changedAt  = new Date(test.changedAt);
        const daysSince  = (now - changedAt) / (1000 * 60 * 60 * 24);

        // Find current metrics for this page in the already-fetched pages data
        const pageUrl = `https://fortitudefx.com/article?slug=${test.slug}`;
        const pageRow = pages.find(r => r.keys[0] === pageUrl);

        const currentClicks      = pageRow?.clicks      || 0;
        const currentImpressions = pageRow?.impressions  || 0;
        const currentPosition    = pageRow?.position     || null;
        const currentCtr         = currentImpressions > 0 ? currentClicks / currentImpressions : 0;

        // Update with latest metrics regardless of day count
        test.positionAfter    = currentPosition;
        test.ctrAfter         = currentCtr;
        test.clicksAfter      = currentClicks;
        test.impressionsAfter = currentImpressions;

        // At 14 days — write final result
        if (daysSince >= 14) {
          const baselineCtr    = test.ctrAtChange    || 0;
          const baselineClicks = test.clicksAtChange || 0;

          // Improvement: CTR improved OR clicks improved (with at least some impressions)
          const ctrImproved    = currentCtr > baselineCtr + 0.005; // 0.5% CTR improvement threshold
          const clicksImproved = currentClicks > baselineClicks && currentImpressions >= 3;

          test.improvement  = ctrImproved || clicksImproved;
          test.result       = test.improvement
            ? `CTR improved from ${(baselineCtr*100).toFixed(1)}% to ${(currentCtr*100).toFixed(1)}%. Clicks: ${baselineClicks} → ${currentClicks}.`
            : `No significant improvement. CTR: ${(baselineCtr*100).toFixed(1)}% → ${(currentCtr*100).toFixed(1)}%. Clicks: ${baselineClicks} → ${currentClicks}.`;
          test.status       = 'complete';
          test.completedAt  = now.toISOString();

          // Update intelligence:brief_log accuracy if this test came from a brief recommendation
          if (test.improvement) {
            await updateBriefLogAccuracy(env, test.slug, test.improvement);
          }

          console.log(`[ffx-seo-signals] Title test complete for ${test.slug}: ${test.improvement ? 'IMPROVED' : 'no improvement'}`);
        }

        await env.FFX_KV.put(key.name, JSON.stringify(test));

      } catch(testErr) {
        console.error('[ffx-seo-signals] Title test check error for key', key.name, ':', testErr.message);
      }
    }
  } catch(e) {
    console.error('[ffx-seo-signals] checkTitleTests error (non-fatal):', e.message);
  }
}

// ── UPDATE BRIEF LOG ACCURACY ─────────────────────────────────────────────
// When a title rewrite succeeds — find the matching brief_log and mark accurate

async function updateBriefLogAccuracy(env, slug, improved) {
  try {
    // List recent brief logs (last 30 days)
    const list = await env.FFX_KV.list({ prefix: 'intelligence:brief_log:' }).catch(() => null);
    if (!list || !list.keys.length) return;

    for (const key of list.keys) {
      try {
        const log = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
        if (!log || !log.recommendations) continue;

        let updated = false;
        for (const rec of log.recommendations) {
          if (rec.type === 'title_rewrite' && rec.target && rec.target.includes(slug) && rec.accurate === null) {
            rec.accurate  = improved;
            rec.actedOn   = rec.actedOn || new Date().toISOString();
            rec.outcome   = improved ? 'CTR improved after title rewrite' : 'No improvement detected';
            updated = true;
          }
        }

        if (updated) {
          await env.FFX_KV.put(key.name, JSON.stringify(log));
          console.log('[ffx-seo-signals] Brief log accuracy updated for:', key.name);
        }
      } catch {}
    }
  } catch(e) {
    console.error('[ffx-seo-signals] updateBriefLogAccuracy error (non-fatal):', e.message);
  }
}

async function updateLearning(env, signals) {
  try {
    const existing = await env.FFX_KV.get(LEARNING_KEY, { type: 'json' }).catch(() => null);
    const entries  = Array.isArray(existing) ? existing : [];
    const lastEntry = entries[entries.length - 1];
    const thisWeek  = signals.period.start;
    if (lastEntry && lastEntry.week === thisWeek) return;

    entries.push({
      week:        thisWeek,
      momentum:    signals.momentum,
      clicks:      signals.totals.clicks,
      impressions: signals.totals.impressions,
      position:    signals.totals.position,
      risingTopics: signals.risingQueries.map(q => q.query),
      bestPage:    signals.bestPage?.url || null,
      articleCount: signals.articleCount,
    });

    const trimmed = entries.slice(-12);
    await env.FFX_KV.put(LEARNING_KEY, JSON.stringify(trimmed));
  } catch(e) {
    console.error('[ffx-seo-signals] Learning update error:', e.message);
  }
}

async function scQuery(token, body) {
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SC_PROPERTY)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('SC API ' + res.status + ': ' + await res.text());
  return res.json();
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
