// functions/api/youtube-metadata.js
// POST /api/youtube-metadata → generates optimised YouTube metadata package
// GET  /api/youtube-metadata?videoId=xxx → returns stored metadata from KV
//
// Reads: transcript:{videoId}, intelligence:brief, seo:signals, ga4:signals,
//        seo:learning:summary, intelligence:accuracy_scores, seo:title_tests:*
// Writes: youtube:metadata:{videoId}
// Called from: Generate YT Metadata button on queue dashboard (orange state)

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
    // ── Read all signal sources ──────────────────────────────────────────
    const [
      transcript,
      brief,
      seoSignals,
      ga4Signals,
      learningSummary,
      accuracyScores,
      videoRecord,
    ] = await Promise.all([
      env.FFX_KV.get(`transcript:${videoId}`, { type: 'text' }).catch(() => null),
      env.FFX_KV.get('intelligence:brief',       { type: 'json' }).catch(() => null),
      env.FFX_KV.get('seo:signals',              { type: 'json' }).catch(() => null),
      env.FFX_KV.get('ga4:signals',              { type: 'json' }).catch(() => null),
      env.FFX_KV.get('seo:learning:summary',     { type: 'json' }).catch(() => null),
      env.FFX_KV.get('intelligence:accuracy_scores', { type: 'json' }).catch(() => null),
      env.FFX_KV.get(`video:${videoId}`,         { type: 'json' }).catch(() => null),
    ]);

    if (!transcript || transcript.trim().length < 100) {
      return new Response(JSON.stringify({
        error: 'Transcript not found or too short. Generate the article first — transcript is stored automatically during generation.'
      }), { status: 400, headers });
    }

    // ── Read completed title tests for learnings ─────────────────────────
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
          titleTestLearnings = `\n━━ TITLE FORMAT LEARNINGS (from A/B tests on this site) ━━\n`;
          if (improved.length > 0)    titleTestLearnings += `Formats that improved CTR:\n${improved.map(t => `  - "${t.newTitle}" — CTR improved`).join('\n')}\n`;
          if (notImproved.length > 0) titleTestLearnings += `Formats that did NOT improve CTR:\n${notImproved.map(t => `  - "${t.newTitle}" — no improvement`).join('\n')}\n`;
          titleTestLearnings += 'Apply these learnings to your title suggestions.\n';
        }
      }
    } catch(e) {
      console.error('[youtube-metadata] Title test read failed (non-fatal):', e.message);
    }

    // ── Build context for Claude ──────────────────────────────────────────
    const videoTitle  = title || videoRecord?.title || 'Unknown title';
    const ytUrl       = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;
    const articleSlug = videoRecord?.slug || null;
    const articleUrl  = articleSlug ? `https://fortitudefx.com/article?slug=${articleSlug}` : 'https://fortitudefx.com/blog';

    let ctx = `You are generating optimised YouTube metadata for FortitudeFX (fortitudefx.com).
Brand: FortitudeFX™ | Methodology: Catch The Wick™ | 2 Candle. 1 Story.™
Founder: Salman Khan — calm, institutional, slightly contrarian voice.
Audience: Retail forex traders seeking mechanical, rules-based trading systems.

VIDEO TITLE (working): ${videoTitle}
VIDEO ID: ${videoId}
YOUTUBE URL: ${ytUrl}
PAIRED ARTICLE URL: ${articleUrl}

TRANSCRIPT (source of truth for this video):
${transcript.slice(0, 3000)}${transcript.length > 3000 ? '\n[...transcript continues...]' : ''}
`;

    if (brief) {
      ctx += `\n━━ INTELLIGENCE BRIEF (today's signals) ━━\n`;
      if (brief.articleBrief?.targetQuery) ctx += `Primary target query: "${brief.articleBrief.targetQuery}"\n`;
      if (brief.promptInjection?.currentSignals) ctx += `Current signals: ${brief.promptInjection.currentSignals}\n`;
      if (brief.weeklyInsight?.momentum) ctx += `Site momentum: ${brief.weeklyInsight.momentum}\n`;

      // YouTube strategy from intelligence engine — apply proven patterns
      if (brief.youtubeStrategy) {
        const ys = brief.youtubeStrategy;
        ctx += `\n━━ YOUTUBE STRATEGY (from intelligence engine — evidence-based) ━━\n`;
        ctx += `Channel momentum: ${ys.channelMomentum || 'unknown'}\n`;
        if (ys.recommendedTitleFormat) ctx += `RECOMMENDED title format (beat channel avg): ${ys.recommendedTitleFormat}\n`;
        if (ys.recommendedVisualScene) ctx += `RECOMMENDED visual scene (beat channel avg): ${ys.recommendedVisualScene}\n`;
        if (ys.recommendedEmotionalRegister) ctx += `RECOMMENDED emotional register: ${ys.recommendedEmotionalRegister}\n`;
        if (ys.recommendedHookStyle) ctx += `RECOMMENDED hook style: ${ys.recommendedHookStyle}\n`;
        if (ys.avoidTitleFormat) ctx += `AVOID title format (underperformed): ${ys.avoidTitleFormat}\n`;
        if (ys.avoidVisualScene) ctx += `AVOID visual scene (underperformed): ${ys.avoidVisualScene}\n`;
        if (ys.reasoning) ctx += `Evidence: ${ys.reasoning}\n`;
        ctx += `INSTRUCTION: Apply the recommended patterns above unless the transcript content strongly dictates otherwise. The channel average is the benchmark — beat it.\n`;
      }
    }

    if (seoSignals) {
      const rising = (seoSignals.risingQueries || []).slice(0, 3).map(q => `"${q.query}"`).join(', ');
      if (rising) ctx += `\nRising search queries this week: ${rising}\n`;
      if (seoSignals.totals?.position) ctx += `Site avg position: ${seoSignals.totals.position.toFixed(1)}\n`;
    }

    if (ga4Signals?.bestTrafficSource) {
      ctx += `\nBest traffic source: ${ga4Signals.bestTrafficSource}\n`;
    }

    if (learningSummary) {
      if (learningSummary.seoSummary)   ctx += `\nSEO pattern: ${learningSummary.seoSummary}\n`;
      if (learningSummary.optimalLength) ctx += `Optimal article length: ${learningSummary.optimalLength} words\n`;
    }

    if (titleTestLearnings) ctx += titleTestLearnings;

    const accuracyNote = accuracyScores && Array.isArray(accuracyScores) && accuracyScores.length > 0
      ? `\nIntelligence accuracy: ${accuracyScores[accuracyScores.length-1].accuracyRate ? (accuracyScores[accuracyScores.length-1].accuracyRate * 100).toFixed(0) + '%' : 'building'}\n`
      : '';
    if (accuracyNote) ctx += accuracyNote;

    ctx += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GENERATE YOUTUBE METADATA PACKAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Using all signal data above, generate the optimal YouTube metadata package.

