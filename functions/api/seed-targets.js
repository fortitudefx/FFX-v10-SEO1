// functions/api/seed-targets.js
// POST /api/seed-targets → writes founding targets to intelligence:targets
// Run ONCE to initialise the target system
// After this, cron updates targets weekly automatically

export async function onRequestPost(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    const now     = new Date();
    const weekOf  = now.toISOString().split('T')[0];

    // ── FOUNDING TARGETS ─────────────────────────────────────────────────
    // Based on actual baseline data from KV:
    // SEO: 6 impressions/week, 1 click, position 40.2, 5 articles indexed
    // GA4: 22 users/week, 63 sessions, 617s avg duration, 46% bounce, 13.6% returning
    // Content: 1 article/day target, 4-5 LinkedIn posts/week
    // Discord: 180 free members
    // Email: 5 subscribers, 0 emails sent
    // Bootcamp: $980 USD

    const targets = {
      meta: {
        setAt:          now.toISOString(),
        version:        1,
        weekOf,
        weekNumber:     1,
        bootcampPrice:  980,
        currency:       'USD',
        note:           'Founding targets based on actual KV baseline data 2026-05-27'
      },

      founding: {
        // Exact baseline from seo:signals and ga4:signals in KV
        seo: {
          weeklyImpressions: 6,
          weeklyClicks:      1,
          avgPosition:       40.2,
          indexedPages:      5,
          zeroClickPages:    5,
          page1Rankings:     0,
        },
        ga4: {
          weeklyUsers:      22,
          weeklySessions:   63,
          avgDuration:      617,
          bounceRate:       0.46,
          returningUserPct: 13.6,
          organicSessions:  6,
          linkedInSessions: 28,
        },
        content: {
          articlesPerWeek:   0,
          linkedInPerWeek:   4,
          xThreadsPerWeek:   4,
          repliesPerWeek:    0,
        },
        community: {
          discordFreeMembers: 180,
          emailSubscribers:   5,
          emailSentCount:     0,
        },
        revenue: {
          bootcampPurchasesMonth: 0,
          bootcampPrice:          980,
        }
      },

      // ── WEEKLY MILESTONES ───────────────────────────────────────────────
      milestones: {
        week4: {
          seo: { impressions: 50, clicks: 5, position: 35, indexedPages: 15 },
          ga4: { users: 50, sessions: 120, avgDuration: 400, bounceRate: 0.55, returningPct: 15 },
          content: { articlesPerWeek: 5, linkedInPerWeek: 5 },
          community: { discordMembers: 220, emailSubscribers: 50 },
          revenue: { bootcampPurchases: 0 },
        },
        week8: {
          seo: { impressions: 200, clicks: 20, position: 28, indexedPages: 30, page1Rankings: 2 },
          ga4: { users: 120, sessions: 300, avgDuration: 350, bounceRate: 0.55, returningPct: 18 },
          content: { articlesPerWeek: 5, linkedInPerWeek: 5 },
          community: { discordMembers: 280, emailSubscribers: 150 },
          revenue: { bootcampPurchases: 1 },
        },
        week13: {
          seo: { impressions: 500, clicks: 50, position: 22, indexedPages: 50, page1Rankings: 5 },
          ga4: { users: 200, sessions: 500, avgDuration: 320, bounceRate: 0.52, returningPct: 22 },
          content: { articlesPerWeek: 5, linkedInPerWeek: 5 },
          community: { discordMembers: 350, emailSubscribers: 300 },
          revenue: { bootcampPurchases: 3 },
        },
      },

      // ── MONTHLY TARGETS ─────────────────────────────────────────────────
      monthly: {
        month3: {
          seo: { monthlyImpressions: 3000, monthlyClicks: 200, avgPosition: 20, indexedPages: 60, page1Rankings: 8 },
          ga4: { monthlyUsers: 600, monthlySessions: 1500, avgDuration: 300, bounceRate: 0.50, returningPct: 25 },
          community: { discordMembers: 400, emailSubscribers: 500 },
          revenue: { bootcampPurchases: 5, mrr: 4900 },
        },
        month6: {
          seo: { monthlyImpressions: 8000, monthlyClicks: 600, avgPosition: 12, indexedPages: 100, page1Rankings: 20 },
          ga4: { monthlyUsers: 2000, monthlySessions: 5000, avgDuration: 280, bounceRate: 0.48, returningPct: 30 },
          community: { discordMembers: 700, emailSubscribers: 1500 },
          revenue: { bootcampPurchases: 15, mrr: 14700 },
        },
        month12: {
          seo: { monthlyImpressions: 40000, monthlyClicks: 3000, avgPosition: 8, indexedPages: 180, page1Rankings: 40 },
          ga4: { monthlyUsers: 8000, monthlySessions: 20000, avgDuration: 260, bounceRate: 0.45, returningPct: 35 },
          community: { discordMembers: 2000, emailSubscribers: 5000 },
          revenue: { bootcampPurchases: 50, mrr: 49000 },
        },
      },

      // ── EARLY WARNING THRESHOLDS ─────────────────────────────────────────
      // If actual falls below these % of target for 2 consecutive weeks:
      // amber alert → adapt targets or increase cadence
      // If below for 4 consecutive weeks: red alert → urgent review
      earlyWarning: {
        amber: 0.70,  // 70% of target = amber warning
        red:   0.50,  // 50% of target = red alert
        rules: {
          contentBehind: 'Content output is upstream cause of all other gaps. If articles < 4/week for 2 weeks: amber. If < 2/week for 2 weeks: red. Primary corrective action before any other.',
          impressionsBehind: 'If impressions behind AND content on track: SEO strategy issue. Review article targeting and title formats.',
          usersBehind: 'If users behind AND impressions on track: distribution issue. Review LinkedIn and platform posting.',
          conversionsBehind: 'If conversions behind AND traffic on track: CTA or landing page issue. Review article CTAs and bootcamp page.',
        }
      },

      // ── ADAPTATION RULES ────────────────────────────────────────────────
      adaptationRules: {
        ahead2Weeks:    'If KPI hits 115%+ of target 2 consecutive weeks: next target = actual * 1.10',
        behind2Weeks:   'If KPI at 70-85% of target 2 weeks: investigate root cause before adjusting',
        critical2Weeks: 'If KPI below 70% of target 2 weeks: reduce target by 15% IF strategic gap. Hold target IF execution gap.',
        critical4Weeks: 'If KPI below 70% of target 4 weeks: red alert in digest, urgent review, consider structural change',
        contentRule:    'Content output target is NEVER reduced. It is the only target that must always be met. If behind: increase urgency, do not adjust down.',
        qualityRule:    'avgDuration and bounceRate targets are quality floors. Never sacrifice quality for volume.',
      },

      // ── CURRENT WEEK TRACKING ────────────────────────────────────────────
      current: {
        weekOf,
        weekNumber: 1,
        targets: {
          impressions:      { target: 15,  actual: null, status: null, weeklyTarget: true },
          clicks:           { target: 2,   actual: null, status: null, weeklyTarget: true },
          avgPosition:      { target: 38,  actual: null, status: null, direction: 'below', weeklyTarget: true },
          users:            { target: 30,  actual: null, status: null, weeklyTarget: true },
          sessions:         { target: 80,  actual: null, status: null, weeklyTarget: true },
          avgDuration:      { target: 400, actual: null, status: null, direction: 'above', weeklyTarget: true },
          bounceRate:       { target: 0.55, actual: null, status: null, direction: 'below', weeklyTarget: true },
          articlesPublished:{ target: 7,   actual: null, status: null, weeklyTarget: true, note: '1/day = 7/week' },
          linkedInPosts:    { target: 5,   actual: null, status: null, weeklyTarget: true },
          discordMembers:   { target: 185, actual: null, status: null, weeklyTarget: true },
          emailSubscribers: { target: 10,  actual: null, status: null, weeklyTarget: true },
        },
        overallStatus:  null,
        primaryGap:     null,
        primaryGapCause: null,
        amberAlerts:    [],
        redAlerts:      [],
      },

      // ── HISTORY ──────────────────────────────────────────────────────────
      history:     [],
      adaptations: [],

      // ── STRETCH TARGETS (week 1) ─────────────────────────────────────────
      stretch: {
        impressions: 25,
        clicks:      4,
        users:       45,
        sessions:    110,
        articlesPublished: 7,
      },

      // ── REVENUE MODEL ────────────────────────────────────────────────────
      revenueModel: {
        bootcampPrice:    980,
        conversionFunnel: {
          visitorToDiscord:    0.08,  // 8% of site visitors join Discord
          discordToBootcamp:   0.03,  // 3% of Discord members buy Bootcamp
          emailToBootcamp:     0.02,  // 2% of email list buys Bootcamp
          note: 'These are conservative estimates. Will be updated as real conversion data arrives.'
        },
        projectedMRR: {
          month3:  4900,
          month6:  14700,
          month12: 49000,
          note: 'Based on traffic targets × conversion funnel × $980 price point'
        }
      }
    };

    await env.FFX_KV.put('intelligence:targets', JSON.stringify(targets));

    console.log('[seed-targets] Founding targets written to KV');
    return new Response(JSON.stringify({
      success: true,
      message: 'Founding targets seeded successfully',
      weekNumber: 1,
      weekOf,
      keyTargets: {
        week1:  { impressions: 15, clicks: 2, users: 30, articles: 7 },
        week4:  { impressions: 50, clicks: 5, users: 50, articles: 5 },
        week8:  { impressions: 200, clicks: 20, users: 120, articles: 5 },
        month3: { impressions: 3000, clicks: 200, users: 600, bootcampPurchases: 5 },
        month6: { impressions: 8000, clicks: 600, users: 2000, bootcampPurchases: 15 },
        month12:{ impressions: 40000, clicks: 3000, users: 8000, bootcampPurchases: 50 },
      }
    }), { status: 200, headers });

  } catch(err) {
    console.error('[seed-targets] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const targets = await env.FFX_KV.get('intelligence:targets', { type: 'json' }).catch(() => null);
    return new Response(JSON.stringify({ targets: targets || null }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
