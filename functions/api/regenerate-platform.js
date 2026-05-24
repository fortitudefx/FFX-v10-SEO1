// ─────────────────────────────────────────────────────────────────────────────
// FFX Regenerate Platform
// POST /api/regenerate-platform
// Pulls transcript:{videoId} from KV — no Supadata call
// Calls Claude for one platform only
// Writes result to pendingEdits in published:{videoId} — never touches globalContent
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_FIELDS = {
  article:  ['body'],
  x:        ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6','x_thread'],
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

  if (!env.FFX_KV)           return json({ error: 'FFX_KV not bound' }, 500, headers);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500, headers);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const { videoId, platform } = body;
  if (!videoId)  return json({ error: 'videoId is required' }, 400, headers);
  if (!platform) return json({ error: 'platform is required' }, 400, headers);
  if (!PLATFORM_FIELDS[platform]) {
    return json({ error: `Unknown platform: ${platform}. Valid: ${Object.keys(PLATFORM_FIELDS).join(', ')}` }, 400, headers);
  }

  // ── 1. Pull transcript — no Supadata call ────────────────────────────────
  const transcript = await env.FFX_KV.get(`transcript:${videoId}`, { type: 'text' }).catch(() => null);
  if (!transcript) {
    return json({ error: 'Transcript not found in KV. This video was generated before transcript storage was added. Re-generate the full video to store the transcript.' }, 404, headers);
  }

  // ── 2. Pull published record for context ─────────────────────────────────
  const published = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' }).catch(() => null);
  if (!published) {
    return json({ error: `No published record found for videoId: ${videoId}` }, 404, headers);
  }

  const globalContent = published.globalContent || {};
  const slug          = published.slug || '';
  const youtubeUrl    = published.youtubeUrl || '';
  const articleUrl    = `https://fortitudefx.com/article?slug=${slug}`;

  // ── 3. Call Claude for this platform only ────────────────────────────────
  let newFields;
  try {
    if (platform === 'article') {
      newFields = await regenArticle(transcript, youtubeUrl, slug, env.ANTHROPIC_API_KEY);
    } else {
      newFields = await regenPlatform(transcript, youtubeUrl, articleUrl, platform, env.ANTHROPIC_API_KEY);
    }
  } catch (err) {
    return json({ error: formatClaudeError(err, platform) }, 500, headers);
  }

  // ── 4. Write to pendingEdits — never touches globalContent ───────────────
  const record = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' }).catch(() => null);
  if (!record) return json({ error: 'Published record disappeared during processing' }, 500, headers);

  if (!record.pendingEdits)  record.pendingEdits  = {};
  if (!Array.isArray(record.editedFields)) record.editedFields = [];

  // Write each field returned by Claude into pendingEdits
  Object.entries(newFields).forEach(([field, value]) => {
    record.pendingEdits[field] = value;
    if (!record.editedFields.includes(field)) {
      record.editedFields.push(field);
    }
  });

  // Keep x_thread in sync for X platform
  if (platform === 'x') {
    record.pendingEdits.x_thread = [1,2,3,4,5,6].map(i => {
      const key = `tweet${i}`;
      return record.pendingEdits[key] !== undefined
        ? record.pendingEdits[key]
        : (globalContent[key] || '');
    });
  }

  record.updatedAt = new Date().toISOString();

  await env.FFX_KV.put(`published:${videoId}`, JSON.stringify(record));
  console.log('[FFX] Regenerated platform:', platform, 'for videoId:', videoId);

  return json({ success: true, platform, fields: newFields }, 200, headers);
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
// CLAUDE — ARTICLE REGEN
// ─────────────────────────────────────────────────────────────────────────────

async function regenArticle(transcript, youtubeUrl, existingSlug, apiKey) {
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
      max_tokens: 3500,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Transcript:\n\n${transcript}\n\nVOICE: This is Salman speaking — founder of FortitudeFX™. Write in his voice — direct, calm, experienced, institutional tone. Study his sentence rhythm and phrasing from the transcript before writing.` }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return parseClaudeJson(await res.json(), ['body']);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE — PLATFORM REGEN (x, linkedin, discord, tumblr)
// ─────────────────────────────────────────────────────────────────────────────

async function regenPlatform(transcript, youtubeUrl, articleUrl, platform, apiKey) {
  const platformInstructions = {
    x: {
      fields: ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6'],
      instruction: `Regenerate the X thread. Return a JSON object with keys tweet1 through tweet6.
THREAD RULES: tweet1 is the hook (no link). tweet2-3 end with https://fortitudefx.com. tweet4 ends with https://fortitudefx.com/vipdiscord. tweet5 ends with https://fortitudefx.com/bootcamp. tweet6 includes ${articleUrl} and ${youtubeUrl}.
BANNED OPENING WORDS — NEVER start any tweet with: "Most traders", "The reality is", "One thing I've learned", "The market doesn't care", "This is why", "Here's the truth", "Trading is", "Many traders", "Many people".
Return: { "tweet1": "...", "tweet2": "...", "tweet3": "...", "tweet4": "...", "tweet5": "...", "tweet6": "..." }`,
    },
    linkedin: {
      fields: ['linkedin'],
      instruction: `Regenerate the LinkedIn post. Pick one format randomly: WALL (350-500w), SHORT (80-150w), SINGLE (60-100w), STORY (200-350w), or CONTRARIAN (150-300w).
Human, intelligent, calm authority. Founder perspective. End with: 📖 Full breakdown: ${articleUrl}\n🌐 https://fortitudefx.com\n\nAdd 3-5 hashtags at end only.
BANNED OPENING WORDS — NEVER start with: "Most traders", "The reality is", "One thing I've learned", "The market doesn't care", "This is why", "Here's the truth", "Trading is", "Many traders", "Many people".
Return: { "linkedin": "..." }`,
    },
    discord: {
      fields: ['discord'],
      instruction: `Regenerate the Discord post. Pick one format randomly: NUGGET (40-80w), DROP (100-200w), or QUESTION (80-150w).
End with: Full breakdown 👉 ${articleUrl}\nWatch: ${youtubeUrl}\n[engagement question]\nhttps://fortitudefx.com
BANNED OPENING WORDS — NEVER start with: "Most traders", "The reality is", "One thing I've learned", "The market doesn't care".
Return: { "discord": "..." }`,
    },
    tumblr: {
      fields: ['tumblr'],
      instruction: `Regenerate the Tumblr post. 300-600 words. Thoughtful, reflective. Plain text, no HTML.
End with: 📖 ${articleUrl}\n▶️ ${youtubeUrl}\n🌐 https://fortitudefx.com
Return: { "tumblr": "..." }`,
    },
  };

  const config = platformInstructions[platform];
  if (!config) throw new Error(`No instruction config for platform: ${platform}`);

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
  const rawText = data.content[0].text.trim();
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
