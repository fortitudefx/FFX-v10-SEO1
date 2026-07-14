// ─────────────────────────────────────────────────────────────────────────────
// FFX Regenerate Platform
// POST /api/regenerate-platform
// Pulls transcript:{videoId} from permanent KV — no Supadata call ever
// Calls Claude for one platform only
// Writes to regen:{videoId}:{platform} — 24hr TTL staging only
// Never touches globalContent, pendingEdits, or any other platform
// User must hit Save to move content into pendingEdits permanently
// ─────────────────────────────────────────────────────────────────────────────

import { callKeywordPlatforms } from '../../lib/keyword/platforms.js';
import { keywordId } from '../../lib/keyword/select.js';

const PLATFORM_FIELDS = {
  article:  ['body'],
  x:        ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6'],
  linkedin: ['linkedin'],
  discord:  ['discord'],
  tumblr:   ['tumblr'],
};

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV)            return json({ error: 'FFX_KV not bound' }, 500, headers);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500, headers);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const { videoId, platform, slug: bodySlug, youtubeUrl: bodyYtUrl } = body;
  if (!videoId)  return json({ error: 'videoId is required' }, 400, headers);
  if (!platform) return json({ error: 'platform is required' }, 400, headers);
  if (!PLATFORM_FIELDS[platform]) {
    return json({ error: `Unknown platform: ${platform}. Valid: ${Object.keys(PLATFORM_FIELDS).join(', ')}` }, 400, headers);
  }

  // ── Keyword items have NO transcript — route to the keyword regen path ────
  // (article → re-gated via the consumer; social → regenerated inline, committed
  // directly). Video items fall through to the transcript path below, unchanged.
  // Detect keyword articles robustly. A PUBLISHED keyword article may be keyed by a
  // real videoId extracted from a baked youtubeUrl (e.g. published:0_YybIdgkFo), so
  // video:{videoId} won't exist — also check the PUBLISHED record's source. Without
  // this, the press regen falls to the transcript path and silently regenerates from
  // the WRONG video's transcript.
  const rec0 = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' }).catch(() => null);
  const pub0 = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' }).catch(() => null);
  const isKeyword = videoId.startsWith('kw-') || (rec0 && rec0.source === 'keyword') || (pub0 && pub0.source === 'keyword');
  if (isKeyword) {
    return await regenKeywordPlatform(videoId, platform, rec0, pub0, env, headers);
  }

  // ── 1. Pull transcript from permanent KV — no Supadata call ever ─────────
  const transcript = await env.FFX_KV.get(`transcript:${videoId}`, { type: 'text' }).catch(() => null);
  if (!transcript) {
    return json({
      error: 'Transcript not found. This video was generated before transcript storage was added. Re-generate the full video first to store the transcript permanently.'
    }, 404, headers);
  }

  // ── 2. Get slug + youtubeUrl — from body first, fall back to published KV ─
  // Body values are passed from queue dashboard for pre-published articles.
  // published:{videoId} only exists after an article has been published.
  let slug       = bodySlug  || '';
  let youtubeUrl = bodyYtUrl || '';

  if (!slug || !youtubeUrl) {
    const published = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' }).catch(() => null);
    if (published) {
      slug       = slug       || published.slug       || '';
      youtubeUrl = youtubeUrl || published.youtubeUrl || '';
    }
  }

  // slug is required to build article URL — fall back to videoId if missing
  const articleUrl = slug
    ? `https://fortitudefx.com/article?slug=${slug}`
    : `https://fortitudefx.com`;

  // ── 3. Call Claude — transcript is the only content input ────────────────
  let newFields;
  try {
    if (platform === 'article') {
      newFields = await regenArticle(transcript, env.ANTHROPIC_API_KEY);
    } else {
      newFields = await regenPlatform(transcript, youtubeUrl, articleUrl, platform, env.ANTHROPIC_API_KEY);
    }
  } catch (err) {
    return json({ error: formatClaudeError(err, platform) }, 500, headers);
  }

  // ── 4. Write to regen:{videoId}:{platform} — 24hr TTL, staging only ──────
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + 86400000).toISOString();

  await env.FFX_KV.put(
    `regen:${videoId}:${platform}`,
    JSON.stringify({
      videoId,
      platform,
      fields:      newFields,
      generatedAt: now.toISOString(),
      expiresAt,
    }),
    { expirationTtl: 86400 }
  );

  console.log('[FFX] regen staged:', videoId, platform, 'expires:', expiresAt);

  return json({
    success:     true,
    platform,
    fields:      newFields,
    generatedAt: now.toISOString(),
    expiresAt,
  }, 200, headers);
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
// KEYWORD-ITEM PER-PLATFORM REGEN (no transcript)
//  • article  → enqueue an article-only job to the consumer: it regenerates the
//               article from the nuggets, RE-GATES it, and preserves the existing
//               social. This is how you fix a failed-gate article WITHOUT touching
//               X/LinkedIn/Discord. Async (re-gates); refresh the row after ~60s.
//  • x/linkedin/discord → regenerate that ONE platform inline and commit it
//               directly to the record (non-gated; shows on next dashboard reload).
// ─────────────────────────────────────────────────────────────────────────────
async function regenKeywordPlatform(videoId, platform, videoRec, pubRec, env, headers) {
  // The LIVE record is the published one if the article is published; otherwise the
  // generation record. Pull the article content + keyword from whichever we have.
  const live = pubRec || videoRec;
  if (!live) return json({ error: 'Record not found for ' + videoId }, 404, headers);
  const contentOf = (r) => r && (r.globalContent || (r.platforms && r.platforms.blog_global && r.platforms.blog_global.content) || r.content) || null;
  const liveContent = contentOf(live);
  if (!liveContent || !liveContent.body) return json({ error: 'No article content on record' }, 404, headers);
  const slug = liveContent.slug || live.slug;
  const kw   = live.keyword || (videoRec && videoRec.keyword) || (pubRec && pubRec.keyword);
  const isPublished = !!pubRec;

  if (platform === 'article') {
    // Article regen on a LIVE/published page would swap an indexed body without a
    // re-gate/re-index cycle — fail loudly with the correct path instead.
    if (isPublished) {
      return json({ error: 'Article regeneration on a PUBLISHED page is not supported here (it would replace a live, indexed article body). Unpublish it, use "Regenerate Article" in the QUEUE (which re-gates), then republish.' }, 400, headers);
    }
    if (!env.ffx_generate_queue) return json({ error: 'Queue binding ffx_generate_queue not found' }, 500, headers);
    const jobId = Date.now() + '-artregen-' + videoId;
    await env.FFX_KV.put('job:' + jobId, JSON.stringify({ status: 'pending', articleOnly: true, slug, createdAt: new Date().toISOString() }), { expirationTtl: 86400 });
    await env.ffx_generate_queue.send({
      jobId, source: 'cron-keyword', keyword: kw, targetQuery: kw,
      canonical: live.canonical, cluster: live.cluster, nuggetTags: live.nuggetTags || '',
      nuggetIds: live.nuggetIds || [], existingSlug: slug, articleOnly: true,
    });
    return json({ success: true, queued: true, platform: 'article',
      message: 'Article is regenerating and will be re-gated — social untouched. Refresh in ~60s.' }, 200, headers);
  }

  if (platform !== 'x' && platform !== 'linkedin' && platform !== 'discord') {
    return json({ error: 'Platform not supported for keyword items: ' + platform }, 400, headers);
  }
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500, headers);

  let p;
  try {
    p = await callKeywordPlatforms(liveContent, kw, 'https://fortitudefx.com/article?slug=' + slug, env.ANTHROPIC_API_KEY, env);
  } catch (e) { return json({ error: 'Regen failed: ' + e.message }, 500, headers); }

  // Apply to EVERY record that represents this article so the live page, press, and
  // the generation record all stay in sync: the published record (what the live page
  // + press read) and the generation record (video:kw-*, if it exists separately).
  const now = new Date().toISOString();
  const genRec = kw ? await env.FFX_KV.get('video:' + keywordId(kw), { type: 'json' }).catch(() => null) : null;
  const targets = [];
  if (pubRec)                                  targets.push({ key: 'published:' + videoId, rec: pubRec });
  if (genRec)                                  targets.push({ key: 'video:' + keywordId(kw), rec: genRec });
  if (videoRec && (!kw || videoId !== keywordId(kw))) targets.push({ key: 'video:' + videoId, rec: videoRec });

  const apply = (rec) => {
    const c = contentOf(rec) || {};
    rec.platforms = rec.platforms || {};
    if (platform === 'x') {
      for (let i = 0; i < 6; i++) c['tweet' + (i + 1)] = p.tweets[i] || '';
      rec.platforms.x = { status: 'generated', content: { tweets: p.tweets }, updatedAt: now };
    } else if (platform === 'linkedin') {
      c.linkedin = p.linkedin;
      rec.platforms.linkedin = { status: 'generated', content: { text: p.linkedin }, updatedAt: now };
    } else {
      c.discord = p.discord;
      rec.platforms.discord = { status: 'generated', content: { text: p.discord }, updatedAt: now };
    }
  };

  const updated = [];
  for (const t of targets) {
    try { apply(t.rec); await env.FFX_KV.put(t.key, JSON.stringify(t.rec)); updated.push(t.key); }
    catch (e) { console.error('[FFX] keyword social regen write failed for', t.key, e.message); }
  }
  if (!updated.length) return json({ error: 'No record could be updated' }, 500, headers);
  return json({ success: true, platform, committed: true, updated, generatedAt: now }, 200, headers);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE — ARTICLE REGEN
