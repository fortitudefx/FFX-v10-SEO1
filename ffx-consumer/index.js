// ─────────────────────────────────────────────────────────────────────────────
// FFX Consumer Worker — Queue consumer
// 4 Claude calls: Global Article, Global Platforms, Regional Article, Regional Platforms
// Each call under 45 seconds — well within Cloudflare's 100s outbound fetch timeout
// Full error handling — all failures written to KV with human-readable messages
// ─────────────────────────────────────────────────────────────────────────────



export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processJob(message.body, env);
        message.ack();
      } catch (err) {
        console.error('[FFX] Unhandled crash:', err.message);
        try { await env.FFX_KV.delete('lock:generating'); } catch {}
        try {
          await env.FFX_KV.put(
            `job:${message.body.jobId}`,
            JSON.stringify({
              status: 'error',
              videoId: message.body.videoId,
              step: 'unknown',
              reason: `Unhandled crash: ${err.message}`,
              retryable: true,
              failedAt: new Date().toISOString(),
            }),
            { expirationTtl: 86400 }
          );
        } catch {}
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

  // Write generating lock immediately
  await kvPut(env, 'lock:generating', JSON.stringify({
    jobId, videoId, startedAt: new Date().toISOString()
  }), { expirationTtl: 1800 });

  await updateJob(env, jobId, videoId, 'processing', 'transcript');

  // ── STEP 1: Fetch transcript ──────────────────────────────────────────────
  let transcript;
  try {
    transcript = await fetchTranscriptSupadata(youtubeUrl, env.SUPADATA_API_KEY);
    console.log('[FFX] Transcript fetched, length:', transcript?.length);
  } catch (err) {
    await failJob(env, jobId, videoId, 'transcript',
      `Transcript fetch failed: ${err.message}. Ensure captions are enabled on this video in YouTube Studio.`,
      false);
    return;
  }

  if (!transcript || transcript.trim().length < 100) {
    await failJob(env, jobId, videoId, 'transcript',
      'Transcript too short or empty. Enable captions in YouTube Studio and try again.',
      false);
    return;
  }

  // ── STEP 1b: Store transcript permanently ────────────────────────────────
  try {
    await env.FFX_KV.put(`transcript:${videoId}`, transcript);
    console.log('[FFX] Transcript stored permanently — transcript:', videoId);
  } catch (err) {
    console.error('[FFX] Transcript KV write failed (non-fatal):', err.message);
  }

  // ── STEP 2: Select random formats ────────────────────────────────────────
  const linkedinFormats = ['WALL', 'SHORT', 'SINGLE', 'STORY', 'CONTRARIAN'];
  const discordFormats  = ['NUGGET', 'DROP', 'QUESTION'];
  const xFormats        = ['THREAD', 'SINGLE', 'MINI', 'HOTTAKE'];
  const selectedLinkedin = linkedinFormats[Math.floor(Math.random() * linkedinFormats.length)];
  const selectedDiscord  = discordFormats[Math.floor(Math.random() * discordFormats.length)];
  const selectedX        = xFormats[Math.floor(Math.random() * xFormats.length)];
  console.log('[FFX] Formats — LinkedIn:', selectedLinkedin, 'Discord:', selectedDiscord, 'X:', selectedX);

  // ── STEP 3: Get region ────────────────────────────────────────────────────
  const regions = ['GCC', 'US/Canada', 'EU/UK/Germany', 'SEA/Asia'];
  let regionIndex = 0;
  try {
    const stored = await env.FFX_KV.get('config:regionCycle');
    regionIndex = stored !== null ? parseInt(stored, 10) % 4 : 0;
  } catch {}
  const regionName = regions[regionIndex];
  console.log('[FFX] Region:', regionName, '(index', regionIndex, ')');

  // ── STEP 4: Global Article ────────────────────────────────────────────────
  await updateJob(env, jobId, videoId, 'processing', 'global_article');
  let globalArticle;
  try {
    globalArticle = await callClaudeArticle(
      transcript, youtubeUrl, env.ANTHROPIC_API_KEY, 'Global', null, existingSlug
    );
    console.log('[FFX] Global article done, slug:', globalArticle.slug);
  } catch (err) {
    await failJob(env, jobId, videoId, 'global_article',
      formatClaudeError(err, 'Global article'), true);
    return;
  }

  // ── STEP 5: Global Platforms ──────────────────────────────────────────────
  await updateJob(env, jobId, videoId, 'processing', 'global_platforms');
  let globalPlatforms;
  try {
    globalPlatforms = await callClaudePlatforms(
      transcript, youtubeUrl, env.ANTHROPIC_API_KEY,
      selectedLinkedin, selectedDiscord, selectedX,
      'Global', globalArticle.slug
    );
    console.log('[FFX] Global platforms done');
  } catch (err) {
    await failJob(env, jobId, videoId, 'global_platforms',
      formatClaudeError(err, 'Global platforms'), true);
    return;
  }

  const globalContent = { ...globalArticle, ...globalPlatforms, region: 'Global', regionLabel: 'Global', videoId, youtubeUrl };

  // ── STEP 6: Regional Article ──────────────────────────────────────────────
  await updateJob(env, jobId, videoId, 'processing', 'regional_article');
  let regionalArticle;
  try {
    regionalArticle = await callClaudeArticle(
      transcript, youtubeUrl, env.ANTHROPIC_API_KEY, regionName, globalArticle.slug, existingSlug
    );
    console.log('[FFX] Regional article done, region:', regionName);
  } catch (err) {
    await failJob(env, jobId, videoId, 'regional_article',
      formatClaudeError(err, `Regional article (${regionName})`), true);
    return;
  }

  // ── STEP 7: Regional Platforms ────────────────────────────────────────────
  await updateJob(env, jobId, videoId, 'processing', 'regional_platforms');
  let regionalPlatforms;
  try {
    regionalPlatforms = await callClaudePlatforms(
      transcript, youtubeUrl, env.ANTHROPIC_API_KEY,
      selectedLinkedin, selectedDiscord, selectedX,
      regionName, regionalArticle.slug
    );
    console.log('[FFX] Regional platforms done');
  } catch (err) {
    await failJob(env, jobId, videoId, 'regional_platforms',
      formatClaudeError(err, `Regional platforms (${regionName})`), true);
    return;
  }

  const regionalContent = { ...regionalArticle, ...regionalPlatforms, region: regionName, regionLabel: regionName, videoId, youtubeUrl };

  // Increment region cycle
  try { await env.FFX_KV.put('config:regionCycle', String((regionIndex + 1) % 4)); } catch {}

  // ── STEP 8: Library extraction (non-fatal) ────────────────────────────────
  await updateJob(env, jobId, videoId, 'processing', 'library');
  let libraryItems = [];
  try {
    libraryItems = await extractLibrary(transcript, youtubeUrl, globalArticle.title, videoId, env.ANTHROPIC_API_KEY);
    console.log('[FFX] Library extracted, items:', libraryItems.length);
  } catch (err) {
    console.error('[FFX] Library extraction failed (non-fatal):', err.message);
  }

  // Write nuggets permanently — nugget:{id} + nuggets:index
  if (libraryItems.length > 0) {
    try {
      const indexRaw = await env.FFX_KV.get('nuggets:index');
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const now = new Date().toISOString();

      for (let i = 0; i < libraryItems.length; i++) {
        const item = libraryItems[i];
        try {
          const nuggetId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`;
          const nugget = {
            id:            nuggetId,
            text:          item.content,
            category:      item.category,
            tags:          Array.isArray(item.tags) ? item.tags : [],
            hook:          item.hook || null,
            format:        item.format || null,
            sourceVideoId: videoId,
            sourceTitle:   globalArticle.title,
            youtubeUrl,
            publishedTo:   {},
            createdAt:     now,
            updatedAt:     now,
          };
          await env.FFX_KV.put(`nugget:${nuggetId}`, JSON.stringify(nugget));
          index.unshift(nuggetId);
          console.log('[FFX] Nugget written:', nuggetId);
        } catch (err) {
          console.error('[FFX] Nugget write failed:', i, err.message);
        }
      }

      await env.FFX_KV.put('nuggets:index', JSON.stringify(index));
      console.log('[FFX] nuggets:index updated, total:', index.length);
    } catch (err) {
      console.error('[FFX] Nuggets index update failed (non-fatal):', err.message);
    }
  }

  // ── STEP 9: Write video record to KV — 24hr TTL ───────────────────────────
  const videoRecord = {
    videoId,
    youtubeUrl,
    slug: globalContent.slug,
    title: globalContent.title,
    generatedAt: new Date().toISOString(),
    region: regionName,
    platforms: {
      blog_global:   { status: 'generated', content: globalContent,   updatedAt: new Date().toISOString() },
      blog_regional: { status: 'generated', content: regionalContent, updatedAt: new Date().toISOString() },
      x:             { status: 'generated', content: { tweets: [globalContent.tweet1, globalContent.tweet2, globalContent.tweet3, globalContent.tweet4, globalContent.tweet5, globalContent.tweet6].filter(Boolean) }, updatedAt: new Date().toISOString() },
      linkedin:      { status: 'generated', content: { text: globalContent.linkedin }, updatedAt: new Date().toISOString() },
      discord:       { status: 'generated', content: { text: globalContent.discord },  updatedAt: new Date().toISOString() },
      tumblr:        { status: 'generated', content: { text: globalContent.tumblr },   updatedAt: new Date().toISOString() },
    }
  };

  try {
    await kvPut(env, `video:${videoId}`, JSON.stringify(videoRecord), { expirationTtl: 86400 });
    console.log('[FFX] Video record written to KV');
  } catch (err) {
    await failJob(env, jobId, videoId, 'kv_write',
      `Storage write failed: ${err.message}. Please retry.`, true);
    return;
  }

  // ── STEP 10: Complete ─────────────────────────────────────────────────────
  await kvPut(env, `job:${jobId}`, JSON.stringify({
    status: 'complete',
    videoId,
    generatedAt: new Date().toISOString(),
  }), { expirationTtl: 86400 });

  try { await env.FFX_KV.delete('lock:generating'); } catch {}
  console.log('[FFX] Job complete:', jobId);

  // ── STEP 11: Send email — non-fatal, generation already complete ──────────
  try {
    await sendCompletionEmail(env, youtubeUrl, videoId, globalContent.title);
    console.log('[FFX] Completion email sent');
  } catch (err) {
    console.error('[FFX] Completion email failed (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND COMPLETION EMAIL via Brevo
// Called only after video:{videoId} is written to KV — content guaranteed ready
// Press link uses ?video=videoId — loads directly from KV, no polling needed
// ─────────────────────────────────────────────────────────────────────────────

async function sendCompletionEmail(env, youtubeUrl, videoId, videoTitle) {
  if (!env.BREVO_API_KEY) throw new Error('BREVO_API_KEY not set on consumer Worker');
  if (!env.APPROVAL_EMAIL) throw new Error('APPROVAL_EMAIL not set on consumer Worker');

  const pressLink = `https://fortitudefx.com/dashboard-queue.html?video=${videoId}`;
  const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

  const expiry = new Date(Date.now() + 86400000);
  const expiryStr = expiry.toLocaleString('en-GB', {
    timeZone: 'Asia/Dubai',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  const emailHtml = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#0c0c0c;color:#e8e8e8;padding:40px 32px;border-radius:8px;">

  <div style="font-family:'Courier New',monospace;font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#787878;margin-bottom:24px;">FortitudeFX™ — Internal</div>

  <h1 style="font-size:22px;font-weight:700;color:#ffffff;margin:0 0 8px;letter-spacing:-0.02em;">Content Ready for Review</h1>
  <p style="font-size:14px;color:#b8b8b8;margin:0 0 24px;line-height:1.6;">Global + Regional articles generated. All platforms ready. Open Press to review and publish.</p>

  <a href="${youtubeUrl}" style="display:block;margin-bottom:24px;border-radius:8px;overflow:hidden;text-decoration:none;">
    <img src="${thumbnailUrl}" alt="${videoTitle || 'Video thumbnail'}" style="width:100%;display:block;border-radius:8px;" />
  </a>

  <p style="font-size:15px;font-weight:600;color:#ffffff;margin:0 0 24px;">${videoTitle || ''}</p>

  <a href="${pressLink}" style="display:block;background:#ffffff;color:#000000;text-align:center;padding:16px 24px;border-radius:6px;font-size:15px;font-weight:700;text-decoration:none;margin-bottom:24px;">Review &amp; Publish in FFX Press →</a>

  <p style="font-family:'Courier New',monospace;font-size:11px;color:#484848;word-break:break-all;margin:0 0 8px;">${pressLink}</p>
  <p style="font-size:12px;color:#484848;margin:0;">Expires: ${expiryStr}</p>

</div>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: 'FortitudeFX™', email: 'salmankhanfx@fortitudefx.com' },
      to: [{ email: env.APPROVAL_EMAIL }],
      replyTo: { email: 'support@fortitudefx.com' },
      subject: `FFX — Content Ready · Expires ${expiryStr}`,
      htmlContent: emailHtml,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo ${res.status}: ${err}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT CLAUDE ERROR — human readable, no Cloudflare logs needed
// ─────────────────────────────────────────────────────────────────────────────

function formatClaudeError(err, step) {
  const msg = err.message || '';
  if (msg.includes('524')) return `${step}: Anthropic took too long to respond (timeout). Click Retry — this usually resolves itself.`;
  if (msg.includes('529')) return `${step}: Anthropic is overloaded right now. Wait 2 minutes and click Retry.`;
  if (msg.includes('401')) return `${step}: Anthropic API key is invalid. Check ANTHROPIC_API_KEY in Worker settings.`;
  if (msg.includes('429')) return `${step}: Anthropic rate limit hit. Wait 1 minute and click Retry.`;
  if (msg.includes('invalid JSON') || msg.includes('Missing field')) return `${step}: Claude returned an incomplete response. Click Retry.`;
  return `${step}: ${msg}. Click Retry.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE JOB STATUS — writes step to KV so browser polling can show progress
// ─────────────────────────────────────────────────────────────────────────────

async function updateJob(env, jobId, videoId, status, step) {
  try {
    await kvPut(env, `job:${jobId}`, JSON.stringify({ status, videoId, step }), { expirationTtl: 86400 });
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// FAIL JOB — writes human-readable error, releases lock
// ─────────────────────────────────────────────────────────────────────────────

async function failJob(env, jobId, videoId, step, reason, retryable) {
  console.error('[FFX] Job failed at step:', step, '—', reason);
  try {
    await kvPut(env, `job:${jobId}`, JSON.stringify({
      status: 'error', videoId, step, reason, retryable,
      failedAt: new Date().toISOString(),
    }), { expirationTtl: 86400 });
  } catch {}
  try { await env.FFX_KV.delete('lock:generating'); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// KV HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function kvPut(env, key, value, options = {}) {
  await env.FFX_KV.put(key, value, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPADATA TRANSCRIPT FETCH
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
// EXTRACT VIDEO ID
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
// CLAUDE CALL — ARTICLE ONLY
// Returns: slug, title, excerpt, category, tags, readTime, body
// Max tokens: 3500 — expected time 30-45 seconds — well within 100s timeout
// ─────────────────────────────────────────────────────────────────────────────

async function callClaudeArticle(transcript, youtubeUrl, apiKey, region, globalSlug, existingSlug) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const isRegional = region !== 'Global';
  const regionInstruction = isRegional ? `
REGIONAL TARGETING — THIS ARTICLE IS FOR: ${region}
This is the regional variant. The global slug is: ${globalSlug}.
Append the region to the slug: e.g. "trading-london-session-gcc" or "trading-london-session-us-canada".
Frame examples, market session times, currency pairs, and cultural context specifically for ${region} traders.
Keep the core trading insight identical — only framing and examples shift.` : '';

  const systemPrompt = `You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick™ mechanical entry system.

TRADEMARK RULE: FortitudeFX™, Catch the Wick™, and 2 Candle. 1 Story.™ must always include the ™ symbol on first use.

Article region: ${region}${regionInstruction}

Generate ONLY the blog article fields. Return a single valid JSON object with exactly these keys and no others:

{
  "slug": "url-safe-lowercase-hyphenated-3-to-6-words",
  "title": "SEO title 50-60 characters including primary keyword${isRegional ? ` naturally referencing ${region} traders` : ''}",
  "excerpt": "compelling meta description max 160 characters",
  "category": "exactly one of: Strategy, Psychology, Risk Management, Market Analysis, Fundamentals",
  "tags": "comma-separated 4-6 relevant tags",
  "readTime": "7 min read",
  "body": "full 2000-word SEO article as valid HTML using h2 and h3 tags. Include internal links to /bootcamp /vipdiscord /blog. End with CTA to join free Discord at https://discord.gg/fortitudefx. Maximum 1 exclamation mark.${isRegional ? ` Frame for ${region} traders.` : ''}"
}

CRITICAL: Return ONLY the raw JSON object. No markdown. No code fences. No preamble. No explanation. Start your response with { and end with }.
The body field contains HTML — ensure all quotes inside HTML attributes use single quotes to avoid breaking JSON string parsing.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 3500,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Transcript:\n\n${transcript}\n\nVOICE: This is Salman speaking — founder of FortitudeFX™. Write in his voice — direct, calm, experienced, institutional tone. Study his sentence rhythm and phrasing from the transcript before writing.${isRegional ? `\n\nREGIONAL: Write the ${region} variant.` : ''}` }],
    }),
  });

  console.log('[FFX] Claude article status:', res.status, 'region:', region);
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const rawText = data.content[0].text.trim();
  const firstBrace = rawText.indexOf('{');
  const lastBrace = rawText.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON object found in Claude article response');
  const cleaned = rawText.slice(firstBrace, lastBrace + 1);

  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) {
    throw new Error('Claude article returned invalid JSON: ' + e.message);
  }

  const required = ['slug', 'title', 'excerpt', 'category', 'tags', 'readTime', 'body'];
  for (const key of required) {
    if (!parsed[key]) throw new Error(`Missing field: "${key}" in ${region} article`);
  }

  if (existingSlug && existingSlug.trim() && region === 'Global') {
    parsed.slug = existingSlug;
  }

  console.log('[FFX] Article complete, slug:', parsed.slug, 'region:', region);
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE CALL — PLATFORMS ONLY
// Returns: linkedin, x_thread, tweet1-6, discord, tumblr, mediumIntro
// Max tokens: 3000 — expected time 20-30 seconds — well within 100s timeout
// ─────────────────────────────────────────────────────────────────────────────

async function callClaudePlatforms(transcript, youtubeUrl, apiKey, linkedinFormat, discordFormat, xFormat, region, slug) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const articleUrl = `https://fortitudefx.com/article?slug=${slug}`;
  const isRegional = region !== 'Global';

  const systemPrompt = `You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick™ mechanical entry system.

TRADEMARK RULE: FortitudeFX™, Catch the Wick™, and 2 Candle. 1 Story.™ must always include the ™ symbol on first use.

THIS RUN'S FORMATS (follow exactly):
- LinkedIn format: ${linkedinFormat}
- Discord format: ${discordFormat}
- X format: ${xFormat}
- Region: ${region}

ABSOLUTELY BANNED OPENING WORDS — NEVER start any post with:
- "Most traders" or any variation
- "The reality is" / "One thing I've learned" / "The market doesn't care"
- "This is why" / "Here's the truth" / "Trading is" / "Many traders" / "Many people"

ARTICLE URL for this content: ${articleUrl}
YOUTUBE URL: ${youtubeUrl}

Generate ONLY the platform content fields. Return a single valid JSON object with exactly these keys:

{
  "linkedin": "LinkedIn post — FORMAT: ${linkedinFormat}. WALL: 350-500w / SHORT: 80-150w / SINGLE: 60-100w / STORY: 200-350w / CONTRARIAN: 150-300w. Human, intelligent, calm authority. Founder perspective. End with: 📖 Full breakdown: ${articleUrl}\\n🌐 https://fortitudefx.com\\n\\nAdd 3-5 hashtags at end only.",
  "x_thread": ["tweet 1", "tweet 2", "tweet 3", "tweet 4", "tweet 5", "tweet 6"],
  "discord": "Discord post — FORMAT: ${discordFormat}. NUGGET: 40-80w / DROP: 100-200w / QUESTION: 80-150w. End with: Full breakdown 👉 ${articleUrl}\\nWatch: ${youtubeUrl}\\n[engagement question]\\nhttps://fortitudefx.com",
  "tumblr": "Tumblr post 300-600 words. Thoughtful, reflective. Plain text, no HTML. End with: 📖 ${articleUrl}\\n▶️ ${youtubeUrl}\\n🌐 https://fortitudefx.com",
  "mediumIntro": "150-200 word rewritten article opening. Final line: Originally published at ${articleUrl}"
}

X THREAD RULES by format:
- THREAD: exactly 6 tweets. Posts 2-3 end with https://fortitudefx.com. Post 4 ends with https://fortitudefx.com/vipdiscord. Post 5 ends with https://fortitudefx.com/bootcamp. Post 6 includes ${articleUrl} and ${youtubeUrl}.
- SINGLE: exactly 1 tweet, max 280 chars
- MINI: exactly 3 tweets
- HOTTAKE: exactly 4 tweets

CRITICAL: Return ONLY the raw JSON object. No markdown. No code fences. No preamble. Start with { end with }.
x_thread must be a JSON array of strings.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Transcript:\n\n${transcript}\n\nVOICE: This is Salman speaking — founder of FortitudeFX™. Write ALL platform content in his voice — direct, calm, experienced, slightly contrarian, institutional tone. Study his phrasing from the transcript.${isRegional ? `\n\nREGIONAL: Frame platform content for ${region} audience where relevant.` : ''}` }],
    }),
  });

  console.log('[FFX] Claude platforms status:', res.status, 'region:', region);
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const rawText = data.content[0].text.trim();
  const firstBrace = rawText.indexOf('{');
  const lastBrace = rawText.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON object found in Claude platforms response');
  const cleaned = rawText.slice(firstBrace, lastBrace + 1);

  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) {
    throw new Error('Claude platforms returned invalid JSON: ' + e.message);
  }

  const required = ['linkedin', 'x_thread', 'discord', 'tumblr', 'mediumIntro'];
  for (const key of required) {
    if (!parsed[key]) throw new Error(`Missing field: "${key}" in ${region} platforms`);
  }

  if (!Array.isArray(parsed.x_thread) || parsed.x_thread.length === 0) {
    throw new Error(`x_thread must be an array of tweets in ${region} platforms`);
  }

  // Map x_thread to tweet1-tweet6
  parsed.x_thread.forEach((t, i) => { parsed[`tweet${i + 1}`] = t; });

  console.log('[FFX] Platforms complete, region:', region);
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIBRARY EXTRACTION — Claude Call 5 (non-fatal)
// ─────────────────────────────────────────────────────────────────────────────

