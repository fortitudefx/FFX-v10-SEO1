// Cloudflare Pages Function — FortitudeFX article publisher
// File location in your repo: /functions/publish.js
//
// Called by Make.com webhook scenario via POST to /publish
// Saves ALL fields including tumblr and discord
// Duplicate slug detection — updates existing entry instead of adding new
// Requires GITHUB_TOKEN in Cloudflare Pages → Settings → Environment Variables

const GITHUB_API = 'https://api.github.com/repos/fortitudefx/FFX-v10-SEO1/contents/articles.json';

export async function onRequestPost(context) {

  // 1. Parse incoming article data from Make
  let article;
  try {
    article = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  // Validate required fields
  if (!article.slug)  return json({ message: 'Missing required field: slug' }, 400);
  if (!article.title) return json({ message: 'Missing required field: title' }, 400);
  if (!article.body)  return json({ message: 'Missing required field: body' }, 400);

  // Clean date field
  if (article.date) article.date = article.date.replace(/"/g, '');

  // Parse tags
  if (typeof article.tags === 'string') {
    try { article.tags = JSON.parse(article.tags); } catch { article.tags = []; }
  }

  // Sanitise tweet fields — strip newlines
  ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6'].forEach(field => {
    if (article[field]) article[field] = article[field].replace(/[\r\n\t]+/g, ' ').trim();
  });

  // Sanitise text fields
  ['linkedin','tumblr','discord','yt_url'].forEach(field => {
    if (article[field]) article[field] = article[field].trim();
  });

  const GITHUB_TOKEN = context.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) return json({ message: 'GITHUB_TOKEN not configured' }, 500);

  const headers = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'FortitudeFX-Publisher'
  };

  // 2. GET current articles.json from GitHub
  let getRes;
  try {
    getRes = await fetch(GITHUB_API, { headers });
  } catch (err) {
    return json({ message: 'GitHub GET failed: ' + err.message }, 500);
  }
  if (!getRes.ok) return json({ message: 'GitHub GET error: ' + getRes.status }, 500);

  const fileData = await getRes.json();
  const sha = fileData.sha;

  // 3. Decode base64 → parse JSON array
  const decoded = atob(fileData.content.replace(/\n/g, ''));
  let articles;
  try {
    articles = JSON.parse(decoded);
  } catch {
    return json({ message: 'Failed to parse existing articles.json' }, 500);
  }
  if (!Array.isArray(articles)) return json({ message: 'articles.json is not an array' }, 500);

  // 4. Duplicate slug check — update in place if exists, prepend if new
  const existingIndex = articles.findIndex(a => a.slug === article.slug);
  let action;
  if (existingIndex !== -1) {
    articles[existingIndex] = article;
    action = 'updated';
  } else {
    articles.unshift(article);
    action = 'created';
  }

  // 5. Encode updated array back to base64
  const updated = btoa(unescape(encodeURIComponent(JSON.stringify(articles, null, 2))));

  // 6. PUT back to GitHub
  let putRes;
  try {
    putRes = await fetch(GITHUB_API, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `${action === 'created' ? 'Add' : 'Update'} article: ${article.title}`,
        content: updated,
        sha
      })
    });
  } catch (err) {
    return json({ message: 'GitHub PUT failed: ' + err.message }, 500);
  }

  if (!putRes.ok) {
    const errData = await putRes.json().catch(() => ({}));
    return json({ message: 'GitHub PUT error: ' + (errData.message ?? putRes.status) }, putRes.status);
  }

  return json({ success: true, action, slug: article.slug });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
