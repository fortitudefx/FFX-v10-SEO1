// Cloudflare Pages Function — FFX Excel Status
// File location: /functions/excel-status.js
//
// Called by generate.html after content loads
// Reads Excel row for slug and returns platform statuses
// So the checklist shows correct state (Yes/Error/Skipped/pending)

const SHEET_NAME = 'FFX Articles';

const COL = {
  slug:     0,  // A
  title:    1,  // B
  date:     2,  // C
  blog:     3,  // D
  x:        4,  // E
  linkedin: 5,  // F
  medium:   6,  // G
  tumblr:   7,  // H
  yt_url:   8,  // I
  discord:  9,  // J
};

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

  const { slug } = body;
  if (!slug) return new Response(JSON.stringify({ error: 'slug required' }), { status: 400, headers });

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
    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: `Excel read failed: ${err}` }), { status: 500, headers });
    }
    const data = await res.json();
    rows = data.values || [];
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }

  // Find row by slug
  const row = rows.find((r, i) => i > 0 && r[COL.slug] === slug);

  if (!row) {
    // No row found — all platforms pending
    return new Response(JSON.stringify({
      found: false,
      status: { blog: 'pending', x: 'pending', linkedin: 'pending', discord: 'pending' }
    }), { status: 200, headers });
  }

  return new Response(JSON.stringify({
    found: true,
    status: {
      blog:     row[COL.blog]     || 'pending',
      x:        row[COL.x]        || 'pending',
      linkedin: row[COL.linkedin]  || 'pending',
      discord:  row[COL.discord]   || 'pending',
    }
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
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token failed ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.access_token;
}
