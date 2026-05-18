// ─────────────────────────────────────────────────────────────────────────────
// FFX Consumer Worker — Queue consumer
// Receives job from ffx-generate-queue
// Makes 3 Claude calls: Global article, Regional article, Library extraction
// Writes results to KV with 24hr TTL (unpublished) or permanent (library)
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processJob(message.body, env);
        message.ack();
      } catch (err) {
        console.error('[FFX Consumer] Unhandled error:', err.message);
        message.retry();
      }
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN JOB PROCESSOR
// ─────────────────────────────────────────────────────────────────────────────

async function processJob(job, env) {
  const { jobId, videoId, youtubeUrl, existingSlug } = job;
  console.log('[FFX] Processing job:', jobId, 'videoId:', videoId);

  // Write generating lock immediately — prevents Cron double-firing
  await kvPut(env, `lock:generating`, JSON.stringify({
    jobId, videoId, startedAt: new Date().toISOString()
  }), { expirationTtl: 1800 }); // 30 min lock max

  // Update job status to processing
  await kvPut(env, `job:${jobId}`, JSON.stringify({
    status: 'processing', videoId, step: 'transcript'
  }), { expirationTtl: 86400 });

  // ── STEP 1: Fetch transcript ──────────────────────────────────────────────
  let transcript;
  try {
    transcript = await fetchTranscriptSupadata(youtubeUrl, env.SUPADATA_API_KEY);
    console.log('[FFX] Transcript fetched, length:', transcript?.length);
  } catch (err) {
    await failJob(env, jobId, videoId, 'transcript', err.message);
    return;
  }

  if (!transcript || transcript.trim().length < 100) {
    await failJob(env, jobId, videoId, 'transcript', 'Transcript too short or empty. Ensure captions are enabled.');
    return;
  }

  // ── STEP 2: Select random formats ────────────────────────────────────────
  const linkedinFormats = ['WALL', 'SHORT', 'SINGLE', 'STORY', 'CONTRARIAN'];
  const discordFormats  = ['NUGGET', 'DROP', 'QUESTION'];
  const xFormats        = ['THREAD', 'SINGLE', 'MINI', 'HOTTAKE'];
  const selectedLinkedin = linkedinFormats[Math.floor(Math.random() * linkedinFormats.length)];
  const selectedDiscord  = discordFormats[Math.floor(Math.random() * discordFormats.length)];
  const selectedX        = xFormats[Math.floor(Math.random() * xFormats.length)];
  console.log('[FFX] Formats — LinkedIn:', selectedLinkedin, 'Discord:', selectedDiscord, 'X:', selectedX);

  // ── STEP 3: Get region for regional article ───────────────────────────────
  const regions = ['GCC', 'US/Canada', 'EU/UK/Germany', 'SEA/Asia'];
  let regionIndex = 0;
  try {
    const stored = await env.FFX_KV.get('config:regionCycle');
    regionIndex = stored !== null ? parseInt(stored, 10) % 4 : 0;
  } catch {}
  const regionName = regions[regionIndex];
  console.log('[FFX] Region for this run:', regionName, '(index', regionIndex, ')');

  // Update job step
  await kvPut(env, `job:${jobId}`, JSON.stringify({
    status: 'processing', videoId, step: 'global'
  }), { expirationTtl: 86400 });

  // ── STEP 4: Claude Call 1 — Global article ───────────────────────────────
  let globalArticle;
  try {
    globalArticle = await callClaude(
      transcript, youtubeUrl, env.ANTHROPIC_API_KEY,
      selectedLinkedin, selectedDiscord, selectedX,
      'Global', null, existingSlug
    );
    console.log('[FFX] Global article done, slug:', globalArticle.slug);
  } catch (err) {
    await failJob(env, jobId, videoId, 'global_claude', err.message);
    return;
  }

  // Update job step
  await kvPut(env, `job:${jobId}`, JSON.stringify({
    status: 'processing', videoId, step: 'regional'
  }), { expirationTtl: 86400 });

  // ── STEP 5: Claude Call 2 — Regional article ─────────────────────────────
  let regionalArticle;
  try {
    regionalArticle = await callClaude(
      transcript, youtubeUrl, env.ANTHROPIC_API_KEY,
      selectedLinkedin, selectedDiscord, selectedX,
      regionName, globalArticle.slug, existingSlug
    );
    console.log('[FFX] Regional article done, region:', regionName);
  } catch (err) {
    await failJob(env, jobId, videoId, 'regional_claude', err.message);
    return;
  }

  // Increment region cycle AFTER both calls succeed
  try {
    await env.FFX_KV.put('config:regionCycle', String((regionIndex + 1) % 4));
  } catch {}

  // Update job step
  await kvPut(env, `job:${jobId}`, JSON.stringify({
    status: 'processing', videoId, step: 'library'
  }), { expirationTtl: 86400 });

  // ── STEP 6: Claude Call 3 — Library extraction ───────────────────────────
  let libraryItems = [];
  try {
    libraryItems = await extractLibrary(transcript, youtubeUrl, globalArticle.title, videoId, env.ANTHROPIC_API_KEY);
    console.log('[FFX] Library extracted, items:', libraryItems.length);
  } catch (err) {
    // Library extraction failure is non-fatal — log and continue
    console.error('[FFX] Library extraction failed (non-fatal):', err.message);
  }

  // ── STEP 7: Write library items to KV — PERMANENT, no TTL ────────────────
  for (let i = 0; i < libraryItems.length; i++) {
    const item = libraryItems[i];
    const key = `library:${videoId}:${item.category}:${i}`;
    try {
      await env.FFX_KV.put(key, JSON.stringify({
        ...item,
        videoId,
        youtubeUrl,
        videoTitle: globalArticle.title,
        createdAt: new Date().toISOString(),
        platforms: [],
        usedAt: null,
      }));
      // No expirationTtl — permanent
    } catch (err) {
      console.error('[FFX] Library KV write failed for item', i, ':', err.message);
    }
  }

  // ── STEP 8: Write full video content to KV — 24hr TTL ───────────────────
  const videoRecord = {
    videoId,
    youtubeUrl,
    slug: globalArticle.slug,
    title: globalArticle.title,
    generatedAt: new Date().toISOString(),
    region: regionName,
    platforms: {
      blog_global:  { status: 'generated', content: globalArticle,   updatedAt: new Date().toISOString() },
      blog_regional:{ status: 'generated', content: regionalArticle, updatedAt: new Date().toISOString() },
      x:            { status: 'generated', content: { tweets: [globalArticle.tweet1, globalArticle.tweet2, globalArticle.tweet3, globalArticle.tweet4, globalArticle.tweet5, globalArticle.tweet6].filter(Boolean) }, updatedAt: new Date().toISOString() },
      linkedin:     { status: 'generated', content: { text: globalArticle.linkedin }, updatedAt: new Date().toISOString() },
      discord:      { status: 'generated', content: { text: globalArticle.discord },  updatedAt: new Date().toISOString() },
      tumblr:       { status: 'generated', content: { text: globalArticle.tumblr },   updatedAt: new Date().toISOString() },
    }
  };

  try {
    await kvPut(env, `video:${videoId}`, JSON.stringify(videoRecord), { expirationTtl: 86400 });
    console.log('[FFX] video: KV written with 24hr TTL');
  } catch (err) {
    await failJob(env, jobId, videoId, 'kv_write', err.message);
    return;
  }

  // ── STEP 9: Complete the job ──────────────────────────────────────────────
  await kvPut(env, `job:${jobId}`, JSON.stringify({
    status: 'complete',
    videoId,
    generatedAt: new Date().toISOString(),
  }), { expirationTtl: 86400 });

  // Release generating lock
  try { await env.FFX_KV.delete('lock:generating'); } catch {}

  console.log('[FFX] Job complete:', jobId);
}

