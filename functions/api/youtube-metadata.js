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

  const { videoId, youtubeUrl, title, thumbOnly } = body;
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
      channelCatalog,
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
      env.FFX_KV.get('youtube:channel:catalog',          { type: 'json' }).catch(() => null),
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

    // ── Transcript for the prompt ────────────────────────────────────────
    // Previously truncated at 2500 chars, so title/description/tags were derived
    // from roughly the first 4 minutes of video. Now the whole transcript goes in.
    // Only absurdly long transcripts are trimmed, and then from the middle — the
    // opening hook and the closing payoff are both SEO-load-bearing.
    const TRANSCRIPT_CAP = 120000;
    let transcriptForPrompt;
    if (transcript.length <= TRANSCRIPT_CAP) {
      transcriptForPrompt = transcript;
    } else {
      const head = transcript.slice(0, Math.floor(TRANSCRIPT_CAP * 0.6));
      const tail = transcript.slice(-Math.floor(TRANSCRIPT_CAP * 0.4));
      transcriptForPrompt = head
        + '\n\n[... middle section omitted for length — opening and closing retained ...]\n\n'
        + tail;
    }

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

FULL TRANSCRIPT — the single source of truth for every claim below.
The title, description bullets and tags MUST come from what Salman actually says here,
not from the opening minutes alone. The strongest hook is often mid-video.
${transcriptForPrompt}
`;

    // ── SIGNAL WEIGHT 1: FULL CHANNEL CATALOGUE (highest authority signal) ──
    // Every public upload, scored on views-per-day against the channel MEDIAN so a
    // 2-year-old video does not beat a 2-week-old one purely on age.
    if (channelCatalog && channelCatalog.scoredCount >= 10) {
      signalsAvailable.push('youtube_channel_catalog');
      ctx += `\n${'='.repeat(60)}\nWEIGHT 1 — YOUR FULL CHANNEL CATALOGUE (strongest signal)\n`;
      ctx += `${channelCatalog.scoredCount} long-form videos scored on views-per-day against your channel median (${channelCatalog.medianViewsPerDay}/day).\n`;
      ctx += `A ratio of 1.0 = exactly median. 2.0 = double the median. 0.5 = half.\n`;
      ctx += `${'='.repeat(60)}\n`;

      if (channelCatalog.topPerformers && channelCatalog.topPerformers.length) {
        ctx += `YOUR BEST-PERFORMING TITLES (highest views/day vs median):\n`;
        channelCatalog.topPerformers.forEach(v => {
          ctx += `  ✓ ${v.performanceRatio}x — "${v.title}" (${v.viewCount} views over ${v.ageDays}d)\n`;
        });
      }

      if (channelCatalog.bottomPerformers && channelCatalog.bottomPerformers.length) {
        ctx += `YOUR WEAKEST-PERFORMING TITLES:\n`;
        channelCatalog.bottomPerformers.forEach(v => {
          ctx += `  ✗ ${v.performanceRatio}x — "${v.title}" (${v.viewCount} views over ${v.ageDays}d)\n`;
        });
      }

      const p = channelCatalog.patterns || {};
      const renderPattern = (label, rows) => {
        if (!rows || !rows.length) return;
        ctx += `${label}:\n`;
        rows.slice(0, 6).forEach(r => {
          ctx += `  ${r.value} — ${r.medianPerf}x median performance (n=${r.count})\n`;
        });
      };
      ctx += `\nTITLE PATTERN ANALYSIS (median performance ratio per pattern, n = sample size):\n`;
      renderPattern('Opening word', p.openingWord);
      renderPattern('Title length', p.lengthBucket);
      renderPattern('Numerals', p.hasNumber);
      renderPattern('Question vs statement', p.hasQuestion);
      renderPattern('Colon split', p.hasColon);
      renderPattern('ALL-CAPS word', p.hasCaps);

      ctx += `\nINSTRUCTION: This is measured evidence from YOUR audience — it outranks every\n`;
      ctx += `other signal below. Favour patterns above 1.0x and avoid those below. Ignore any\n`;
      ctx += `pattern with n < 5; the sample is too small to act on.\n`;
    } else if (channelCatalog) {
      ctx += `\nWEIGHT 1 — CHANNEL CATALOGUE: only ${channelCatalog.scoredCount || 0} scored videos — too few for reliable title patterns. Ignore.\n`;
    } else {
      ctx += `\nWEIGHT 1 — CHANNEL CATALOGUE: not yet synced. Run POST /api/youtube-catalog.\n`;
    }

    // ── SIGNAL WEIGHT 1B: FFX-attributed titles (did the suggested title win?) ──
    // Separate from the catalogue above: this is the only source that knows WHICH
    // suggested title was used. Suppressed below 3 samples — with n=1 a video is
    // compared against itself and always reads as a failure.
    if (Array.isArray(ytTitleLearning) && ytTitleLearning.length >= 3) {
      signalsAvailable.push('youtube_ffx_attribution');
      const winners = ytTitleLearning.filter(t => t.beatAverage);
      const losers  = ytTitleLearning.filter(t => t.beatAverage === false);
      ctx += `\n${'='.repeat(60)}\nWEIGHT 1B — FFX-GENERATED TITLE ATTRIBUTION\n`;
      ctx += `${ytTitleLearning.length} videos published through this system, tracking which suggested title was used.\n${'='.repeat(60)}\n`;

      if (winners.length > 0) {
        ctx += `SUGGESTIONS THAT BEAT AVERAGE:\n`;
        winners.slice(0, 5).forEach(t => {
          ctx += `  ✓ "${t.actualTitle}" — ${(t.viewsVsAvgPct > 0 ? '+' : '')}${t.viewsVsAvgPct}% vs avg`;
          if (t.thumbnailHook) ctx += ` | Hook: "${t.thumbnailHook}"`;
          ctx += '\n';
        });
      }
      if (losers.length > 0) {
        ctx += `SUGGESTIONS THAT UNDERPERFORMED:\n`;
        losers.slice(0, 3).forEach(t => {
          ctx += `  ✗ "${t.actualTitle}" — ${t.viewsVsAvgPct}% vs avg\n`;
        });
      }
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

DUAL-PLATFORM SEO MANDATE — read before generating anything:
This package must rank in TWO different search engines with different ranking logic.

  YOUTUBE SEARCH ranks on: exact keyword match in the title, keyword density and
  semantic coverage across the full description, chapter titles (indexed as key
  moments), tags, and — above all — click-through rate and watch time. Keywords must
  appear EARLY. YouTube reads roughly the first 150 characters of the description as
  the primary relevance signal.

  GOOGLE SEARCH surfaces this video in three places: the Video tab, the "Key moments"
  carousel (built directly from your chapter timestamps), and the main blue-link
  results via the paired article. Google reads the FULL description as page text and
  weights natural-language phrasing and semantic depth over keyword repetition.

  RESOLUTION: front-load exact-match keywords for YouTube; carry semantic variants and
  natural phrasing through the body for Google. Never keyword-stuff — YouTube demotes
  it and Google ignores it. Every keyword must read as something Salman would say.

TITLE RULES:
- HARD LIMIT 60 characters. 50-60 is the sweet spot. Never exceed 60 — YouTube truncates.
- Must be grounded in the transcript content — do not invent topics
- TITLE KEYWORD PRIORITY ORDER:
  1. If YouTube Analytics shows exact queries people use to find YOUR videos → use that phrasing verbatim
  2. If the WEIGHT 1 catalogue shows a title pattern above 1.0x with n >= 5 → apply it
  3. If competitor titles show a dominant format for this niche → use it as structure reference
  4. Derive the YouTube equivalent of the GSC targetQuery (shorter, more direct)
  5. Default to the transcript's core insight as the title hook
- PRIMARY KEYWORD MUST APPEAR IN THE FIRST 3 WORDS. This is non-negotiable for YouTube
  search ranking — it is the single highest-weight on-page factor.
- The keyword must be a phrase a retail forex trader would actually type into YouTube
  ("momentum candle", "stop hunt", "liquidity sweep") — not internal CTW jargon alone.
- No clickbait, no ALL-CAPS shouting, no "2026" year-padding unless the content is
  genuinely time-bound.
- Salman's voice — personal, specific, never third-party agency tone
- Suggest 1 primary title + 2 alternatives with reasoning. The 2 alternatives must test
  genuinely DIFFERENT angles (e.g. pain-point vs mechanism vs outcome) — not reworded
  versions of the primary.

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

DESCRIPTION SEO DEPTH — required for Google to rank the video and the paired article:
- The description body must total AT LEAST 250 words before the chapter block. A thin
  description is the most common reason a well-titled video fails to rank on Google.
- The PRIMARY KEYWORD must appear in the first 150 characters (YouTube's relevance
  window), then 2-4 more times naturally across the body. Never more — that is stuffing.
- Include 3-5 SEMANTIC VARIANTS of the primary keyword spread through the body. Example
  for a momentum-candle video: "momentum candle", "large-bodied candle", "continuation
  candle", "displacement candle", "the candle that breaks structure". Google rewards
  this coverage; YouTube uses it to match long-tail queries.
- After the bullet list, add a 2-4 sentence paragraph in Salman's voice expanding on the
  single most important mechanic in the video. This paragraph is what Google indexes as
  the substance of the page — it is not filler.
- Name specific instruments, sessions, timeframes and CTW model codes wherever the
  transcript mentions them. Specificity is what wins long-tail search.
- Never repeat the title verbatim as the first line.

CHAPTER GENERATION RULES — MANDATORY:
${chapterContext ? `You have timestamped transcript data above. USE IT to generate accurate chapter markers.

