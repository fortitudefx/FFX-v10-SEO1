// functions/api/social-intelligence.js
// POST /api/social-intelligence → runs Claude web search scan directly (same pattern as intelligence-engine.js)
// POST /api/social-intelligence + {opportunityId, action} → records outcome
// GET  /api/social-intelligence → returns today's opportunities from KV

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function generateId(platform, keyword) {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const hash  = Math.random().toString(36).slice(2, 7);
  const safe  = (platform || 'unknown').replace(/[^a-z0-9]/gi, '').slice(0, 10);
  return `opp_${today}_${safe}_${hash}`;
}

// ── GET — return today's opportunities and scan status ────────────────────
export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const today   = new Date().toISOString().split('T')[0];
    const signals = await env.FFX_KV.get('intelligence:signals', { type: 'json' }).catch(() => null);
    const list    = await env.FFX_KV.list({ prefix: 'intelligence:opportunities:' }).catch(() => null);
    const opportunities = [];
    if (list && list.keys.length) {
      for (const key of list.keys) {
        const opp = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
        if (!opp) continue;
        if (opp.detectedAt && !opp.detectedAt.startsWith(today)) continue;
        opportunities.push(opp);
      }
    }
    const urgencyOrder = { high: 0, medium: 1, low: 2 };
    opportunities.sort((a, b) => (urgencyOrder[a.urgency] ?? 2) - (urgencyOrder[b.urgency] ?? 2));
    const voiceCalibration = await env.FFX_KV.get('intelligence:voice_calibration', { type: 'json' }).catch(() => null);
    return json({ opportunities, date: today, signals, voiceCalibration }, 200, headers);
  } catch (err) {
    return json({ error: err.message }, 500, headers);
  }
}

// ── POST — run scan OR record outcome ────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  // ── Record outcome for existing opportunity ───────────────────────────
  if (body.opportunityId && body.action) {
    return recordOutcome(body, env, headers);
  }

  // ── Run scan — same pattern as intelligence-engine.js ─────────────────
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY not set in Pages environment variables' }, 500, headers);
  }

  const today = new Date().toISOString().split('T')[0];

  try {
    // ── Read signals from KV ────────────────────────────────────────────
    const [seoSignals, brief, voiceCalibration, existingPerf] = await Promise.all([
      env.FFX_KV.get('seo:signals',                   { type: 'json' }).catch(() => null),
      env.FFX_KV.get('intelligence:brief',             { type: 'json' }).catch(() => null),
      env.FFX_KV.get('intelligence:voice_calibration', { type: 'json' }).catch(() => null),
      getReplyPerformanceSummary(env).catch(() => null),
    ]);

    // ── Build keywords ──────────────────────────────────────────────────
    const keywords = buildKeywords(seoSignals, brief);
    console.log('[social-intelligence] Scanning with keywords:', keywords.slice(0, 5).join(', '));

    // ── Call Claude with web search — awaited, same as intelligence engine
    const opportunities = await runScan(keywords, brief, voiceCalibration, existingPerf, env.ANTHROPIC_API_KEY);

    // ── Write opportunities to KV ───────────────────────────────────────
    let written = 0;
    if (opportunities && opportunities.length) {
      for (const opp of opportunities.slice(0, 5)) {
        try {
          if (!opp.id) opp.id = generateId(opp.platform, opp.keyword);
          opp.detectedAt = new Date().toISOString();
          opp.status     = 'surfaced';
          await env.FFX_KV.put(
            `intelligence:opportunities:${opp.id}`,
            JSON.stringify(opp),
            { expirationTtl: 86400 * 30 }
          );
          const verify = await env.FFX_KV.get(`intelligence:opportunities:${opp.id}`, { type: 'json' }).catch(() => null);
          if (!verify) { console.error('[social-intelligence] KV verify FAILED:', opp.id); continue; }
          written++;
          console.log('[social-intelligence] Opportunity written:', opp.id, opp.platform);
        } catch (writeErr) {
          console.error('[social-intelligence] Write error (non-fatal):', writeErr.message);
        }
      }
    }

    // ── Write scan summary ──────────────────────────────────────────────
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
    await env.FFX_KV.put('intelligence:signals', JSON.stringify(signals), { expirationTtl: 86400 * 30 });

    console.log('[social-intelligence] Scan complete. Written:', written);
    return json({ success: true, opportunitiesFound: written }, 200, headers);

  } catch (err) {
    console.error('[social-intelligence] Scan error:', err.message);
    // Write error to KV so dashboard can show it
    try {
      await env.FFX_KV.put('intelligence:signals', JSON.stringify({
        date: today, scannedAt: new Date().toISOString(), scanning: false,
        opportunitiesFound: 0, error: err.message, keywords: [], acted: 0, dismissed: 0,
      }), { expirationTtl: 86400 * 30 });
    } catch {}
    return json({ error: err.message }, 500, headers);
  }
}

