// functions/api/intelligence-engine.js
// POST /api/intelligence-engine → runs full intelligence analysis
// Called by cron daily after signals are collected
// Reads all available signal KV keys, calls Claude analyst, writes intelligence:brief

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500, headers);

  try {
    // ── Read all available signal sources ────────────────────────────────
    const [
      seoSignals,    seoLearning,
      ga4Signals,    ga4Learning,
      ytSignals,     discordSignals,
      emailSignals,  intelSignals,
      calSignals,    knowledgeTaxonomy,
      knowledgePerf, prevBrief,
    ] = await Promise.all([
      env.FFX_KV.get('seo:signals',           { type: 'json' }).catch(() => null),
      env.FFX_KV.get('seo:learning',           { type: 'json' }).catch(() => null),
      env.FFX_KV.get('ga4:signals',            { type: 'json' }).catch(() => null),
      env.FFX_KV.get('ga4:learning',           { type: 'json' }).catch(() => null),
      env.FFX_KV.get('youtube:signals',        { type: 'json' }).catch(() => null),
      env.FFX_KV.get('discord:signals',        { type: 'json' }).catch(() => null),
      env.FFX_KV.get('email:signals',          { type: 'json' }).catch(() => null),
      env.FFX_KV.get('intelligence:signals',   { type: 'json' }).catch(() => null),
      env.FFX_KV.get('calendar:signals',       { type: 'json' }).catch(() => null),
      env.FFX_KV.get('knowledge:taxonomy',     { type: 'json' }).catch(() => null),
      env.FFX_KV.get('knowledge:performance',  { type: 'json' }).catch(() => null),
      env.FFX_KV.get('intelligence:brief',     { type: 'json' }).catch(() => null),
    ]);

    if (!seoSignals && !ga4Signals) {
      return json({ error: 'No signal data available. Run signal collection first.' }, 400, headers);
    }

    // ── Build signal context for Claude ──────────────────────────────────
    const signalContext = buildSignalContext({
      seoSignals, seoLearning, ga4Signals, ga4Learning,
      ytSignals, discordSignals, emailSignals, intelSignals,
      calSignals, knowledgeTaxonomy, knowledgePerf, prevBrief,
    });

    // ── Call Claude analyst ───────────────────────────────────────────────
    const brief = await callClaudeAnalyst(signalContext, env.ANTHROPIC_API_KEY);

    // ── Write intelligence:brief to KV ────────────────────────────────────
    const output = {
      ...brief,
      generatedAt: new Date().toISOString(),
      signalSources: {
        seo:         !!seoSignals,
        ga4:         !!ga4Signals,
        youtube:     !!ytSignals,
        discord:     !!discordSignals,
        email:       !!emailSignals,
        intelligence:!!intelSignals,
        calendar:    !!calSignals,
        knowledge:   !!knowledgeTaxonomy,
      },
    };

    await env.FFX_KV.put('intelligence:brief', JSON.stringify(output));

    // ── Update weekly learning summary if Monday ──────────────────────────
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 1) {
      await updateLearningSummary(env, seoLearning, ga4Learning, brief);
    }

    console.log('[intelligence-engine] Brief written successfully');
    return json({ success: true, brief: output }, 200, headers);

  } catch(err) {
    console.error('[intelligence-engine] Error:', err.message);
    return json({ error: err.message }, 500, headers);
  }
}