Chapters are a DUAL-PLATFORM SEO asset, not a convenience feature. YouTube indexes
chapter titles as searchable key moments, and Google builds its "Key moments" carousel
directly from them — that carousel is often how a video earns a blue-link position.

- Generate 5-8 chapters that reflect the actual video structure
- YouTube's HARD REQUIREMENTS — violating any of these disables chapters entirely:
  1. The first chapter MUST be exactly 0:00
  2. There must be AT LEAST 3 chapters
  3. Every chapter must be AT LEAST 10 seconds long — never place two markers closer
     than 10 seconds apart
  4. Timestamps must run in ascending order
- CHAPTER TITLES ARE KEYWORDS. Write them as phrases people search, not as labels.
  Weak: "Introduction" / "Part 2" / "The Setup"
  Strong: "What The Momentum Candle Signals" / "Where Most Traders Enter Too Early"
- The first chapter is the exception — keep it short and orienting, but still specific
  (e.g. "0:00 The Setup In One Sentence" rather than bare "Introduction").
- Do not repeat the same keyword in every chapter title — vary the phrasing to cover
  more long-tail queries.
- Format EXACTLY as YouTube requires (copy-paste ready):
  0:00 Chapter Title
  1:24 Chapter Title
  3:47 Chapter Title
  (etc.)
