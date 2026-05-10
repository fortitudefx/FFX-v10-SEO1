// Cloudflare Pages Function — FortitudeFX Discord poster
// File location in your repo: /functions/discord.js
//
// Called by publish-confirm.js via POST to /discord
// Receives slug + optional discord content directly
// If discord content provided in request — uses it directly (no GitHub fetch)
// If not provided — falls back to fetching from articles.json
// Requires: DISCORD_WEBHOOK_URL in Cloudflare env vars

const GITHUB_RAW = 'https://raw.githubusercontent.com/fortitudefx/FFX-v10-SEO1/main/articles.json';

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  const { slug, discord: discordContent } = body;
  if (!slug) return json({ message: 'Missing slug' }, 400);

  const DISCORD_WEBHOOK_URL = context.env.DISCORD_WEBHOOK_URL;
  if (!DISCORD_WEBHOOK_URL) return json({ message: 'DISCORD_WEBHOOK_URL not configured' }, 500);

  // Use content passed directly if available — avoids GitHub race condition
  let content = discordContent || null;

  if (!content) {
    // Fall back to articles.json — used when called directly without content
    let article;
    try {
      const res = await fetch(GITHUB_RAW, {
        headers: { 'User-Agent': 'FortitudeFX-Discord' }
      });
      if (!res.ok) return json({ message: 'Failed to fetch articles.json: ' + res.status }, 500);
      const articles = await res.json();
      article = articles.find(a => a.slug === slug);
    } catch (err) {
      return json({ message: 'Error reading articles.json: ' + err.message }, 500);
    }
    if (!article) return json({ message: 'Article not found for slug: ' + slug }, 404);
    content = article.discord;
  }

  if (!content) return json({ message: 'No discord content found for slug: ' + slug }, 400);

  const description = content.length > 4000
    ? content.substring(0, 3997) + '...'
    : content;

  const payload = {
    username: 'FortitudeFX',
    embeds: [
      {
        color: 0x7c3aed,
        description,
        footer: { text: 'FortitudeFX — fortitudefx.com' }
      }
    ]
  };

  let discordRes;
  try {
    discordRes = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return json({ message: 'Discord webhook request failed: ' + err.message }, 500);
  }

  if (discordRes.status === 204 || discordRes.ok) {
    return json({ success: true, slug });
  }

  const errData = await discordRes.json().catch(() => ({}));
  return json({ message: 'Discord webhook error', detail: errData }, discordRes.status);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
