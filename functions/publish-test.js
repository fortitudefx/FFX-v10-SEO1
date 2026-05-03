// Cloudflare Pages Function — FortitudeFX SANDBOX article publisher
// File location in your repo: /functions/publish-test.js
//
// SANDBOX ONLY — writes to articles-test.json NOT articles.json
// Live production is never touched by this function
// Called by Make FFX TEST scenario via POST to /publish-test
// Requires GITHUB_TOKEN in Cloudflare Pages → Settings → Environment Variables

const GITHUB_API = 'https://api.github.com/repos/fortitudefx/FFX-v10-SEO1/contents/articles-test.json';

export async function onRequestPost(context) {

  // 1. Parse incoming article data
  let article;
  try {
    article = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  if (article.date) article.date = article.date.replace(/"/g, '');

  if (typeof article.tags === 'string') {
    try { article.tags = JSON.parse(article.tags); } catch { article.tags = []; }
  }

  // Sanitise tweet fields
  const tweetFields = ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6'];
  tweetFields.forEach(field => {
    if (article[field]) {
      article[field] = article[field].replace(/[\r\n\t]+/g, ' ').trim();
    }
  });

  if (article.yt_url) article.yt_url = article.yt_url.trim();

  const GITHUB_TOKEN = context.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    return json({ message: 'GITHUB_TOKEN not configured' }, 500);
  }

  const headers = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'FortitudeFX-Publisher'
  };

  // 2. GET current articles-test.json from GitHub
  let getRes;
  try {
    getRes = await fetch(GITHUB_API, { headers });
  } catch (err) {
    return json({ message: 'GitHub GET failed: ' + err.message }, 500);
  }

  if (!getRes.ok) {
    return json({ message: 'GitHub GET error: ' + getRes.status }, 500);
  }

  const fileData = await getRes.json();
  const sha = fileData.sha;

  // 3. Decode base64 content
  const decoded = atob(fileData.content.replace(/\n/g, ''));
  let articles;
  try {
    articles = JSON.parse(decoded);
  } catch {
    return json({ message: 'Failed to parse articles-test.json' }, 500);
  }

  if (!Array.isArray(articles)) {
    return json({ message: 'articles-test.json is not an array' }, 500);
  }

  // 4. Append new article (newest first)
  articles.unshift(article);

  // 5. Encode back to base64
  const updated = btoa(unescape(encodeURIComponent(JSON.stringify(articles, null, 2))));

  // 6. PUT back to GitHub — articles-test.json only
  let putRes;
  try {
    putRes = await fetch(GITHUB_API, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `[SANDBOX] Add test article: ${article.title ?? 'untitled'}`,
        content: updated,
        sha: sha
      })
    });
  } catch (err) {
    return json({ message: 'GitHub PUT failed: ' + err.message }, 500);
  }

  if (!putRes.ok) {
    const errData = await putRes.json().catch(() => ({}));
    return json({ message: 'GitHub PUT error: ' + (errData.message ?? putRes.status) }, putRes.status);
  }

  return json({ success: true, environment: 'sandbox', file: 'articles-test.json' });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
