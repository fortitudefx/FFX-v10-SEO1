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

    // ── Check title tests daily ───────────────────────────────────────────
    await checkTitleTests(env, token, pages);

    // ── ITEM 1: Update content:performance snapshots at 7/30/90 days ─────
    await updateContentPerformanceSnapshots(env, pages);

    // ── ITEM 3: Weekly accuracy scoring (Mondays only) ────────────────────
    const dayOfWeek = now.getDay();
    if (dayOfWeek === 1) {
      await updateAccuracyScores(env);
    }

    console.log('[ffx-seo-signals] Signals written:', JSON.stringify({ momentum, risingQueries: risingQueries.length, zeroClick: zeroClick.length }));
    return new Response(JSON.stringify({ success: true, signals }), { status: 200, headers });

  } catch(err) {
    console.error('[ffx-seo-signals] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

// ── ITEM 1: CONTENT PERFORMANCE SNAPSHOTS ────────────────────────────────
// Runs daily — checks all published content:performance entries
// Writes snapshot7, snapshot30, snapshot90 based on days since publishedAt
// Also detects article_brief recommendation outcomes for brief_log

async function updateContentPerformanceSnapshots(env, pages) {
  try {
    const now = new Date();

    // Build a URL → metrics map from already-fetched Search Console pages
    const pageMetrics = {};
    for (const row of pages) {
      const url = row.keys[0];
      const slug = url.includes('?slug=') ? url.split('?slug=')[1] : null;
      if (slug) {
        pageMetrics[slug] = {
          position:    row.position    || null,
          impressions: row.impressions || 0,
          clicks:      row.clicks      || 0,
          ctr:         row.impressions > 0 ? row.clicks / row.impressions : 0,
        };
      }
    }

    // Read ga4:signals for session duration and bounce rate per article
    const ga4Signals = await env.FFX_KV.get('ga4:signals', { type: 'json' }).catch(() => null);
    const ga4ArticleMap = {};
    if (ga4Signals?.topArticles) {
      for (const a of ga4Signals.topArticles) {
        const slug = a.path?.includes('slug=') ? a.path.split('slug=')[1] : null;
        if (slug) {
          ga4ArticleMap[slug] = {
            sessions:        a.sessions      || 0,
            avgDuration:     a.duration      || 0,
            bounceRate:      a.bounce        || null,
          };
        }
      }
    }

    // List all content:performance keys
    const list = await env.FFX_KV.list({ prefix: 'content:performance:' }).catch(() => null);
    if (!list || !list.keys.length) return;

    for (const key of list.keys) {
      try {
        const perf = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
        if (!perf || !perf.publishedAt || perf.status !== 'published') continue;

        const publishedAt = new Date(perf.publishedAt);
        const daysSince   = (now - publishedAt) / (1000 * 60 * 60 * 24);
        const slug        = perf.slug;
        const scMetrics   = pageMetrics[slug] || null;
        const ga4Metrics  = ga4ArticleMap[slug] || null;
        let updated       = false;

        const buildSnapshot = () => ({
          takenAt:      now.toISOString(),
          position:     scMetrics?.position     || null,
          impressions:  scMetrics?.impressions  || 0,
          clicks:       scMetrics?.clicks       || 0,
          ctr:          scMetrics?.ctr          || 0,
          sessions:     ga4Metrics?.sessions    || 0,
          avgDuration:  ga4Metrics?.avgDuration || 0,
          bounceRate:   ga4Metrics?.bounceRate  || null,
        });

        // snapshot7 — write once at 7+ days if not yet taken
        if (daysSince >= 7 && !perf.snapshot7) {
          perf.snapshot7 = buildSnapshot();
          updated = true;
          console.log(`[ffx-seo-signals] snapshot7 written for: ${slug}`);

          // ITEM 2: Check if this article matches an article_brief recommendation
          await matchArticleBriefRecommendation(env, perf, 7);
        }

        // snapshot30 — write once at 30+ days if not yet taken
        if (daysSince >= 30 && !perf.snapshot30) {
          perf.snapshot30 = buildSnapshot();
          updated = true;
          console.log(`[ffx-seo-signals] snapshot30 written for: ${slug}`);

          // ITEM 2+3: Update brief_log outcome and write intelligence:outcomes
          await matchArticleBriefRecommendation(env, perf, 30);
        }

        // snapshot90 — write once at 90+ days if not yet taken
        if (daysSince >= 90 && !perf.snapshot90) {
          perf.snapshot90 = buildSnapshot();
          updated = true;
          console.log(`[ffx-seo-signals] snapshot90 written for: ${slug}`);

          await matchArticleBriefRecommendation(env, perf, 90);
        }

        if (updated) {
          await env.FFX_KV.put(key.name, JSON.stringify(perf));
        }

      } catch(perfErr) {
        console.error('[ffx-seo-signals] Snapshot error for key', key.name, ':', perfErr.message);
      }
    }
  } catch(e) {
    console.error('[ffx-seo-signals] updateContentPerformanceSnapshots error (non-fatal):', e.message);
  }
}

// ── ITEM 2: MATCH ARTICLE BRIEF RECOMMENDATIONS ───────────────────────────
// When a content:performance snapshot is taken — find matching brief_log
// article_brief recommendation and write outcome + intelligence:outcomes

async function matchArticleBriefRecommendation(env, perf, day) {
  try {
    const list = await env.FFX_KV.list({ prefix: 'intelligence:brief_log:' }).catch(() => null);
    if (!list || !list.keys.length) return;

    for (const key of list.keys) {
      try {
        const log = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
        if (!log || !log.recommendations) continue;

        let updated = false;

        for (const rec of log.recommendations) {
          if (rec.type !== 'article_brief') continue;
          if (rec.accurate !== null) continue; // already resolved

          // Match: targetQuery in brief matches targetQuery in content:performance
          const briefQuery = (rec.target || '').toLowerCase().trim();
          const perfQuery  = (perf.targetQuery || '').toLowerCase().trim();
          if (!briefQuery || !perfQuery || briefQuery !== perfQuery) continue;

          // Article is ranked — determine accuracy
          const snapshot   = day === 7  ? perf.snapshot7
                           : day === 30 ? perf.snapshot30
                           :              perf.snapshot90;
          const position   = snapshot?.position || null;
          const impressions = snapshot?.impressions || 0;

          // accurate = true if ranked in top 50 within 30 days (has any impressions)
          const accurate = day <= 30
            ? (impressions > 0 && position !== null && position <= 50)
            : (impressions > 0);

          rec.actedOn  = rec.actedOn || perf.publishedAt || new Date().toISOString();
          rec.outcome  = position
            ? `Position ${position.toFixed(1)}, ${impressions} impressions at day ${day}`
            : `No impressions yet at day ${day}`;
          rec.accurate = accurate;
          updated = true;

          // ITEM 3: Write intelligence:outcomes:{rec_id}
          await writeOutcome(env, rec, perf, snapshot, day, accurate);

          console.log(`[ffx-seo-signals] article_brief outcome written — rec: ${rec.id}, accurate: ${accurate}, day: ${day}`);
        }

        if (updated) {
          await env.FFX_KV.put(key.name, JSON.stringify(log));
        }

      } catch {}
    }
  } catch(e) {
    console.error('[ffx-seo-signals] matchArticleBriefRecommendation error (non-fatal):', e.message);
  }
}

// ── ITEM 3: WRITE intelligence:outcomes:{rec_id} ──────────────────────────
// Per-recommendation outcome record — full lifecycle tracking

async function writeOutcome(env, rec, perf, snapshot, day, accurate) {
  try {
    const outcomeKey = `intelligence:outcomes:${rec.id}`;
    const existing   = await env.FFX_KV.get(outcomeKey, { type: 'json' }).catch(() => null);

    const outcome = {
      recId:            rec.id,
      briefId:          rec.id.split('_')[0] || null,
      type:             rec.type,
      target:           rec.target,
      slug:             perf.slug,
      actedOnAt:        perf.publishedAt || null,
      measurementDay:   day,
      measurementStart: perf.publishedAt || null,
      measurementEnd:   new Date().toISOString(),
      baselineMetrics: {
        targetQuery:   perf.targetQuery || null,
        briefVersion:  perf.briefVersion || null,
        wordCount:     perf.wordCount || 0,
      },
      outcomeMetrics: {
        position:     snapshot?.position     || null,
        impressions:  snapshot?.impressions  || 0,
        clicks:       snapshot?.clicks       || 0,
        ctr:          snapshot?.ctr          || 0,
        sessions:     snapshot?.sessions     || 0,
        avgDuration:  snapshot?.avgDuration  || 0,
      },
      accurate,
      notes: accurate
        ? `Ranked at position ${snapshot?.position?.toFixed(1)} with ${snapshot?.impressions} impressions at day ${day}`
        : `No ranking signal detected at day ${day}`,
      // Preserve any existing data from earlier snapshots
      ...(existing || {}),
    };

    // Always update with latest snapshot data
    outcome.outcomeMetrics  = {
      position:     snapshot?.position     || null,
      impressions:  snapshot?.impressions  || 0,
      clicks:       snapshot?.clicks       || 0,
      ctr:          snapshot?.ctr          || 0,
      sessions:     snapshot?.sessions     || 0,
      avgDuration:  snapshot?.avgDuration  || 0,
    };
    outcome.accurate        = accurate;
    outcome.measurementDay  = day;
    outcome.measurementEnd  = new Date().toISOString();

    await env.FFX_KV.put(outcomeKey, JSON.stringify(outcome));
    console.log(`[ffx-seo-signals] intelligence:outcomes written for: ${rec.id}`);
  } catch(e) {
    console.error('[ffx-seo-signals] writeOutcome error (non-fatal):', e.message);
  }
}

// ── ITEM 3: WEEKLY ACCURACY SCORING ──────────────────────────────────────
// Runs every Monday — reads all intelligence:outcomes entries
// Calculates accuracy per recommendation type
// Appends to intelligence:accuracy_scores (last 12 weeks)

async function updateAccuracyScores(env) {
  try {
    const now        = new Date();
    const weekEnding = now.toISOString().split('T')[0];

    // Read all outcome records
    const list = await env.FFX_KV.list({ prefix: 'intelligence:outcomes:' }).catch(() => null);
    if (!list || !list.keys.length) {
      console.log('[ffx-seo-signals] No outcomes to score yet');
      return;
    }

    const byType = {};
    let totalMade = 0, totalActed = 0, totalMeasured = 0, totalAccurate = 0;

    for (const key of list.keys) {
      try {
        const outcome = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
        if (!outcome) continue;

        const type = outcome.type || 'unknown';
        if (!byType[type]) {
          byType[type] = { made: 0, actedOn: 0, measured: 0, accurate: 0 };
        }

        byType[type].made++;
        totalMade++;

        if (outcome.actedOnAt) {
          byType[type].actedOn++;
          totalActed++;
        }

        if (outcome.accurate !== null && outcome.accurate !== undefined) {
          byType[type].measured++;
          totalMeasured++;
          if (outcome.accurate === true) {
            byType[type].accurate++;
            totalAccurate++;
          }
        }
      } catch {}
    }

    // Calculate accuracy rates
    const byTypeRates = {};
    for (const [type, counts] of Object.entries(byType)) {
      byTypeRates[type] = {
        made:       counts.made,
        actedOn:    counts.actedOn,
        measured:   counts.measured,
        accurate:   counts.accurate,
        accuracyRate:     counts.measured > 0 ? counts.accurate / counts.measured : null,
        usefulnessRate:   counts.made     > 0 ? counts.actedOn  / counts.made     : null,
      };
    }

    const weekScore = {
      weekEnding,
      totalRecommendations: totalMade,
      actedOn:              totalActed,
      usefulnessRate:       totalMade     > 0 ? totalActed    / totalMade     : null,
      totalMeasured,
      accurateCount:        totalAccurate,
      accuracyRate:         totalMeasured > 0 ? totalAccurate / totalMeasured : null,
      byType:               byTypeRates,
      mostActedOnType:      Object.entries(byTypeRates).sort((a,b) => (b[1].actedOn||0) - (a[1].actedOn||0))[0]?.[0] || null,
      leastActedOnType:     Object.entries(byTypeRates).sort((a,b) => (a[1].actedOn||0) - (b[1].actedOn||0))[0]?.[0] || null,
      scoredAt:             now.toISOString(),
    };

    // Append to history — keep last 12 weeks
    const existing = await env.FFX_KV.get('intelligence:accuracy_scores', { type: 'json' }).catch(() => null);
    const history  = Array.isArray(existing) ? existing : [];
    const filtered = history.filter(w => w.weekEnding !== weekEnding); // replace if same week
    filtered.push(weekScore);
    const trimmed = filtered.slice(-12);

    await env.FFX_KV.put('intelligence:accuracy_scores', JSON.stringify(trimmed));
    console.log(`[ffx-seo-signals] Accuracy scores updated — week: ${weekEnding}, accuracy: ${weekScore.accuracyRate?.toFixed(2) || 'N/A'}, usefulness: ${weekScore.usefulnessRate?.toFixed(2) || 'N/A'}`);

  } catch(e) {
    console.error('[ffx-seo-signals] updateAccuracyScores error (non-fatal):', e.message);
  }
}

// ── TITLE TEST MONITORING ─────────────────────────────────────────────────
// Runs daily — checks all monitoring title tests, writes result at 14 days

async function checkTitleTests(env, token, pages) {
  try {
    const list = await env.FFX_KV.list({ prefix: 'seo:title_tests:' }).catch(() => null);
    if (!list || !list.keys.length) return;

    const now = new Date();

    for (const key of list.keys) {
      try {
        const test = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
        if (!test || test.status !== 'monitoring') continue;

        const changedAt  = new Date(test.changedAt);
        const daysSince  = (now - changedAt) / (1000 * 60 * 60 * 24);

        const pageUrl = `https://fortitudefx.com/article?slug=${test.slug}`;
        const pageRow = pages.find(r => r.keys[0] === pageUrl);

        const currentClicks      = pageRow?.clicks      || 0;
        const currentImpressions = pageRow?.impressions  || 0;
        const currentPosition    = pageRow?.position     || null;
        const currentCtr         = currentImpressions > 0 ? currentClicks / currentImpressions : 0;

        test.positionAfter    = currentPosition;
        test.ctrAfter         = currentCtr;
        test.clicksAfter      = currentClicks;
        test.impressionsAfter = currentImpressions;

        if (daysSince >= 14) {
          const baselineCtr    = test.ctrAtChange    || 0;
          const baselineClicks = test.clicksAtChange || 0;

          const ctrImproved    = currentCtr > baselineCtr + 0.005;
          const clicksImproved = currentClicks > baselineClicks && currentImpressions >= 3;

          test.improvement  = ctrImproved || clicksImproved;
          test.result       = test.improvement
            ? `CTR improved from ${(baselineCtr*100).toFixed(1)}% to ${(currentCtr*100).toFixed(1)}%. Clicks: ${baselineClicks} → ${currentClicks}.`
            : `No significant improvement. CTR: ${(baselineCtr*100).toFixed(1)}% → ${(currentCtr*100).toFixed(1)}%. Clicks: ${baselineClicks} → ${currentClicks}.`;
          test.status       = 'complete';
          test.completedAt  = now.toISOString();

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
