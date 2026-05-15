// ─────────────────────────────────────────────────────────────────────────────
// FFX Generate Worker — No KV
// POST /generate → Supadata transcript → Claude → return articles to browser
// Phase 1: Regional SEO Intelligence Layer + Internal Linking
// Region cycle: Global + mandated region from ffx-config.json cycle index
// Regions: GCC → US/Canada → EU/UK/Germany → SEA/Asia → repeat
// ─────────────────────────────────────────────────────────────────────────────

const REGIONS = ['GCC', 'US/Canada', 'EU/UK/Germany', 'SEA/Asia'];

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  console.log('[FFX] /generate request received');

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { youtubeUrl, existingSlug } = body;
  if (!youtubeUrl) {
    return new Response(JSON.stringify({ error: 'youtubeUrl is required' }), { status: 400, headers });
  }

  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    return new Response(JSON.stringify({ error: 'Could not parse YouTube video ID from URL' }), { status: 400, headers });
  }

  console.log('[FFX] videoId:', videoId, 'existingSlug:', existingSlug || 'none');

  // 1. Fetch transcript via Supadata
  console.log('[FFX] Fetching transcript via Supadata');
  let transcript;
  try {
    transcript = await fetchTranscriptSupadata(youtubeUrl, env.SUPADATA_API_KEY);
    console.log('[FFX] Transcript fetched, length:', transcript?.length);
  } catch (err) {
    console.log('[FFX] Supadata failed:', err.message);
    return new Response(JSON.stringify({ error: `Transcript fetch failed: ${err.message}` }), { status: 502, headers });
  }

  if (!transcript || transcript.trim().length < 100) {
    return new Response(JSON.stringify({ error: 'Transcript too short or empty. Ensure captions are enabled and try again.' }), { status: 422, headers });
  }

  // 2. Fetch existing articles for internal linking — fails gracefully
  console.log('[FFX] Fetching articles.json for internal linking');
  let existingArticles = [];
  try {
    existingArticles = await fetchExistingArticles();
    console.log('[FFX] Existing articles fetched:', existingArticles.length);
  } catch (err) {
    console.log('[FFX] articles.json fetch failed (non-fatal):', err.message);
  }

  // 3. Fetch region cycle index from ffx-config.json — fails gracefully to index 0
  console.log('[FFX] Fetching ffx-config.json for region cycle');
  let regionCycleIndex = 0;
  try {
    const cfgRes = await fetch('https://fortitudefx.com/ffx-config.json', {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      regionCycleIndex = typeof cfg.regionCycleIndex === 'number' ? cfg.regionCycleIndex : 0;
    }
    console.log('[FFX] regionCycleIndex:', regionCycleIndex);
  } catch (err) {
    console.log('[FFX] ffx-config.json fetch failed (non-fatal), defaulting to index 0:', err.message);
  }

  const currentRegion = REGIONS[regionCycleIndex % REGIONS.length];
  console.log('[FFX] Current region for this run:', currentRegion);

  // 4. Call Claude — always generates exactly 2 articles: Global + currentRegion
  console.log('[FFX] Calling Claude');
  let articles;
  try {
    articles = await callClaude(transcript, youtubeUrl, env.ANTHROPIC_API_KEY, existingArticles, currentRegion);
    console.log('[FFX] Claude done, articles generated:', articles.length, articles.map(a => a.region).join(', '));
  } catch (err) {
    console.log('[FFX] Claude failed:', err.message);
    return new Response(JSON.stringify({ error: `Claude API failed: ${err.message}` }), { status: 502, headers });
  }

  // 5. Apply existing slug lock to primary (Global) article only
  if (existingSlug && existingSlug.trim()) {
    console.log('[FFX] Locking slug to existing:', existingSlug);
    const primary = articles[0];
    const oldArticleUrl = `https://fortitudefx.com/article?slug=${primary.slug}`;
    const newArticleUrl = `https://fortitudefx.com/article?slug=${existingSlug}`;
    primary.slug = existingSlug;
    const fields = ['discord', 'tumblr', 'mediumIntro', 'linkedin', 'tweet1', 'tweet2', 'tweet3', 'tweet4', 'tweet5', 'tweet6'];
    fields.forEach(f => {
      if (primary[f]) primary[f] = primary[f].replace(new RegExp(oldArticleUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newArticleUrl);
    });
    if (Array.isArray(primary.x_thread)) {
      primary.x_thread = primary.x_thread.map(t => t.replace(new RegExp(oldArticleUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newArticleUrl));
    }
  }

  // 6. Attach youtubeUrl and regionCycleIndex to every article
  articles.forEach(a => { a.youtubeUrl = youtubeUrl; });

  return new Response(JSON.stringify({ success: true, articles, regionCycleIndex, currentRegion }), { status: 200, headers });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const parts = u.pathname.split('/');
      const si = parts.indexOf('shorts');
      if (si !== -1) return parts[si + 1];
    }
  } catch {}
  return null;
}

