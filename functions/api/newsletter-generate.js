// ─────────────────────────────────────────────────────────────────────────────
// FFX Newsletter Generate — Pages Function
// POST /api/newsletter-generate
//   body: { setupNote?, setupImageUrl? }
//   Calls Claude with web_search for all sections
//   Saves newsletter:draft to KV
//   Returns full draft object
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
var PROGRESS_KEY    = 'newsletter:generate:progress';
var DRAFT_KEY       = 'newsletter:draft';

// ── Robust JSON extractor — handles Claude web search preamble ────────────────
function extractJson(text) {
  if (!text) return null;
  var start = text.indexOf('{');
  var end   = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch(e) { return null; }
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

    if (!env.ANTHROPIC_API_KEY) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers: CORS_HEADERS });
    if (!env.BREVO_API_KEY)     return new Response(JSON.stringify({ error: 'BREVO_API_KEY not set' }),     { status: 500, headers: CORS_HEADERS });

    async function writeProgress(step, total, label) {
      try {
        await env.FFX_KV.put(PROGRESS_KEY, JSON.stringify({
          step: step, total: total, label: label, updatedAt: new Date().toISOString()
        }), { expirationTtl: 600 });
      } catch(e) {}
    }

    await writeProgress(1, 8, 'Reading KV data — articles, signals, brief');

    // ── Step 1: Read all KV data ──────────────────────────────────────────────
    var today     = new Date().toISOString().split('T')[0];
    var issueDate = today;

    var results = await Promise.all([
      env.FFX_KV.get('intelligence:brief',   { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('seo:signals',          { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('ga4:signals',          { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('articles:index',       { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('youtube:signals',      { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('newsletter:last_sent', { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('newsletter:index',     { type: 'json' }).catch(function() { return null; }),
    ]);

    var brief          = results[0];
    var seoSignals     = results[1];
    var articlesIndex  = results[3];
    var lastIssue      = results[5];
    var newsletterIdx  = results[6];

    var issueNumber = lastIssue ? (lastIssue.issueNumber + 1) : 1;

    // Articles published in last 14 days — max 3
    var cutoff   = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    var articles = Array.isArray(articlesIndex) ? articlesIndex.filter(function(a) {
      return a.publishedAt && a.publishedAt > cutoff;
    }).slice(0, 3) : [];
    if (articles.length === 0 && Array.isArray(articlesIndex)) {
      articles = articlesIndex.slice(0, 3);
    }

    // Articles already featured in past newsletters — avoid repetition
    var featuredSlugs = [];
    if (Array.isArray(newsletterIdx)) {
      newsletterIdx.slice(0, 3).forEach(function(ni) {
        if (ni.featuredSlugs && Array.isArray(ni.featuredSlugs)) {
          featuredSlugs = featuredSlugs.concat(ni.featuredSlugs);
        }
      });
    }

    // Build article context string for Claude cross-referencing
    var articleContext = Array.isArray(articlesIndex) ? articlesIndex.slice(0, 20).map(function(a) {
      return a.slug + ' | ' + a.title + ' | ' + (a.category || '') + ' | ' + (a.excerpt || '').substring(0, 80);
    }).join('\n') : '';

    // Top keyword from SEO signals
    var topKeyword = '';
    if (seoSignals && seoSignals.risingQueries && seoSignals.risingQueries.length > 0) {
      topKeyword = seoSignals.risingQueries[0].query;
    } else if (seoSignals && seoSignals.topQueries && seoSignals.topQueries.length > 0) {
      topKeyword = seoSignals.topQueries[0].query;
    }

    // Previous issue topics to avoid repetition
    var prevExclusiveTitle = lastIssue ? (lastIssue.exclusiveTitle || '') : '';

    await writeProgress(2, 8, 'Calling Claude — Week in Markets + On This Day (web search)');

    // ── Step 2: Week in Markets + On This Day ─────────────────────────────────
    var marketsPrompt = 'You are writing for FortitudeFX — a forex trading education brand built around the Catch The Wick (CTW) mechanical entry framework. Brand voice: direct, authoritative, specific, no corporate language, no fluff.\n\n'
      + 'Generate TWO sections for the bi-weekly FFX newsletter dated ' + issueDate + ':\n\n'
      + '1. WEEK IN MARKETS (200-250 words)\n'
      + 'Web search for the most significant forex and macro market events from the past 14 days. Be specific — name the pairs, the levels, the events (CPI, NFP, central bank decisions, geopolitical moves). Frame everything through the CTW lens: what did the wicks reveal, where were the 2-candle setups, what did price action confirm or reject. Write as if Salman is briefing his Discord community. Direct, opinionated, specific. Find one credible source URL (Reuters, Bloomberg, FX Street, Investing.com, or FT) for the main story and return it.\n\n'
      + '2. ON THIS DAY IN MARKETS\n'
      + 'Find a significant historical forex or macro market event that happened on or near ' + issueDate + ' in any past year. Must be real and verifiable. One punchy paragraph — what happened, why it mattered, one lesson for a CTW trader. Find and return the Wikipedia URL for this specific event.\n\n'
      + 'CRITICAL INSTRUCTION: Return ONLY a JSON object. First character must be {. Last must be }. No preamble. No markdown.\n'
      + '{"weekInMarkets":{"content":"full text here","sourceUrl":"https://...","sourceLabel":"Reuters"},"onThisDay":{"year":"YYYY","event":"full event text","lesson":"trader lesson","wikiUrl":"https://en.wikipedia.org/wiki/..."}}';

    var marketsRes  = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'web-search-2025-03-05' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2000, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: marketsPrompt }] }),
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
      marketsJson.weekInMarkets = { content: '', sourceUrl: '', sourceLabel: '' };
      marketsJson.onThisDay     = { year: '', event: '', lesson: '', wikiUrl: '' };
    }

    await writeProgress(3, 8, 'Calling Claude — Trending Question + Exclusive Article');

    // ── Step 3: Trending Question + Newsletter Exclusive ──────────────────────
    var articlePrompt = 'You are writing for FortitudeFX in Salman Khan\'s voice. Salman is a Dubai-based forex trader and educator. The Catch The Wick (CTW) framework: mechanical entry system, 2-candle story, HTF/LTF timeframe pairs, 5 entry models (LC-E, LE-I, LC-ZIE, LC-ZR, LC-FR). Voice: direct, authoritative, no fluff, no corporate language, specific not vague, occasionally blunt.\n\n'
      + 'Top SEO keyword right now: ' + (topKeyword || 'forex risk management') + '\n'
      + 'Current market context: ' + (marketsJson.weekInMarkets && marketsJson.weekInMarkets.content ? marketsJson.weekInMarkets.content.substring(0, 300) : 'USD strength, rate decisions in focus') + '\n\n'
      + 'Existing articles for cross-referencing (slug | title | category | excerpt):\n' + articleContext + '\n\n'
      + 'Generate TWO sections:\n\n'
      + '1. TRENDING QUESTION (150-200 words)\n'
      + 'Pick the most interesting trading question a beginner or intermediate trader would be asking RIGHT NOW based on the top keyword and current market context. Frame it as a real question. Answer it in full — detailed, specific, in Salman\'s voice, referencing CTW where relevant. This is a full paragraph answer, not a one-liner.\n'
      + 'Then review the existing articles list above. If any article is closely related to this question (same topic, category, or concept), return its slug and title. If none is relevant, return null.\n\n'
      + '2. NEWSLETTER EXCLUSIVE EDITORIAL (hook: 150-200 words, full: 400-500 words)\n'
      + 'Write a newsletter-exclusive editorial piece on a trading topic directly tied to current market conditions. Previous exclusive was: "' + prevExclusiveTitle + '" — do not repeat this topic.\n'
      + 'The piece must be: opinionated, in Salman\'s voice, tied to what\'s happening in markets right now, applying the CTW framework to a real current situation. Not generic advice.\n'
      + 'Return TWO versions: hookText (150-200 words, punchy opening that makes you want to read more) and fullText (400-500 words, the complete editorial).\n'
      + 'Then check the articles list for the single most related article (by topic and content). Return its slug and title if found.\n\n'
      + 'CRITICAL INSTRUCTION: Return ONLY a JSON object. First character must be {. Last must be }. No preamble. No markdown.\n'
      + '{"trendingQ":{"question":"...","answer":"full paragraph answer","relatedArticleSlug":"slug-or-null","relatedArticleTitle":"title-or-null"},"exclusiveArticle":{"title":"...","hookText":"150-200 word hook","fullText":"400-500 word full editorial","relatedArticleSlug":"slug-or-null","relatedArticleTitle":"title-or-null"}}';

    var articleRes  = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2500, messages: [{ role: 'user', content: articlePrompt }] }),
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
      articleJson.trendingQ        = { question: '', answer: '', relatedArticleSlug: null, relatedArticleTitle: null };
      articleJson.exclusiveArticle = { title: '', hookText: '', fullText: '', relatedArticleSlug: null, relatedArticleTitle: null };
    }

    await writeProgress(4, 8, 'Calling Claude — 6 Lifestyle Sections (web search)');

    // ── Step 4: Lifestyle Sections ────────────────────────────────────────────
    var lifestylePrompt = 'You are curating the lifestyle section of the FortitudeFX bi-weekly newsletter. FFX sells an aspirational but attainable high-end lifestyle to young and intermediate forex traders — the life that trading freedom creates. Think GQ, Robb Report, Monocle aesthetic. Not out of reach, but premium enough to be aspirational.\n\n'
      + 'For each of the 6 sections:\n'
      + '1. Web search for real, current content from a credible source (GQ, Robb Report, Condé Nast Traveller, Bloomberg, Wired, Mens Health, etc)\n'
      + '2. Write the content — title + exactly 2 sentences (hook only, makes you want to click)\n'
      + '3. Return the real source URL where this content lives (the actual article URL, not the homepage)\n'
      + '4. Web search Unsplash.com for a high quality relevant photo. Return the direct image URL in format https://images.unsplash.com/photo-XXXXXXXXX\n\n'
      + 'SECTIONS:\n'
      + '1. TRADING FREEDOM — TRAVEL & DESTINATION: One specific destination right now. Aspirational but attainable — Lisbon, Barcelona, Bali, Maldives, Amalfi, Mykonos. Real place with real pull.\n\n'
      + '2. LUXURY: One specific luxury item — watch, car, hotel suite, experience. Real product, real substance. Not just price — why it exists and why it matters.\n\n'
      + '3. WOMEN & LIFESTYLE: Tasteful, genuinely desirable, GQ editorial aesthetic. A beautiful woman in an aspirational setting — beach, rooftop bar, yacht, cocktail party, summer terrace. Classy not crude. 2 sentences of lifestyle context.\n\n'
      + '4. TECH & AI: One genuine tech or AI development from the past 2 weeks that a trader should know about. Real news, real substance, one line on why it matters to their world.\n\n'
      + '5. FITNESS, DIET & MINDSET: One specific protocol that directly improves trading performance — sleep, cold exposure, zone 2 cardio, nutrition timing. Real science, actionable.\n\n'
      + '6. ENTERTAINMENT: One specific recommendation — film, series, book, podcast. Always tied to discipline, risk, excellence, or the trader mindset. Tell them exactly why.\n\n'
      + 'CRITICAL INSTRUCTION: Return ONLY a JSON object. First character must be {. Last must be }. No preamble. No markdown.\n'
      + '{"travel":{"title":"...","body":"exactly 2 sentences","sourceUrl":"https://...","sourceLabel":"Condé Nast Traveller","imageUrl":"https://images.unsplash.com/photo-..."},"luxury":{"title":"...","body":"exactly 2 sentences","sourceUrl":"https://...","sourceLabel":"GQ","imageUrl":"https://images.unsplash.com/photo-..."},"women":{"title":"...","body":"exactly 2 sentences","sourceUrl":"https://...","sourceLabel":"GQ","imageUrl":"https://images.unsplash.com/photo-..."},"tech":{"title":"...","body":"exactly 2 sentences","sourceUrl":"https://...","sourceLabel":"Wired","imageUrl":"https://images.unsplash.com/photo-..."},"fitness":{"title":"...","body":"exactly 2 sentences","sourceUrl":"https://...","sourceLabel":"Men\'s Health","imageUrl":"https://images.unsplash.com/photo-..."},"entertainment":{"title":"...","body":"exactly 2 sentences","sourceUrl":"https://...","sourceLabel":"GQ","imageUrl":"https://images.unsplash.com/photo-..."}}';

    var lifestyleRes  = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'web-search-2025-03-05' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2500, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: lifestylePrompt }] }),
    });
    var lifestyleData = await lifestyleRes.json();
    var lifestyleText = '';
    if (lifestyleData.content) {
      for (var k = 0; k < lifestyleData.content.length; k++) {
        if (lifestyleData.content[k].type === 'text') lifestyleText += lifestyleData.content[k].text;
      }
    }
    var lifestyleJson = extractJson(lifestyleText) || {};
    var lsKeys = ['travel','luxury','women','tech','fitness','entertainment'];
    lsKeys.forEach(function(key) {
      lifestyleJson[key] = lifestyleJson[key] || { title: '', body: '', sourceUrl: '', sourceLabel: '', imageUrl: '' };
    });

    await writeProgress(5, 8, 'Generating Mindset Line');

    // ── Step 5: Mindset Line ──────────────────────────────────────────────────
    var mindsetPrompt = 'Write ONE sentence — the FFX Mindset Line for this bi-weekly newsletter.\n'
      + 'Rules: mechanical and specific to CTW framework, not motivational fluff, memorable, in Salman\'s direct voice, maximum 25 words.\n'
      + 'Tied to current market context: ' + (marketsJson.weekInMarkets && marketsJson.weekInMarkets.content ? marketsJson.weekInMarkets.content.substring(0, 150) : '') + '\n'
      + 'Return ONLY the sentence. No quotes. No explanation.';

    var mindsetRes  = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 60, messages: [{ role: 'user', content: mindsetPrompt }] }),
    });
    var mindsetData = await mindsetRes.json();
    var mindsetLine = '';
    if (mindsetData.content && mindsetData.content[0] && mindsetData.content[0].text) {
      mindsetLine = mindsetData.content[0].text.trim().replace(/^["']|["']$/g, '');
    }

    await writeProgress(6, 8, 'Building draft + saving to KV');

    // ── Step 6: Build draft ───────────────────────────────────────────────────
    var featuredArticleSlugs = articles.map(function(a) { return a.slug; });
    if (articleJson.trendingQ && articleJson.trendingQ.relatedArticleSlug) {
      featuredArticleSlugs.push(articleJson.trendingQ.relatedArticleSlug);
    }
    if (articleJson.exclusiveArticle && articleJson.exclusiveArticle.relatedArticleSlug) {
      featuredArticleSlugs.push(articleJson.exclusiveArticle.relatedArticleSlug);
    }

    var draft = {
      issueNumber:   issueNumber,
      issueDate:     issueDate,
      generatedAt:   new Date().toISOString(),
      status:        'draft',

      weekInMarkets: {
        content:     marketsJson.weekInMarkets && marketsJson.weekInMarkets.content     || '',
        sourceUrl:   marketsJson.weekInMarkets && marketsJson.weekInMarkets.sourceUrl   || '',
        sourceLabel: marketsJson.weekInMarkets && marketsJson.weekInMarkets.sourceLabel || 'Source',
      },
      onThisDay: {
        year:     marketsJson.onThisDay && marketsJson.onThisDay.year    || '',
        event:    marketsJson.onThisDay && marketsJson.onThisDay.event   || '',
        lesson:   marketsJson.onThisDay && marketsJson.onThisDay.lesson  || '',
        wikiUrl:  marketsJson.onThisDay && marketsJson.onThisDay.wikiUrl || '',
      },
      trendingQ: {
        question:            articleJson.trendingQ && articleJson.trendingQ.question            || '',
        answer:              articleJson.trendingQ && articleJson.trendingQ.answer              || '',
        relatedArticleSlug:  articleJson.trendingQ && articleJson.trendingQ.relatedArticleSlug  || null,
        relatedArticleTitle: articleJson.trendingQ && articleJson.trendingQ.relatedArticleTitle || null,
      },
      exclusiveArticle: {
        title:               articleJson.exclusiveArticle && articleJson.exclusiveArticle.title               || '',
        hookText:            articleJson.exclusiveArticle && articleJson.exclusiveArticle.hookText            || '',
        fullText:            articleJson.exclusiveArticle && articleJson.exclusiveArticle.fullText            || '',
        relatedArticleSlug:  articleJson.exclusiveArticle && articleJson.exclusiveArticle.relatedArticleSlug  || null,
        relatedArticleTitle: articleJson.exclusiveArticle && articleJson.exclusiveArticle.relatedArticleTitle || null,
      },
      mindsetLine: mindsetLine,
      setup: {
        note:     setupNote,
        imageUrl: setupImageUrl,
        hasSetup: !!(setupNote || setupImageUrl),
      },
      articles: articles.map(function(a) {
        return {
          slug:        a.slug,
          title:       a.title,
          excerpt:     a.excerpt    || '',
          category:    a.category   || '',
          youtubeUrl:  a.youtubeUrl || '',
          publishedAt: a.publishedAt || '',
          url:         'https://fortitudefx.com/article?slug=' + a.slug,
        };
      }),
      lifestyle: lifestyleJson,
      featuredSlugs: featuredArticleSlugs,
      subject: 'Catch The Wick\u2122 \u00b7 Issue #' + issueNumber + ' \u00b7 ' + formatDateDisplay(issueDate),
    };

    await writeProgress(7, 8, 'Saving draft to KV');
    await env.FFX_KV.put(DRAFT_KEY, JSON.stringify(draft));
    await writeProgress(8, 8, 'Complete');

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

function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
