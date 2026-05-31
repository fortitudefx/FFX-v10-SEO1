// functions/api/social-intelligence.js
// POST /api/social-intelligence → runs scan via Claude + web search, drafts replies
// POST /api/social-intelligence (action) → records outcome for an opportunity
// GET  /api/social-intelligence → returns today's opportunities from KV

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// ── Helpers ───────────────────────────────────────────────────────────────
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateId(platform, keyword) {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const hash  = Math.random().toString(36).slice(2, 7);
  const safe  = (platform || 'unknown').replace(/[^a-z0-9]/gi, '').slice(0, 10);
  return `opp_${today}_${safe}_${hash}`;
}

// ── GET — return today's opportunities ────────────────────────────────────
export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    const today = new Date().toISOString().split('T')[0];
    const list  = await env.FFX_KV.list({ prefix: 'intelligence:opportunities:' }).catch(() => null);

    if (!list || !list.keys.length) {
      return json({ opportunities: [], scanStatus: 'not_run', date: today }, 200, headers);
    }

    const opportunities = [];
    for (const key of list.keys) {
      const opp = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
      if (!opp) continue;
      // Only return today's opportunities
      if (opp.detectedAt && !opp.detectedAt.startsWith(today)) continue;
      opportunities.push(opp);
    }

    // Sort: high urgency first, then medium, then low
    const urgencyOrder = { high: 0, medium: 1, low: 2 };
    opportunities.sort((a, b) => (urgencyOrder[a.urgency] ?? 2) - (urgencyOrder[b.urgency] ?? 2));

    // Read voice calibration for context
    const voiceCalibration = await env.FFX_KV.get('intelligence:voice_calibration', { type: 'json' }).catch(() => null);

    // Read weekly performance summary
    const signals = await env.FFX_KV.get('intelligence:signals', { type: 'json' }).catch(() => null);

    return json({ opportunities, scanStatus: 'complete', date: today, voiceCalibration, signals }, 200, headers);

  } catch (err) {
    console.error('[social-intelligence] GET error:', err.message);
    return json({ error: err.message }, 500, headers);
  }
}

// ── POST — run scan OR record outcome ────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  // ── Record outcome for an existing opportunity ──────────────────────────
  if (body.opportunityId && body.action) {
    return recordOutcome(body, env, headers);
  }

  // ── Run scan — dispatched to standalone ffx-social-scanner Worker ──────────
  // ANTHROPIC_API_KEY lives on the scanner Worker, not here

  // ── Mark scan as in-progress in KV so dashboard shows scanning state ──────
  const today = new Date().toISOString().split('T')[0];
  try {
    await env.FFX_KV.put('intelligence:signals', JSON.stringify({
      date:               today,
      scannedAt:          new Date().toISOString(),
      scanning:           true,
      opportunitiesFound: 0,
      keywords:           [],
      acted:              0,
      dismissed:          0,
    }), { expirationTtl: 86400 * 30 });
  } catch(e) {
    console.error('[social-intelligence] Failed to write scanning state (non-fatal):', e.message);
  }

  // ── Fire request to standalone Worker — returns immediately, scan runs there ─
  // SOCIAL_SCANNER_URL env var = https://ffx-social-scanner.YOUR-SUBDOMAIN.workers.dev
  if (!env.SOCIAL_SCANNER_URL) {
    // Fallback error — SOCIAL_SCANNER_URL not configured
    console.error('[social-intelligence] SOCIAL_SCANNER_URL not set in Pages env vars');
    await env.FFX_KV.put('intelligence:signals', JSON.stringify({
      date: today, scannedAt: new Date().toISOString(), scanning: false,
      opportunitiesFound: 0, error: 'SOCIAL_SCANNER_URL not configured in Pages environment variables',
      keywords: [], acted: 0, dismissed: 0,
    }), { expirationTtl: 86400 * 30 });
    return json({ error: 'SOCIAL_SCANNER_URL not set — add it to Cloudflare Pages environment variables' }, 500, headers);
  }

  if (!env.SCANNER_SECRET) {
    console.error('[social-intelligence] SCANNER_SECRET not set in Pages env vars');
    return json({ error: 'SCANNER_SECRET not set — add it to Cloudflare Pages environment variables' }, 500, headers);
  }

  // ── Call scanner Worker and capture response for dashboard visibility ───────
  // We await the fetch but with a short timeout — scanner Worker responds immediately
  // then continues running. This lets us capture any connection/auth errors.
  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 10000); // 10s to get initial response

    let scannerStatus = null;
    let scannerError  = null;

    try {
      const scannerRes = await fetch(env.SOCIAL_SCANNER_URL, {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'X-Scanner-Secret':  env.SCANNER_SECRET,
        },
        body:   JSON.stringify({ today }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      scannerStatus = scannerRes.status;

      if (!scannerRes.ok) {
        // Scanner Worker returned an error — read the body
        const errBody = await scannerRes.json().catch(() => ({ error: 'Could not parse scanner error response' }));
        scannerError = `Scanner Worker returned ${scannerRes.status}: ${errBody.error || JSON.stringify(errBody)}`;
        console.error('[social-intelligence] Scanner Worker error:', scannerError);

        // Write error to KV so dashboard shows it
        await env.FFX_KV.put('intelligence:signals', JSON.stringify({
          date:               today,
          scannedAt:          new Date().toISOString(),
          scanning:           false,
          opportunitiesFound: 0,
          error:              scannerError,
          keywords:           [],
          acted:              0,
          dismissed:          0,
        }), { expirationTtl: 86400 * 30 });

        return json({ success: false, error: scannerError, scannerStatus }, 200, headers);
      }

      // Scanner Worker accepted the request — it will write results to KV when done
      console.log('[social-intelligence] Scanner Worker accepted scan:', scannerStatus);

    } catch(fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        // Timeout reaching scanner — may still be running but connection failed
        scannerError = `Could not reach scanner Worker within 10 seconds. Check SOCIAL_SCANNER_URL is correct: ${env.SOCIAL_SCANNER_URL}`;
      } else {
        scannerError = `Network error reaching scanner Worker: ${fetchErr.message}. URL: ${env.SOCIAL_SCANNER_URL}`;
      }
      console.error('[social-intelligence]', scannerError);

      await env.FFX_KV.put('intelligence:signals', JSON.stringify({
        date:               today,
        scannedAt:          new Date().toISOString(),
        scanning:           false,
        opportunitiesFound: 0,
        error:              scannerError,
        keywords:           [],
        acted:              0,
        dismissed:          0,
      }), { expirationTtl: 86400 * 30 });

      return json({ success: false, error: scannerError }, 200, headers);
    }

  } catch(outerErr) {
    console.error('[social-intelligence] Outer fetch error:', outerErr.message);
    return json({ success: false, error: outerErr.message }, 200, headers);
  }

  return json({ success: true, scanning: true, message: 'Scan dispatched to scanner Worker. Poll GET for results.' }, 200, headers);
}

