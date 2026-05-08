// Cloudflare Pages Function — TEMPORARY LinkedIn URN lookup
// File location in your repo: /functions/linkedin-urn.js
//
// Hit this once via GET to /linkedin-urn to get your LinkedIn person URN
// DELETE THIS FILE after you have your URN
// Requires: LINKEDIN_ACCESS_TOKEN in Cloudflare env vars

export async function onRequestGet(context) {

  const ACCESS_TOKEN = context.env.LINKEDIN_ACCESS_TOKEN;

  if (!ACCESS_TOKEN) {
    return json({ message: 'LINKEDIN_ACCESS_TOKEN not set in Cloudflare env vars' }, 500);
  }

  let liRes;
  try {
    liRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    return json({ message: 'LinkedIn API request failed: ' + err.message }, 500);
  }

  if (!liRes.ok) {
    const errData = await liRes.json().catch(() => ({}));
    return json({ message: 'LinkedIn API error', detail: errData }, liRes.status);
  }

  const data = await liRes.json();

  return json({
    name: data.name,
    email: data.email,
    person_urn: data.sub,
    message: 'Copy person_urn into LINKEDIN_PERSON_URN env var in Cloudflare, then delete this Worker file'
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
