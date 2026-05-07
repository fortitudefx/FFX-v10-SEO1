// Cloudflare Pages Function — FortitudeFX Discord poster
// File location in your repo: /functions/discord.js
//
// Called by Make.com via POST to /discord
// Receives slug only — fetches discord field from articles.json
// Requires: DISCORD_WEBHOOK_URL in Cloudflare env vars

const GITHUB_RAW = 'https://raw.githubusercontent.com/fortitudefx/FFX-v10-SEO1/main/articles.json';

export async function onRequestPost(context) {

  // 1. Parse incoming slug from Make
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  const { slug } = body;
  if (!slug) return json({ message: 'Missing slug' }, 400);

  // 2. Get Discord webhook URL from env
  const DISCORD_WEBHOOK_URL = context.env.DISCORD_WEBHOOK_URL;
  if (!DISCORD_WEBHOOK_URL) return json({ message: 'DISCORD_WEBHOOK_URL not configured' }, 500);

  // 3. Fetch articles.json and find article by slug
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

  // 4. Extract discord field
  const discordContent = article.discord;
  if (!discordContent) return json({ message: 'No discord content found for slug: ' + slug }, 400);

  // 5. Build article URL
  const articleUrl = `https://fortitudefx.com/article?slug=${slug}`;

  // 6. Build links line
  const ytUrl = article.yt_url || null;
  let linksLine = `Read: ${articleUrl}`;
  if (ytUrl) linksLine += `\nWatch: ${ytUrl}`;
  linksLine += `\nMore: https://fortitudefx.com`;

  // 7. Build Discord message payload
  // Discord has a 2000 char limit per message content
  // We use an embed for clean formatting
  const description = discordContent.length > 3800
    ? discordContent.substring(0, 3797) + '...'
    : discordContent;

  const payload = {
    username: 'FortitudeFX',
    embeds: [
      {
        color: 0x7c3aed, // FFX purple
        description: `${description}\n\n${linksLine}`,
        footer: {
          text: 'FortitudeFX — fortitudefx.com'
        }
      }
    ]
  };

  // 7. Post to Discord webhook
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

  // Discord returns 204 No Content on success
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