// ── Record outcome (posted / dismissed / edited) ──────────────────────────
async function recordOutcome(body, env, headers) {
  const { opportunityId, action, editedReply, dismissReason } = body;

  try {
    const key = `intelligence:opportunities:${opportunityId}`;
    const opp = await env.FFX_KV.get(key, { type: 'json' }).catch(() => null);

    if (!opp) {
      return json({ error: `Opportunity ${opportunityId} not found in KV` }, 404, headers);
    }

    const now = new Date().toISOString();

    if (action === 'posted_as_is') {
      opp.status       = 'posted-as-is';
      opp.postedAt     = now;
      opp.editDistance = 0;
      opp.editType     = null;
      opp.finalReply   = opp.draft;
      opp.linkIncluded = opp.includeLinkRecommendation || false;
    } else if (action === 'posted_edited') {
      const original = opp.draft || '';
      const edited   = editedReply || '';
      const editDist = levenshteinApprox(original, edited);
      opp.status        = 'posted-edited';
      opp.postedAt      = now;
      opp.editedVersion = edited;
      opp.editDistance  = editDist;
      opp.editType      = classifyEdit(original, edited);
      opp.finalReply    = edited;
      opp.linkIncluded  = opp.includeLinkRecommendation || false;

      // Update voice calibration with edit pattern
      await updateVoiceCalibration(env, opp.editType, original, edited);

    } else if (action === 'dismissed') {
      opp.status        = 'dismissed';
      opp.dismissedAt   = now;
      opp.dismissReason = dismissReason || 'not_specified';
    } else {
      return json({ error: `Unknown action: ${action}` }, 400, headers);
    }

    // Write updated opportunity
    await env.FFX_KV.put(key, JSON.stringify(opp), { expirationTtl: 86400 * 7 });

    // Verify write
    const verify = await env.FFX_KV.get(key, { type: 'json' }).catch(() => null);
    if (!verify || verify.status !== opp.status) {
      return json({ error: 'KV write verification failed — outcome not saved', verified: false }, 500, headers);
    }

    // Write performance record for posted replies (72hr tracking)
    if (action === 'posted_as_is' || action === 'posted_edited') {
      try {
        const perfKey = `intelligence:reply_performance:${opportunityId}`;
        const perf = {
          id:               opportunityId,
          platform:         opp.platform,
          keyword:          opp.keyword,
          topic:            opp.topic,
          linkIncluded:     opp.linkIncluded,
          utmUrl:           opp.utmTaggedUrl || null,
          postedAt:         now,
          editDistance:     opp.editDistance || 0,
          trafficGenerated: 0,   // Updated at 72hrs
          discordClicks:    0,
          followUpReplies:  0,
          overallResult:    'pending',
          checkedAt:        null,
          accurate:         null,
        };
        await env.FFX_KV.put(perfKey, JSON.stringify(perf), { expirationTtl: 86400 * 30 });
        console.log('[social-intelligence] Reply performance record created:', perfKey);
      } catch (perfErr) {
        console.error('[social-intelligence] Performance record write failed (non-fatal):', perfErr.message);
      }

      // Update signals acted count
      try {
        const signals = await env.FFX_KV.get('intelligence:signals', { type: 'json' }).catch(() => null);
        if (signals) {
          signals.acted = (signals.acted || 0) + 1;
          await env.FFX_KV.put('intelligence:signals', JSON.stringify(signals), { expirationTtl: 86400 * 30 });
        }
      } catch (sigErr) {
        console.error('[social-intelligence] Signals acted count update failed (non-fatal):', sigErr.message);
      }
    }

    if (action === 'dismissed') {
      try {
        const signals = await env.FFX_KV.get('intelligence:signals', { type: 'json' }).catch(() => null);
        if (signals) {
          signals.dismissed = (signals.dismissed || 0) + 1;
          await env.FFX_KV.put('intelligence:signals', JSON.stringify(signals), { expirationTtl: 86400 * 30 });
        }
      } catch {}
    }

    console.log('[social-intelligence] Outcome recorded and verified:', opportunityId, action);
    return json({ success: true, verified: true, opportunityId, action, status: opp.status }, 200, headers);

  } catch (err) {
    console.error('[social-intelligence] recordOutcome error:', err.message);
    return json({ error: err.message, verified: false }, 500, headers);
  }
}