// ── Build signal context string for Claude ────────────────────────────────
function buildSignalContext(signals) {
  const { seoSignals, seoLearning, ga4Signals, ga4Learning, ytSignals,
          discordSignals, emailSignals, intelSignals, calSignals,
          knowledgeTaxonomy, knowledgePerf, prevBrief } = signals;

  let ctx = `You are the intelligence analyst for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick™ mechanical entry system by Salman Khan.

Your job is to analyse ALL available signal data and produce a precise, actionable intelligence brief that will:
1. Brief Claude (the content writer) on exactly what article to write next
2. Identify the highest-ROI opportunities across all platforms
3. Surface patterns that improve future content performance
4. Draft reply opportunities for community engagement

ABOUT FORTITUDEFX:
- Brand: FortitudeFX™, methodology: Catch The Wick™, 2 Candle. 1 Story.™
- Founder: Salman Khan — calm, institutional, slightly contrarian voice
- Products: Free Discord community, Catch the Wick Bootcamp, VIP Discord
- Content pillars: CTW Framework, Execution Discipline, Market Psychology, Trading Reality, Lifestyle & Philosophy
- Target: Retail forex traders who want mechanical, rules-based trading
- Zero ad spend — entirely organic, SEO, community

SIGNAL DATA AVAILABLE:
`;

  if (seoSignals) {
    ctx += `
━━ SEARCH CONSOLE SIGNALS (last 7 days) ━━
Clicks: ${seoSignals.totals?.clicks || 0} | Impressions: ${seoSignals.totals?.impressions || 0} | Avg Position: ${seoSignals.totals?.position?.toFixed(1) || 'N/A'}
Momentum: ${seoSignals.momentum || 'unknown'}
Impressions delta vs prev week: ${seoSignals.imprDelta ? seoSignals.imprDelta.toFixed(1) + '%' : 'N/A'}

Rising queries (gaining impressions):
${(seoSignals.risingQueries||[]).map(q => `  - "${q.query}" — ${q.impressions} impr, pos ${q.position?.toFixed(0)}, prev ${q.prevImpressions} impr`).join('\n') || '  None yet'}

Zero-click opportunities (impressions but 0 clicks — fix title):
${(seoSignals.zeroClickOpportunities||[]).map(z => `  - ${z.url} — ${z.impressions} impr, pos ${z.position?.toFixed(1)}`).join('\n') || '  None'}

Page 2 opportunities (pos 11-20 — close to page 1):
${(seoSignals.page2Opportunities||[]).map(p => `  - ${p.url} — pos ${p.position?.toFixed(1)}, ${p.impressions} impr`).join('\n') || '  None'}

Best performing page: ${seoSignals.bestPage?.url || 'N/A'} (${seoSignals.bestPage?.clicks || 0} clicks)
Total indexed pages: ${seoSignals.totalIndexedPages || 0}
Top countries: ${(seoSignals.topCountries||[]).map(c => c.country).join(', ')}
`;
  }

  if (seoLearning && seoLearning.length > 0) {
    ctx += `
━━ SEO LEARNING (${seoLearning.length} weeks of data) ━━
${seoLearning.map(w => `  Week ${w.week}: ${w.momentum}, ${w.clicks} clicks, ${w.impressions} impr, pos ${w.position?.toFixed(1)}, rising: ${(w.risingTopics||[]).join(', ')}`).join('\n')}
`;
  }

  if (ga4Signals) {
    ctx += `
━━ GA4 AUDIENCE SIGNALS (last 7 days) ━━
Users: ${ga4Signals.totals?.users || 0} | Sessions: ${ga4Signals.totals?.sessions || 0}
Avg session duration: ${Math.round((ga4Signals.totals?.avgDuration||0)/60)}m ${Math.round((ga4Signals.totals?.avgDuration||0)%60)}s
Bounce rate: ${((ga4Signals.totals?.bounceRate||0)*100).toFixed(1)}%
Engagement Quality Score: ${ga4Signals.engagementQualityScore || 0}/100
Momentum: ${ga4Signals.momentum || 'unknown'}
User delta vs prev week: ${ga4Signals.deltas?.users ? ga4Signals.deltas.users.toFixed(1) + '%' : 'N/A'}

Best traffic source: ${ga4Signals.bestTrafficSource || 'unknown'}
Returning user rate: ${ga4Signals.returningUserPct?.toFixed(1) || 0}%

Top traffic sources: ${(ga4Signals.topSources||[]).map(s => `${s.source} (${s.sessions})`).join(', ')}
Top countries: ${(ga4Signals.topCountries||[]).map(c => `${c.country} (${c.users})`).join(', ')}
Devices: ${(ga4Signals.devices||[]).map(d => `${d.device}: ${d.sessions}`).join(', ')}

Top pages by sessions:
${(ga4Signals.topPages||[]).slice(0,5).map(p => `  - ${p.path}: ${p.sessions} sessions, ${Math.round(p.duration)}s avg, ${(p.bounce*100).toFixed(0)}% bounce`).join('\n')}

Top articles:
${(ga4Signals.topArticles||[]).map(a => `  - ${a.path}: ${a.sessions} sessions, ${Math.round(a.duration)}s avg`).join('\n') || '  None yet'}

High bounce pages (>70%):
${(ga4Signals.highBouncePages||[]).map(p => `  - ${p.path}: ${(p.bounce*100).toFixed(0)}% bounce`).join('\n') || '  None'}
`;
  }

  if (ga4Learning && ga4Learning.length > 0) {
    ctx += `
━━ GA4 LEARNING (${ga4Learning.length} weeks of data) ━━
${ga4Learning.map(w => `  Week ${w.week}: EQS ${w.eqs}, ${w.users} users, ${Math.round(w.avgDuration)}s avg, bounce ${(w.bounceRate*100).toFixed(0)}%, best source: ${w.bestSource}`).join('\n')}
`;
  }

  if (ytSignals) {
    ctx += `
━━ YOUTUBE SIGNALS ━━
${JSON.stringify(ytSignals, null, 2)}
`;
  }

  if (discordSignals) {
    ctx += `
━━ DISCORD SIGNALS ━━
${JSON.stringify(discordSignals, null, 2)}
`;
  }

  if (emailSignals) {
    ctx += `
━━ EMAIL SIGNALS ━━
${JSON.stringify(emailSignals, null, 2)}
`;
  }

  if (intelSignals) {
    ctx += `
━━ INTELLIGENCE AGENT SIGNALS (community conversations) ━━
${JSON.stringify(intelSignals, null, 2)}
`;
  }

  if (calSignals) {
    ctx += `
━━ FOREX CALENDAR SIGNALS ━━
${JSON.stringify(calSignals, null, 2)}
`;
  }

  if (knowledgeTaxonomy) {
    ctx += `
━━ KNOWLEDGE LIBRARY TAXONOMY ━━
Categories: ${(knowledgeTaxonomy.categories||[]).join(', ')}
Total nuggets: ${knowledgeTaxonomy.totalNuggets || 'unknown'}
Tag distribution: ${JSON.stringify(knowledgeTaxonomy.tagCounts || {})}
Underrepresented categories: ${(knowledgeTaxonomy.underrepresented||[]).join(', ') || 'unknown'}
`;
  }

  if (knowledgePerf) {
    ctx += `
━━ KNOWLEDGE PERFORMANCE ━━
Best performing categories: ${JSON.stringify(knowledgePerf)}
`;
  }

  if (prevBrief) {
    ctx += `
━━ YESTERDAY'S BRIEF (for continuity) ━━
Yesterday's article target: ${prevBrief.articleBrief?.targetQuery || 'N/A'}
Yesterday's momentum: ${prevBrief.weeklyInsight?.momentum || 'N/A'}
`;
  }

  return ctx;
}