// ── Build keywords from signals ───────────────────────────────────────────
function buildKeywords(seoSignals, brief) {
  const keywords = new Set();
  if (seoSignals?.risingQueries) seoSignals.risingQueries.slice(0, 5).forEach(q => { if (q.query) keywords.add(q.query); });
  if (brief?.articleBrief?.targetQuery) keywords.add(brief.articleBrief.targetQuery);
  if (brief?.articleBrief?.nuggetTags) brief.articleBrief.nuggetTags.slice(0, 3).forEach(t => keywords.add(t));
  ['forex wick trading strategy','stop loss hunting forex','price action entry strategy',
   'london session forex setup','liquidity sweep trading','candle wick entry forex',
   'institutional order flow trading','how to trade wicks'].forEach(k => keywords.add(k));
  return [...keywords].slice(0, 8);
}

// ── Run Claude scan with web search ──────────────────────────────────────
async function runScan(keywords, brief, voiceCalibration, existingPerf, apiKey) {
  const keywordList = keywords.slice(0, 6).map(k => `"${k}"`).join(', ');
  const today = new Date().toISOString().split('T')[0];

  const voiceRules = voiceCalibration?.corrections?.length > 0
    ? `\nVoice calibration corrections:\n${voiceCalibration.corrections.slice(0, 5).map(c => `- ${c}`).join('\n')}`
    : '';

  const perfContext = existingPerf?.totalPosted > 0
    ? `\nPast performance: ${existingPerf.totalPosted} replies. Best platform: ${existingPerf.topPlatform}. Best keyword: "${existingPerf.topKeyword}".`
    : '';

  const systemPrompt = `You are the Social Intelligence Agent for FortitudeFX, a forex trading education brand built around the Catch The Wick™ (CTW) methodology by Salman Khan.

Find 3-5 active forum threads where traders ask questions that CTW directly answers. Draft genuine replies in Salman's voice.

SALMAN'S VOICE:
- Direct, institutional, slightly contrarian
- First sentence is a direct answer — never a preamble
- Never: "Great question!", "As a trader myself...", "I highly recommend..."
- Max 3 paragraphs. Calm authority.${voiceRules}

CTW FRAMEWORK:
- Wicks form because institutions sweep liquidity before reversing
- The wick that hits your stop IS the institutional fill — price reverses after
- Entry on close of wick candle. Stop beyond wick extreme. Mechanical, not subjective.

PLATFORMS: reddit.com/r/Forex, reddit.com/r/Daytrading, babypips.com/forum, forexfactory.com, quora.com, YouTube comments on forex education videos.

FRESHNESS: Only threads active within last 14 days. Discard older.
KEYWORDS: ${keywordList}${perfContext}
Today: ${today}.`;

  const userPrompt = `Search for 3-5 active forum threads where traders ask questions that Catch The Wick answers.

Filter: last 14 days activity, question format, at least 3 replies, max 5 opportunities.

Fetch each thread URL before drafting the reply.

Return ONLY a raw JSON array — no markdown, no preamble. Start with [ end with ].

Each object:
{
  "platform": "reddit|babypips|forexfactory|quora|youtube",
  "platformDisplay": "r/Forex|r/Daytrading|BabyPips|ForexFactory|Quora|YouTube",
  "url": "exact thread URL",
  "replyUrl": "direct reply URL",
  "topic": "what the thread asks in one sentence",
  "threadTitle": "actual thread title",
  "keyword": "which keyword triggered this",
  "threadAgeDays": 3,
  "threadReplies": 14,
  "urgency": "high|medium|low",
  "urgencyReason": "why this urgency",
  "draft": "full reply in Salman's voice — max 3 paragraphs, direct answer first",
  "draftWithoutLink": "reply without article link",
  "includeLinkRecommendation": true,
  "linkRecommendationReason": "why link is or is not recommended",
  "articleToLink": "slug or null",
  "utmTaggedUrl": "https://fortitudefx.com/article?slug=SLUG&utm_source=PLATFORM&utm_medium=reply&utm_campaign=organic&utm_content=KEYWORD or null",
  "nuggetTagsUsed": ["wick", "institutional"]
}`;

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
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  console.log('[social-intelligence] Claude stop_reason:', data.stop_reason, 'blocks:', data.content?.length);

  let rawText = '';
  if (data.content && Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text') rawText += block.text;
    }
  }

  if (!rawText.trim()) {
    console.error('[social-intelligence] No text in Claude response:', JSON.stringify(data).slice(0, 500));
    return [];
  }

  const first = rawText.indexOf('[');
  const last  = rawText.lastIndexOf(']');
  if (first === -1 || last === -1) {
    console.error('[social-intelligence] No JSON array in response:', rawText.slice(0, 300));
    return [];
  }

  let opportunities;
  try {
    opportunities = JSON.parse(rawText.slice(first, last + 1));
  } catch (parseErr) {
    console.error('[social-intelligence] JSON parse failed:', parseErr.message);
    return [];
  }

  if (!Array.isArray(opportunities)) return [];

  const valid = opportunities.filter(o => o.url && o.draft && o.platform && (o.threadTitle || o.topic));
  console.log('[social-intelligence] Claude returned', opportunities.length, 'raw,', valid.length, 'valid');
  return valid;
}