// ── Build keyword list from signals ──────────────────────────────────────
function buildKeywords(seoSignals, brief) {
  const keywords = new Set();

  // Rising queries from Search Console
  if (seoSignals && Array.isArray(seoSignals.risingQueries)) {
    seoSignals.risingQueries.slice(0, 5).forEach(q => {
      if (q.query) keywords.add(q.query);
    });
  }

  // Today's target query from brief
  if (brief && brief.articleBrief && brief.articleBrief.targetQuery) {
    keywords.add(brief.articleBrief.targetQuery);
  }

  // Nugget tags from brief
  if (brief && brief.articleBrief && Array.isArray(brief.articleBrief.nuggetTags)) {
    brief.articleBrief.nuggetTags.slice(0, 3).forEach(t => keywords.add(t));
  }

  // Always include these high-value CTW-aligned keywords as fallback
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

  const voiceRules = voiceCalibration && voiceCalibration.corrections && voiceCalibration.corrections.length > 0
    ? `\nVoice calibration corrections (apply to every draft):\n${voiceCalibration.corrections.slice(0, 5).map(c => `- ${c}`).join('\n')}`
    : '';

  const perfContext = existingPerf && existingPerf.totalPosted > 0
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

FRESHNESS REQUIREMENT: Only surface threads with activity within the last 14 days. Discard anything older. Check dates in search snippets.

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
  "replyUrl": "direct URL to reply/comment section (same as url for most, comment URL for YouTube)",
  "topic": "what the thread is asking in one sentence",
  "threadTitle": "the actual title or first line of the thread",
  "keyword": "which keyword triggered this find",
  "threadAgeDays": 3,
  "threadReplies": 14,
  "urgency": "high|medium|low",
  "urgencyReason": "why this urgency level — freshness, reply count, keyword alignment",
  "draft": "full reply draft in Salman's voice — max 3 paragraphs, direct answer first",
  "draftWithoutLink": "version of draft with no article link — standalone value",
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
      'Content-Type':       'application/json',
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
      'anthropic-beta':     'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model:      ANTHROPIC_MODEL,
      max_tokens: 8000,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
        },
      ],
      system:   systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();

  // Log stop reason and content structure for debugging
  console.log('[social-intelligence] Claude stop_reason:', data.stop_reason, 'content blocks:', data.content?.length);
  if (data.content) {
    data.content.forEach((block, i) => console.log(`  block[${i}]: type=${block.type}`));
  }

  // Extract text from response — may have tool use blocks before final text
  let rawText = '';
  if (data.content && Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text') rawText += block.text;
    }
  }

  if (!rawText.trim()) {
    console.error('[social-intelligence] No text in Claude response. Stop reason:', data.stop_reason, 'Full response:', JSON.stringify(data).slice(0, 1000));
    return [];
  }

  // Parse JSON array from response
  const first = rawText.indexOf('[');
  const last  = rawText.lastIndexOf(']');
  if (first === -1 || last === -1) {
    console.error('[social-intelligence] No JSON array in Claude response. Raw:', rawText.slice(0, 500));
    return [];
  }

  let opportunities;
  try {
    opportunities = JSON.parse(rawText.slice(first, last + 1));
  } catch (parseErr) {
    console.error('[social-intelligence] JSON parse failed:', parseErr.message, rawText.slice(first, first + 500));
    return [];
  }

  if (!Array.isArray(opportunities)) {
    console.error('[social-intelligence] Parsed result is not an array');
    return [];
  }

  // Filter and validate
  const valid = opportunities.filter(opp => {
    if (!opp.url || !opp.draft || !opp.platform) return false;
    if (!opp.threadTitle && !opp.topic) return false;
    return true;
  });

  console.log('[social-intelligence] Claude returned', opportunities.length, 'opportunities,', valid.length, 'valid after filtering');
  return valid;
}

