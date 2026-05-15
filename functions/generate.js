// ─────────────────────────────────────────────────────────────────────────────
// FFX Generate Worker — No KV
// POST /generate → Supadata transcript → Claude (x2) → return articles to browser
// Phase 1: Regional SEO Intelligence Layer + Internal Linking
// Region cycle: Global + mandated region from ffx-config.json cycle index
// Regions: GCC → US/Canada → EU/UK/Germany → SEA/Asia → repeat
// Two sequential Claude calls at 8000 tokens each — avoids API timeout
// ─────────────────────────────────────────────────────────────────────────────

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

  // 4. Call Claude — Global article only
  console.log('[FFX] Calling Claude — Global');
  let content;
  try {
    content = await callClaudeArticle(transcript, youtubeUrl, env.ANTHROPIC_API_KEY, existingArticles, 'Global', null);
    console.log('[FFX] Claude done, slug:', content.slug);
  } catch (err) {
    console.log('[FFX] Claude failed:', err.message);
    return new Response(JSON.stringify({ error: `Claude API failed: ${err.message}` }), { status: 502, headers });
  }

  // 5. Apply existing slug lock
  if (existingSlug && existingSlug.trim()) {
    console.log('[FFX] Locking slug to existing:', existingSlug);
    const oldArticleUrl = `https://fortitudefx.com/article?slug=${content.slug}`;
    const newArticleUrl = `https://fortitudefx.com/article?slug=${existingSlug}`;
    content.slug = existingSlug;
    const fields = ['discord', 'tumblr', 'mediumIntro', 'linkedin', 'tweet1', 'tweet2', 'tweet3', 'tweet4', 'tweet5', 'tweet6'];
    fields.forEach(f => {
      if (content[f]) content[f] = content[f].replace(new RegExp(oldArticleUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newArticleUrl);
    });
    if (Array.isArray(content.x_thread)) {
      content.x_thread = content.x_thread.map(t => t.replace(new RegExp(oldArticleUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newArticleUrl));
    }
  }

  // 6. Attach youtubeUrl
  content.youtubeUrl = youtubeUrl;

  return new Response(JSON.stringify({ success: true, content }), { status: 200, headers });
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

// Regional framing guide per region
function getRegionalGuide(region) {
  if (region === 'GCC') return `- UAE, Saudi Arabia, Kuwait, Bahrain audience
- Dubai trading lifestyle, Gulf trading culture
- Evening London session preparation from Gulf timezone (UTC+4)
- Work-life balance with London open timing
- English-speaking GCC traders`;
  if (region === 'US/Canada') return `- New York session focus, North American traders
- EST/CST timezone context
- Overlap between London close and NY open
- US economic calendar relevance`;
  if (region === 'EU/UK/Germany') return `- London session authority, European institutional flow
- GMT timezone, Frankfurt/London context
- XETRA open, European market structure
- UK and European retail trader audience`;
  if (region === 'SEA/Asia') return `- Asian session focus, Singapore/Hong Kong/Tokyo
- Overnight trading from Western perspective
- Asian range setup for London open
- SGT/HKT/JST timezone context`;
  return '';
}

// Single article Claude call — one article per call, 8000 tokens max
async function callClaudeArticle(transcript, youtubeUrl, apiKey, existingArticles, region, globalSlug) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const isGlobal = region === 'Global';

  // Build internal links context
  const internalLinksContext = existingArticles.length > 0
    ? `\n\nEXISTING PUBLISHED ARTICLES FOR INTERNAL LINKING:\nWhere contextually relevant and natural, insert internal links inside the body HTML using <a href="https://fortitudefx.com/article?slug=SLUG">TITLE</a>. Only link when genuinely relevant — never force links.\n${existingArticles.map(a => `- slug: ${a.slug} | title: ${a.title}`).join('\n')}`
    : '';

  // Regional slug guidance
  const slugGuidance = isGlobal
    ? 'URL-safe lowercase hyphenated string, 3-6 words, describes core topic. e.g. "liquidity-sweep-trading-strategy"'
    : `URL-safe lowercase hyphenated string, 3-6 words, includes regional signal. e.g. "liquidity-sweeps-dubai-traders" or "london-session-gcc-traders". Must be different from the Global article slug: ${globalSlug || 'unknown'}`;

  const regionalSection = isGlobal ? '' : `
REGIONAL FRAMING FOR ${region}:
${getRegionalGuide(region)}

This article must be genuinely different from the Global article — different examples, different headings, different framing. Same core trading knowledge, different regional lens. 80% universal knowledge, 20% regional context. Never keyword-stuff the region.`;

  const systemPrompt = `You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick™ mechanical entry system (5 entry models, 2-candle philosophy).

Generate one complete content package for a ${isGlobal ? 'GLOBAL (universal audience, no regional framing)' : region + ' REGIONAL'} article.${regionalSection}

Return a single valid JSON object with exactly these keys. No markdown, no preamble, no explanation — raw JSON only.

region: "${region}"

slug: ${slugGuidance}

title: SEO title 50-60 characters, includes primary keyword.${isGlobal ? '' : ' Must include regional signal.'}

excerpt: Max 160 characters, compelling meta description.

category: Exactly one of: Strategy, Psychology, Risk Management, Market Analysis, Fundamentals

tags: Comma-separated string of 4-6 relevant tags.${isGlobal ? '' : ' Include regional tag.'}

readTime: String like "7 min read".

body: Full 2000-word SEO article as valid HTML. Use h2 and h3 tags.${internalLinksContext}
Include internal links to /bootcamp, /vipdiscord, /blog where contextually appropriate using <a href="https://fortitudefx.com/PATH">.
End with a CTA paragraph inviting readers to join the free Discord community at https://fortitudefx.com/joinfree — never link directly to Discord.
Maximum 1 exclamation mark in the entire body.${isGlobal ? '' : ' Body must be genuinely different from the Global article — different examples, different headings, different regional framing.'}

linkedin: LinkedIn post for the FortitudeFX founder. Human, intelligent, credible, experienced. Calm authority, thoughtful observations. 180-450 words. Hook → Insight → Perspective Shift → Soft CTA. No LinkedIn jargon, no motivational fluff, no AI-sounding language. No hashtags in body — 3-5 hashtags at end only.${isGlobal ? '' : ' Naturally frame for ' + region + ' audience.'}
ALWAYS END WITH:
📖 Full breakdown: [ARTICLE_URL]
🌐 https://fortitudefx.com

x_thread: JSON array of exactly 6 strings. X/Twitter thread for FortitudeFX founder. Human, sharp, high signal, calm authority.
Post 1: Hook — no links, no CTA, pure attention.
Posts 2-3: Expand topic with real educational value. Each MUST end with https://fortitudefx.com
Post 4: Continue expanding. MUST end with https://fortitudefx.com/vipdiscord
Post 5: Perspective shift. MUST end with https://fortitudefx.com/bootcamp
Post 6: Soft CTA with [ARTICLE_URL], ${youtubeUrl}, https://fortitudefx.com

discord: Discord community post. GLOBAL FRAMING ONLY regardless of article region. Human, experienced, calm, conversational. 150-250 words body (hard limit). Use 6-10 emojis naturally. End with:
Full breakdown 👉 [ARTICLE_URL]
Watch the video: ${youtubeUrl}
[engagement question]
https://fortitudefx.com

tumblr: Tumblr post. Human, thoughtful, reflective, intelligent. 300-900 words. Plain text only — no HTML, no markdown. End with:
📖 Full breakdown: [ARTICLE_URL]
▶️ Watch the video: ${youtubeUrl}
🌐 https://fortitudefx.com

mediumIntro: 150-200 word rewritten article opening. Final line: "Originally published at [ARTICLE_URL]"

The YouTube URL for this video is: ${youtubeUrl}
Write [ARTICLE_URL] exactly as shown — it will be replaced automatically.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Here is the transcript:\n\n${transcript}` }],
    }),
  });

  console.log(`[FFX] Claude status (${region}):`, res.status);

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
    throw new Error(`Claude returned invalid JSON (${region}). First 300 chars: ` + cleaned.slice(0, 300));
  }

  // Validate required keys
  const required = ['region', 'slug', 'title', 'excerpt', 'category', 'tags', 'readTime', 'body', 'linkedin', 'x_thread', 'discord', 'tumblr', 'mediumIntro'];
  for (const key of required) {
    if (!parsed[key]) throw new Error(`${region} article: missing key "${key}"`);
  }

  // Ensure region is set correctly
  parsed.region = region;

  // Map x_thread to tweet1-tweet6
  if (Array.isArray(parsed.x_thread)) {
    parsed.x_thread.forEach((t, i) => { parsed[`tweet${i + 1}`] = t; });
  }

  // Replace [ARTICLE_URL] with actual URL
  const articleUrl = `https://fortitudefx.com/article?slug=${parsed.slug}`;
  const fields = ['discord', 'tumblr', 'mediumIntro', 'linkedin', 'tweet1', 'tweet2', 'tweet3', 'tweet4', 'tweet5', 'tweet6'];
  fields.forEach(f => {
    if (parsed[f]) parsed[f] = parsed[f].replace(/\[ARTICLE_URL\]/g, articleUrl);
  });
  if (Array.isArray(parsed.x_thread)) {
    parsed.x_thread = parsed.x_thread.map(t => t.replace(/\[ARTICLE_URL\]/g, articleUrl));
  }

  return parsed;
}
