// ─────────────────────────────────────────────────────────────────────────────
// FFX Pipeline Worker v2
// POST /pipeline → fetch transcript → Claude → store pending → send review email
// Triggered by: trigger.html (manual) or Cron (automatic)
// Storage: GitHub pending/{jobId}.json — no KV needed
// ─────────────────────────────────────────────────────────────────────────────

const REGIONS = ['GCC', 'US/Canada', 'EU/UK/Germany', 'SEA/Asia'];
const GITHUB_OWNER  = 'fortitudefx';
const GITHUB_REPO   = 'FFX-v10-SEO1';
const GITHUB_BRANCH = 'main';

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  console.log('[FFX Pipeline] Request received');

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
    return new Response(JSON.stringify({ error: 'Could not parse YouTube video ID' }), { status: 400, headers });
  }

  console.log('[FFX Pipeline] Video ID:', videoId);

  // 1. Fetch transcript
  console.log('[FFX Pipeline] Fetching transcript');
  let transcript;
  try {
    transcript = await fetchTranscript(youtubeUrl, env.SUPADATA_API_KEY);
    console.log('[FFX Pipeline] Transcript length:', transcript.length);
  } catch (err) {
    console.log('[FFX Pipeline] Transcript failed:', err.message);
    return new Response(JSON.stringify({ error: `Transcript failed: ${err.message}` }), { status: 502, headers });
  }

  // 2. Fetch existing articles for internal linking
  let existingArticles = [];
  try {
    existingArticles = await fetchExistingArticles();
    console.log('[FFX Pipeline] Existing articles:', existingArticles.length);
  } catch (err) {
    console.log('[FFX Pipeline] articles.json fetch failed (non-fatal):', err.message);
  }

  // 3. Fetch region cycle index
  let regionCycleIndex = 0;
  try {
    const cfgRes = await fetch('https://fortitudefx.com/ffx-config.json', {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      regionCycleIndex = typeof cfg.regionCycleIndex === 'number' ? cfg.regionCycleIndex : 0;
    }
    console.log('[FFX Pipeline] regionCycleIndex:', regionCycleIndex);
  } catch (err) {
    console.log('[FFX Pipeline] ffx-config fetch failed (non-fatal):', err.message);
  }

  const currentRegion = REGIONS[regionCycleIndex % REGIONS.length];
  console.log('[FFX Pipeline] Current region:', currentRegion);

  // 4. Call Claude — Global article only
  console.log('[FFX Pipeline] Calling Claude — Global');
  let globalArticle;
  try {
    globalArticle = await callClaudeArticle(transcript, youtubeUrl, env.ANTHROPIC_API_KEY, existingArticles, 'Global', null);
    console.log('[FFX Pipeline] Global article done, slug:', globalArticle.slug);
  } catch (err) {
    console.log('[FFX Pipeline] Claude failed (Global):', err.message);
    return new Response(JSON.stringify({ error: `Claude failed: ${err.message}` }), { status: 502, headers });
  }

  // Attach metadata
  globalArticle.youtubeUrl = youtubeUrl;
  globalArticle.regionCycleIndex = regionCycleIndex;
  globalArticle.currentRegion = currentRegion;

  // 5. Generate job ID and store pending file in GitHub
  const jobId = `${Date.now()}-${videoId}`;
  console.log('[FFX Pipeline] Storing pending job:', jobId);

  const pendingData = {
    jobId,
    createdAt: new Date().toISOString(),
    youtubeUrl,
    currentRegion,
    regionCycleIndex,
    articles: [globalArticle],
  };

  try {
    await storePendingJob(env, jobId, pendingData);
    console.log('[FFX Pipeline] Pending job stored');
  } catch (err) {
    console.log('[FFX Pipeline] Failed to store pending job:', err.message);
    return new Response(JSON.stringify({ error: `Storage failed: ${err.message}` }), { status: 502, headers });
  }

  // 6. Send review email
  const reviewUrl = `https://fortitudefx.com/review?job=${jobId}`;
  console.log('[FFX Pipeline] Sending review email, reviewUrl:', reviewUrl);
  try {
    await sendReviewEmail(env, globalArticle, currentRegion, youtubeUrl, reviewUrl);
    console.log('[FFX Pipeline] Review email sent');
  } catch (err) {
    console.log('[FFX Pipeline] Email failed:', err.message);
    return new Response(JSON.stringify({ error: `Email failed: ${err.message}` }), { status: 502, headers });
  }

  return new Response(JSON.stringify({
    success: true,
    message: 'Pipeline complete. Review email sent.',
    jobId,
    globalSlug: globalArticle.slug,
    region: currentRegion,
  }), { status: 200, headers });
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
// GITHUB STORAGE
// ─────────────────────────────────────────────────────────────────────────────

async function storePendingJob(env, jobId, data) {
  const path = `pending/${jobId}.json`;
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;

  const encoded = (() => {
    const b = new TextEncoder().encode(JSON.stringify(data, null, 2));
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  })();

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'FFX-Worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `pipeline: pending job ${jobId}`,
      content: encoded,
      branch: GITHUB_BRANCH,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub write failed: ${res.status} ${err}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW EMAIL — FFX Master Template
// ─────────────────────────────────────────────────────────────────────────────

async function sendReviewEmail(env, globalArticle, currentRegion, youtubeUrl, reviewUrl) {
  const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f0f4;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f4;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,0.08);overflow:hidden;max-width:600px;width:100%;">

      <!-- Gradient stripe -->
      <tr><td style="height:7px;background:linear-gradient(90deg,#7c3aed,#f97316);font-size:0;line-height:0;">&nbsp;</td></tr>

      <!-- Hero header -->
      <tr><td style="background:#0a0a12;padding:32px 40px;">
        <!-- Logo row -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:middle;">
              <a href="https://fortitudefx.com" style="text-decoration:none;display:inline-block;vertical-align:middle;">
                <img src="https://fortitudefx.com/favicon-192x192.png" width="36" height="36" alt="FFX" style="border-radius:6px;vertical-align:middle;display:inline-block;border:0;">
                <span style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;letter-spacing:0.1em;vertical-align:middle;margin-left:10px;">FORTITUDEFX</span>
                <span style="font-family:Arial,sans-serif;font-size:11px;color:#9ca3af;letter-spacing:0.12em;vertical-align:middle;margin-left:8px;">CATCH THE WICK</span>
              </a>
            </td>
          </tr>
        </table>

        <!-- Kicker pill -->
        <div style="margin-top:20px;">
          <span style="display:inline-block;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);border-radius:20px;padding:5px 14px;">
            <span style="display:inline-block;width:6px;height:6px;background:#7c3aed;border-radius:50%;vertical-align:middle;margin-right:8px;"></span>
            <span style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#a78bfa;letter-spacing:0.1em;vertical-align:middle;">CONTENT APPROVAL</span>
          </span>
        </div>

        <!-- Hero title + 2 Candles -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">New content ready<br>for review</div>
              <div style="font-family:Arial,sans-serif;font-size:13px;color:#9ca3af;margin-top:8px;">Tap below to review and publish</div>
            </td>
            <td style="vertical-align:middle;text-align:right;width:140px;">
              <a href="https://fortitudefx.com" style="text-decoration:none;">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#ffffff;line-height:1.2;">2 Candles.</div>
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#f97316;line-height:1.2;">1 Story.</div>
              </a>
            </td>
          </tr>
        </table>

        <!-- Social icons -->
        <table cellpadding="0" cellspacing="0" style="margin-top:24px;">
          <tr>
            <td style="padding-right:8px;"><a href="https://youtube.com/@fortitudefx" style="text-decoration:none;display:inline-block;background:rgba(255,255,255,0.1);border-radius:6px;padding:7px 10px;line-height:0;"><img src="https://fortitudefx.com/email-icon-youtube.png" width="18" height="18" alt="YouTube" style="display:block;border:0;"></a></td>
            <td style="padding-right:8px;"><a href="https://instagram.com/fortitudefx" style="text-decoration:none;display:inline-block;background:rgba(255,255,255,0.1);border-radius:6px;padding:7px 10px;line-height:0;"><img src="https://fortitudefx.com/email-icon-instagram.png" width="18" height="18" alt="Instagram" style="display:block;border:0;"></a></td>
            <td style="padding-right:8px;"><a href="https://tiktok.com/@fortitudefx" style="text-decoration:none;display:inline-block;background:rgba(255,255,255,0.1);border-radius:6px;padding:7px 10px;line-height:0;"><img src="https://fortitudefx.com/email-icon-tiktok.png" width="18" height="18" alt="TikTok" style="display:block;border:0;"></a></td>
            <td><a href="https://x.com/fortitudefx" style="text-decoration:none;display:inline-block;background:rgba(255,255,255,0.1);border-radius:6px;padding:7px 10px;line-height:0;"><img src="https://fortitudefx.com/email-icon-x.png" width="18" height="18" alt="X" style="display:block;border:0;"></a></td>
          </tr>
        </table>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:36px 40px;">

        <!-- Article preview -->
        <div style="background:#f8f9fa;border-radius:8px;padding:20px 24px;margin-bottom:28px;border-left:4px solid #7c3aed;">
          <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#7c3aed;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:10px;">🌍 Global Article</div>
          <div style="font-family:Arial,sans-serif;font-size:17px;font-weight:700;color:#111111;margin-bottom:6px;line-height:1.3;">${globalArticle.title}</div>
          <div style="font-family:Arial,sans-serif;font-size:12px;color:#7c3aed;margin-bottom:8px;">/${globalArticle.slug}</div>
          <div style="font-family:Arial,sans-serif;font-size:13px;color:#555555;line-height:1.6;">${globalArticle.excerpt}</div>
        </div>

        <!-- Source video -->
        <div style="margin-bottom:28px;">
          <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#9ca3af;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;">Source Video</div>
          <a href="${youtubeUrl}" style="font-family:Arial,sans-serif;font-size:13px;color:#7c3aed;text-decoration:none;">${youtubeUrl}</a>
        </div>

        <!-- CTA Button -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center">
              <a href="${reviewUrl}" style="display:inline-block;background:#7c3aed;color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:700;text-decoration:none;padding:16px 48px;border-radius:8px;letter-spacing:0.02em;">Review &amp; Publish →</a>
            </td>
          </tr>
        </table>

        <div style="margin-top:12px;text-align:center;">
          <a href="${reviewUrl}" style="font-family:Arial,sans-serif;font-size:12px;color:#9ca3af;text-decoration:none;">${reviewUrl}</a>
        </div>

        <!-- Sign off -->
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#444444;margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb;">
          — Salman / FortitudeFX
        </div>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f8f9fa;padding:20px 40px;border-top:1px solid #e5e7eb;">
        <div style="font-family:Arial,sans-serif;font-size:12px;color:#9ca3af;text-align:center;">
          <a href="https://fortitudefx.com/privacy" style="color:#9ca3af;text-decoration:underline;">Privacy Policy</a>
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: 'FortitudeFX', email: 'salmankhanfx@fortitudefx.com' },
      to: [{ email: env.APPROVAL_EMAIL }],
      replyTo: { email: 'support@fortitudefx.com' },
      subject: `FFX Content Approval — ${globalArticle.title}`,
      htmlContent: emailHtml,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo ${res.status}: ${err}`);
  }
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

async function fetchTranscript(youtubeUrl, apiKey) {
  if (!apiKey) throw new Error('SUPADATA_API_KEY not set');
  const url = `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(youtubeUrl)}&text=true`;
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
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

async function callClaudeArticle(transcript, youtubeUrl, apiKey, existingArticles, region, globalSlug) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const isGlobal = region === 'Global';

  const internalLinksContext = existingArticles.length > 0
    ? `\n\nEXISTING PUBLISHED ARTICLES FOR INTERNAL LINKING:\nWhere contextually relevant and natural, insert internal links inside the body HTML using <a href="https://fortitudefx.com/article?slug=SLUG">TITLE</a>. Only link when genuinely relevant — never force links.\n${existingArticles.map(a => `- slug: ${a.slug} | title: ${a.title}`).join('\n')}`
    : '';

  const slugGuidance = isGlobal
    ? 'URL-safe lowercase hyphenated string, 3-6 words, describes core topic.'
    : `URL-safe lowercase hyphenated string, 3-6 words, includes regional signal. Must differ from Global slug: ${globalSlug || 'unknown'}`;

  const regionalSection = isGlobal ? '' : `