// ── Update voice calibration from edit pattern ────────────────────────────
async function updateVoiceCalibration(env, editType, original, edited) {
  try {
    const cal = await env.FFX_KV.get('intelligence:voice_calibration', { type: 'json' }).catch(() => null)
      || { corrections: [], editHistory: [], lastUpdated: null };

    cal.editHistory = cal.editHistory || [];
    cal.editHistory.push({
      editType,
      recordedAt: new Date().toISOString(),
    });

    // Count edit types — after 10 of same type, add correction
    const counts = {};
    cal.editHistory.forEach(e => { if (e.editType) counts[e.editType] = (counts[e.editType] || 0) + 1; });

    cal.corrections = cal.corrections || [];

    // Auto-generate corrections at 10+ repeats
    const correctionMap = {
      length_reduction:    'Shorten replies — opening paragraph max 2 sentences. Total max 150 words.',
      tone_adjustment:     'Soften tone — less assertive, more advisory in delivery.',
      removed_promo:       'Never include self-promotional language in first 2 paragraphs.',
      added_personal:      'Include specific personal trading observation in middle paragraph.',
      factual_correction:  'Double-check all specific numbers, pairs, and timeframes before including.',
    };

    Object.entries(counts).forEach(([type, count]) => {
      if (count >= 10) {
        const correction = correctionMap[type];
        if (correction && !cal.corrections.includes(correction)) {
          cal.corrections.push(correction);
          console.log('[social-intelligence] Voice calibration correction added:', correction);
        }
      }
    });

    // Keep last 50 edit history entries
    if (cal.editHistory.length > 50) cal.editHistory = cal.editHistory.slice(-50);

    cal.lastUpdated = new Date().toISOString();
    await env.FFX_KV.put('intelligence:voice_calibration', JSON.stringify(cal), { expirationTtl: 86400 * 365 });
  } catch (err) {
    console.error('[social-intelligence] Voice calibration update failed (non-fatal):', err.message);
  }
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
    console.error('[social-intelligence] getReplyPerformanceSummary error:', err.message);
    return null;
  }
}

// ── Classify edit type ────────────────────────────────────────────────────
function classifyEdit(original, edited) {
  if (!original || !edited) return 'unknown';
  const origWords  = original.split(/\s+/).length;
  const editWords  = edited.split(/\s+/).length;
  const lengthDiff = origWords - editWords;

  if (lengthDiff > origWords * 0.25) return 'length_reduction';
  if (edited.toLowerCase().includes('i ') && !original.toLowerCase().includes('i ')) return 'added_personal';
  if (!edited.toLowerCase().includes('fortitudefx') && original.toLowerCase().includes('fortitudefx')) return 'removed_promo';
  return 'tone_adjustment';
}

// ── Approximate edit distance (fast) ────────────────────────────────────
function levenshteinApprox(a, b) {
  if (!a || !b) return Math.max((a || '').length, (b || '').length);
  const aLen = a.length, bLen = b.length;
  if (Math.abs(aLen - bLen) > 500) return Math.abs(aLen - bLen);
  // Simple character difference for large strings
  const minLen = Math.min(aLen, bLen);
  let diff = Math.abs(aLen - bLen);
  for (let i = 0; i < minLen; i++) if (a[i] !== b[i]) diff++;
  return diff;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
