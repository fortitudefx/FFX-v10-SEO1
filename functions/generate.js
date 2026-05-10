// ─────────────────────────────────────────────────────────────────────────────
// FFX Generate Worker — No KV
// POST /generate → Supadata transcript → Claude → return content to browser
// Browser holds content in JS memory during review session
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

  const { youtubeUrl } = body;
  if (!youtubeUrl) {
    return new Response(JSON.stringify({ error: 'youtubeUrl is required' }), { status: 400, headers });
  }

  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    return new Response(JSON.stringify({ error: 'Could not parse YouTube video ID from URL' }), { status: 400, headers });
  }

  console.log('[FFX] videoId:', videoId);

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

  // 2. Call Claude
  console.log('[FFX] Calling Claude');
  let content;
  try {
    content = await callClaude(transcript, youtubeUrl, env.ANTHROPIC_API_KEY);
    console.log('[FFX] Claude done, slug:', content.slug);
  } catch (err) {
    console.log('[FFX] Claude failed:', err.message);
    return new Response(JSON.stringify({ error: `Claude API failed: ${err.message}` }), { status: 502, headers });
  }

  // Store youtubeUrl on content for Excel logging
  content.youtubeUrl = youtubeUrl;

  // Return content directly to browser — no KV
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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supadata ${res.status}: ${err}`);
  }

  const data = await res.json();

  if (data.content && typeof data.content === 'string') return data.content.trim();
  if (Array.isArray(data.content)) return data.content.map(s => s.text || '').join(' ').trim();

  throw new Error('Unexpected Supadata response: ' + JSON.stringify(data).slice(0, 200));
}

async function callClaude(transcript, youtubeUrl, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = `You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick mechanical entry system (5 entry models, 2-candle philosophy). Voice: direct, authoritative, no fluff. Products: free Discord, VIP Discord, Bootcamp. Zero ad spend — content does the selling.

You will receive a YouTube video transcript. Generate a full content package and return it as a single valid JSON object with exactly these keys. No markdown, no preamble, no explanation — only the raw JSON object.

slug
URL-safe lowercase hyphenated string, 3-6 words, no stopwords, describes the core topic.

title
SEO title 50-60 characters, includes primary keyword.

excerpt
Max 160 characters, compelling meta description.

category
Exactly one of: Strategy, Psychology, Risk Management, Market Analysis, Fundamentals

tags
Comma-separated string of 4-6 relevant tags.

readTime
String like "7 min read".

body
Full 2000-word SEO article as valid HTML. Use <h2> and <h3> tags. Include internal links using <a href="https://fortitudefx.com/PATH"> throughout — link to /bootcamp, /vipdiscord, /blog where contextually appropriate. End with a CTA paragraph inviting readers to join the free Discord at https://discord.gg/fortitudefx. Maximum 1 exclamation mark in the entire body.

linkedin
800-1200 word native LinkedIn longform post. No hashtags in the body. Add 3-5 relevant hashtags at the very end only. Direct voice, teach something genuinely useful.

x_thread
A JSON array of exactly 6 strings. Tweet 1: hook only, no link, must stop the scroll — provocative statement or counterintuitive truth about trading. Tweets 2-4: one punchy insight each, max 2 sentences, ends with fortitudefx.com. Tweet 5: key takeaway, the one thing they must remember, ends with fortitudefx.com. Tweet 6: "New article: [ARTICLE_URL] | Watch: ${youtubeUrl} | fortitudefx.com"

discord
STRICT 400-500 word community knowledge drop. Count words carefully — do not exceed 500 words under any circumstances. Use 4-6 emojis naturally throughout. Structure:

Opening hook (2-3 sentences max): Bold pattern-interrupt statement that challenges a common trader belief. Make them stop scrolling.

Knowledge drop (200-250 words): Teach something specific and real from the video. Short paragraphs. No bullet walls.

Curiosity bridge (2-3 sentences): Tease what the full article covers without giving it away.

Links (keep concise):
Full breakdown 👉 [ARTICLE_URL]
Watch: ${youtubeUrl}
fortitudefx.com

VIP close (2-3 sentences max): Soft natural close. No hard sell. fortitudefx.com/vipdiscord

Rules: No markdown headers. No bullets. Short paragraphs. Max 1 exclamation mark. TOTAL WORD COUNT MUST BE 400-500 WORDS.

tumblr
200-350 word short essay, conversational tone.

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
      max_tokens: 8000,
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

  const required = ['slug', 'title', 'excerpt', 'category', 'tags', 'readTime', 'body', 'linkedin', 'x_thread', 'discord', 'tumblr', 'mediumIntro'];
  for (const key of required) {
    if (!parsed[key]) throw new Error(`Missing key: "${key}"`);
  }

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

  console.log('[FFX] Content ready, slug:', parsed.slug);
  return parsed;
}
