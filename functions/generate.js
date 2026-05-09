// ─────────────────────────────────────────────────────────────────────────────
// FFX Generate Worker
// Routes:
//   POST /generate         → check KV cache → if hit return instantly
//                           → else fetch transcript via Supadata → call Claude
//                           → save to KV → return preview
//   POST /publish-confirm  → read from KV → fire Make webhook → delete from KV
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  console.log('[FFX] Request received:', request.method, url.pathname);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // ── Route: /publish-confirm ────────────────────────────────────────────────
  if (url.pathname === '/publish-confirm') {
    console.log('[FFX] Route: /publish-confirm');

    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
    }

    const { slug } = body;
    if (!slug) {
      return new Response(JSON.stringify({ error: 'slug is required' }), { status: 400, headers });
    }

    console.log('[FFX] publish-confirm slug:', slug);

    const stored = await env.FFX_CONTENT.get(`slug:${slug}`);
    if (!stored) {
      return new Response(JSON.stringify({ error: 'Content not found or expired. Please generate again.' }), { status: 404, headers });
    }

    let content;
    try { content = JSON.parse(stored); } catch {
      return new Response(JSON.stringify({ error: 'Stored content is corrupted. Please generate again.' }), { status: 500, headers });
    }

    console.log('[FFX] Firing Make webhook for slug:', slug);

    let makeRes;
    try {
      makeRes = await fetch('https://hook.eu1.make.com/jnjy3n7w2cy12mclu8uh9nr11ultt6l', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      });
    } catch (err) {
      console.log('[FFX] Make webhook network error:', err.message);
      return new Response(JSON.stringify({ error: `Make webhook network error: ${err.message}` }), { status: 502, headers });
    }

    if (!makeRes.ok) {
      const makeErr = await makeRes.text();
      console.log('[FFX] Make webhook rejected:', makeErr);
      return new Response(JSON.stringify({ error: `Make webhook rejected the request: ${makeErr}` }), { status: 502, headers });
    }

    // Clean up both KV keys
    const videoId = extractVideoId(content.youtubeUrl || '');
    if (videoId) await env.FFX_CONTENT.delete(`video:${videoId}`);
    await env.FFX_CONTENT.delete(`slug:${slug}`);
    console.log('[FFX] KV deleted, publish complete');

    return new Response(JSON.stringify({ success: true, slug: content.slug }), { status: 200, headers });
  }

  // ── Route: /generate ──────────────────────────────────────────────────────
  console.log('[FFX] Route: /generate');

  let body;
  try { body = await request.json(); } catch {
    console.log('[FFX] Failed to parse JSON body');
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { youtubeUrl } = body;
  console.log('[FFX] youtubeUrl received:', youtubeUrl);

  if (!youtubeUrl) {
    return new Response(JSON.stringify({ error: 'youtubeUrl is required' }), { status: 400, headers });
  }

  const videoId = extractVideoId(youtubeUrl);
  console.log('[FFX] videoId extracted:', videoId);

  if (!videoId) {
    return new Response(JSON.stringify({ error: 'Could not parse YouTube video ID from URL' }), { status: 400, headers });
  }

  // 1. Check KV cache first — return instantly if already generated
  console.log('[FFX] Checking KV cache for videoId:', videoId);
  const cached = await env.FFX_CONTENT.get(`video:${videoId}`);
  if (cached) {
    console.log('[FFX] KV cache hit — returning cached content');
    let content;
    try { content = JSON.parse(cached); } catch {
      console.log('[FFX] Cached content corrupted — regenerating');
    }
    if (content) {
      return new Response(JSON.stringify({ success: true, content, cached: true }), { status: 200, headers });
    }
  }

  console.log('[FFX] KV cache miss — generating fresh content');

  // 2. Fetch transcript via Supadata
  console.log('[FFX] Fetching transcript via Supadata');
  let transcript;
  try {
    transcript = await fetchTranscriptSupadata(youtubeUrl, env.SUPADATA_API_KEY);
    console.log('[FFX] Transcript fetched, length:', transcript ? transcript.length : 0);
  } catch (err) {
    console.log('[FFX] Supadata transcript fetch failed:', err.message);
    return new Response(JSON.stringify({ error: `Transcript fetch failed: ${err.message}` }), { status: 502, headers });
  }

  if (!transcript || transcript.trim().length < 100) {
    console.log('[FFX] Transcript too short or empty');
    return new Response(JSON.stringify({ error: 'Transcript too short or empty. Ensure captions are enabled on the video and try again.' }), { status: 422, headers });
  }

  // 3. Call Claude API
  console.log('[FFX] Starting Claude API call');
  let content;
  try {
    content = await callClaude(transcript, youtubeUrl, env.ANTHROPIC_API_KEY);
    console.log('[FFX] Claude response received, slug:', content.slug);
  } catch (err) {
    console.log('[FFX] Claude API failed:', err.message);
    return new Response(JSON.stringify({ error: `Claude API failed: ${err.message}` }), { status: 502, headers });
  }

  // Store the youtubeUrl in content so publish-confirm can clean up both KV keys
  content.youtubeUrl = youtubeUrl;

  // 4. Save to KV with both keys — expires after 24 hours
  console.log('[FFX] Saving to KV, slug:', content.slug, 'videoId:', videoId);
  await env.FFX_CONTENT.put(`video:${videoId}`, JSON.stringify(content), { expirationTtl: 86400 });
  await env.FFX_CONTENT.put(`slug:${content.slug}`, JSON.stringify(content), { expirationTtl: 86400 });
  console.log('[FFX] KV save complete');

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
  if (!apiKey) throw new Error('SUPADATA_API_KEY is not set in Cloudflare environment variables.');

  console.log('[FFX] Calling Supadata API for URL:', youtubeUrl);

  const supadataUrl = `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(youtubeUrl)}&text=true`;

  const res = await fetch(supadataUrl, {
    headers: {
      'x-api-key': apiKey,
    },
  });

  console.log('[FFX] Supadata response status:', res.status);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supadata API returned ${res.status}: ${err}`);
  }

  const data = await res.json();
  console.log('[FFX] Supadata response keys:', Object.keys(data).join(', '));

  if (data.content && typeof data.content === 'string') {
    return data.content.trim();
  }

  if (Array.isArray(data.content)) {
    return data.content.map(s => s.text || '').join(' ').trim();
  }

  throw new Error('Supadata returned unexpected response format: ' + JSON.stringify(data).slice(0, 200));
}

async function callClaude(transcript, youtubeUrl, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set in Cloudflare.');

  console.log('[FFX] ANTHROPIC_API_KEY present:', !!apiKey);

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
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Here is the transcript:\n\n${transcript}` }],
    }),
  });

  console.log('[FFX] Claude API response status:', res.status);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API returned ${res.status}: ${err}`);
  }

  const data = await res.json();
  const rawText = data.content[0].text.trim();
  console.log('[FFX] Claude raw response length:', rawText.length);

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

  // Map x_thread array to tweet1-tweet6 so Make + /tweet Worker can read them
  if (Array.isArray(parsed.x_thread)) {
    parsed.x_thread.forEach((t, i) => {
      parsed[`tweet${i + 1}`] = t;
    });
  }

  console.log('[FFX] Content parsed successfully, slug:', parsed.slug);

  return parsed;
}