async function fetchTranscriptSupadata(youtubeUrl, apiKey) {
  if (!apiKey) throw new Error('SUPADATA_API_KEY not set');
  const url = `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(youtubeUrl)}&text=true`;
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  console.log('[FFX] Supadata status:', res.status);
  if (!res.ok) throw new Error(`Supadata ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.content && typeof data.content === 'string') return data.content.trim();
  if (Array.isArray(data.content)) return data.content.map(s => s.text || '').join(' ').trim();
  throw new Error('Unexpected Supadata response: ' + JSON.stringify(data).slice(0, 200));
}

// Fetch existing published articles for internal linking context
async function fetchExistingArticles() {
  const res = await fetch('https://fortitudefx.com/articles.json', {
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error(`articles.json fetch failed: ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data)) {
    return data.map(a => ({ slug: a.slug, title: a.title })).filter(a => a.slug && a.title);
  }
  return [];
}

// Hard truncate to maxWords at last complete sentence
function truncateToWordLimit(text, maxWords) {
  if (!text) return text;
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  const truncated = words.slice(0, maxWords).join(' ');
  const match = truncated.match(/^([\s\S]*[.!?])\s*/);
  if (match && match[1]) return match[1].trim();
  return truncated.trim();
}

async function callClaude(transcript, youtubeUrl, apiKey, existingArticles, currentRegion) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // Build internal links context string for Claude
  const internalLinksContext = existingArticles.length > 0
    ? `\n\nEXISTING PUBLISHED ARTICLES FOR INTERNAL LINKING:\nThe following articles are already published on fortitudefx.com. Where contextually relevant and natural, insert internal links to these articles inside the body HTML using <a href="https://fortitudefx.com/article?slug=SLUG">TITLE</a>. Only link when genuinely relevant — never force links.\n${existingArticles.map(a => `- slug: ${a.slug} | title: ${a.title}`).join('\n')}`
    : '';

  const systemPrompt = `You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick™ mechanical entry system (5 entry models, 2-candle philosophy).

You will receive a YouTube video transcript. Generate exactly 2 articles and return them as a single valid JSON object. No markdown, no preamble, no explanation — only the raw JSON object.

═══════════════════════════════════════════════════════
MANDATORY OUTPUT — ALWAYS EXACTLY 2 ARTICLES
═══════════════════════════════════════════════════════

Article 1: GLOBAL
- Universal audience, no regional framing
- Applies to all traders worldwide
- Evergreen, authoritative, clean

Article 2: ${currentRegion} REGIONAL
- Targeted specifically to ${currentRegion} traders
- Regionally framed examples, context, search intent
- Different slug, title, headings, examples from Article 1
- Same core trading knowledge, different regional lens

REGIONAL FRAMING GUIDE FOR ${currentRegion}:
${currentRegion === 'GCC' ? '- UAE, Saudi Arabia, Kuwait, Bahrain audience\n- Dubai trading lifestyle, Gulf trading culture\n- Evening London session preparation from Gulf timezone\n- Work-life balance with London open timing\n- English-speaking GCC traders' : ''}
${currentRegion === 'US/Canada' ? '- New York session focus, North American traders\n- EST/CST timezone context\n- Overlap between London close and NY open\n- US economic calendar relevance' : ''}
${currentRegion === 'EU/UK/Germany' ? '- London session authority, European institutional flow\n- GMT timezone, Frankfurt/London context\n- XETRA open, European market structure\n- UK and European retail trader audience' : ''}
${currentRegion === 'SEA/Asia' ? '- Asian session focus, Singapore/Hong Kong/Tokyo\n- Overnight trading from Western perspective\n- Asian range setup for London open\n- SGT/HKT/JST timezone context' : ''}

CONTENT PRINCIPLES:
- 80% universal trading knowledge, 20% regional contextualisation
- Genuinely different content between articles — different examples, framing, search intent, headings
- Never duplicate body content — Google filters duplicates
- Regional framing must feel natural, not keyword-stuffed
- Each article targets a different search query

═══════════════════════════════════════════════════════
OUTPUT FORMAT — SINGLE JSON OBJECT
═══════════════════════════════════════════════════════

{
  "articles": [
    {
      "region": "Global",
      "slug": "...",
      "title": "...",
      "excerpt": "...",
      "category": "...",
      "tags": "...",
      "readTime": "...",
      "body": "...",
      "linkedin": "...",
      "x_thread": ["...", "...", "...", "...", "...", "..."],
      "discord": "...",
      "tumblr": "...",
      "mediumIntro": "..."
    },
    {
      "region": "${currentRegion}",
      "slug": "...",
      "title": "...",
      "excerpt": "...",
      "category": "...",
      "tags": "...",
      "readTime": "...",
      "body": "...",
      "linkedin": "...",
      "x_thread": ["...", "...", "...", "...", "...", "..."],
      "discord": "...",
      "tumblr": "...",
      "mediumIntro": "..."
    }
  ]
}

═══════════════════════════════════════════════════════
CONTENT FIELD SPECIFICATIONS
═══════════════════════════════════════════════════════

slug
URL-safe lowercase hyphenated string, 3-6 words, no stopwords.
Global article: describes core topic e.g. "liquidity-sweep-trading-strategy"
Regional article: append region identifier e.g. "liquidity-sweep-trading-dubai" or "london-session-trading-gcc"

title
SEO title 50-60 characters, includes primary keyword.
Global: universal framing.
Regional: includes regional signal e.g. "How Dubai Traders Can Master Liquidity Sweeps"

excerpt
Max 160 characters, compelling meta description. Regionally relevant where applicable.

category
Exactly one of: Strategy, Psychology, Risk Management, Market Analysis, Fundamentals

tags
Comma-separated string of 4-6 relevant tags. Include regional tags for regional article.

readTime
String like "7 min read".

body
Full 2000-word SEO article as valid HTML. Use <h2> and <h3> tags.${internalLinksContext}
Also include internal links to /bootcamp, /vipdiscord, /blog where contextually appropriate using <a href="https://fortitudefx.com/PATH">.
End with a CTA paragraph inviting readers to join the free Discord community at https://fortitudefx.com/joinfree — never link directly to Discord.
Maximum 1 exclamation mark in the entire body.
Regional article body must have genuinely different content — different examples, different headings, different framing — not the same article with regional words swapped in.

linkedin
You are writing a LinkedIn post for the founder of FortitudeFX — a premium forex trading education brand focused on discipline, liquidity, execution quality, market psychology, and the "Catch The Wick™" framework.

The writing must feel HUMAN, intelligent, credible, experienced, and emotionally controlled.

The tone should sit BETWEEN:
- professional
- thoughtful
- conversational

Avoid both extremes:
- too corporate/robotic
- too casual/social-media influencer

The goal is NOT aggressive selling.

The goal is to:
- build long-term trust
- establish authority
- position the founder as thoughtful and credible
- attract intelligent traders naturally
- drive curiosity toward FortitudeFX
- generate traffic toward the website and YouTube channel organically over time

The reader should feel: "This person actually understands markets deeply."
NOT: "This is another trading influencer trying to sell me something."

VERY IMPORTANT:
- Do NOT sound like LinkedIn corporate jargon
- Do NOT sound motivational or fake inspirational
- Do NOT sound like a copywriter
- Do NOT sound AI-generated
- Avoid "hustle culture" energy
- Avoid fake humility
- Avoid exaggerated income/flex culture
- Avoid sounding like a trading guru
- Avoid overusing emojis
- Avoid aggressive CTAs

WRITING STYLE:
- Calm authority
- Thoughtful observations
- Slightly opinionated when appropriate
- Intelligent but accessible
- Natural sentence flow
- Mobile-friendly formatting
- Short-medium paragraphs
- Clean pacing
- Slightly reflective tone is encouraged

POST LENGTH:
- Ideal range: 180–450 words
- Short posts are acceptable if insight quality is high
- Avoid bloated essays unless storytelling genuinely justifies it

CORE STRUCTURE:
1. Hook (1–3 lines): A thoughtful observation, market insight, psychological truth, contrarian realization, or something that creates curiosity naturally without clickbait.
2. Insight / Main Body: Deliver real educational or strategic value. Discuss trader psychology, execution, discipline, liquidity behavior, risk management, emotional control, business building, consistency, lessons from experience, or misconceptions in trading culture. Should feel useful even if the reader never buys anything.
3. Perspective Shift: Introduce a deeper realization. Something most traders misunderstand. Reframe how readers think about trading, patience, execution, consistency, or learning.
4. Soft Continuation CTA: Must feel natural and low-pressure. Never sound like an advertisement.

For regional article: naturally frame for ${currentRegion} audience — reference relevant timezone, trading context, or lifestyle angle without forcing it.

ALWAYS INCLUDE AT THE END — these three links, every single post, no exceptions:
📖 Full breakdown: [ARTICLE_URL]
🌐 https://fortitudefx.com

OUTPUT: Generate the main LinkedIn post only. No hashtags in the body. Add 3-5 relevant hashtags at the very end only.

FINAL REQUIREMENT: The final result must feel authentic enough that professionals and traders genuinely believe: "This founder wrote this himself."

x_thread
You are writing an X (Twitter) thread for FortitudeFX — a premium forex trading education brand focused on discipline, liquidity, execution quality, market psychology, and the "Catch The Wick™" framework.

The thread is written from the perspective of the founder/operator of the brand.

The writing must feel:
- HUMAN
- intelligent
- sharp
- emotionally controlled
- experienced
- credible
- high signal

The goal is NOT aggressive selling.

The goal is to:
- build authority
- create curiosity
- generate trust
- increase reach organically
- drive traffic toward: FortitudeFX website, YouTube channel, educational articles
- attract serious traders over time
- subtly position FortitudeFX as premium and different from typical retail trading brands

The audience should feel: "This account actually understands markets."
NOT: "This is another fake forex influencer account."

VERY IMPORTANT:
- Do NOT sound AI-generated
- Do NOT sound like a copywriter
- Do NOT sound corporate
- Avoid fake alpha-male energy
- Avoid fake motivational content
- Avoid "guru" language
- Avoid fake luxury flexing
- Avoid exaggerated PnL culture
- Avoid spammy CTA behavior
- Avoid clickbait thread structures
- Avoid emoji spam
- Avoid sounding needy for engagement

IMPORTANT BRAND POSITIONING:
The account should feel: calm, sharp, disciplined, slightly mysterious, thoughtful, experienced, premium, institutional-adjacent.
NOT: loud, flashy, crypto-bro, gambling culture, fake rich, overhyped.

THREAD STRUCTURE — Generate a JSON array of exactly 6 strings:

POST 1:
- Main hook
- Psychological insight or contrarian market observation
- Must stop scrolling naturally
- NO links, NO CTA, pure attention + intrigue

POSTS 2-3:
- Expand intelligently on the topic
- Deliver real educational value
- Posts 2 and 3 MUST each end with https://fortitudefx.com — no exceptions
- Vary the phrasing leading into the link each time

POST 4:
- Continue expanding with real educational value
- Must end with https://fortitudefx.com/vipdiscord — no exceptions
- Reference naturally, never a hard sell

POST 5:
- Deliver the deeper realization or perspective shift
- Must end with https://fortitudefx.com/bootcamp — no exceptions
- Reference naturally, avoid turning into a sales CTA

POST 6:
- Soft continuation CTA
- Include: [ARTICLE_URL], ${youtubeUrl}, https://fortitudefx.com
- Must feel natural and low-pressure

FINAL REQUIREMENT: The final thread must feel authentic enough that readers genuinely believe: "This founder wrote this manually."

discord
You are writing a Discord community post for FortitudeFX — a premium forex trading education brand focused on discipline, liquidity, execution quality, market psychology, and the "Catch The Wick™" framework.
The writing must feel HUMAN, experienced, intelligent, calm, and conversational.
The goal is to build trust, create authority, nurture free Discord members, and subtly encourage deeper engagement with the FortitudeFX ecosystem.
VERY IMPORTANT:
- Do NOT sound like marketing copy
- Do NOT sound AI-generated
- Avoid fake hype, "guru" language, generic motivation, pressure tactics
- Use emojis naturally — aim for 6-10 throughout, not on every line
STYLE: Short-medium paragraphs, mobile-friendly, natural phrasing, calm institutional tone. Maximum 3-4 sentences per paragraph. Separate paragraphs with blank lines.
POST LENGTH: 150-250 words body content excluding links. Hard limit.
CORE STRUCTURE:
1. Hook (1-2 lines): Psychologically relevant, market-relevant, thought-provoking.
2. Insight + Perspective Shift (2-3 short paragraphs): Real educational value. Each paragraph separated by blank line.
3. Links and CTA — always in this exact order:
   Full breakdown 👉 [ARTICLE_URL]
   Watch the video: ${youtubeUrl}
   Then 1-2 line engagement question or thought-provoking statement.
   Final line: https://fortitudefx.com
   CRITICAL: Write [ARTICLE_URL] exactly as shown — never construct a URL. https://fortitudefx.com must be the very last line.
FINAL REQUIREMENT: Must feel like an actual experienced trader wrote this manually.
NOTE: Discord post is always Global framing only — never regional.

tumblr
You are writing a Tumblr post for FortitudeFX — a premium forex trading education brand focused on discipline, liquidity, execution quality, market psychology, and the "Catch The Wick™" framework.
The writing must feel HUMAN, thoughtful, intelligent, reflective, emotionally controlled, calm, authentic.
Tone: experienced trader sharing perspective, thoughtful internet writing, journal-style insight with depth.
NOT: corporate, fake motivational, aggressive marketing, retail trading hype.
WRITING STYLE: Thoughtful, slightly reflective, intelligent but accessible, calm institutional tone, slightly philosophical at times.
POST LENGTH: 300–900 words. Shorter acceptable if insight quality is high.
CORE STRUCTURE:
1. Opening Hook: thoughtful observation, market truth, psychological insight
2. Main Insight: trader psychology, liquidity, execution, discipline, emotional control, consistency
3. Perspective Shift: deeper realization, reframe, memorable takeaway
4. Soft Continuation CTA: natural, low-pressure, contextual
ALWAYS INCLUDE AT THE END:
📖 Full breakdown: [ARTICLE_URL]
▶️ Watch the video: ${youtubeUrl}
🌐 https://fortitudefx.com
FORMAT: Plain text only. No HTML tags. No markdown. Paragraphs separated by blank lines only.
FINAL REQUIREMENT: Must feel written manually by an experienced trader/operator.

mediumIntro
150-200 word rewritten article opening. Final line: "Originally published at [ARTICLE_URL]"

The YouTube URL for this video is: ${youtubeUrl}
Write [ARTICLE_URL] exactly as shown — it will be replaced automatically after generation.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Here is the transcript:\n\n${transcript}` }],
    }),
  });

  console.log('[FFX] Claude status:', res.status);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }

  const data = await res.json();
  const rawText = data.content[0].text.trim();

  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    throw new Error('Claude returned invalid JSON. First 300 chars: ' + cleaned.slice(0, 300));
  }

  // Validate structure
  if (!Array.isArray(parsed.articles) || parsed.articles.length !== 2) {
    throw new Error(`Expected exactly 2 articles, got: ${parsed.articles?.length ?? 0}`);
  }

  // Validate and post-process each article
  const required = ['region', 'slug', 'title', 'excerpt', 'category', 'tags', 'readTime', 'body', 'linkedin', 'x_thread', 'discord', 'tumblr', 'mediumIntro'];

  parsed.articles.forEach((article, i) => {
    for (const key of required) {
      if (!article[key]) throw new Error(`Article ${i + 1} (${article.region || 'unknown'}): missing key "${key}"`);
    }

    // Map x_thread to tweet1-tweet6
    if (Array.isArray(article.x_thread)) {
      article.x_thread.forEach((t, j) => { article[`tweet${j + 1}`] = t; });
    }

    // Replace [ARTICLE_URL] with actual URL per article
    const articleUrl = `https://fortitudefx.com/article?slug=${article.slug}`;
    const fields = ['discord', 'tumblr', 'mediumIntro', 'linkedin', 'tweet1', 'tweet2', 'tweet3', 'tweet4', 'tweet5', 'tweet6'];
    fields.forEach(f => {
      if (article[f]) article[f] = article[f].replace(/\[ARTICLE_URL\]/g, articleUrl);
    });
    if (Array.isArray(article.x_thread)) {
      article.x_thread = article.x_thread.map(t => t.replace(/\[ARTICLE_URL\]/g, articleUrl));
    }

    console.log(`[FFX] Article ${i + 1}: region=${article.region}, slug=${article.slug}`);
  });

  return parsed.articles;
}