TITLE RULES:
- Under 60 characters (YouTube truncates at 60 in search)
- Primary keyword in first 3 words where possible
- Salman's voice — direct, specific, not clickbait
- First word should be a power word: "Why", "How", specific pair/level, specific pattern name
- Suggest 1 primary title + 2 alternatives with reasoning

DESCRIPTION RULES:
- First 125 characters (before "Show more") must hook immediately — state the core insight directly, no fluff
- Structure: hook → body explanation → [TIMESTAMPS] → article link → Discord CTA → website
- Include exact keywords from rising queries naturally woven in
- Discord: https://discord.com/invite/fWAPJdR8TR
- Article URL: ${articleUrl}
- Website: https://fortitudefx.com
- Use \\n for line breaks. Chapters must be on separate lines: "0:00 Introduction\\n2:34 Next Chapter"
- The [TIMESTAMPS] placeholder marks where Salman pastes chapter timestamps after upload

TAGS RULES:
- 15-20 tags maximum
- Mix: brand tags, methodology tags (catch the wick, CTW, wick trading), topic-specific tags, question tags
- Always include: FortitudeFX, Catch the Wick, forex trading, price action, forex strategy
- Add 8-10 specific tags from this exact video's content (pairs mentioned, patterns shown, concepts taught)

THUMBNAIL RULES — READ CAREFULLY, EVERY FIELD IS MANDATORY:
Choose the VISUAL SCENE that fits this video's content best:
  A) DRAMATIC_CHART — extreme candlestick spike or crash, cinematic lighting, sense of danger or opportunity
  B) PRICE_ACTION — close-up of a key forex level being hit, precision and tension
  C) VOLATILITY_STORM — chaotic multi-candle market motion, storm energy, urgency
  D) SIGNAL_MOMENT — single clean setup with zones or arrows, surgical and authoritative
  E) AFTERMATH — chart showing the result after the move, proof energy

Choose the EMOTIONAL REGISTER that creates the strongest curiosity gap:
  1) SHOCK — viewer sees something unexpected. For: reversals, surprises, results
  2) AUTHORITY — calm certainty, institutional. For: strategy, system explanations
  3) URGENCY — right now energy. For: live setups, current market conditions
  4) REVELATION — moment of understanding. For: concepts, psychology, "why" videos

Choose COLOUR TEMPERATURE based on content:
  COOL (blue-teal): analytical, educational, system-based content
  WARM (gold-orange): opportunity, profit, live setup content
  RED_ACCENT: risk, stop losses, loss analysis — use sparingly

