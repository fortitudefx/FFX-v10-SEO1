// Cloudflare Pages Function — FortitudeFX LinkedIn personal profile poster
// File location in your repo: /functions/linkedin.js
//
// Called by Make.com via POST to /linkedin
// Receives slug only — fetches linkedin field from articles.json
// Requires: LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN

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

  // 2. Fetch articles.json and find article by slug
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

  // 3. Extract linkedin field
  const { linkedin } = article;
  if (!linkedin || !linkedin.trim()) {
    return json({ message: 'No linkedin content found for slug: ' + slug }, 400);
  }

  // 4. Get credentials from Cloudflare env
  const ACCESS_TOKEN  = context.env.LINKEDIN_ACCESS_TOKEN;
  const PERSON_URN    = context.env.LINKEDIN_PERSON_URN;

  if (!ACCESS_TOKEN || !PERSON_URN) {
    return json({ message: 'LinkedIn credentials not configured' }, 500);
  }

  // 5. Post to LinkedIn personal profile
  const payload = {
    author: `urn:li:person:${PERSON_URN}`,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: {
          text: linkedin.trim()
        },
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

  // 6. Handle response
  if (!liRes.ok) {
    const errData = await liRes.json().catch(() => ({}));
    return json({ message: 'LinkedIn API error', detail: errData }, liRes.status);
  }

  // LinkedIn returns 201 with no body on success — just grab the post ID from header
  const postId = liRes.headers.get('x-restli-id') || liRes.headers.get('X-RestLi-Id') || 'unknown';

  return json({ success: true, slug, post_id: postId });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
