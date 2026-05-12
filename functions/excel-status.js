// ─────────────────────────────────────────────────────────────────────────────
// FFX Excel Status — read-only lookup
// POST /excel-status
// Accepts: { slug } or { youtubeUrl }
// Returns: platform statuses + existing article content if found
// Used by generate.html to check if video was published before
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_NAME = 'FFX Articles';

const COL = {
  slug:     0,
  title:    1,
  date:     2,
  blog:     3,
  x:        4,
  linkedin: 5,
  medium:   6,
  tumblr:   7,
  yt_url:   8,
  discord:  9,
};

const GITHUB_RAW = 'https://raw.githubusercontent.com/fortitudefx/FFX-v10-SEO1/main/articles.json';

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
  }

  const { slug, youtubeUrl } = body;
  if (!slug && !youtubeUrl) {
    return new Response(JSON.stringify({ error: 'slug or youtubeUrl required' }), { status: 400, headers });
  }

  // Get Graph token
  let token;
  try {
    token = await getGraphToken(env);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }

  // Read Excel
  let rows;
  try {
    const url = `https://graph.microsoft.com/v1.0/sites/${env.MS_SHAREPOINT_HOST}/drive/items/${env.MS_FILE_ID}/workbook/worksheets('${SHEET_NAME}')/usedRange`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Excel read ${res.status}: ${await res.text()}`);
    rows = (await res.json()).values || [];
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }

  // Find row by slug or YT URL
  let row = null;
  if (slug) {
    row = rows.find((r, i) => i > 0 && r[COL.slug] === slug) || null;
  } else if (youtubeUrl) {
    // Normalise URL for comparison — strip query params except v=
    const normalise = (u) => {
      try {
        const parsed = new URL(u);
        if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1).split('?')[0];
        return parsed.searchParams.get('v') || u;
      } catch { return u; }
    };
    const targetId = normalise(youtubeUrl);
    row = rows.find((r, i) => i > 0 && r[COL.yt_url] && normalise(r[COL.yt_url]) === targetId) || null;
  }

  if (!row) {
    return new Response(JSON.stringify({
      found: false,
      status: { blog: 'pending', x: 'pending', linkedin: 'pending', discord: 'pending' }
    }), { status: 200, headers });
  }

  const foundSlug = row[COL.slug];

  // Try to fetch existing article content from articles.json
  let articleContent = null;
  try {
    const res = await fetch(GITHUB_RAW, { headers: { 'User-Agent': 'FFX-Worker' } });
    if (res.ok) {
      const articles = await res.json();
      articleContent = articles.find(a => a.slug === foundSlug) || null;
    }
  } catch (err) {
    console.log('[FFX] articles.json fetch failed (non-fatal):', err.message);
  }

  return new Response(JSON.stringify({
    found: true,
    slug: foundSlug,
    title: row[COL.title] || '',
    ytUrl: row[COL.yt_url] || '',
    status: {
      blog:     row[COL.blog]     || 'pending',
      x:        row[COL.x]        || 'pending',
      linkedin: row[COL.linkedin]  || 'pending',
      discord:  row[COL.discord]   || 'pending',
    },
    // Full content if available from articles.json
    content: articleContent,
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

async function getGraphToken(env) {
  const res = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  );
  if (!res.ok) throw new Error(`Token failed ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}