textOverlay: 3-5 words MAXIMUM. ALL CAPS. Creates a question or tension in the viewer's mind.
Strong examples: "THEY SWEPT MY STOP", "PRICE NEVER LIES", "THIS SETUP NEVER FAILS", "WHY PRICE REVERSED HERE"
Weak examples (never use): "FOREX TRADING TIPS", "HOW TO TRADE FOREX", "CATCH THE WICK TUTORIAL"

leonardoPrompt: A rich, detailed image generation prompt for Leonardo AI Phoenix model.
MUST follow this exact structure:
"[specific scene based on visual scene choice], [lighting description], [colour palette], [mood], cinematic 16:9 composition, left 40 percent of frame is dark clean negative space #0a0a12 with no visual elements for text overlay, right 60 percent contains the main visual subject, gold accent lighting #c9a84c, dark editorial background #0a0a12, [colour temperature specific details], ultra sharp focus, high contrast, professional financial editorial photography, cinematic depth, no text, no watermarks, no logos, no people, 1280x720 YouTube thumbnail format"
Make the [specific scene] section vivid and different each time — this is what creates visual variety across videos.

reasoning: One sentence explaining the CTR psychology — why this specific combination of scene + hook + emotion will make someone stop scrolling.

Return ONLY a valid JSON object:
{
  "primaryTitle": "main title — under 60 chars, keyword-first",
  "titleAlternatives": [
    { "title": "alternative 1 under 60 chars", "reasoning": "explain the CTR angle" },
    { "title": "alternative 2 under 60 chars", "reasoning": "explain the CTR angle" }
  ],
  "description": {
    "hook": "first 125 characters — the hook before Show More. Direct, specific, no preamble.",
    "full": "complete description. Hook paragraph. Body. \\n[TIMESTAMPS]\\n\\nRead the full breakdown: ${articleUrl}\\n\\nJoin 7000+ traders learning Catch The Wick:\\nhttps://discord.com/invite/fWAPJdR8TR\\n\\nFree resources: https://fortitudefx.com"
  },
  "tags": ["FortitudeFX", "Catch the Wick", "forex trading", "price action", "tag4", "tag5"],
  "thumbnailConcept": {
    "visualScene": "A or B or C or D or E — the code letter you chose",
    "emotionalRegister": "1 or 2 or 3 or 4 — the number you chose",
    "colourTemperature": "COOL or WARM or RED_ACCENT",
    "textOverlay": "3-5 WORD ALL CAPS HOOK",
    "leonardoPrompt": "full rich Leonardo AI prompt as specified above — minimum 80 words",
    "reasoning": "one sentence CTR psychology explanation"
  },
  "briefVersion": "${brief?.generatedAt || new Date().toISOString()}",
  "signalsUsed": ["seo", "ga4", "transcript", "brief"]
}

CRITICAL: Return ONLY the raw JSON object. No markdown. No code fences. Start with { end with }.`;

    // ── Call Claude ───────────────────────────────────────────────────────
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 3000,
        messages: [{ role: 'user', content: ctx }],
      }),
    });

    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);

    const data    = await res.json();
    const rawText = data.content[0].text.trim();
    const first   = rawText.indexOf('{');
    const last    = rawText.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('No JSON in Claude response');

    let metadata;
    try { metadata = JSON.parse(rawText.slice(first, last + 1)); } catch(e) {
      throw new Error('Claude returned invalid JSON: ' + e.message);
    }

    // Validate required fields
    if (!metadata.primaryTitle || !metadata.description || !metadata.tags) {
      throw new Error('Claude response missing required fields: primaryTitle, description, or tags');
    }

    // Add generation metadata
    metadata.videoId     = videoId;
    metadata.youtubeUrl  = ytUrl;
    metadata.generatedAt = new Date().toISOString();

    // Write to KV permanently
    await env.FFX_KV.put(`youtube:metadata:${videoId}`, JSON.stringify(metadata));
    console.log('[youtube-metadata] Metadata written for videoId:', videoId);

    // Write to intelligence:brief_log as youtube_metadata recommendation
    try {
      const today = new Date().toISOString().split('T')[0];
      const log   = await env.FFX_KV.get(`intelligence:brief_log:${today}`, { type: 'json' }).catch(() => null);
      if (log) {
        log.recommendations.push({
          id:         `${today}_ytmeta_${videoId}`,
          type:       'youtube_metadata',
          target:     videoId,
          prediction: 'CTR > 3% and at least 1 GA4 session from youtube.com within 7 days',
          confidence: 'medium',
          actedOn:    new Date().toISOString(),
          outcome:    null,
          accurate:   null,
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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
