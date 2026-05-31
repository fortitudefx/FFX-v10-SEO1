// ffx-social-scanner/index.js
// Standalone Cloudflare Worker — triggered by Pages Function social-intelligence.js
// Runs the full Anthropic web search scan with no timeout pressure
// Writes results directly to FFX_KV
// Called via: fetch(env.SOCIAL_SCANNER_URL, { method: 'POST', body: JSON.stringify({ today }) })

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

export default {
  async fetch(request, env) {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Scanner-Secret',
      }});
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set on scanner Worker' }), { status: 500, headers });
    }

    let body = {};
    try { body = await request.json(); } catch { body = {}; }

    const today = body.today || new Date().toISOString().split('T')[0];

    console.log('[ffx-social-scanner] Scan started for date:', today);

    try {
      // ── Step 1: Reading signals ───────────────────────────────────────────
      await writeProgress(env, today, 1, 'Reading your SEO signals and intelligence brief…', null);

      const [seoSignals, brief, voiceCalibration, existingPerf] = await Promise.all([
        env.FFX_KV.get('seo:signals',                    { type: 'json' }).catch(() => null),
        env.FFX_KV.get('intelligence:brief',              { type: 'json' }).catch(() => null),
        env.FFX_KV.get('intelligence:voice_calibration',  { type: 'json' }).catch(() => null),
        getReplyPerformanceSummary(env).catch(() => null),
      ]);

      // ── Step 2: Building keywords ─────────────────────────────────────────
      const keywords = buildKeywords(seoSignals, brief);
      await writeProgress(env, today, 2, `Built keyword list: ${keywords.slice(0, 4).join(', ')}`, null);

      if (!keywords.length) {
        const errSignal = {
          date: today, scannedAt: new Date().toISOString(), scanning: false,
          opportunitiesFound: 0, error: 'No keywords — run SEO signals and Run Analysis first',
          keywords: [], acted: 0, dismissed: 0, progress: [], progressStep: 0,
        };
        await env.FFX_KV.put('intelligence:signals', JSON.stringify(errSignal), { expirationTtl: 86400 * 30 });
        console.error('[ffx-social-scanner] No keywords available');
        return new Response(JSON.stringify({ success: false, error: 'No keywords' }), { status: 400, headers });
      }

      console.log('[ffx-social-scanner] Scanning with keywords:', keywords.slice(0, 5).join(', '));

      // ── Step 3: Claude searching ──────────────────────────────────────────
      await writeProgress(env, today, 3, 'Claude is searching Reddit, BabyPips, ForexFactory, Quora and YouTube for active threads…', null);

      // ── Run Claude scan — this is the slow step (60-90s) — no timeout here ─
      const opportunities = await runScan(keywords, brief, voiceCalibration, existingPerf, env.ANTHROPIC_API_KEY);

      // ── Step 4: Drafting replies ──────────────────────────────────────────
      await writeProgress(env, today, 4, `Found ${opportunities.length} qualifying threads. Drafting replies in your voice…`, null);

      // ── Write each opportunity to KV ──────────────────────────────────────
      let written = 0;
      const writtenIds = [];

      if (opportunities && opportunities.length) {
        for (const opp of opportunities.slice(0, 5)) {
          try {
            if (!opp.id) opp.id = generateId(opp.platform, opp.keyword);
            opp.detectedAt = new Date().toISOString();
            opp.status     = 'surfaced';

            await env.FFX_KV.put(
              `intelligence:opportunities:${opp.id}`,
              JSON.stringify(opp),
              { expirationTtl: 86400 * 7 },
            );

            // Verify write
            const verify = await env.FFX_KV.get(`intelligence:opportunities:${opp.id}`, { type: 'json' }).catch(() => null);
            if (!verify) {
              console.error('[ffx-social-scanner] KV verify FAILED for:', opp.id);
              continue;
            }

            written++;
            writtenIds.push(opp.id);
            console.log('[ffx-social-scanner] Opportunity written and verified:', opp.id, opp.platform, opp.urgency);
          } catch (writeErr) {
            console.error('[ffx-social-scanner] Opportunity write error (non-fatal):', writeErr.message);
          }
        }
      }

      // ── Write final scan summary — scanning:false signals completion ───────
      const signals = {
        date:               today,
        scannedAt:          new Date().toISOString(),
        scanning:           false,
        opportunitiesFound: written,
        keywords:           keywords.slice(0, 5),
        topPlatform:        opportunities?.[0]?.platform || null,
        topKeywords:        [...new Set((opportunities || []).map(o => o.keyword).filter(Boolean))].slice(0, 3),
        acted:              0,
        dismissed:          0,
      };

      // ── Step 5: Complete ─────────────────────────────────────────────────
      signals.progress     = ['✓ Signals read', '✓ Keywords built', '✓ Forums searched', '✓ Replies drafted', `✓ ${written} opportunit${written !== 1 ? 'ies' : 'y'} saved`];
      signals.progressStep = 5;
      await env.FFX_KV.put('intelligence:signals', JSON.stringify(signals), { expirationTtl: 86400 * 30 });

      // Verify signals write
      const sigVerify = await env.FFX_KV.get('intelligence:signals', { type: 'json' }).catch(() => null);
      if (!sigVerify || sigVerify.scanning !== false) {
        console.error('[ffx-social-scanner] intelligence:signals final write verification FAILED');
      } else {
        console.log('[ffx-social-scanner] Scan complete. Opportunities written:', written, 'Signals verified.');
      }

      return new Response(JSON.stringify({ success: true, opportunitiesFound: written, ids: writtenIds }), { status: 200, headers });

    } catch (err) {
      console.error('[ffx-social-scanner] Fatal scan error:', err.message);

      // Write error state to KV so dashboard can show it
      try {
        await env.FFX_KV.put('intelligence:signals', JSON.stringify({
          date:               today,
          scannedAt:          new Date().toISOString(),
          scanning:           false,
          opportunitiesFound: 0,
          error:              err.message,
          keywords:           [],
          acted:              0,
          dismissed:          0,
        }), { expirationTtl: 86400 * 30 });
      } catch (kvErr) {
        console.error('[ffx-social-scanner] Failed to write error state to KV:', kvErr.message);
      }

      return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers });
    }
  },
};