// ── Record outcome ────────────────────────────────────────────────────────
async function recordOutcome(body, env, headers) {
  const { opportunityId, action, editedReply, dismissReason } = body;
  try {
    const key = `intelligence:opportunities:${opportunityId}`;
    const opp = await env.FFX_KV.get(key, { type: 'json' }).catch(() => null);
    if (!opp) return json({ error: `Opportunity ${opportunityId} not found` }, 404, headers);

    const now = new Date().toISOString();
    if (action === 'posted_as_is') {
      opp.status = 'posted-as-is'; opp.postedAt = now; opp.finalReply = opp.draft;
    } else if (action === 'posted_edited') {
      opp.status = 'posted-edited'; opp.postedAt = now;
      opp.editedVersion = editedReply; opp.finalReply = editedReply;
      await updateVoiceCalibration(env, classifyEdit(opp.draft, editedReply), opp.draft, editedReply);
    } else if (action === 'dismissed') {
      opp.status = 'dismissed'; opp.dismissedAt = now; opp.dismissReason = dismissReason || 'not_specified';
    } else {
      return json({ error: `Unknown action: ${action}` }, 400, headers);
    }

    await env.FFX_KV.put(key, JSON.stringify(opp), { expirationTtl: 86400 * 30 });
    const verify = await env.FFX_KV.get(key, { type: 'json' }).catch(() => null);
    if (!verify || verify.status !== opp.status) {
      return json({ error: 'KV write verification failed', verified: false }, 500, headers);
    }

    if (action === 'posted_as_is' || action === 'posted_edited') {
      try {
        await env.FFX_KV.put(`intelligence:reply_performance:${opportunityId}`, JSON.stringify({
          id:               opportunityId,
          platform:         opp.platform,
          keyword:          opp.keyword,
          topic:            opp.topic || null,
          threadTitle:      opp.threadTitle || null,
          linkIncluded:     opp.includeLinkRecommendation || false,
          utmUrl:           opp.utmTaggedUrl || null,
          postedAt:         now,
          trafficGenerated: 0,
          overallResult:    'pending',
          checkedAt:        null,
          accurate:         null,
        })); // No TTL — permanent record for intelligence engine history
        const sig = await env.FFX_KV.get('intelligence:signals', { type: 'json' }).catch(() => null);
        if (sig) { sig.acted = (sig.acted || 0) + 1; await env.FFX_KV.put('intelligence:signals', JSON.stringify(sig), { expirationTtl: 86400 * 30 }); }
      } catch {}
    }
    if (action === 'dismissed') {
      try {
        const sig = await env.FFX_KV.get('intelligence:signals', { type: 'json' }).catch(() => null);
        if (sig) { sig.dismissed = (sig.dismissed || 0) + 1; await env.FFX_KV.put('intelligence:signals', JSON.stringify(sig), { expirationTtl: 86400 * 30 }); }
      } catch {}
    }

    return json({ success: true, verified: true, opportunityId, action, status: opp.status }, 200, headers);
  } catch (err) {
    return json({ error: err.message, verified: false }, 500, headers);
  }
}

