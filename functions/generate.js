// ─────────────────────────────────────────────────────────────────────────────
// FFX Generate Worker
// Routes:
//   POST /generate         → fetch transcript → call Claude → save to KV → return preview
//   POST /publish-confirm  → read from KV → fire Make webhook → delete from KV
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // ── Route: /publish-confirm ────────────────────────────────────────────────
  if (url.pathname === '/publish-confirm') {
    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
    }

    const { slug } = body;
    if (!slug) {
      return new Response(JSON.stringify({ error: 'slug is required' }), { status: 400, headers });
    }

    // Read generated content from KV
    const stored = await env.FFX_CONTENT.get(slug);
    if (!stored) {
      return new Response(JSON.stringify({ error: 'Content not found or expired. Please generate again.' }), { status: 404, headers });
    }

    let content;
    try { content = JSON.parse(stored); } catch {
      return new Response(JSON.stringify({ error: 'Stored content is corrupted. Please generate again.' }), { status: 500, headers });
    }

    // Fire Make FFX LIVE webhook
    let makeRes;
    try {
      makeRes = await fetch('https://hook.eu1.make.com/0iwx8y8ufy318mfml1jmgs1cjjeii388', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: `Make webhook network error: ${err.message}` }), { status: 502, headers });
    }

    if (!makeRes.ok) {
      const makeErr = await makeRes.text();
      return new Response(JSON.stringify({ error: `Make webhook rejected the request: ${makeErr}` }), { status: 502, headers });
    }

    // Clean up KV
    await env.FFX_CONTENT.delete(slug);

    return new Response(JSON.stringify({ success: true, slug: content.slug }), { status: 200, headers });
  }

  // ── Route: /generate ──────────────────────────────────────────────────────
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

  // 1. Fetch transcript from YouTube
  let transcript;
  try {
    transcript = await fetchYouTubeTranscript(videoId);
  } catch (err) {
    return new Response(JSON.stringify({ error: `Transcript fetch failed: ${err.message}` }), { status: 502, headers });
  }

  if (!transcript || transcript.trim().length < 100) {
    return new Response(JSON.stringify({ error: 'Transcript too short or empty. Ensure captions are enabled and wait a few minutes after publishing to YouTube.' }), { status: 422, headers });
  }

  // 2. Call Claude API
  let content;
  try {
    content = await callClaude(transcript, youtubeUrl, env.ANTHROPIC_API_KEY);
  } catch (err) {
    return new Response(JSON.stringify({ error: `Claude API failed: ${err.message}` }), { status: 502, headers });
  }

  // 3. Save to KV — expires after 24 hours
  await env.FFX_CONTENT.put(content.slug, JSON.stringify(content), { expirationTtl: 86400 });

  // Return full content for preview — Make NOT called yet
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

async function fetchYouTubeTranscript(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!pageRes.ok) throw new Error(`YouTube page returned ${pageRes.status}`);
  const html = await pageRes.text();

  const match = html.match(/"captionTracks":\s*(\[.*?\])/s);
  if (!match) throw new Error('No caption tracks found. Captions may not be ready yet — wait a few minutes after publishing and try again.');

  let tracks;
  try { tracks = JSON.parse(match[1]); } catch {
    throw new Error('Failed to parse caption tracks from YouTube page.');
  }

  if (!tracks || !tracks.length) throw new Error('No caption tracks available for this video.');

  const preferred =
    tracks.find(t => t.languageCode === 'en' && !t.kind) ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks[0];

  const captionRes = await fetch(preferred.baseUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!captionRes.ok) throw new Error(`Caption fetch returned ${captionRes.status}`);

  const xml = await captionRes.text();

  return xml
    .replace(/<\/?[^>]+(>|$)/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function callClaude(transcript, youtubeUrl, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set in Cloudflare.');

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
A JSON array of exactly 6 strings. Tweet 1: hook only, no link. Tweets 2-5: content value + fortitudefx.com. Tweet 6: "New article: [ARTICLE_URL]" + the YouTube URL + fortitudefx.com.

discord
800-1000 word knowledge drop for the community. Genuine value, builds curiosity, soft push toward VIP at the end. Final lines: "Full breakdown: [ARTICLE_URL] | Video: ${youtubeUrl} | fortitudefx.com | VIP: fortitudefx.com/vipdiscord"

tumblr
200-350 word short essay, conversational tone.

mediumIntro
150-200 word rewritten article opening. Final line: "Originally published at [ARTICLE_URL]"

The YouTube URL for this video is: ${youtubeUrl}
Leave [ARTICLE_URL] exactly as written — it will be replaced automatically.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Here is the transcript:\n\n${transcript}` }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API returned ${res.status}: ${err}`);
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
    if (!parsed[key]) throw new Error(`Claude response missing required key: "${key}"`);
  }

  return parsed;
}