async function extractLibrary(transcript, youtubeUrl, videoTitle, videoId, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = `You are extracting high-quality reusable community content from a FortitudeFX™ YouTube transcript.

EXTRACTION STANDARD — MANDATORY:
Only extract an item if it passes ALL THREE tests:
1. Would an experienced trader stop scrolling to read this?
2. Does it add something the FFX community cannot get from generic trading content anywhere else?
3. Is it specific enough to spark a real discussion?

If it does not pass all three — do not extract it. Quality over quantity. Never pad with filler.

CATEGORIES (assign exactly one):
CTW Framework, Market Psychology, Execution Discipline, Professional Thinking, Trading Reality, Lifestyle & Philosophy, Founder Observation, Hook/Viral

FORMATS (assign exactly one):
question, insight, contrarian, story, chart_game

BRAND VOICE: Calm, intelligent, reflective, slightly contrarian, institutional. Never motivational guru. Never generic.

Return a JSON array of objects. Each object:
{
  "category": "Psychology",
  "format": "contrarian",
  "content": "The full post content here — 50-180 words",
  "hook": "The opening line only",
  "tags": ["tag1", "tag2", "tag3"]
}

Return ONLY the raw JSON array. Start with [ end with ].`;

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
      messages: [{ role: 'user', content: `Video: ${videoTitle}\nURL: ${youtubeUrl}\n\nTranscript:\n\n${transcript}\n\nExtract 10-15 high-quality items. Apply three-test filter strictly. Write in Salman's voice — calm, direct, experienced.` }],
    }),
  });

  if (!res.ok) throw new Error(`Library extraction ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const rawText = data.content[0].text.trim();
  const firstBracket = rawText.indexOf('[');
  const lastBracket = rawText.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1) throw new Error('No JSON array in library response');
  const cleaned = rawText.slice(firstBracket, lastBracket + 1);

  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    throw new Error('Library extraction returned invalid JSON');
  }

  if (!Array.isArray(parsed)) throw new Error('Library extraction did not return array');
  return parsed.filter(item => item.category && item.format && item.content);
}
