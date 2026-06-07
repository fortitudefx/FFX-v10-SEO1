// ─────────────────────────────────────────────────────────────────────────────
// FFX Newsletter Generate — Pages Function
// POST /api/newsletter-generate
//   body: { setupNote?: string, setupImageUrl?: string }
//   Calls Claude with web_search to generate all newsletter sections
//   Saves draft to KV at newsletter:draft
//   Returns full newsletter HTML for preview
//
// GET /api/newsletter-generate
//   Returns current draft from KV
// ─────────────────────────────────────────────────────────────────────────────

var CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

var ANTHROPIC_MODEL = 'claude-sonnet-4-6';
var ANTHROPIC_API   = 'https://api.anthropic.com/v1/messages';

// Progress key so dashboard can poll during generation
var PROGRESS_KEY = 'newsletter:generate:progress';
var DRAFT_KEY    = 'newsletter:draft';

// ── Robust JSON extractor — handles Claude web search preamble text ──────────
function extractJson(text) {
  if (!text) return null;
  // Strip markdown code fences first
  var stripped = text.replace(/```json[\s\S]*?```/g, function(m) {
    return m.replace(/```json\s*/,'').replace(/\s*```$/,'');
  }).replace(/```[\s\S]*?```/g, function(m) {
    return m.replace(/```\s*/g,'');
  });
  // Find first { and last } — handles preamble text before JSON
  var start = stripped.indexOf('{');
  var end   = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch(e) {
    // Try full stripped text as fallback
    try { return JSON.parse(stripped.trim()); } catch(e2) { return null; }
  }
}

// ── GET — return current draft ────────────────────────────────────────────────
export async function onRequestGet(context) {
  var env = context.env;
  try {
    var draft = await env.FFX_KV.get(DRAFT_KEY, { type: 'json' }).catch(function() { return null; });
    return new Response(JSON.stringify({ draft: draft || null }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// ── POST — generate full newsletter ──────────────────────────────────────────
export async function onRequestPost(context) {
  var env = context.env;
  try {
    var body = await context.request.json().catch(function() { return {}; });
    var setupNote     = body.setupNote     || '';
    var setupImageUrl = body.setupImageUrl || '';

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers: CORS_HEADERS });
    }
    if (!env.BREVO_API_KEY) {
      return new Response(JSON.stringify({ error: 'BREVO_API_KEY not set' }), { status: 500, headers: CORS_HEADERS });
    }

    // ── Write initial progress ────────────────────────────────────────────────
    async function writeProgress(step, total, label) {
      try {
        await env.FFX_KV.put(PROGRESS_KEY, JSON.stringify({
          step: step, total: total, label: label,
          updatedAt: new Date().toISOString(),
        }), { expirationTtl: 600 });
      } catch(e) {}
    }

    await writeProgress(1, 8, 'Reading KV data — articles, signals, brief');

    // ── Step 1: Read all KV data ──────────────────────────────────────────────
    var today    = new Date().toISOString().split('T')[0];
    var issueDate = today;

    var [brief, seoSignals, ga4Signals, articlesIndex, youtubeSignals, lastIssue] = await Promise.all([
      env.FFX_KV.get('intelligence:brief',  { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('seo:signals',         { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('ga4:signals',         { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('articles:index',      { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('youtube:signals',     { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('newsletter:last_sent',{ type: 'json' }).catch(function() { return null; }),
    ]);

    // Get issue number
    var issueNumber = lastIssue ? (lastIssue.issueNumber + 1) : 1;

    // Articles published in last 14 days
    var cutoff   = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    var articles = Array.isArray(articlesIndex) ? articlesIndex.filter(function(a) {
      return a.publishedAt && a.publishedAt > cutoff;
    }).slice(0, 3) : [];

    // If no recent articles, take the latest 4
    if (articles.length === 0 && Array.isArray(articlesIndex)) {
      articles = articlesIndex.slice(0, 3);
    }

    // Top keywords from SEO signals
    var topKeyword = '';
    if (seoSignals && seoSignals.risingQueries && seoSignals.risingQueries.length > 0) {
      topKeyword = seoSignals.risingQueries[0].query;
    }

    // Intelligence brief data
    var weeklyInsight = brief ? (brief.weeklyInsight || {}) : {};
    var audienceBrief = brief ? (brief.audienceBrief || {}) : {};
    var topKeywords   = seoSignals && seoSignals.topQueries ? seoSignals.topQueries.slice(0, 5).map(function(q) { return q.query; }) : [];

    await writeProgress(2, 8, 'Calling Claude — Week in Markets + On This Day');

    // ── Step 2: Generate Week in Markets + On This Day ─────────────────────
    var marketsPrompt = 'You are writing for FortitudeFX, a forex trading education brand built around the Catch The Wick (CTW) mechanical entry framework. The brand voice is direct, authoritative, zero corporate language, specific not vague.\n\n'
      + 'Generate TWO sections for the bi-weekly FFX newsletter dated ' + issueDate + ':\n\n'
      + '1. WEEK IN MARKETS (150-200 words)\n'
      + 'Use your web search to find the most significant forex/macro market events from the past 14 days. Frame them through the CTW lens — what did price action tell us, where were the 2-candle setups, what did the wicks reveal. Be specific with pairs, dates, and moves. Do not be generic. Write as if Salman is briefing his Discord community on what the market did and why it matters to a CTW trader.\n\n'
      + '2. ON THIS DAY IN MARKETS (80-100 words)\n'
      + 'Find a significant historical market event that happened on or near ' + issueDate + ' in any past year. Could be a crash, a central bank decision, a currency crisis, a legendary trade. Write it as a punchy historical note — what happened, why it matters, one lesson for a trader today.\n\n'
      + 'CRITICAL INSTRUCTION: Your response must be ONLY a JSON object. The very first character must be { and the very last must be }. No explanation text before or after. No markdown fences. No code blocks.\n'
      + '{"weekInMarkets": "full text here", "onThisDay": {"event": "full event description", "lesson": "trader lesson", "year": "YYYY"}}\n';

    var marketsRes = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: marketsPrompt }],
      }),
    });

    var marketsData = await marketsRes.json();
    var marketsText = '';
    if (marketsData.content) {
      for (var i = 0; i < marketsData.content.length; i++) {
        if (marketsData.content[i].type === 'text') marketsText += marketsData.content[i].text;
      }
    }

    var marketsJson = extractJson(marketsText) || {};
    if (!marketsJson.weekInMarkets) {
      marketsJson.weekInMarkets = '';
      marketsJson.onThisDay     = marketsJson.onThisDay || { event: '', lesson: '', year: '' };
    }

    await writeProgress(3, 8, 'Calling Claude — Trending Question + Exclusive Article');

    // ── Step 3: Trending Question + Newsletter Article ─────────────────────
    var articlePrompt = 'You are writing for FortitudeFX. Brand voice: direct, authoritative, no fluff, no corporate language. Salman Khan is a Dubai-based forex trader and educator. He built the Catch The Wick (CTW) framework — mechanical entry system based on 2-candle story, 5 entry models (LC-E, LE-I, LC-ZIE, LC-ZR, LC-FR), HTF/LTF timeframe pairs.\n\n'
      + 'Top search keywords for FFX right now: ' + (topKeywords.join(', ') || 'forex risk management, mechanical trading') + '\n'
      + 'Intelligence brief key win: ' + (weeklyInsight.keyWin || '') + '\n'
      + 'Intelligence brief key risk: ' + (weeklyInsight.keyRisk || '') + '\n\n'
      + 'Generate TWO sections:\n\n'
      + '1. TRENDING QUESTION (100-120 words)\n'
      + 'Pick the most interesting keyword from the list above. Frame it as a question a real trader would ask. Answer it in Salman\'s voice — specific, mechanical, no fluff. Reference the CTW framework where relevant.\n\n'
      + '2. NEWSLETTER-EXCLUSIVE ARTICLE (220-280 words)\n'
      + 'Write a newsletter-exclusive piece on a topic that would interest a serious forex trader right now. This is NOT published on the blog — it is exclusive to newsletter subscribers. Could be about trading psychology, a specific market condition, a mindset principle, a mechanical observation. Salman\'s voice. Direct. Authoritative. One clear insight delivered well.\n\n'
      + 'CRITICAL: Return ONLY a JSON object starting with { and ending with }. No text before or after.\n'
      + '{"trendingQ": {"question": "full question text", "answer": "full answer text"}, "exclusiveArticle": {"title": "article title", "body": "full article body"}}\n';

    var articleRes = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: articlePrompt }],
      }),
    });

    var articleData = await articleRes.json();
    var articleText = '';
    if (articleData.content) {
      for (var j = 0; j < articleData.content.length; j++) {
        if (articleData.content[j].type === 'text') articleText += articleData.content[j].text;
      }
    }

    var articleJson = extractJson(articleText) || {};
    if (!articleJson.trendingQ) {
      articleJson.trendingQ        = articleJson.trendingQ        || { question: '', answer: '' };
      articleJson.exclusiveArticle = articleJson.exclusiveArticle || { title: '', body: '' };
    }

    await writeProgress(4, 8, 'Calling Claude — 6 Lifestyle Sections');

    // ── Step 4: All 6 Lifestyle Sections ──────────────────────────────────
    var lifestylePrompt = 'You are curating the lifestyle section of the FortitudeFX bi-weekly newsletter. FFX is a premium forex trading brand. Audience: serious traders working toward financial and time freedom. Tone: aspirational, tasteful, GQ/Robb Report level.\n\n'
      + 'For each of the 6 sections: write the content (title + max 2 sentences) AND use web search to find a direct publicly accessible Unsplash photo URL. Search unsplash.com for a relevant photo. Return the actual image URL in format https://images.unsplash.com/photo-XXXXXXXXX not the page URL.\n\n'
      + '1. TRADING FREEDOM \u2014 TRAVEL & DESTINATION: One specific destination. Real place. 2 sentences max. Search Unsplash for a stunning travel photo.\n\n'
      + '2. LUXURY: One specific luxury item \u2014 watch, car, hotel. 2 sentences max. Search Unsplash for a premium luxury photo.\n\n'
      + '3. WOMEN & LIFESTYLE: Tasteful, aspirational, GQ/Vogue. A beautiful woman in an aspirational setting \u2014 beach, cocktail party, rooftop, yacht. 2 sentences. Search Unsplash for an elegant editorial lifestyle photo of a woman.\n\n'
      + '4. TECH & AI: One genuine tech or AI development from the past 2 weeks. 2 sentences max. Search Unsplash for a clean tech photo.\n\n'
      + '5. FITNESS, DIET & MINDSET: One specific protocol with direct connection to trading performance. 2 sentences max. Search Unsplash for a fitness or wellness photo.\n\n'
      + '6. ENTERTAINMENT: One specific recommendation \u2014 film, series, book, podcast. 2 sentences max. Search Unsplash for a relevant cinematic photo.\n\n'
      + 'CRITICAL INSTRUCTION: Your response must be ONLY a JSON object. First character must be {. Last character must be }. No preamble, no explanation, no markdown fences.\n'
      + '{"travel":{"title":"...","body":"...","imageUrl":"https://images.unsplash.com/photo-..."},"luxury":{"title":"...","body":"...","imageUrl":"https://images.unsplash.com/photo-..."},"women":{"title":"...","body":"...","imageUrl":"https://images.unsplash.com/photo-..."},"tech":{"title":"...","body":"...","imageUrl":"https://images.unsplash.com/photo-..."},"fitness":{"title":"...","body":"...","imageUrl":"https://images.unsplash.com/photo-..."},"entertainment":{"title":"...","body":"...","imageUrl":"https://images.unsplash.com/photo-..."}}\n';

    var lifestyleRes = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: lifestylePrompt }],
      }),
    });

    var lifestyleData = await lifestyleRes.json();
    var lifestyleText = '';
    if (lifestyleData.content) {
      for (var k = 0; k < lifestyleData.content.length; k++) {
        if (lifestyleData.content[k].type === 'text') lifestyleText += lifestyleData.content[k].text;
      }
    }

    var lifestyleJson = extractJson(lifestyleText) || {};
    if (!lifestyleJson.travel) {
      lifestyleJson.travel        = lifestyleJson.travel        || { title: '', body: '', imageUrl: '' };
      lifestyleJson.luxury        = lifestyleJson.luxury        || { title: '', body: '', imageUrl: '' };
      lifestyleJson.women         = lifestyleJson.women         || { title: '', body: '', imageUrl: '' };
      lifestyleJson.tech          = lifestyleJson.tech          || { title: '', body: '', imageUrl: '' };
      lifestyleJson.fitness       = lifestyleJson.fitness       || { title: '', body: '', imageUrl: '' };
      lifestyleJson.entertainment = lifestyleJson.entertainment || { title: '', body: '', imageUrl: '' };
    }

    await writeProgress(5, 8, 'Generating Mindset Line');

    // ── Step 5: Mindset Line ──────────────────────────────────────────────
    var mindsetPrompt = 'Write ONE sentence — the FFX Mindset Line for this bi-weekly newsletter. It must be:\n'
      + '- Mechanical and specific to the CTW / Catch The Wick framework\n'
      + '- Not motivational fluff — a real trading principle\n'
      + '- Memorable and quotable\n'
      + '- In Salman\'s direct voice\n'
      + '- Maximum 25 words\n\n'
      + 'Examples of the tone (do not copy these):\n'
      + '"Every candle that isn\'t your setup is information, not a missed trade."\n'
      + '"The wick is not noise. It is the market telling you exactly where it is going."\n\n'
      + 'Return ONLY the sentence, no quotes, no JSON, no explanation.';

    var mindsetRes = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 60,
        messages: [{ role: 'user', content: mindsetPrompt }],
      }),
    });

    var mindsetData = await mindsetRes.json();
    var mindsetLine = '';
    if (mindsetData.content && mindsetData.content[0] && mindsetData.content[0].text) {
      mindsetLine = mindsetData.content[0].text.trim().replace(/^"|"$/g, '');
    }

    await writeProgress(6, 8, 'Building newsletter HTML');

    // ── Step 6: Build draft object ────────────────────────────────────────
    var draft = {
      issueNumber:      issueNumber,
      issueDate:        issueDate,
      generatedAt:      new Date().toISOString(),
      status:           'draft',

      // Content sections
      weekInMarkets:    marketsJson.weekInMarkets    || '',
      onThisDay:        marketsJson.onThisDay        || {},
      trendingQ:        articleJson.trendingQ        || {},
      exclusiveArticle: articleJson.exclusiveArticle || {},
      mindsetLine:      mindsetLine,

      // Setup of the fortnight — from user input
      setup: {
        note:     setupNote,
        imageUrl: setupImageUrl,
        hasSetup: !!(setupNote || setupImageUrl),
      },

      // Articles from KV
      articles: articles.map(function(a) {
        return {
          slug:        a.slug,
          title:       a.title,
          excerpt:     a.excerpt     || '',
          category:    a.category    || '',
          youtubeUrl:  a.youtubeUrl  || '',
          publishedAt: a.publishedAt || '',
          url:         'https://fortitudefx.com/article?slug=' + a.slug,
        };
      }),

      // Lifestyle sections
      lifestyle: lifestyleJson,

      // Audience brief mandate
      audienceMandate: audienceBrief.mandate || '',

      // Meta for email
      subject: 'FFX Intelligence Brief \u00b7 Issue #' + issueNumber + ' \u00b7 ' + formatDateDisplay(issueDate),
    };

    await writeProgress(7, 8, 'Saving draft to KV');

    // Save draft to KV — permanent no TTL
    await env.FFX_KV.put(DRAFT_KEY, JSON.stringify(draft));

    await writeProgress(8, 8, 'Complete');

    // Clear progress after short delay (non-blocking)
    try { await env.FFX_KV.delete(PROGRESS_KEY); } catch(e) {}

    return new Response(JSON.stringify({ success: true, draft: draft }), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    try { await context.env.FFX_KV.delete(PROGRESS_KEY); } catch(e) {}
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDateDisplay(dateStr) {
  var d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
