// functions/api/ga4-signals.js
// GET /api/ga4-signals → returns latest ga4:signals from KV
// POST /api/ga4-signals → triggers fresh signal collection

const PROPERTY_ID   = '534628287';
const SIGNALS_KEY   = 'ga4:signals';
const LEARNING_KEY  = 'ga4:learning';
const CONV_KEY      = 'ga4:conversions';

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
    const baseUrl  = new URL(request.url).origin;
    const authRes  = await fetch(`${baseUrl}/api/google-auth`);
    const authData = await authRes.json();
    if (!authData.access_token) return new Response(JSON.stringify({ error: 'Auth failed: ' + (authData.error||'unknown') }), { status: 500, headers });
    const token = authData.access_token;

    const now     = new Date();
    const endDate = new Date(now); endDate.setDate(endDate.getDate() - 1);
    const start7  = new Date(endDate); start7.setDate(start7.getDate() - 7);
    const start28 = new Date(endDate); start28.setDate(start28.getDate() - 28);
    const prevEnd = new Date(start7); prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 7);

    const fmt = d => d.toISOString().split('T')[0];

    const [overview7, prevOverview7, pages7, sources7, countries7, devices7, channels7, newReturn7] = await Promise.all([
      ga4Query(token, { dateRanges: [{ startDate: fmt(start7), endDate: fmt(endDate) }], metrics: [{ name:'activeUsers' },{ name:'sessions' },{ name:'averageSessionDuration' },{ name:'bounceRate' }] }),
      ga4Query(token, { dateRanges: [{ startDate: fmt(prevStart), endDate: fmt(prevEnd) }], metrics: [{ name:'activeUsers' },{ name:'sessions' },{ name:'averageSessionDuration' },{ name:'bounceRate' }] }),
      ga4Query(token, { dateRanges: [{ startDate: fmt(start7), endDate: fmt(endDate) }], dimensions: [{ name:'pagePath' }], metrics: [{ name:'sessions' },{ name:'averageSessionDuration' },{ name:'bounceRate' }], limit: 15, orderBys: [{ metric: { metricName:'sessions' }, desc: true }] }),
      ga4Query(token, { dateRanges: [{ startDate: fmt(start7), endDate: fmt(endDate) }], dimensions: [{ name:'sessionSource' }], metrics: [{ name:'sessions' }], limit: 8, orderBys: [{ metric: { metricName:'sessions' }, desc: true }] }),
      ga4Query(token, { dateRanges: [{ startDate: fmt(start7), endDate: fmt(endDate) }], dimensions: [{ name:'country' }], metrics: [{ name:'activeUsers' }], limit: 5, orderBys: [{ metric: { metricName:'activeUsers' }, desc: true }] }),
      ga4Query(token, { dateRanges: [{ startDate: fmt(start7), endDate: fmt(endDate) }], dimensions: [{ name:'deviceCategory' }], metrics: [{ name:'sessions' }] }),
      ga4Query(token, { dateRanges: [{ startDate: fmt(start7), endDate: fmt(endDate) }], dimensions: [{ name:'sessionDefaultChannelGroup' }], metrics: [{ name:'activeUsers' },{ name:'sessions' }], orderBys: [{ metric: { metricName:'sessions' }, desc: true }] }),
      ga4Query(token, { dateRanges: [{ startDate: fmt(start7), endDate: fmt(endDate) }], dimensions: [{ name:'newVsReturning' }], metrics: [{ name:'activeUsers' }] }),
    ]);

    const c = overview7.rows?.[0]?.metricValues || [];
    const p = prevOverview7.rows?.[0]?.metricValues || [];
    const users    = parseInt(c[0]?.value||0);
    const sessions = parseInt(c[1]?.value||0);
    const dur      = parseFloat(c[2]?.value||0);
    const bounce   = parseFloat(c[3]?.value||0);
    const pUsers   = parseInt(p[0]?.value||0);
    const pSess    = parseInt(p[1]?.value||0);
    const pDur     = parseFloat(p[2]?.value||0);
    const pBounce  = parseFloat(p[3]?.value||0);

    const userDelta  = pUsers ? ((users-pUsers)/pUsers*100)   : null;
    const sessDelta  = pSess  ? ((sessions-pSess)/pSess*100)  : null;
    const durDelta   = pDur   ? ((dur-pDur)/pDur*100)         : null;
    const bounceDelta = pBounce ? ((bounce-pBounce)/pBounce*100) : null;

    // Engagement quality score
    const eqs = Math.round(Math.min(dur/180*40,40) + Math.min((1-bounce)*40,40) + Math.min(users/500*20,20));

    // Best traffic source
    const sources = (sources7.rows||[]).map(r => ({ source: r.dimensionValues[0].value, sessions: parseInt(r.metricValues[0].value) }));

    // Top pages
    const allPages = (pages7.rows||[]).map(r => ({
      path:     r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
      duration: parseFloat(r.metricValues[1].value),
      bounce:   parseFloat(r.metricValues[2].value),
    }));
    const topPages    = allPages.slice(0,5);
    const articles    = allPages.filter(r => r.path.includes('/article'));
    const bestContent = allPages.sort((a,b) => b.duration - a.duration)[0] || null;
    const highBounce  = allPages.filter(r => r.bounce > 0.70 && r.sessions > 2);

    // New vs returning
    const nrRows   = newReturn7.rows||[];
    const retUsers = parseInt(nrRows.find(r=>r.dimensionValues[0].value==='returning')?.metricValues[0].value||0);
    const retPct   = users ? (retUsers/users*100) : 0;

    // Momentum
    let momentum = 'stable';
    if (userDelta !== null && userDelta > 15) momentum = 'accelerating';
    else if (userDelta !== null && userDelta > 0) momentum = 'growing';
    else if (userDelta !== null && userDelta < -10) momentum = 'declining';

    const signals = {
      generatedAt: now.toISOString(),
      period:      { start: fmt(start7), end: fmt(endDate) },
      totals:      { users, sessions, avgDuration: dur, bounceRate: bounce },
      prevTotals:  { users: pUsers, sessions: pSess, avgDuration: pDur, bounceRate: pBounce },
      deltas:      { users: userDelta, sessions: sessDelta, duration: durDelta, bounce: bounceDelta },
      momentum,
      engagementQualityScore: eqs,
      returningUserPct: retPct,
      bestTrafficSource:  sources[0]?.source || 'direct',
      bestContentPage:    bestContent ? { path: bestContent.path, duration: bestContent.duration } : null,
      highBouncePages:    highBounce.map(r => ({ path: r.path, bounce: r.bounce, sessions: r.sessions })).slice(0,3),
      topPages,
      topArticles:  articles.slice(0,5),
      topSources:   sources.slice(0,5),
      topCountries: (countries7.rows||[]).map(r => ({ country: r.dimensionValues[0].value, users: parseInt(r.metricValues[0].value) })),
      devices:      (devices7.rows||[]).map(r => ({ device: r.dimensionValues[0].value, sessions: parseInt(r.metricValues[0].value) })),
      channels:     (channels7.rows||[]).map(r => ({ channel: r.dimensionValues[0].value, users: parseInt(r.metricValues[0].value), sessions: parseInt(r.metricValues[1].value) })),
    };

    await env.FFX_KV.put(SIGNALS_KEY, JSON.stringify(signals));
    await updateGA4Learning(env, signals);

    console.log('[ffx-ga4-signals] Signals written:', JSON.stringify({ momentum, eqs, users }));
    return new Response(JSON.stringify({ success: true, signals }), { status: 200, headers });

  } catch(err) {
    console.error('[ffx-ga4-signals] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

async function updateGA4Learning(env, signals) {
  try {
    const existing = await env.FFX_KV.get(LEARNING_KEY, { type: 'json' }).catch(() => null);
    const entries  = Array.isArray(existing) ? existing : [];
    const lastEntry = entries[entries.length - 1];
    if (lastEntry && lastEntry.week === signals.period.start) return;

    entries.push({
      week:        signals.period.start,
      momentum:    signals.momentum,
      users:       signals.totals.users,
      sessions:    signals.totals.sessions,
      eqs:         signals.engagementQualityScore,
      bounceRate:  signals.totals.bounceRate,
      avgDuration: signals.totals.avgDuration,
      bestSource:  signals.bestTrafficSource,
      bestContent: signals.bestContentPage?.path || null,
      retPct:      signals.returningUserPct,
    });

    await env.FFX_KV.put(LEARNING_KEY, JSON.stringify(entries.slice(-12)));
  } catch(e) {
    console.error('[ffx-ga4-signals] Learning error:', e.message);
  }
}

async function ga4Query(token, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('GA4 API ' + res.status + ': ' + await res.text());
  return res.json();
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }});
}