REGIONAL FRAMING FOR ${region}:
${getRegionalGuide(region)}

Genuinely different from Global article — different examples, headings, framing. Same core knowledge, different regional lens. 80% universal, 20% regional. Never keyword-stuff.`;

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
End with CTA to join free Discord at https://fortitudefx.com/joinfree — never link directly to Discord.
Maximum 1 exclamation mark in entire body.${isGlobal ? '' : ' Genuinely different body from Global — different examples, headings, framing.'}

linkedin: LinkedIn post for FortitudeFX founder. Human, intelligent, credible. Calm authority. 180-450 words. Hook → Insight → Perspective Shift → Soft CTA. No jargon, no fluff. No hashtags in body — 3-5 at end only.${isGlobal ? '' : ' Frame for ' + region + ' audience.'}
ALWAYS END WITH:
📖 Full breakdown: [ARTICLE_URL]
🌐 https://fortitudefx.com

x_thread: JSON array of exactly 6 strings. X thread for FortitudeFX founder. Human, sharp, high signal, calm authority.
Post 1: Hook — no links, no CTA, pure attention.
Posts 2-3: Educational value. Each MUST end with https://fortitudefx.com
Post 4: Educational value. MUST end with https://fortitudefx.com/vipdiscord
Post 5: Perspective shift. MUST end with https://fortitudefx.com/bootcamp
Post 6: Soft CTA with [ARTICLE_URL], ${youtubeUrl}, https://fortitudefx.com

discord: Discord post. GLOBAL FRAMING ONLY regardless of region. Human, experienced, calm. 150-250 words body (hard limit). 6-10 emojis naturally. End with:
Full breakdown 👉 [ARTICLE_URL]
Watch the video: ${youtubeUrl}
[engagement question]
https://fortitudefx.com

tumblr: Tumblr post. Human, thoughtful, reflective. 300-900 words. Plain text only. End with:
📖 Full breakdown: [ARTICLE_URL]
▶️ Watch the video: ${youtubeUrl}
🌐 https://fortitudefx.com

mediumIntro: 150-200 word rewritten article opening. Final line: "Originally published at [ARTICLE_URL]"

YouTube URL: ${youtubeUrl}
Write [ARTICLE_URL] exactly as shown — replaced automatically.`;

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
    throw new Error(`Invalid JSON (${region}): ` + cleaned.slice(0, 300));
  }

  const required = ['region', 'slug', 'title', 'excerpt', 'category', 'tags', 'readTime', 'body', 'linkedin', 'x_thread', 'discord', 'tumblr', 'mediumIntro'];
  for (const key of required) {
    if (!parsed[key]) throw new Error(`${region} article missing key: "${key}"`);
  }

  parsed.region = region;

  if (Array.isArray(parsed.x_thread)) {
    parsed.x_thread.forEach((t, i) => { parsed[`tweet${i + 1}`] = t; });
  }

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