// ── Build keyword list from SEO signals and brief ─────────────────────────
function buildKeywords(seoSignals, brief) {
  const keywords = new Set();

  if (seoSignals && Array.isArray(seoSignals.risingQueries)) {
    seoSignals.risingQueries.slice(0, 5).forEach(q => { if (q.query) keywords.add(q.query); });
  }

  if (brief?.articleBrief?.targetQuery) {
    keywords.add(brief.articleBrief.targetQuery);
  }

  if (brief?.articleBrief?.nuggetTags && Array.isArray(brief.articleBrief.nuggetTags)) {
    brief.articleBrief.nuggetTags.slice(0, 3).forEach(t => keywords.add(t));
  }

  // Always include CTW-aligned fallback keywords
  const fallbackKeywords = [
    'forex wick trading strategy',
    'stop loss hunting forex',
    'price action entry strategy',
    'london session forex setup',
    'liquidity sweep trading',
    'candle wick entry forex',
    'institutional order flow trading',
    'how to trade wicks',
  ];
  fallbackKeywords.forEach(k => keywords.add(k));

  return [...keywords].slice(0, 8);
}

// ── Run Claude scan with web search ──────────────────────────────────────
async function runScan(keywords, brief, voiceCalibration, existingPerf, apiKey) {
  const keywordList = keywords.slice(0, 6).map(k => `"${k}"`).join(', ');

  const voiceRules = voiceCalibration?.corrections?.length > 0
    ? `\nVoice calibration corrections (apply to every draft):\n${voiceCalibration.corrections.slice(0, 5).map(c => `- ${c}`).join('\n')}`
    : '';

  const perfContext = existingPerf?.totalPosted > 0
    ? `\nPast reply performance: ${existingPerf.totalPosted} replies posted. Best platform: ${existingPerf.topPlatform || 'unknown'}. Best keyword: "${existingPerf.topKeyword || 'unknown'}". Traffic generated: ${existingPerf.totalTraffic} sessions.`
    : '';

  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are the Social Intelligence Agent for FortitudeFX, a forex trading education brand built around the Catch The Wick™ (CTW) methodology by Salman Khan.

Your job is to find 3-5 active forum threads where traders are asking questions that the CTW methodology directly answers, then draft genuine, value-adding replies in Salman's voice.

SALMAN'S VOICE:
- Direct, institutional, slightly contrarian
- First sentence is a direct answer — never a preamble
- Never: "Great question!", "As a trader myself...", "I highly recommend..."
- Never self-promotional in the opening paragraph
- Maximum 3 paragraphs per reply
- CTW methodology explained in plain language, not jargon-heavy
- If linking: link goes in the final paragraph naturally, never forced
- Tone: calm authority, like someone who has seen this question a hundred times and knows the exact answer${voiceRules}

THE CTW FRAMEWORK (use this to answer questions):
- Wicks form because institutions sweep liquidity before reversing
- The wick that hits your stop IS the institutional fill — price reverses after
- Entry is on the close of the wick candle, not the next candle
- Stop goes beyond the wick extreme — tight, mechanical
- The two-candle sequence: wick candle + confirmation close = complete setup
- Works across all pairs, all sessions — it is mechanical, not subjective

TARGET PLATFORMS (search these specifically):
- site:reddit.com/r/Forex
- site:reddit.com/r/Daytrading
- site:babypips.com/forum
- site:forexfactory.com
- site:quora.com (forex trading questions)
- YouTube comments on high-traffic generic forex education videos (NOT competitor channels)

FRESHNESS REQUIREMENT: Only surface threads with activity within the last 14 days. Discard anything older.

KEYWORDS TO SEARCH: ${keywordList}${perfContext}

Today is ${today}.`;

  const userPrompt = `Search for 3-5 active forum threads where traders are asking questions that the Catch The Wick methodology directly answers.

For each keyword, search the target platforms. Filter ruthlessly:
1. Thread must have had activity in the last 14 days (check snippet dates)
2. Question format — someone is asking for help or strategy advice
3. CTW methodology is a direct, complete answer to their question
4. Thread has at least 3 replies (active discussion, not dead)
5. Maximum 5 opportunities total — quality over volume

For each qualifying thread, fetch the URL to read the actual thread content before drafting the reply.

Then return a JSON array of opportunity objects. Return ONLY the raw JSON array — no markdown, no preamble, start with [ and end with ].

Each object:
{
  "platform": "reddit|babypips|forexfactory|quora|youtube",
  "platformDisplay": "r/Forex|r/Daytrading|BabyPips|ForexFactory|Quora|YouTube",
  "url": "exact URL to the thread",
  "replyUrl": "direct URL to reply/comment section (same as url for most)",
  "topic": "what the thread is asking in one sentence",
  "threadTitle": "the actual title or first line of the thread",
  "keyword": "which keyword triggered this find",
  "threadAgeDays": 3,
  "threadReplies": 14,
  "urgency": "high|medium|low",
  "urgencyReason": "why this urgency level",
  "draft": "full reply draft in Salman's voice — max 3 paragraphs, direct answer first",
  "draftWithoutLink": "version of draft with no article link",
  "includeLinkRecommendation": true,
  "linkRecommendationReason": "why link is or is not recommended here",
  "articleToLink": "which article slug is most relevant (or null if none yet)",
  "utmTaggedUrl": "https://fortitudefx.com/article?slug=SLUG&utm_source=PLATFORM&utm_medium=reply&utm_campaign=organic&utm_content=KEYWORD or null",
  "nuggetTagsUsed": ["wick", "institutional", "liquidity"],
  "noLinkDraft": false
}

Search now. Find real active threads. Draft genuine helpful replies.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model:      ANTHROPIC_MODEL,
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system:   systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();

  console.log('[ffx-social-scanner] Claude stop_reason:', data.stop_reason, 'content blocks:', data.content?.length);
  if (data.content) {
    data.content.forEach((block, i) => console.log(`  block[${i}]: type=${block.type}`));
  }

  // Extract all text blocks — web search responses have tool_use blocks before final text
  let rawText = '';
  if (data.content && Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text') rawText += block.text;
    }
  }

  if (!rawText.trim()) {
    console.error('[ffx-social-scanner] No text in Claude response. Stop reason:', data.stop_reason);
    console.error('[ffx-social-scanner] Full response:', JSON.stringify(data).slice(0, 1000));
    return [];
  }

  // Parse JSON array from response
  const first = rawText.indexOf('[');
  const last  = rawText.lastIndexOf(']');
  if (first === -1 || last === -1) {
    console.error('[ffx-social-scanner] No JSON array in Claude response. Raw text:', rawText.slice(0, 500));
    return [];
  }

  let opportunities;
  try {
    opportunities = JSON.parse(rawText.slice(first, last + 1));
  } catch (parseErr) {
    console.error('[ffx-social-scanner] JSON parse failed:', parseErr.message);
    console.error('[ffx-social-scanner] Raw JSON attempt:', rawText.slice(first, first + 500));
    return [];
  }

  if (!Array.isArray(opportunities)) {
    console.error('[ffx-social-scanner] Parsed result is not an array');
    return [];
  }

  // Filter: require url, draft, platform, and at least one of threadTitle/topic
  const valid = opportunities.filter(opp => {
    if (!opp.url || !opp.draft || !opp.platform) return false;
    if (!opp.threadTitle && !opp.topic) return false;
    return true;
  });

  console.log('[ffx-social-scanner] Claude returned', opportunities.length, 'raw,', valid.length, 'valid after filtering');
  return valid;
}

