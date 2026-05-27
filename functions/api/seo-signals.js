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
    // Get fresh access token via auth helper
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

    // Run all SC queries in parallel
    const [curr7, prev7, pages28, queries28, countries7] = await Promise.all([
      scQuery(token, { startDate: fmt(start7),  endDate: fmt(endDate), dimensions: [] }),
      scQuery(token, { startDate: fmt(prevStart), endDate: fmt(prevEnd), dimensions: [] }),
      scQuery(token, { startDate: fmt(start28), endDate: fmt(endDate), dimensions: ['page'], rowLimit: 25 }),
      scQuery(token, { startDate: fmt(start28), endDate: fmt(endDate), dimensions: ['query'], rowLimit: 20 }),
      scQuery(token, { startDate: fmt(start7),  endDate: fmt(endDate), dimensions: ['country'], rowLimit: 5 }),
    ]);

    const currRow  = curr7.rows?.[0]  || {};
    const prevRow  = prev7.rows?.[0]  || {};
    const pages    = pages28.rows    || [];
    const queries  = queries28.rows  || [];
    const countries = countries7.rows || [];

    // Rising queries — impressions grew vs prev week
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

    // Zero-click opportunities — impressions but no clicks
    const zeroClick = pages
      .filter(r => r.impressions >= 3 && r.clicks === 0)
      .map(r => ({ url: r.keys[0].replace('https://fortitudefx.com','') || '/', impressions: r.impressions, position: r.position }))
      .slice(0, 5);

    // Page 2 opportunities — positions 11-20
    const page2 = pages
      .filter(r => r.position > 10 && r.position <= 20)
      .map(r => ({ url: r.keys[0].replace('https://fortitudefx.com','') || '/', position: r.position, impressions: r.impressions, clicks: r.clicks }))
      .slice(0, 5);

    // Best performing topic — page with most clicks
    const bestPage = pages.filter(r => r.clicks > 0).sort((a,b) => b.clicks - a.clicks)[0] || null;

    // Article-specific performance
    const articles = pages.filter(r => r.keys[0].includes('/article'));

    // Momentum
    const imprDelta = prevRow.impressions ? ((currRow.impressions||0) - prevRow.impressions) / prevRow.impressions * 100 : null;
    const clickDelta = prevRow.clicks ? ((currRow.clicks||0) - prevRow.clicks) / prevRow.clicks * 100 : null;
    let momentum = 'stable';
    if (imprDelta > 15) momentum = 'accelerating';
    else if (imprDelta > 0) momentum = 'growing';
    else if (imprDelta < -10) momentum = 'declining';

    const signals = {
      generatedAt:   now.toISOString(),
      period:        { start: fmt(start7), end: fmt(endDate) },
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
      bestPage:    bestPage ? { url: bestPage.keys[0].replace('https://fortitudefx.com',''), clicks: bestPage.clicks, position: bestPage.position } : null,
      articleCount: articles.length,
      topCountries: countries.map(r => ({ country: r.keys[0], clicks: r.clicks, impressions: r.impressions })),
      totalIndexedPages: pages.length,
    };

    // Write signals to KV — overwrites daily
    await env.FFX_KV.put(SIGNALS_KEY, JSON.stringify(signals));

    // Update learning — append weekly summary, keep last 12
    await updateLearning(env, signals);

    console.log('[ffx-seo-signals] Signals written:', JSON.stringify({ momentum, risingQueries: risingQueries.length, zeroClick: zeroClick.length }));

    return new Response(JSON.stringify({ success: true, signals }), { status: 200, headers });

  } catch(err) {
    console.error('[ffx-seo-signals] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

async function updateLearning(env, signals) {
  try {
    const existing = await env.FFX_KV.get(LEARNING_KEY, { type: 'json' }).catch(() => null);
    const entries  = Array.isArray(existing) ? existing : [];

    // Only append if last entry is from a different week
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

    // Keep last 12 weeks
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
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }});
}