- Place the chapter block where [CHAPTERS] appears in the description structure` :
`No timestamped transcript available for this video.
Place [TIMESTAMPS] in the description where chapters will go.
Add note: "⚠ Add chapter timestamps after upload."
Chapters will be available on next generation once timestamps are stored.`}

TAGS RULES:
- 15-20 tags. HARD LIMIT: the tags joined with commas must total UNDER 450 characters
  (YouTube's ceiling is 500 and rejects the whole set if exceeded — stay under 450).
- Keep every individual tag under 30 characters. YouTube ignores longer ones.
- Tag order matters — YouTube weights the first few most. Lead with the SINGLE most
  important exact-match keyword for this specific video, NOT with the brand.
- Structure:
  1. The primary keyword, exactly as it appears in the title (position 1)
  2. 2-3 close variants of that primary keyword
  3. 6-8 specific tags drawn from this video's actual content
  4. 2-3 question-format tags matching real search behaviour
     ("what is a momentum candle", "how to trade stop hunts")
  5. Brand and methodology tags LAST: FortitudeFX, Catch the Wick, Salman Khan forex
  6. Broad category tags to close: forex trading, price action, forex strategy
- Mix short-tail (forex trading) and long-tail (catch the wick momentum candle entry).
- Never repeat the same phrase across multiple tags — each must earn its slot.

THUMBNAIL RULES:

USE THIS EXACT PROMPT STRUCTURE for every thumbnail. Fill in the bracketed sections from the transcript.
This structure is proven for YouTube thumbnails. Follow it precisely.

LEONARDO PROMPT TEMPLATE — copy this structure exactly, fill the brackets:

"Create a professional YouTube thumbnail.

Visual Story:
[describe the trading scene as cinematic visuals — what is HAPPENING in this video.
Use visual language: glowing screens, dramatic price movement, dark trading environment.
Examples:
- Momentum candle video: "Dark trading environment. Single large glowing green price bar dominating the screen. Market momentum visible. Clean chart on dark screen."
- Stop hunt video: "Dark screens showing price sweeping through a level then reversing violently. Dramatic red and green contrast."
- Structure video: "Clean dark chart showing a clear horizontal level. Price approaching with tension. Dark atmospheric trading room."
- Entry setup video: "Precise chart moment. Two bars forming a perfect setup. Dark screens. Gold light on the key level."
Never describe a physical candle, wax, or object. Always describe a SCENE on a trading screen.]

Style:
Premium YouTube thumbnail.
Modern financial education channel.
Luxury brand aesthetic — dark, gold accents, cinematic.
Ultra realistic.
Cinematic lighting — dark with single gold/amber light source.
Sharp focus.
High detail.
Professional financial content creator aesthetic.
Dark background — near black with gold accent tones.
FortitudeFX channel aesthetic — institutional, precise, authoritative.

Psychology:
[pick one based on transcript]:
- Educational video: Create curiosity. Make viewer ask: what does this tell me that I am missing?
- Setup video: Create urgency. Make viewer ask: am I seeing this opportunity right now?
- Reversal/danger video: Create tension. Make viewer ask: is this happening to me?
- System video: Create authority. Make viewer trust this is the definitive answer.

Composition:
Dark scene occupying right 60% of frame.
Strong focal point on the key visual element.
High contrast — dark background, bright focal point.
Clear negative space on left 40% for text overlay.
No clutter.
No watermark.
No logo.
No text in image.
16:9 aspect ratio.
4K quality."

STEP 2 — HOOK TEXT (textOverlay):
Maximum 3 words. ALL CAPS. Specific curiosity gap from the transcript's core insight.
Informed by YouTube search queries — what does this specific audience NOT know?

Strong hooks: "PRICE ALREADY TOLD YOU", "STRUCTURE ALREADY BROKE", "THE WICK REVEALS", "BEFORE THE ENTRY", "THEY ALREADY MOVED"
Banned: "FOREX TIPS", "TRADE THIS NOW", "CATCH THE WICK", anything generic

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
    "textOverlay": "3 WORD ALL CAPS HOOK — specific curiosity gap from transcript",
    "leonardoPrompt": "the complete prompt using the template above — Visual Story filled from transcript, Psychology selected, all other sections copied exactly",
    "searchQueryInformed": "which YouTube search query informed the hook text",
    "reasoning": "one sentence — why this visual story + hook will stop a retail forex trader mid-scroll"
  },
  "signalsApplied": {
    "primaryTitleSignal": "which signal drove the title choice",
    "keywordSource": "where the primary keyword came from",
    "thumbnailStrategy": "thumbnail_first or title_first based on discovery data"
  },
  "briefVersion": "${brief?.generatedAt || new Date().toISOString()}"
}

CRITICAL: Return ONLY the raw JSON. No markdown. No code fences. Start with { end with }.`;

    // ── thumbOnly fast path: skip full SEO, generate thumbnail concept only ──
    if (thumbOnly) {
      const thumbCtx = `You are generating a YouTube thumbnail concept for FortitudeFX™.

VIDEO TRANSCRIPT (first 1500 chars):
${transcript.slice(0, 1500)}

YOUTUBE SEARCH SIGNALS:
${ytAnalyticsSignals && ytAnalyticsSignals.topYouTubeSearchQueries
  ? 'Top YouTube search queries: ' + ytAnalyticsSignals.topYouTubeSearchQueries.slice(0,5).map(function(q){return '"'+q.query+'"';}).join(', ')
  : 'No YouTube search data yet.'}

${ytSearchGlobalSignals && ytSearchGlobalSignals.competitorTitles
  ? 'Competitor titles for this niche: ' + ytSearchGlobalSignals.competitorTitles.slice(0,5).map(function(t){return '"'+t.title+'"';}).join(', ')
  : ''}

` + (function() {
        // Slice ONLY the thumbnail rules. Previously this ran to the end of ctx,
        // dragging in the full package's JSON schema alongside the thumbnail-only
        // schema appended below — the model received two conflicting output specs.
        const start = ctx.indexOf('THUMBNAIL RULES:');
        const end   = ctx.indexOf('Return ONLY a valid JSON object:', start);
        return end === -1 ? ctx.slice(start) : ctx.slice(start, end);
      })();

      const thumbRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      ANTHROPIC_MODEL,
          max_tokens: 1200,
          messages:   [{ role: 'user', content: thumbCtx + '\n\nReturn ONLY a valid JSON object:\n{\n  "thumbnailConcept": {\n    "textOverlay": "3 WORD ALL CAPS HOOK — specific curiosity gap from transcript",\n    "leonardoPrompt": "the complete prompt using the template above — Visual Story filled from transcript, Psychology selected, all other sections copied exactly",\n    "searchQueryInformed": "which YouTube search query informed the hook text",\n    "reasoning": "one sentence — why this visual story + hook will stop a retail forex trader mid-scroll"\n  }\n}\nCRITICAL: Return ONLY raw JSON. Start with { end with }.' }],
        }),
      });

      if (!thumbRes.ok) throw new Error('Claude thumbOnly ' + thumbRes.status);
      const thumbData = await thumbRes.json();
      if (thumbData.stop_reason === 'max_tokens') throw new Error('Claude thumbOnly response truncated');
      const thumbRaw  = thumbData.content[0].text.trim();
      const thumbF    = thumbRaw.indexOf('{');
      const thumbL    = thumbRaw.lastIndexOf('}');
      if (thumbF === -1 || thumbL === -1) throw new Error('No JSON in thumbOnly response');
      const thumbParsed = JSON.parse(thumbRaw.slice(thumbF, thumbL + 1));
      if (!thumbParsed.thumbnailConcept) throw new Error('thumbnailConcept missing from thumbOnly response');

      // Merge into existing metadata
      const existingMeta = await env.FFX_KV.get('youtube:metadata:' + videoId, { type: 'json' }).catch(function() { return null; });
      const mergedMeta   = Object.assign({}, existingMeta || {}, {
        thumbnailConcept: thumbParsed.thumbnailConcept,
        videoId:          videoId,
        youtubeUrl:       youtubeUrl || (existingMeta && existingMeta.youtubeUrl) || '',
        signalsUsed:      signalsAvailable,
        hasTimestamps:    Array.isArray(resolvedTimestamps) && resolvedTimestamps.length > 0,
        apiKeyConfigured: false,
      });
      await env.FFX_KV.put('youtube:metadata:' + videoId, JSON.stringify(mergedMeta));
      console.log('[youtube-metadata] thumbOnly complete for:', videoId);
      return new Response(JSON.stringify({ success: true, metadata: mergedMeta }), { status: 200, headers });
    }

    // ── Call Claude (full SEO package) ────────────────────────────────────
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

    // ── Validate + repair against YouTube's hard limits ──────────────────
    // The prompt asks for these limits; nothing previously enforced them, so an
    // over-length title or an invalid chapter block reached the clipboard silently.
    metadata.seoAudit = validateSeoPackage(metadata);

    // Enrich metadata
    metadata.videoId          = videoId;
    metadata.youtubeUrl       = ytUrl;
    metadata.generatedAt      = new Date().toISOString();
    metadata.signalsUsed      = signalsAvailable;
    // Must use resolvedTimestamps, not transcriptTimestamps — when timestamps are
    // fetched fresh in this run, chapters generate but the original KV read is empty.
    metadata.hasTimestamps    = Array.isArray(resolvedTimestamps) && resolvedTimestamps.length > 0;
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