// ─────────────────────────────────────────────────────────────────────────────
// FAIL JOB — writes error state, releases lock, sends notification
// ─────────────────────────────────────────────────────────────────────────────

async function failJob(env, jobId, videoId, step, reason) {
  console.error('[FFX] Job failed at step:', step, '—', reason);
  try {
    await kvPut(env, `job:${jobId}`, JSON.stringify({
      status: 'error', videoId, step, reason,
      failedAt: new Date().toISOString(),
    }), { expirationTtl: 86400 });
  } catch {}
  try { await env.FFX_KV.delete('lock:generating'); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// KV HELPER — wraps put with error logging
// ─────────────────────────────────────────────────────────────────────────────

async function kvPut(env, key, value, options = {}) {
  await env.FFX_KV.put(key, value, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPADATA TRANSCRIPT FETCH — carried forward exactly from generate.js
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT VIDEO ID — carried forward exactly from generate.js
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

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE CALL — Global or Regional article
// Carried forward from generate.js with region injection added
// ─────────────────────────────────────────────────────────────────────────────

async function callClaude(transcript, youtubeUrl, apiKey, linkedinFormat, discordFormat, xFormat, region, globalSlug, existingSlug) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const isRegional = region !== 'Global';
  const regionInstruction = isRegional ? `

REGIONAL TARGETING — THIS ARTICLE IS FOR: ${region}
This is the regional variant of the Global article (slug: ${globalSlug}).
Adjust examples, references, market session timing, and cultural context specifically for ${region} traders.
The slug must be different from the global slug — append the region: e.g. if global slug is "trading-london-session" then regional slug is "trading-london-session-gcc" or "trading-london-session-us-canada".
All platform content (LinkedIn, Discord, X, Tumblr) should also reflect the ${region} audience perspective where relevant.
Keep the core trading insight identical — only the framing, examples, and cultural context should shift.` : '';

  const systemPrompt = `You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick™ mechanical entry system (5 entry models, 2-candle philosophy).

CRITICAL RULES — APPLY TO EVERY PLATFORM VARIANT — READ BEFORE GENERATING ANYTHING:

THIS RUN'S FORMATS (non-negotiable — follow exactly):
- LinkedIn format: ${linkedinFormat}
- Discord format: ${discordFormat}
- X format: ${xFormat}
- Article region: ${region}${regionInstruction}

ABSOLUTELY BANNED OPENING WORDS — NEVER start any LinkedIn, Discord, X, or Tumblr post with:
- "Most traders" or any variation (Most traders think / Most traders fail / Most traders don't)
- "The reality is"
- "One thing I've learned"
- "The market doesn't care"
- "This is why"
- "People think trading is"
- "A lot of traders"
- "If you're struggling with"
- "Here's the truth"
- "Trading is not about"
- "In the world of trading"
- "Trading is"
- "Many traders"
- "Many people"
Violating this rule means the output is wrong. Use a completely different opening every single time.

TRADEMARK RULE — MANDATORY:
FortitudeFX™, Catch the Wick™, and 2 Candle. 1 Story.™ must always include the ™ symbol on first use in any platform content.

VARIETY IS MANDATORY — every platform post must feel different in tone, length, pacing, and structure from a typical AI-generated trading post. Some posts are short. Some are blunt. Some open with a question. Some open mid-thought. Vary everything.

You will receive a YouTube video transcript. Generate a full content package and return it as a single valid JSON object with exactly these keys. No markdown, no preamble, no explanation — only the raw JSON object.

slug
URL-safe lowercase hyphenated string, 3-6 words, no stopwords, describes the core topic.${isRegional ? ' Append region suffix as described above.' : ''}

title
SEO title 50-60 characters, includes primary keyword.${isRegional ? ` Include region context naturally e.g. "...for ${region} Traders".` : ''}

excerpt
Max 160 characters, compelling meta description.

category
Exactly one of: Strategy, Psychology, Risk Management, Market Analysis, Fundamentals

tags
Comma-separated string of 4-6 relevant tags.

readTime
String like "7 min read".

body
Full 2000-word SEO article as valid HTML. Use <h2> and <h3> tags. Include internal links using <a href="https://fortitudefx.com/PATH"> throughout — link to /bootcamp, /vipdiscord, /blog where contextually appropriate. End with a CTA paragraph inviting readers to join the free Discord at https://discord.gg/fortitudefx. Maximum 1 exclamation mark in the entire body.${isRegional ? ` Frame examples and context specifically for ${region} traders — market session times, relevant currency pairs, regional trading habits.` : ''}

linkedin
FORMAT THIS RUN: ${linkedinFormat}. Length is determined by format — WALL: 350-500 words / SHORT: 80-150 words / SINGLE: 60-100 words / STORY: 200-350 words / CONTRARIAN: 150-300 words. Do not exceed the upper limit for the selected format. HARD CEILING: 500 words absolute maximum for any format. No exceptions.
BANNED OPENINGS: See CRITICAL RULES above. Never start with any banned hook.

You are writing a LinkedIn post for the founder of FortitudeFX™ — a premium forex trading education brand focused on discipline, liquidity, execution quality, market psychology, and the Catch The Wick™ framework.

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
- drive curiosity toward FortitudeFX™
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

ANGLE FOR THIS RUN — take the founder/operator perspective from the transcript. What would a professional who has seen this pattern a hundred times say about it. Not the tutorial angle — the been-there angle.

CORE STRUCTURE:
1. Hook (1–3 lines): A thoughtful observation, market insight, psychological truth, contrarian realization, or something that creates curiosity naturally without clickbait.
2. Insight / Main Body: Deliver real educational or strategic value. Discuss trader psychology, execution, discipline, liquidity behavior, risk management, emotional control, business building, consistency, lessons from experience, or misconceptions in trading culture. Should feel useful even if the reader never buys anything.
3. Perspective Shift: Introduce a deeper realization. Something most traders misunderstand. Reframe how readers think about trading, patience, execution, consistency, or learning.
4. Soft Continuation CTA: Must feel natural and low-pressure. Never sound like an advertisement.

CONTENT GOALS:
- Build credibility
- Build trust slowly
- Encourage engagement naturally
- Position FortitudeFX™ as premium and thoughtful
- Attract serious traders rather than mass-market retail audiences

SOFT POSITIONING RULES:
You may naturally reference YouTube videos, FortitudeFX™ articles, lessons from the community, mention FortitudeFX™ subtly, imply deeper educational resources exist.
But NEVER hard sell, use pressure tactics, overuse CTAs, sound like a sales funnel, or push VIP aggressively.

ALWAYS INCLUDE AT THE END — these three links, every single post, no exceptions:
📖 Full breakdown: [ARTICLE_URL]
🌐 https://fortitudefx.com

OUTPUT: Generate the main LinkedIn post only. No hashtags in the body. Add 3-5 relevant hashtags at the very end only.

FINAL REQUIREMENT: The final result must feel authentic enough that professionals and traders genuinely believe: "This founder wrote this himself."

x_thread
FORMAT THIS RUN: ${xFormat}. Tweet count by format — THREAD: exactly 6 tweets / SINGLE: exactly 1 tweet, max 280 characters / MINI: exactly 3 tweets / HOTTAKE: exactly 4 tweets. Return a JSON array with exactly that many strings — no more, no less.
BANNED OPENINGS: See CRITICAL RULES above. Never start tweet 1 with any banned hook.

You are writing an X (Twitter) thread for FortitudeFX™ — a premium forex trading education brand focused on discipline, liquidity, execution quality, market psychology, and the Catch The Wick™ framework.

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
- drive traffic toward: FortitudeFX™ website, YouTube channel, educational articles
- attract serious traders over time
- subtly position FortitudeFX™ as premium and different from typical retail trading brands

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

FORMAT FOR THIS RUN — follow exactly:
- THREAD: Full 6-tweet thread. Hook → education (posts 2-5) → CTA (post 6).
- SINGLE: One tweet only. Return a JSON array with exactly 1 string. Max 280 characters.
- MINI: 3-tweet thread only. Return a JSON array with exactly 3 strings.
- HOTTAKE: 4-tweet thread. Return a JSON array with exactly 4 strings.

THREAD STRUCTURE — Generate a JSON array of exactly 6 strings (or fewer if SINGLE/MINI/HOTTAKE):

POST 1: Hook — no links, no CTA, pure attention.
POSTS 2-3: Educational value — each must end with https://fortitudefx.com
POST 4: Educational value — must end with https://fortitudefx.com/vipdiscord
POST 5: Perspective shift — must end with https://fortitudefx.com/bootcamp
POST 6: Soft CTA — include [ARTICLE_URL], ${youtubeUrl}, https://fortitudefx.com

WRITING STYLE: Concise, intelligent, high signal, slightly opinionated, mobile friendly.

FINAL REQUIREMENT: Must feel written by the founder manually.

discord
WORD LIMIT: Maximum 200 words for the body content. Do not exceed this under any circumstances.
FORMAT THIS RUN: ${discordFormat}
BANNED OPENINGS: See CRITICAL RULES above.

You are writing a Discord community post for FortitudeFX™.
The writing must feel HUMAN, experienced, intelligent, calm, and conversational.

FORMAT AND LENGTH:
- NUGGET: 40-80 words body. One tight concept. Ends with a direct question.
- DROP: 100-200 words body. Insight + context + one reframe.
- QUESTION: 80-150 words body. Opens with a question that reframes thinking.

CORE STRUCTURE:
1. Hook (1-2 lines)
2. Insight + Perspective Shift
3. Links section (always):
   Full breakdown 👉 [ARTICLE_URL]
   Watch the video: ${youtubeUrl}
   [Engagement hook — genuine question related to the topic]
   https://fortitudefx.com

FINAL REQUIREMENT: Must feel written by an experienced trader manually. Use 6-10 emojis naturally.

tumblr
LENGTH: 300-600 words. Do not exceed 600 words.
BANNED OPENINGS: See CRITICAL RULES above.

Thoughtful, reflective, intelligent Tumblr post for FortitudeFX™.
Tone: experienced trader sharing perspective. Journal-style insight with depth.
Not corporate, not motivational, not aggressive marketing.

ALWAYS INCLUDE AT THE END:
📖 Full breakdown: [ARTICLE_URL]
▶️ Watch the video: ${youtubeUrl}
🌐 https://fortitudefx.com

FORMAT: Plain text only. No HTML. Paragraphs separated by blank lines only.

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
      messages: [{
        role: 'user',
        content: `Here is the transcript:\n\n${transcript}\n\nVOICE INSTRUCTION: This transcript is Salman speaking — the founder of FortitudeFX™. Before writing anything, study how he naturally speaks: his sentence rhythm, his directness, the specific words and phrases he chooses, how he builds and frames trading concepts, his personality and level of formality. Write ALL platform variants (LinkedIn, Discord, X, Tumblr) AND the article body in his voice as demonstrated in this transcript — not in a generic trading educator voice. The reader should feel this content was written by the same person who recorded this video.${isRegional ? `\n\nREGIONAL NOTE: This is the ${region} variant. Frame examples, session times, and cultural context for ${region} traders specifically.` : ''}`
      }],
    }),
  });

  console.log('[FFX] Claude status:', res.status, 'region:', region);

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
    throw new Error('Claude returned invalid JSON. First 2000 chars: ' + cleaned.slice(0, 2000));
  }

  const required = ['slug', 'title', 'excerpt', 'category', 'tags', 'readTime', 'body', 'linkedin', 'x_thread', 'discord', 'tumblr', 'mediumIntro'];
  for (const key of required) {
    if (!parsed[key]) throw new Error(`Missing key: "${key}" in ${region} article`);
  }

  // Map x_thread to tweet1-tweet6
  if (Array.isArray(parsed.x_thread)) {
    parsed.x_thread.forEach((t, i) => { parsed[`tweet${i + 1}`] = t; });
  }

  // Lock slug if existingSlug provided (for regeneration of already-published video)
  if (existingSlug && existingSlug.trim() && region === 'Global') {
    parsed.slug = existingSlug;
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

  console.log('[FFX] Claude complete, slug:', parsed.slug, 'region:', region);
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIBRARY EXTRACTION — Claude Call 3
// Extracts high-quality reusable community content items from transcript
// ─────────────────────────────────────────────────────────────────────────────

async function extractLibrary(transcript, youtubeUrl, videoTitle, videoId, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = `You are extracting high-quality reusable community content from a FortitudeFX™ YouTube transcript.

EXTRACTION STANDARD — MANDATORY:
Only extract an item if it passes ALL THREE tests:
1. Would an experienced trader stop scrolling to read this?
2. Does it add something the FFX community cannot get from generic trading content anywhere else?
3. Is it specific enough to spark a real discussion — not a nod and scroll past?

If it does not pass all three — do not extract it. Quality over quantity. A video might yield 15 items or 6. Never pad with filler to hit a number.

CATEGORIES (assign exactly one per item):
- Psychology — revenge trading, hesitation, overanalysis, fear, emotional attachment, certainty addiction, boredom trading, euphoria, social media comparison
- Execution — waiting for confirmation, not forcing setups, respecting invalidation, accepting missed trades, patience, no-trade days, entry precision, exit discipline
- CTW Framework — liquidity sweeps, HTF candle narrative, candle 2, manipulation vs continuation, fractal behaviour, session timing, inducement, wick anatomy
- Risk Management — position sizing, drawdown psychology, risk per trade, protecting capital, consistency over excitement, when to stop trading
- Market Structure — liquidity pools, key levels, order flow, session behaviour, London vs NY, Asian range, sweep and reverse, institutional vs retail
- Entries — entry triggers, confirmation signals, precision vs early entry, avoiding fakeouts, timeframe alignment
- Professional Mindset — probabilities vs certainty, process over outcome, institutional patience, emotional neutrality, thinking in sample sizes
- Life and Identity — discipline in daily life, delayed gratification, routine building, gym vs trading parallels, emotional control under pressure
- Work Life Balance — trading hours vs life, avoiding screen addiction, knowing when to walk away, trading as a business
- Mental Health — anxiety around trades, depression after drawdowns, isolation, burnout recognition, separating self-worth from P&L
- Community — learning in public, sharing losses, peer accountability, avoiding echo chambers
- Fundamentals — why fundamentals matter for price action traders, news as catalyst, economic calendar, central bank behaviour
- Beginner Mistakes — over-leveraging, chasing price, ignoring HTF, no trading plan, revenge after first loss

FORMATS (assign exactly one per item):
- question — opens with a question that reframes thinking, builds curiosity, drops insight at end
- insight — short tight concept, drops straight into value, no padding
- contrarian — challenges a common trading belief, backs it up
- story — personal observation or pattern noticed over years, feels human
- chart_game — a question about a chart concept, setup, or market behaviour that invites community to think and respond

BRAND VOICE — MANDATORY:
- Calm, intelligent, reflective, slightly contrarian, institutional tone
- Never motivational guru energy
- Never crypto-bro energy
- Never generic trading Twitter noise
- Never start with "Most traders"
- Sound like an experienced trader sharing perspective naturally
- 50-180 words per item

Return a JSON array of objects. Each object has exactly these keys:
{
  "category": "Psychology",
  "format": "contrarian",
  "content": "The full post content here...",
  "hook": "The opening line only — used for preview",
  "tags": ["psychology", "consistency", "process"]
}

Return ONLY the raw JSON array. No markdown, no preamble, no explanation.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Video title: ${videoTitle}\nYouTube URL: ${youtubeUrl}\n\nTranscript:\n\n${transcript}\n\nExtract 10-15 high-quality community content items from this transcript. Apply the three-test quality filter strictly. Return only items that would genuinely stop an experienced trader scrolling. Voice instruction: This is Salman speaking — the founder of FortitudeFX™. Write in his voice — calm, direct, experienced, slightly contrarian. Never generic.`
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic library extraction ${res.status}: ${err}`);
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
    throw new Error('Library extraction returned invalid JSON');
  }

  if (!Array.isArray(parsed)) throw new Error('Library extraction did not return array');
  return parsed.filter(item => item.category && item.format && item.content);
}
