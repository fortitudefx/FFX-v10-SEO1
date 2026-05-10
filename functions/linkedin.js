// Cloudflare Pages Function — FortitudeFX LinkedIn personal profile poster
// File location in your repo: /functions/linkedin.js
//
// Called by publish-confirm.js via POST to /linkedin
// Receives slug + optional linkedin content directly
// If linkedin content provided in request — uses it directly (no GitHub fetch)
// If not provided — falls back to fetching from articles.json
// Requires: LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN

const GITHUB_RAW = 'https://raw.githubusercontent.com/fortitudefx/FFX-v10-SEO1/main/articles.json';

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ message: 'Invalid JSON' }, 400);
  }

  const { slug, linkedin: linkedinContent } = body;
  if (!slug) return json({ message: 'Missing slug' }, 400);

  const ACCESS_TOKEN = context.env.LINKEDIN_ACCESS_TOKEN;
  const PERSON_URN   = context.env.LINKEDIN_PERSON_URN;

  if (!ACCESS_TOKEN || !PERSON_URN) {
    return json({ message: 'LinkedIn credentials not configured' }, 500);
  }

  // Use content passed directly if available — avoids GitHub race condition
  let content = linkedinContent || null;

  if (!content) {
    // Fall back to articles.json
    let article;
    try {
      const res = await fetch(GITHUB_RAW, {
        headers: { 'User-Agent': 'FortitudeFX-LinkedIn' }
      });
      if (!res.ok) return json({ message: 'Failed to fetch articles.json: ' + res.status }, 500);
      const articles = await res.json();
      article = articles.find(a => a.slug === slug);
    } catch (err) {
      return json({ message: 'Error reading articles.json: ' + err.message }, 500);
    }
    if (!article) return json({ message: 'Article not found for slug: ' + slug }, 404);
    content = article.linkedin;
  }

  if (!content || !content.trim()) {
    return json({ message: 'No linkedin content found for slug: ' + slug }, 400);
  }

  const payload = {
    author: `urn:li:person:${PERSON_URN}`,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: content.trim() },
        shareMediaCategory: 'NONE'
      }
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
    }
  };

  let liRes;
  try {
    liRes = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202401'
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return json({ message: 'LinkedIn API request failed: ' + err.message }, 500);
  }

  if (!liRes.ok) {
    const errData = await liRes.json().catch(() => ({}));
    return json({ message: 'LinkedIn API error', detail: errData }, liRes.status);
  }

  const postId = liRes.headers.get('x-restli-id') || liRes.headers.get('X-RestLi-Id') || 'unknown';
  return json({ success: true, slug, post_id: postId });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