// ── Call Claude analyst ───────────────────────────────────────────────────
async function callClaudeAnalyst(signalContext, apiKey) {
  const prompt = `${signalContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR TASK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Analyse ALL signal data above and produce a comprehensive intelligence brief. Look for cross-signal patterns — where multiple signals point to the same opportunity, that is the highest priority.

Return ONLY a valid JSON object with exactly this structure:

{
  "articleBrief": {
    "targetQuery": "exact search query to target",
    "suggestedTitle": "SEO-optimised article title in Salman's voice",
    "angle": "specific angle — trade story first or framework first or psychology first",
    "keyPoints": ["point 1", "point 2", "point 3"],
    "targetLength": 1200,
    "contentPillar": "CTW Framework|Execution Discipline|Market Psychology|Trading Reality|Lifestyle & Philosophy",
    "internalLinks": ["slug-to-link-to-1", "slug-to-link-to-2"],
    "nuggetTags": ["tags to pull nuggets from"],
    "reasoning": "why this specific article now — what cross-signal pattern drove this decision"
  },
  "titleRewrites": [
    {
      "currentUrl": "/article?slug=example",
      "currentImpressions": 0,
      "currentClicks": 0,
      "currentPosition": 0,
      "suggestedTitle": "new title",
      "reasoning": "why this change will improve CTR"
    }
  ],
  "replyOpportunities": [
    {
      "platform": "reddit|quora|x|youtube|linkedin",
      "topic": "topic description",
      "urgency": "high|medium|low",
      "angle": "how to approach the reply",
      "relevantNuggetTags": ["tags"],
      "articleToLink": "slug if relevant"
    }
  ],
  "weeklyInsight": {
    "momentum": "accelerating|growing|stable|declining",
    "headline": "one sentence summary of site performance this week",
    "keyWin": "biggest win this week",
    "keyRisk": "biggest risk or gap to address",
    "forecast": "where will you be in 30 days if current trajectory continues"
  },
  "priorityActions": [
    {
      "rank": 1,
      "action": "specific action to take",
      "impact": "high|medium|low",
      "effort": "high|medium|low",
      "reasoning": "why this is priority 1"
    }
  ],
  "learningUpdate": {
    "newPattern": "any new pattern detected this week not seen before",
    "confirmedPattern": "pattern that was seen before and confirmed again",
    "invalidatedPattern": "anything that used to work but stopped working"
  },
  "promptInjection": {
    "currentSignals": "2-3 sentence summary of current opportunity for the article generation prompt",
    "historicalLearning": "2-3 sentence summary of what has worked on FFX for the article generation prompt",
    "avoidance": "1-2 sentences on what to avoid based on high bounce or poor performance data"
  }
}

CRITICAL: Return ONLY the raw JSON object. No markdown. No code fences. No preamble. Start with { end with }.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
  const data = await res.json();
  const raw  = data.content[0].text.trim();
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON in Claude response');
  return JSON.parse(raw.slice(first, last + 1));
}

// ── Weekly learning summary ───────────────────────────────────────────────
async function updateLearningSummary(env, seoLearning, ga4Learning, brief) {
  try {
    if (!seoLearning || seoLearning.length < 2) return; // Need at least 2 weeks

    const summaryPrompt = `You are analysing historical SEO and audience data for FortitudeFX to extract actionable patterns.

SEO Learning (${seoLearning.length} weeks):
${JSON.stringify(seoLearning, null, 2)}

GA4 Learning (${ga4Learning?.length || 0} weeks):
${JSON.stringify(ga4Learning || [], null, 2)}

Extract the key patterns specific to FortitudeFX. What article approaches rank fastest? What content keeps people reading? What topics are gaining traction? What should be avoided?

Return a JSON object:
{
  "seoSummary": "2-3 sentences on what article patterns rank best on this specific site",
  "audienceSummary": "2-3 sentences on what content your audience engages with most",
  "risingTopics": ["topic1", "topic2", "topic3"],
  "avoidTopics": ["topic to avoid"],
  "optimalLength": 1200,
  "optimalStructure": "brief description of best performing article structure",
  "generatedAt": "ISO date"
}

Return ONLY raw JSON. No markdown. No preamble.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        messages: [{ role: 'user', content: summaryPrompt }],
      }),
    });

    if (!res.ok) return;
    const data = await res.json();
    const raw  = data.content[0].text.trim();
    const first = raw.indexOf('{');
    const last  = raw.lastIndexOf('}');
    if (first === -1) return;
    const summary = JSON.parse(raw.slice(first, last + 1));
    summary.generatedAt = new Date().toISOString();

    await env.FFX_KV.put('seo:learning:summary', JSON.stringify(summary));
    console.log('[intelligence-engine] Learning summary updated');
  } catch(e) {
    console.error('[intelligence-engine] Learning summary error:', e.message);
  }
}

export async function onRequestGet(context) {
  // GET returns the latest brief
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const brief = await env.FFX_KV.get('intelligence:brief', { type: 'json' }).catch(() => null);
    return new Response(JSON.stringify({ brief: brief || null }), { status: 200, headers });
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

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