// ── Voice calibration ─────────────────────────────────────────────────────
async function updateVoiceCalibration(env, editType, original, edited) {
  try {
    const cal = await env.FFX_KV.get('intelligence:voice_calibration', { type: 'json' }).catch(() => null)
      || { corrections: [], editHistory: [], lastUpdated: null };
    cal.editHistory = cal.editHistory || [];
    cal.editHistory.push({ editType, recordedAt: new Date().toISOString() });
    const counts = {};
    cal.editHistory.forEach(e => { if (e.editType) counts[e.editType] = (counts[e.editType] || 0) + 1; });
    const correctionMap = {
      length_reduction: 'Shorten replies — max 150 words.',
      tone_adjustment:  'Soften tone — more advisory in delivery.',
      removed_promo:    'Never self-promotional in first 2 paragraphs.',
      added_personal:   'Include personal trading observation in middle paragraph.',
    };
    cal.corrections = cal.corrections || [];
    Object.entries(counts).forEach(([type, count]) => {
      if (count >= 10) {
        const c = correctionMap[type];
        if (c && !cal.corrections.includes(c)) cal.corrections.push(c);
      }
    });
    if (cal.editHistory.length > 50) cal.editHistory = cal.editHistory.slice(-50);
    cal.lastUpdated = new Date().toISOString();
    await env.FFX_KV.put('intelligence:voice_calibration', JSON.stringify(cal), { expirationTtl: 86400 * 365 });
  } catch {}
}

// ── Reply performance summary ─────────────────────────────────────────────
async function getReplyPerformanceSummary(env) {
  try {
    const list = await env.FFX_KV.list({ prefix: 'intelligence:reply_performance:' }).catch(() => null);
    if (!list || !list.keys.length) return null;
    let totalPosted = 0, totalTraffic = 0;
    const platformCounts = {}, keywordCounts = {};
    for (const key of list.keys.slice(0, 30)) {
      const perf = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
      if (!perf) continue;
      totalPosted++;
      totalTraffic += perf.trafficGenerated || 0;
      if (perf.platform) platformCounts[perf.platform] = (platformCounts[perf.platform] || 0) + 1;
      if (perf.keyword)  keywordCounts[perf.keyword]   = (keywordCounts[perf.keyword]  || 0) + 1;
    }
    const topPlatform = Object.entries(platformCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const topKeyword  = Object.entries(keywordCounts).sort((a, b)  => b[1] - a[1])[0]?.[0]  || null;
    return { totalPosted, totalTraffic, topPlatform, topKeyword };
  } catch { return null; }
}

// ── Classify edit type ────────────────────────────────────────────────────
function classifyEdit(original, edited) {
  if (!original || !edited) return 'unknown';
  const origWords = original.split(/\s+/).length;
  const editWords = edited.split(/\s+/).length;
  if (origWords - editWords > origWords * 0.25) return 'length_reduction';
  if (!edited.toLowerCase().includes('fortitudefx') && original.toLowerCase().includes('fortitudefx')) return 'removed_promo';
  if (edited.toLowerCase().includes(' i ') && !original.toLowerCase().includes(' i ')) return 'added_personal';
  return 'tone_adjustment';
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