// ── Parse a YouTube chapter timestamp ("1:24" or "1:02:03") into seconds ──
function parseTimestamp(ts) {
  const parts = String(ts).trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  return null;
}

// ── Validate and repair the generated package against YouTube's hard limits ──
// Mutates `meta` in place where a safe automatic repair exists; returns a report
// so the dashboard can show exactly what was adjusted and what still needs a human.
function validateSeoPackage(meta) {
  const errors   = [];  // blocks a clean upload — needs attention
  const warnings = [];  // suboptimal but usable
  const repaired = [];  // fixed automatically

  // ── Title: 60 char hard ceiling ──
  const title = String(meta.primaryTitle || '');
  if (title.length > 60) {
    const alts = (meta.titleAlternatives || [])
      .filter(a => a && a.title && a.title.length <= 60);
    if (alts.length) {
      // Promote the best in-limit alternative rather than truncating mid-word
      const promoted = alts[0];
      meta.titleAlternatives = (meta.titleAlternatives || [])
        .filter(a => a !== promoted)
        .concat([{ title: title, reasoning: 'Original primary — ' + title.length + ' chars, over the 60 limit' }]);
      meta.primaryTitle = promoted.title;
      repaired.push('Primary title was ' + title.length + ' chars (limit 60). Promoted in-limit alternative "' + promoted.title + '"; original moved to alternatives.');
    } else {
      errors.push('Primary title is ' + title.length + ' chars — exceeds YouTube\'s 60 char limit and no alternative fits. Shorten before uploading.');
    }
  } else if (title.length < 30) {
    warnings.push('Primary title is only ' + title.length + ' chars — short titles carry fewer ranking keywords.');
  }

  // ── Tags: 500 char ceiling (we target 450), 30 chars each ──
  if (Array.isArray(meta.tags)) {
    const before = meta.tags.length;
    meta.tags = meta.tags.filter(t => typeof t === 'string' && t.trim().length > 0);

    // Trim from the END — tag order is deliberate, broad category tags sit last
    let dropped = 0;
    while (meta.tags.length > 1 && meta.tags.join(',').length > 450) {
      meta.tags.pop();
      dropped++;
    }
    if (dropped > 0) {
      repaired.push('Dropped ' + dropped + ' trailing tag(s) to stay under YouTube\'s 500 char tag limit (now ' + meta.tags.join(',').length + ' chars).');
    }
    if (meta.tags.length > 20) {
      repaired.push('Trimmed tag list from ' + meta.tags.length + ' to 20.');
      meta.tags = meta.tags.slice(0, 20);
    }
    if (before !== meta.tags.length && dropped === 0) {
      repaired.push('Removed ' + (before - meta.tags.length) + ' empty tag entries.');
    }

    // Report oversize tags only after trimming, so the warning reflects what ships
    const oversize = meta.tags.filter(t => t.length > 30);
    if (oversize.length) {
      warnings.push(oversize.length + ' tag(s) exceed 30 chars and may be ignored by YouTube: ' + oversize.join(', '));
    }
  }

  // ── Chapters: first at 0:00, min 3, ascending, min 10s apart ──
  if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
    const parsed = meta.chapters.map(c => {
      const s = String(c);
      const sp = s.indexOf(' ');
      const stamp = sp === -1 ? s : s.slice(0, sp);
      return { raw: s, seconds: parseTimestamp(stamp), label: sp === -1 ? '' : s.slice(sp + 1).trim() };
    });

    const malformed = parsed.filter(p => p.seconds === null);
    if (malformed.length) {
      errors.push(malformed.length + ' chapter line(s) are not in "M:SS Title" format: ' + malformed.map(m => m.raw).join(' | '));
    }

    const valid = parsed.filter(p => p.seconds !== null).sort((a, b) => a.seconds - b.seconds);

    if (valid.length && valid[0].seconds !== 0) {
      errors.push('First chapter is at ' + valid[0].raw + ', not 0:00. YouTube disables chapters entirely unless the first marker is 0:00.');
    }

    // Drop any marker less than 10s after the previous one — YouTube's minimum
    const spaced = [];
    let droppedClose = 0;
    valid.forEach(p => {
      if (!spaced.length || (p.seconds - spaced[spaced.length - 1].seconds) >= 10) {
        spaced.push(p);
      } else {
        droppedClose++;
      }
    });
    if (droppedClose > 0) {
      repaired.push('Removed ' + droppedClose + ' chapter marker(s) spaced under YouTube\'s 10-second minimum.');
    }

    if (spaced.length < 3) {
      errors.push('Only ' + spaced.length + ' valid chapter(s) — YouTube requires at least 3 to show chapters at all.');
    }

    const genericLabels = spaced.filter(p => /^(introduction|intro|part \d|outro|conclusion|the setup)$/i.test(p.label));
    if (genericLabels.length) {
      warnings.push(genericLabels.length + ' chapter title(s) are generic and carry no search keywords: ' + genericLabels.map(g => g.label).join(', '));
    }

    meta.chapters = spaced.map(p => p.raw);
  }

  // ── Description ──
  const full = (meta.description && meta.description.full) || '';
  const hook = (meta.description && meta.description.hook) || '';
  if (hook.length > 150) {
    warnings.push('Description hook is ' + hook.length + ' chars — only ~125 show before "Show more".');
  }
  const bodyWords = full.split(/\s+/).filter(Boolean).length;
  if (bodyWords < 150) {
    warnings.push('Description is only ~' + bodyWords + ' words. Thin descriptions rank poorly on Google — 250+ is the target.');
  }
  if (full && !/fortitudefx\.com/i.test(full)) {
    errors.push('Description is missing the fortitudefx.com link — the video cannot pass authority to the paired article.');
  }

  return {
    passed:   errors.length === 0,
    errors:   errors,
    warnings: warnings,
    repaired: repaired,
    metrics: {
      titleLength:   String(meta.primaryTitle || '').length,
      tagCount:      Array.isArray(meta.tags) ? meta.tags.length : 0,
      tagCharLength: Array.isArray(meta.tags) ? meta.tags.join(',').length : 0,
      chapterCount:  Array.isArray(meta.chapters) ? meta.chapters.length : 0,
      hookLength:    hook.length,
      descriptionWords: bodyWords,
    },
  };
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