// ── Get reply performance summary ─────────────────────────────────────────
async function getReplyPerformanceSummary(env) {
  try {
    const list = await env.FFX_KV.list({ prefix: 'intelligence:reply_performance:' }).catch(() => null);
    if (!list || !list.keys.length) return null;

    let totalPosted = 0, highCount = 0, totalTraffic = 0;
    const platformCounts = {}, keywordCounts = {};

    for (const key of list.keys.slice(0, 30)) {
      const perf = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
      if (!perf) continue;
      totalPosted++;
      if (perf.overallResult === 'high') highCount++;
      totalTraffic += perf.trafficGenerated || 0;
      if (perf.platform) platformCounts[perf.platform] = (platformCounts[perf.platform] || 0) + 1;
      if (perf.keyword)  keywordCounts[perf.keyword]   = (keywordCounts[perf.keyword]  || 0) + 1;
    }

    const topPlatform = Object.entries(platformCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const topKeyword  = Object.entries(keywordCounts).sort((a, b) => b[1] - a[1])[0]?.[0]  || null;

    return { totalPosted, highCount, totalTraffic, topPlatform, topKeyword };
  } catch (err) {
    console.error('[ffx-social-scanner] getReplyPerformanceSummary error:', err.message);
    return null;
  }
}

// ── Write progress to KV so dashboard can show live status ──────────────
async function writeProgress(env, today, step, message, error) {
  try {
    const existing = await env.FFX_KV.get('intelligence:signals', { type: 'json' }).catch(() => null) || {};
    const progressSteps = [
      'Reading signals',
      'Building keywords',
      'Searching forums',
      'Drafting replies',
      'Saving results',
    ];
    const progress = progressSteps.map((label, i) => {
      if (i + 1 < step)  return `✓ ${label}`;
      if (i + 1 === step) return `⚡ ${label}`;
      return `○ ${label}`;
    });
    await env.FFX_KV.put('intelligence:signals', JSON.stringify({
      ...existing,
      scanning:    true,
      progressStep: step,
      progressMsg:  message,
      progress,
      error:        error || null,
    }), { expirationTtl: 86400 * 30 });
  } catch(e) {
    console.error('[ffx-social-scanner] writeProgress failed (non-fatal):', e.message);
  }
}

// ── Generate unique opportunity ID ────────────────────────────────────────
function generateId(platform, keyword) {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const hash  = Math.random().toString(36).slice(2, 7);
  const safe  = (platform || 'unknown').replace(/[^a-z0-9]/gi, '').slice(0, 10);
  return `opp_${today}_${safe}_${hash}`;
}