// ─────────────────────────────────────────────────────────────────────────────

async function regenArticle(transcript, apiKey) {
  const systemPrompt = `You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick™ mechanical entry system.

TRADEMARK RULE: FortitudeFX™, Catch the Wick™, and 2 Candle. 1 Story.™ must always include the ™ symbol on first use.

Regenerate ONLY the article body. Return a single valid JSON object with exactly this key:

{
  "body": "full 2000-word SEO article as valid HTML using h2 and h3 tags. Include internal links to /bootcamp /vipdiscord /blog. End with CTA to join free Discord at https://discord.gg/fortitudefx. Maximum 1 exclamation mark."
}

CRITICAL: Return ONLY the raw JSON object. No markdown. No code fences. No preamble. Start with { end with }.
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
      max_tokens: 6000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Transcript:\n\n${transcript}\n\nVOICE: This is Salman speaking — founder of FortitudeFX™. Write in his voice — direct, calm, experienced, institutional tone. Study his sentence rhythm and phrasing from the transcript before writing.` }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return parseClaudeJson(await res.json(), ['body']);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE — PLATFORM REGEN
// ─────────────────────────────────────────────────────────────────────────────

async function regenPlatform(transcript, youtubeUrl, articleUrl, platform, apiKey) {
  const configs = {
    x: {
      fields: ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6'],
      instruction: `Regenerate the X thread. Return a JSON object with keys tweet1 through tweet6.
THREAD RULES — exactly 6 tweets:
Tweet 1: hook only, no links, no URLs.
Tweet 2: first reply tweet, ends with https://fortitudefx.com on its own line.
Tweets 3-5: content only, no links, no URLs.
Tweet 6: ends with https://fortitudefx.com on its own line, then ${articleUrl} on its own line, then ${youtubeUrl} on its own line.
BANNED OPENING WORDS: Never start any tweet with "Most traders", "The reality is", "One thing I've learned", "The market doesn't care", "This is why", "Here's the truth", "Trading is", "Many traders", "Many people".
Return: { "tweet1": "...", "tweet2": "...", "tweet3": "...", "tweet4": "...", "tweet5": "...", "tweet6": "..." }`,
    },
    linkedin: {
      fields: ['linkedin'],
      instruction: `Regenerate the LinkedIn post. Pick one format randomly: WALL (350-500w), SHORT (80-150w), SINGLE (60-100w), STORY (200-350w), or CONTRARIAN (150-300w).
Human, intelligent, calm authority. Founder perspective. End with: 📖 Full breakdown: ${articleUrl}\n🌐 https://fortitudefx.com\n\nAdd 3-5 hashtags at end only.
BANNED OPENING WORDS: Never start with "Most traders", "The reality is", "One thing I've learned", "The market doesn't care", "This is why", "Here's the truth", "Trading is", "Many traders", "Many people".
Return: { "linkedin": "..." }`,
    },
    discord: {
      fields: ['discord'],
      instruction: `Regenerate the Discord post. Pick one format randomly: NUGGET (40-80w), DROP (100-200w), or QUESTION (80-150w).
End with: Full breakdown 👉 ${articleUrl}\nWatch: ${youtubeUrl}\n[engagement question]\nhttps://fortitudefx.com
BANNED OPENING WORDS: Never start with "Most traders", "The reality is", "One thing I've learned", "The market doesn't care".
Return: { "discord": "..." }`,
    },
    tumblr: {
      fields: ['tumblr'],
      instruction: `Regenerate the Tumblr post. 300-600 words. Thoughtful, reflective. Plain text, no HTML.
End with: 📖 ${articleUrl}\n▶️ ${youtubeUrl}\n🌐 https://fortitudefx.com
Return: { "tumblr": "..." }`,
    },
  };

  const config = configs[platform];
  if (!config) throw new Error(`No config for platform: ${platform}`);

  const systemPrompt = `You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick™ mechanical entry system.

TRADEMARK RULE: FortitudeFX™, Catch the Wick™, and 2 Candle. 1 Story.™ must always include the ™ symbol on first use.

${config.instruction}

CRITICAL: Return ONLY the raw JSON object. No markdown. No code fences. No preamble. Start with { end with }.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Transcript:\n\n${transcript}\n\nVOICE: This is Salman speaking — founder of FortitudeFX™. Write ALL content in his voice — direct, calm, experienced, slightly contrarian, institutional tone. Study his phrasing from the transcript.` }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return parseClaudeJson(await res.json(), config.fields);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function parseClaudeJson(data, requiredFields) {
  const rawText    = data.content[0].text.trim();
  const firstBrace = rawText.indexOf('{');
  const lastBrace  = rawText.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON object in Claude response');
  const cleaned = rawText.slice(firstBrace, lastBrace + 1);
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) {
    throw new Error('Claude returned invalid JSON: ' + e.message);
  }
  for (const key of requiredFields) {
    if (!parsed[key]) throw new Error(`Missing field: "${key}" in Claude response`);
  }
  return parsed;
}

function formatClaudeError(err, platform) {
  const msg = err.message || '';
  if (msg.includes('524')) return `${platform} regen: Anthropic timeout. Try again.`;
  if (msg.includes('529')) return `${platform} regen: Anthropic overloaded. Wait 2 minutes and try again.`;
  if (msg.includes('401')) return `${platform} regen: Invalid API key.`;
  if (msg.includes('429')) return `${platform} regen: Rate limit hit. Wait 1 minute and try again.`;
  if (msg.includes('Transcript not found')) return msg;
  return `${platform} regen: ${msg}`;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
