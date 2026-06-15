// functions/api/youtube-metadata.js
// POST /api/youtube-metadata → generates optimised YouTube metadata package
// GET  /api/youtube-metadata?videoId=xxx → returns stored metadata from KV
//
// Signal sources read (in priority order):
//   1. youtube:title:learning      — YOUR channel: what title/scene beat avg (highest weight)
//   2. youtube:analytics:signals   — YOUR channel: search vs suggested, top YT search queries
//   3. transcript:timestamps:{id}  — Timestamped chunks for chapter generation
//   4. transcript:{id}             — Full plain text for content analysis
//   5. youtube:search:global:signals — What competitors title similar content on YouTube
//   6. seo:signals                 — Google Search Console: rising web queries, positions
//   7. ga4:signals                 — GA4: YouTube referral conversions, best content
//   8. intelligence:brief          — Daily brief: targetQuery, youtubeStrategy, signals
//   9. seo:learning:summary        — 12-week SEO patterns
//   10. seo:title_tests            — A/B test outcomes on your articles

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const videoId = new URL(request.url).searchParams.get('videoId');
  if (!videoId) return new Response(JSON.stringify({ error: 'videoId required' }), { status: 400, headers });
  try {
    const meta = await env.FFX_KV.get(`youtube:metadata:${videoId}`, { type: 'json' }).catch(() => null);
    return new Response(JSON.stringify({ metadata: meta || null }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!env.ANTHROPIC_API_KEY) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers });

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
  }

  const { videoId, youtubeUrl, title } = body;
  if (!videoId) return new Response(JSON.stringify({ error: 'videoId required' }), { status: 400, headers });

  try {
    // ── Read ALL signal sources in parallel ──────────────────────────────
    const [
      transcript,
      transcriptTimestamps,
      brief,
      seoSignals,
      ga4Signals,
      learningSummary,
      accuracyScores,
      videoRecord,
      ytTitleLearning,
      ytAnalyticsSignals,
      ytSearchGlobalSignals,
    ] = await Promise.all([
      env.FFX_KV.get(`transcript:${videoId}`,            { type: 'text' }).catch(() => null),
      env.FFX_KV.get(`transcript:timestamps:${videoId}`, { type: 'json' }).catch(() => null),
      env.FFX_KV.get('intelligence:brief',               { type: 'json' }).catch(() => null),
      env.FFX_KV.get('seo:signals',                      { type: 'json' }).catch(() => null),
      env.FFX_KV.get('ga4:signals',                      { type: 'json' }).catch(() => null),
      env.FFX_KV.get('seo:learning:summary',             { type: 'json' }).catch(() => null),
      env.FFX_KV.get('intelligence:accuracy_scores',     { type: 'json' }).catch(() => null),
      env.FFX_KV.get(`video:${videoId}`,                 { type: 'json' }).catch(() => null),
      env.FFX_KV.get('youtube:title:learning',           { type: 'json' }).catch(() => null),
      env.FFX_KV.get('youtube:analytics:signals',        { type: 'json' }).catch(() => null),
      env.FFX_KV.get('youtube:search:global:signals',    { type: 'json' }).catch(() => null),
    ]);

    if (!transcript || transcript.trim().length < 100) {
      return new Response(JSON.stringify({
        error: 'Transcript not found. The video must be processed through the Generate workflow first.'
      }), { status: 400, headers });
    }

    // ── Read title test learnings ────────────────────────────────────────
    let titleTestLearnings = '';
    try {
      const testList = await env.FFX_KV.list({ prefix: 'seo:title_tests:' }).catch(() => null);
      if (testList && testList.keys.length > 0) {
        const completedTests = [];
        for (const key of testList.keys.slice(0, 10)) {
          const test = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
          if (test && test.status === 'complete') completedTests.push(test);
        }
        if (completedTests.length > 0) {
          const improved    = completedTests.filter(t => t.improvement);
          const notImproved = completedTests.filter(t => !t.improvement);
          titleTestLearnings = `\n━━ TITLE A/B TEST OUTCOMES (your site) ━━\n`;
          if (improved.length)    titleTestLearnings += `Formats that improved CTR: ${improved.map(t => `"${t.newTitle}"`).join(', ')}\n`;
          if (notImproved.length) titleTestLearnings += `Formats that did NOT improve CTR: ${notImproved.map(t => `"${t.newTitle}"`).join(', ')}\n`;
        }
      }
    } catch(e) {}

    // ── Fetch timestamps directly if not already in KV ─────────────────
    // Supadata response: { content: [{text, offset(ms), duration(ms), lang}], lang, availableLangs }
    // For videos >20min: returns HTTP 202 with { jobId } — must poll /v1/transcript/{jobId}
    let resolvedTimestamps = transcriptTimestamps;
    if (!Array.isArray(resolvedTimestamps) || resolvedTimestamps.length === 0) {
      const ytUrlForTs = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;
      if (ytUrlForTs && env.SUPADATA_API_KEY) {
        try {
          const tsApiUrl = 'https://api.supadata.ai/v1/transcript?url=' + encodeURIComponent(ytUrlForTs);
          const tsRes = await fetch(tsApiUrl, { headers: { 'x-api-key': env.SUPADATA_API_KEY } });

          let tsData = null;

          if (tsRes.status === 200) {
            // Immediate response
            tsData = await tsRes.json();

          } else if (tsRes.status === 202) {
            // Async job — poll until complete (max 60s, 1s intervals)
            const jobData = await tsRes.json();
            const jobId   = jobData.jobId;
            if (jobId) {
              for (let attempt = 0; attempt < 60; attempt++) {
                await new Promise(function(r) { setTimeout(r, 1000); });
                const pollRes = await fetch('https://api.supadata.ai/v1/transcript/' + jobId, {
                  headers: { 'x-api-key': env.SUPADATA_API_KEY },
                });
                if (pollRes.ok) {
                  const pollData = await pollRes.json();
                  if (pollData.status === 'completed') {
                    // Completed job returns content directly in pollData
                    tsData = pollData;
                    break;
                  } else if (pollData.status === 'failed') {
                    console.error('[youtube-metadata] Supadata async job failed:', pollData.error);
                    break;
                  }
                  // Still queued/active — keep polling
                }
              }
            }
          } else {
            console.error('[youtube-metadata] Supadata timestamps status:', tsRes.status);
          }

          // Parse chunks — field is 'offset' (milliseconds), not 'start'
          if (tsData && Array.isArray(tsData.content) && tsData.content.length > 0
              && typeof tsData.content[0] === 'object'
              && typeof tsData.content[0].offset === 'number') {
            resolvedTimestamps = tsData.content
              .filter(function(s) { return s && typeof s.text === 'string' && typeof s.offset === 'number'; })
              .map(function(s) {
                return {
                  text:     s.text,
                  start:    s.offset / 1000,    // convert ms → seconds for formatSeconds()
                  duration: (s.duration || 0) / 1000,
                };
              });
            if (resolvedTimestamps.length > 0) {
              await env.FFX_KV.put(`transcript:timestamps:${videoId}`, JSON.stringify(resolvedTimestamps)).catch(function() {});
              console.log('[youtube-metadata] Timestamps fetched and stored:', resolvedTimestamps.length, 'chunks');
            }
          } else {
            console.error('[youtube-metadata] Unexpected Supadata structure or no offset field. Keys:', tsData && tsData.content && tsData.content[0] ? Object.keys(tsData.content[0]).join(',') : 'no content');
          }

        } catch(tsErr) {
          console.error('[youtube-metadata] Direct timestamp fetch failed (non-fatal):', tsErr.message);
        }
      }
    }

    // ── Build chapter outline from timestamps ────────────────────────────
    let chapterContext = '';
    if (Array.isArray(resolvedTimestamps) && resolvedTimestamps.length > 0) {
      const totalChunks = resolvedTimestamps.length;
      const step = Math.max(1, Math.floor(totalChunks / 60));
      const sampled = resolvedTimestamps.filter(function(_, i) { return i % step === 0; });
      chapterContext = `\n━━ TIMESTAMPED TRANSCRIPT (for chapter generation) ━━\n`;
      chapterContext += `Total duration: approximately ${formatSeconds(resolvedTimestamps[resolvedTimestamps.length-1].start + (resolvedTimestamps[resolvedTimestamps.length-1].duration || 0))}\n`;
      chapterContext += `Sampled transcript with timestamps:\n`;
      sampled.forEach(function(chunk) {
        chapterContext += `[${formatSeconds(chunk.start)}] ${chunk.text}\n`;
      });
      chapterContext += `\nUSE THESE TIMESTAMPS to generate exact chapter markers. Format required:\n0:00 Introduction\n1:24 Chapter Name\nEtc.\n`;
    }

    // ── Resolve article URL ──────────────────────────────────────────────
    const videoTitle  = title || videoRecord?.title || 'Unknown title';
    const ytUrl       = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;
    const articleSlug = videoRecord?.slug || null;
    const articleUrl  = articleSlug ? `https://fortitudefx.com/article?slug=${articleSlug}` : 'https://fortitudefx.com/blog';

    // ── Track which signals are available ────────────────────────────────
    const signalsAvailable = [];

    // ── BUILD CONTEXT — weighted priority order ──────────────────────────
    let ctx = `You are generating the optimal YouTube metadata package for FortitudeFX.

BRAND IDENTITY:
FortitudeFX™ | Catch The Wick™ | 2 Candles. 1 Story.™
Founder: Salman Khan — professional forex trader, Dubai-based, runs everything solo.
Methodology: Catch The Wick™ — mechanical 2-candle entry system. Wick candle + reversal candle.
5 models: LC-E, LE-I, LC-ZIE, LC-ZR, LC-FR. Any pair, any timeframe, zero guesswork.
Audience: Retail forex traders wanting mechanical, rules-based systems. 7,500+ YouTube subscribers.

TRADEMARK RULES — NEVER VIOLATED:
- FortitudeFX™ — always include ™ on every mention
- Catch The Wick™ — always include ™ on every mention
- 2 Candles. 1 Story.™ — ALWAYS numerals (2 and 1), never spell out "Two" or "One"
- In descriptions and titles: the ™ symbol is mandatory, not optional

VIDEO BEING OPTIMISED:
Working title: ${videoTitle}
Video ID: ${videoId}
YouTube URL: ${ytUrl}
Paired article: ${articleUrl}

TRANSCRIPT (first 2500 chars — source of truth for content):
${transcript.slice(0, 2500)}${transcript.length > 2500 ? '\n[...transcript continues...]' : ''}
`;

    // ── SIGNAL WEIGHT 1: YOUR YouTube channel performance data (highest weight) ──
    if (Array.isArray(ytTitleLearning) && ytTitleLearning.length > 0) {
      signalsAvailable.push('youtube_channel_learning');
      const winners = ytTitleLearning.filter(t => t.beatAverage);
      const losers  = ytTitleLearning.filter(t => t.beatAverage === false);
      ctx += `\n${'='.repeat(60)}\nWEIGHT 1 — YOUR CHANNEL PERFORMANCE (highest authority signal)\nBased on ${ytTitleLearning.length} published videos measured against YOUR channel average.\n${'='.repeat(60)}\n`;

      if (winners.length > 0) {
        ctx += `WHAT BEAT YOUR CHANNEL AVERAGE VIEWS:\n`;
        winners.slice(0, 5).forEach(t => {
          ctx += `  ✓ "${t.actualTitle}" — ${(t.viewsVsAvgPct > 0 ? '+' : '')}${t.viewsVsAvgPct}% vs avg`;
          if (t.visualScene) ctx += ` | Scene: ${t.visualScene}`;
          if (t.thumbnailHook) ctx += ` | Hook: "${t.thumbnailHook}"`;
          ctx += '\n';
        });
        // Opening word patterns from winners
        const winWords = {};
        winners.forEach(w => { if (w.titleStartsWithWord) winWords[w.titleStartsWithWord] = (winWords[w.titleStartsWithWord]||0)+1; });
        const topWords = Object.entries(winWords).sort((a,b)=>b[1]-a[1]).slice(0,3);
        if (topWords.length) ctx += `Title opening words that win on YOUR channel: ${topWords.map(e=>e[0]).join(', ')}\n`;
      }

      if (losers.length > 0) {
        ctx += `WHAT UNDERPERFORMED ON YOUR CHANNEL:\n`;
        losers.slice(0, 3).forEach(t => {
          ctx += `  ✗ "${t.actualTitle}" — ${t.viewsVsAvgPct}% vs avg\n`;
        });
        const loseWords = {};
        losers.forEach(l => { if (l.titleStartsWithWord) loseWords[l.titleStartsWithWord] = (loseWords[l.titleStartsWithWord]||0)+1; });
        const bottomWords = Object.entries(loseWords).sort((a,b)=>b[1]-a[1]).slice(0,3);
        if (bottomWords.length) ctx += `Opening words that underperform: ${bottomWords.map(e=>e[0]).join(', ')}\n`;
      }

      ctx += `INSTRUCTION: Apply winning patterns above to this video's title. This is evidence from YOUR channel — treat it as the strongest signal.\n`;
    }

    // ── SIGNAL WEIGHT 2: YouTube Analytics (search vs suggested, actual YT search queries) ──
    if (ytAnalyticsSignals) {
      signalsAvailable.push('youtube_analytics');
      const authRequired = await env.FFX_KV.get('youtube:analytics:auth_required').catch(()=>null);
      if (authRequired === 'true') {
        ctx += `\n${'='.repeat(60)}\nWEIGHT 2 — YOUTUBE ANALYTICS\nNOT AVAILABLE — yt-analytics.readonly scope not yet authorised.\nOAuth re-authorisation required. See youtube-analytics dashboard for instructions.\n${'='.repeat(60)}\n`;
      } else {
        ctx += `\n${'='.repeat(60)}\nWEIGHT 2 — YOUTUBE ANALYTICS (how YOUR audience finds your videos)\n${'='.repeat(60)}\n`;
        if (ytAnalyticsSignals.titleVsThumbnailPriority) {
          ctx += `DISCOVERY PRIORITY: ${ytAnalyticsSignals.titleVsThumbnailPriority}\n`;
        }
        if (ytAnalyticsSignals.searchPct !== undefined) {
          ctx += `Traffic breakdown: ${ytAnalyticsSignals.searchPct}% from YouTube Search | ${ytAnalyticsSignals.suggestedPct}% from Suggested | ${ytAnalyticsSignals.browsePct}% from Browse\n`;
        }
        if (ytAnalyticsSignals.topYouTubeSearchQueries && ytAnalyticsSignals.topYouTubeSearchQueries.length > 0) {
          ctx += `Top queries people type on YouTube to find YOUR videos:\n`;
          ytAnalyticsSignals.topYouTubeSearchQueries.slice(0, 10).forEach(q => {
            ctx += `  "${q.query}" — ${q.views} views\n`;
          });
          ctx += `INSTRUCTION: If any of these queries match this video's content, use the EXACT phrasing in the title.\n`;
        }
        if (ytAnalyticsSignals.channelAvgViewPct) {
          ctx += `Channel avg audience retention: ${ytAnalyticsSignals.channelAvgViewPct}%\n`;
        }
      }
    } else {
      ctx += `\nWEIGHT 2 — YOUTUBE ANALYTICS: Not yet collected. Run POST /api/youtube-analytics after OAuth setup.\n`;
    }

    // ── SIGNAL WEIGHT 3: What people search on YouTube in your niche (competitor analysis) ──
    if (ytSearchGlobalSignals) {
      signalsAvailable.push('youtube_search_niche');
      ctx += `\n${'='.repeat(60)}\nWEIGHT 3 — YOUTUBE NICHE SEARCH INTELLIGENCE (daily cron data)\n${'='.repeat(60)}\n`;
      if (ytSearchGlobalSignals.titlePatterns && ytSearchGlobalSignals.titlePatterns.length > 0) {
        ctx += `Most common opening words in competitor YouTube titles for this niche:\n`;
        ytSearchGlobalSignals.titlePatterns.forEach(p => {
          ctx += `  "${p.word}" — appears in ${p.count} competitor titles\n`;
        });
      }
      if (ytSearchGlobalSignals.competitorTitles && ytSearchGlobalSignals.competitorTitles.length > 0) {
        ctx += `Sample competitor titles ranking for your content pillars:\n`;
        ytSearchGlobalSignals.competitorTitles.slice(0, 10).forEach(ct => {
          ctx += `  [${ct.query}] "${ct.title}" (${ct.channel})\n`;
        });
        ctx += `INSTRUCTION: Study these title patterns. You are competing with these videos for the same searchers. Match their clarity and specificity while differentiating with Salman's voice.\n`;
      }
    }

    // ── SIGNAL WEIGHT 4: Google Search Console (what your audience searches on Google) ──
    if (seoSignals) {
      signalsAvailable.push('seo_gsc');
      ctx += `\n${'='.repeat(60)}\nWEIGHT 4 — GOOGLE SEARCH CONSOLE (web search — related but different from YouTube)\nNOTE: These are Google web search queries. YouTube search queries differ in format (shorter, more direct).\nUse these to understand TOPIC demand — not to copy the exact query format into YouTube titles.\n${'='.repeat(60)}\n`;

      // Rising queries — highest growth this week
      const risingQ = (seoSignals.risingQueries || []).slice(0, 5);
      if (risingQ.length > 0) {
        ctx += `Rising Google queries this week (growing impressions):\n`;
        risingQ.forEach(q => ctx += `  "${q.query}" — ${q.impressions} impr, pos ${q.position ? q.position.toFixed(0) : 'N/A'}\n`);
      }

      // Zero-click opportunities — getting seen but not clicked
      const zeroclickQ = (seoSignals.zeroClickOpportunities || []).slice(0, 3);
      if (zeroclickQ.length > 0) {
        ctx += `Zero-click opportunities (impressions but no clicks — strong keyword demand):\n`;
        zeroclickQ.forEach(z => ctx += `  ${z.url} — ${z.impressions} impr, pos ${z.position ? z.position.toFixed(1) : 'N/A'}\n`);
      }

      // Page 2 opportunities — almost ranking
      const page2Q = (seoSignals.page2Opportunities || []).slice(0, 3);
      if (page2Q.length > 0) {
        ctx += `Page 2 opportunities (close to ranking — reinforce with video):\n`;
        page2Q.forEach(p => ctx += `  ${p.url} — pos ${p.position ? p.position.toFixed(1) : 'N/A'}, ${p.impressions} impr\n`);
      }

      if (seoSignals.bestPage) {
        ctx += `Best performing page: ${seoSignals.bestPage.url} (${seoSignals.bestPage.clicks} clicks)\n`;
      }
      ctx += `Site momentum: ${seoSignals.momentum || 'unknown'} | Avg position: ${seoSignals.totals?.position ? seoSignals.totals.position.toFixed(1) : 'N/A'}\n`;
    }

    // ── SIGNAL WEIGHT 5: Intelligence brief targetQuery ──────────────────
    if (brief) {
      signalsAvailable.push('intelligence_brief');
      ctx += `\n${'='.repeat(60)}\nWEIGHT 5 — INTELLIGENCE BRIEF (daily analysis)\n${'='.repeat(60)}\n`;
      if (brief.articleBrief?.targetQuery) {
        ctx += `Today's target query (Google web search opportunity): "${brief.articleBrief.targetQuery}"\n`;
        ctx += `NOTE: This is a GOOGLE query. Derive the YouTube equivalent: shorter, more action-oriented.\n`;
        ctx += `Example: Google "momentum candle forex strategy" → YouTube "reading momentum candles"\n`;
      }
      if (brief.promptInjection?.currentSignals) ctx += `Current signals: ${brief.promptInjection.currentSignals}\n`;
      if (brief.weeklyInsight?.momentum) ctx += `Site momentum: ${brief.weeklyInsight.momentum}\n`;
      if (brief.youtubeStrategy) {
        const ys = brief.youtubeStrategy;
        ctx += `YouTube strategy recommendation (from intelligence engine):\n`;
        if (ys.recommendedTitleFormat)     ctx += `  RECOMMENDED title format: ${ys.recommendedTitleFormat}\n`;
        if (ys.recommendedVisualScene)     ctx += `  RECOMMENDED visual scene: ${ys.recommendedVisualScene}\n`;
        if (ys.recommendedEmotionalRegister) ctx += `  RECOMMENDED emotional register: ${ys.recommendedEmotionalRegister}\n`;
        if (ys.recommendedHookStyle)       ctx += `  RECOMMENDED hook style: ${ys.recommendedHookStyle}\n`;
        if (ys.avoidTitleFormat)           ctx += `  AVOID: ${ys.avoidTitleFormat}\n`;
        if (ys.reasoning)                  ctx += `  Evidence: ${ys.reasoning}\n`;
      }
    }

    // ── SIGNAL WEIGHT 6: GA4 YouTube referral conversions ───────────────
    if (ga4Signals?.youtubeReferralData) {
      signalsAvailable.push('ga4_yt_referral');
      const ytRef = ga4Signals.youtubeReferralData;
      ctx += `\n${'='.repeat(60)}\nWEIGHT 6 — GA4 YOUTUBE REFERRAL CONVERSIONS\nWhat YouTube visitors DO after landing on your site — shows which video topics convert.\n${'='.repeat(60)}\n`;
      if (ytRef.topPages && ytRef.topPages.length > 0) {
        ctx += `Pages getting most YouTube-referred traffic (last 28 days):\n`;
        ytRef.topPages.slice(0, 5).forEach(p => {
          ctx += `  ${p.path} — ${p.sessions} sessions, avg ${Math.round(p.avgDuration)}s on page\n`;
        });
      }
      if (ytRef.conversions && ytRef.conversions.length > 0) {
        ctx += `Conversion events from YouTube visitors:\n`;
        ytRef.conversions.slice(0, 5).forEach(c => {
          ctx += `  ${c.event}: ${c.eventCount} times\n`;
        });
        ctx += `INSTRUCTION: Topics driving Discord joins and bootcamp views from YouTube are proven converters — weight them heavily in description CTAs.\n`;
      }
    }

    // ── SIGNAL WEIGHT 7: 12-week SEO patterns ──────────────────────────
    if (learningSummary?.seoSummary) {
      signalsAvailable.push('seo_learning');
      ctx += `\n12-week SEO pattern: ${learningSummary.seoSummary}\n`;
    }

    if (titleTestLearnings) ctx += titleTestLearnings;

    // ── Chapter timestamps context ───────────────────────────────────────
    if (chapterContext) {
      signalsAvailable.push('transcript_timestamps');
      ctx += chapterContext;
    }

    // ── SALMAN'S VOICE — CRITICAL SECTION ────────────────────────────────
    ctx += `
${'='.repeat(60)}
SALMAN'S VOICE — NON-NEGOTIABLE
${'='.repeat(60)}
This is Salman Khan's personal YouTube channel. NOT a faceless brand channel.
Salman speaks in first person. He is direct, institutional, occasionally contrarian.
He has seen it all before. He is calm. He does not hype. He does not motivate.

VOICE RULES:
- Write as if Salman is speaking directly to a fellow trader
- "Here's what the momentum candle is actually telling you" — NOT "Learn momentum candles"
- Use "you" and "your" — personal, direct conversation
- Reference specific pairs, specific levels, specific CTW concepts when in the transcript
- First sentence of description: a direct statement, never a question, never a preamble
- Maximum 1 exclamation mark in the ENTIRE description
- Never: "In this video...", "Welcome back...", "Make sure to like and subscribe..."
- Never: generic trading advice, motivational phrases, vague claims
- Always: specific, mechanical, evidence-based language from the CTW methodology

TITLE VOICE:
- "The Momentum Candle: What It Actually Tells You" ← acceptable but generic
- "What the Momentum Candle Is Actually Telling You" ← better — more personal
- "This Is Why Your Stop Loss Gets Hunted (Momentum Candle)" ← strong — specific pain point
- Never: "BEST Momentum Candle Strategy 2026" — clickbait, not Salman's voice
`;

    // ── GENERATE PACKAGE INSTRUCTIONS ────────────────────────────────────
    ctx += `
${'='.repeat(60)}
GENERATE YOUTUBE METADATA PACKAGE
${'='.repeat(60)}

TITLE RULES:
- Under 60 characters (YouTube truncates at 60 in search results)
- Must be grounded in the transcript content — do not invent topics
- TITLE KEYWORD PRIORITY ORDER:
  1. If YouTube Analytics shows exact queries people use to find YOUR videos → use that phrasing
  2. If ytTitleLearning shows a winning opening word pattern → apply it
  3. If competitor titles show a dominant format for this niche → use it as structure reference
  4. Derive YouTube equivalent of the GSC targetQuery (shorter, more direct)
  5. Default to transcript's core insight as the title hook
- Primary keyword in first 3 words
- Salman's voice — personal, specific, never third-party agency tone
- Suggest 1 primary title + 2 alternatives with reasoning

DESCRIPTION RULES:
- First 125 characters must hook immediately — Salman's direct voice, core insight, no preamble
- Structure EXACTLY as follows (use \\n for every line break):

  [Hook line — one direct sentence, core insight from video, first person]
  \\n\\n
  [1-2 sentence body intro — what this video establishes, Salman's voice]
  \\n\\n
  [Bullet list — what viewer will learn. EACH item on its own line starting with — (em dash + space)]
  Format:
  — [specific thing 1]\\n
  — [specific thing 2]\\n
  — [specific thing 3]\\n
  — [specific thing 4]\\n
  \\n
  [One closing line — the payoff or system reference]
  \\n\\n
  [CHAPTERS]
  \\n\\n
  Read the full breakdown: ${articleUrl}\\n\\n
  Join free — resources + community: https://fortitudefx.com/joinfree

- Each bullet must be specific to THIS video — what Salman actually covers in the transcript
- Never: generic trading advice, vague benefits, "you will learn how to..."
- Always: specific concepts, specific mechanics, specific CTW terminology from the transcript
- Weave rising search queries naturally into the hook or body — not forced
- The — bullet format is NON-NEGOTIABLE. Never collapse bullets into a paragraph.

CHAPTER GENERATION RULES — MANDATORY:
${chapterContext ? `You have timestamped transcript data above. USE IT to generate accurate chapter markers.
- Generate 5-8 chapters that reflect the actual video structure
- First chapter MUST be 0:00 Introduction
- Use the timestamps from the transcript to identify topic transitions
- Format EXACTLY as YouTube requires (copy-paste ready):
  0:00 Introduction
  1:24 Chapter Title
  3:47 Chapter Title
  (etc.)
- Place the chapter block where [CHAPTERS] appears in the description structure` : 
`No timestamped transcript available for this video.
Place [TIMESTAMPS] in the description where chapters will go.
Add note: "⚠ Add chapter timestamps after upload."
Chapters will be available on next generation once timestamps are stored.`}

TAGS RULES:
- 15-20 tags maximum
- Priority order: brand tags → methodology tags → video-specific tags → question tags
- Always include: FortitudeFX, Catch the Wick, forex trading, price action, forex strategy, Salman Khan forex
- Add 8-10 specific tags from this video's exact content
- Include question-format tags: "what is momentum candle", "how to trade momentum candle" (adapt to actual topic)
- Include both short-tail (forex trading) and long-tail (catch the wick momentum candle strategy) tags

THUMBNAIL RULES:

CRITICAL ARCHITECTURE — READ CAREFULLY:
The thumbnail uses a LOCKED BRAND TEMPLATE with ONE variable you fill from the transcript.
Do NOT write a free-form description. Fill ONLY the [VISUAL_SUBJECT] slot.

THE LOCKED FFX TEMPLATE (never changes — this is the brand):
"[VISUAL_SUBJECT], single subject extreme close-up, perfectly isolated against pure black background #0a0a12, subject positioned in right 55% of frame, left 45% of frame is pure black emptiness with zero detail, single warm gold rim light source from upper right edge only #c9a84c creating a thin glowing outline on the subject, deep black shadows everywhere else, anamorphic cinematic lens compression, f/1.2 ultra shallow depth of field, ultra sharp on subject surface, the rest falls to pure black, desaturated color grade except warm amber and gold tones on subject edges, no text, no labels, no arrows, no grid lines, no annotations, no watermarks, no people, no chart overlays, pure black left half of frame, film grain, 1472x832"

YOUR ONLY JOB — fill [VISUAL_SUBJECT] with 6-10 words describing the specific visual from THIS video:
- Momentum candle video: "single large bullish candlestick with long dominant body"
- Wick video: "single candlestick with extreme long upper wick rejection"
- Structure break: "two candlesticks side by side momentum then reversal"
- Stop hunt: "sharp candlestick wick piercing through a horizontal price level"
- Entry setup: "clean two-candle formation on dark chart surface"
- Risk management: "single red bearish candle in isolation"

The [VISUAL_SUBJECT] must be:
- Specific to what THIS video is actually about (read the transcript)
- A physical forex chart element — candlestick, wick, level, formation
- Simple — one or two elements maximum. Not a full chart scene.
- NOT generic ("forex chart", "trading screen", "candlestick pattern")

textOverlay: 3 words MAXIMUM. ALL CAPS. Single aggressive statement that creates a question or tension.
Strong examples: "THIS TELLS ALL", "PRICE NEVER LIES", "THEY SWEPT IT", "STRUCTURE SHIFTS HERE", "THE WICK REVEALS"
Weak (never use): "FOREX TRADING TIPS", "LEARN THIS NOW", "CATCH THE WICK" (brand name, not a hook)
The hook must make a viewer think "what does it tell? I need to know" — it is incomplete without clicking.

Return ONLY a valid JSON object:
{
  "primaryTitle": "title under 60 chars — keyword-first, Salman's voice",
  "titleAlternatives": [
    { "title": "alt 1 under 60 chars", "reasoning": "explain the CTR angle and which signal informed it" },
    { "title": "alt 2 under 60 chars", "reasoning": "explain the CTR angle and which signal informed it" }
  ],
  "description": {
    "hook": "first 125 chars — Salman speaking directly, core insight, no preamble",
    "full": "complete description with chapter markers (or [TIMESTAMPS] if no timestamp data), article link, joinfree CTA"
  },
  "chapters": ["0:00 Introduction", "1:24 Chapter Name", "etc — OR empty array if no timestamp data"],
  "tags": ["FortitudeFX", "Catch the Wick", "forex trading", "price action", "forex strategy", "Salman Khan forex", "tag7", "tag8"],
  "thumbnailConcept": {
    "visualSubject": "6-10 words describing the specific forex visual from this video transcript",
    "textOverlay": "3 WORD ALL CAPS HOOK — specific tension, NOT generic",
    "leonardoPrompt": "LOCKED TEMPLATE with [VISUAL_SUBJECT] replaced by your visualSubject — copy the full template and substitute the slot",
    "reasoning": "one sentence — why this specific visual subject and hook will make the target viewer stop scrolling"
  },
  "signalsApplied": {
    "primaryTitleSignal": "which signal drove the title choice",
    "keywordSource": "where the primary keyword came from",
    "thumbnailStrategy": "thumbnail_first or title_first based on discovery data"
  },
  "briefVersion": "${brief?.generatedAt || new Date().toISOString()}"
}

CRITICAL: Return ONLY the raw JSON. No markdown. No code fences. Start with { end with }.`;

    // ── Call Claude ───────────────────────────────────────────────────────
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      ANTHROPIC_MODEL,
        max_tokens: 4000,
        messages:   [{ role: 'user', content: ctx }],
      }),
    });

    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);

    const data      = await res.json();
    const stopReason = data.stop_reason || '';

    if (stopReason === 'max_tokens') {
      throw new Error('Claude response was cut off (max_tokens). This should not happen — contact support.');
    }

    if (!data.content || !data.content[0] || !data.content[0].text) {
      throw new Error('Claude returned empty response. stop_reason: ' + stopReason);
    }

    const rawText = data.content[0].text.trim();
    const first   = rawText.indexOf('{');
    const last    = rawText.lastIndexOf('}');
    if (first === -1 || last === -1) {
      throw new Error('No JSON in Claude response. stop_reason: ' + stopReason + '. Starts: ' + rawText.slice(0, 100));
    }

    let metadata;
    try {
      metadata = JSON.parse(rawText.slice(first, last + 1));
    } catch(e) {
      throw new Error('Claude returned invalid JSON: ' + e.message);
    }

    if (!metadata.primaryTitle || !metadata.description || !metadata.tags) {
      throw new Error('Claude response missing required fields');
    }

    // Enrich metadata
    metadata.videoId          = videoId;
    metadata.youtubeUrl       = ytUrl;
    metadata.generatedAt      = new Date().toISOString();
    metadata.signalsUsed      = signalsAvailable;
    metadata.hasTimestamps    = Array.isArray(transcriptTimestamps) && transcriptTimestamps.length > 0;
    metadata.apiKeyConfigured = false; // Leonardo not yet integrated

    // Write to KV permanently
    await env.FFX_KV.put(`youtube:metadata:${videoId}`, JSON.stringify(metadata));
    console.log('[youtube-metadata] Metadata written for:', videoId, '| signals:', signalsAvailable.join(','));

    // Log to intelligence brief_log
    try {
      const today = new Date().toISOString().split('T')[0];
      const log   = await env.FFX_KV.get(`intelligence:brief_log:${today}`, { type: 'json' }).catch(() => null);
      if (log) {
        log.recommendations = log.recommendations || [];
        log.recommendations.push({
          id:         `${today}_ytmeta_${videoId}`,
          type:       'youtube_metadata',
          target:     videoId,
          prediction: 'CTR > 3% and at least 1 GA4 session from youtube.com within 7 days',
          confidence: 'medium',
          actedOn:    new Date().toISOString(),
          outcome:    null,
          accurate:   null,
          signalsUsed: signalsAvailable,
        });
        await env.FFX_KV.put(`intelligence:brief_log:${today}`, JSON.stringify(log));
      }
    } catch(logErr) {
      console.error('[youtube-metadata] Brief log update failed (non-fatal):', logErr.message);
    }

    return new Response(JSON.stringify({ success: true, metadata }), { status: 200, headers });

  } catch(err) {
    console.error('[youtube-metadata] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

function formatSeconds(seconds) {
  if (!seconds && seconds !== 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
