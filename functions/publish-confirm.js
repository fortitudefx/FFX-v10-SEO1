// ─────────────────────────────────────────────────────────────────────────────
// FFX Publish Confirm — Master Orchestrator
// Replaces Make.com entirely for publishing workflow
//
// Flow:
// 1. Read content from KV by slug
// 2. Get Microsoft Graph token (client credentials — no manual refresh ever)
// 3. Find Excel row by slug
// 4. For each platform: skip if Yes, run if No/empty
// 5. Update Excel cell after each success, mark Error on failure
// 6. Add new Excel row if slug not found
// 7. Return full status report to generate.html
//
// Platforms: Blog, X, Discord, LinkedIn
// Excel columns: A=Slug B=Title C=Date D=Blog E=X F=LinkedIn G=Medium H=Tumblr I=YT_URL J=Discord
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_NAME = 'FFX Articles';

// Column index map (0-based)
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

  console.log('[FFX] publish-confirm: request received');

  // ── 1. Parse request ───────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); } catch {
    return resp({ error: 'Invalid JSON body' }, 400, headers);
  }

  const { slug } = body;
  if (!slug) return resp({ error: 'slug is required' }, 400, headers);

  console.log('[FFX] publish-confirm slug:', slug);

  // ── 2. Read content from KV ────────────────────────────────────────────────
  const stored = await env.FFX_CONTENT.get(`slug:${slug}`);
  if (!stored) {
    return resp({ error: 'Content not found or expired. Please generate again.' }, 404, headers);
  }

  let content;
  try { content = JSON.parse(stored); } catch {
    return resp({ error: 'Stored content is corrupted. Please generate again.' }, 500, headers);
  }

  // ── 3. Get Microsoft Graph access token ────────────────────────────────────
  let graphToken;
  try {
    graphToken = await getGraphToken(env);
    console.log('[FFX] Graph token obtained');
  } catch (err) {
    console.log('[FFX] Graph token failed:', err.message);
    return resp({ error: `Microsoft Graph auth failed: ${err.message}` }, 500, headers);
  }

  // ── 4. Find Excel row by slug ──────────────────────────────────────────────
  let excelRows;
  try {
    excelRows = await getExcelRows(graphToken, env);
    console.log('[FFX] Excel rows fetched:', excelRows.length);
  } catch (err) {
    console.log('[FFX] Excel read failed:', err.message);
    return resp({ error: `Excel read failed: ${err.message}` }, 500, headers);
  }

  // Find matching row (skip header row index 0)
  const rowIndex = excelRows.findIndex((r, i) => i > 0 && r[COL.slug] === slug);
  const existingRow = rowIndex > 0 ? excelRows[rowIndex] : null;

  console.log('[FFX] Excel row found:', rowIndex > 0 ? `row ${rowIndex + 1}` : 'none');

  // ── 5. Determine which platforms need posting ──────────────────────────────
  const needsBlog     = !existingRow || existingRow[COL.blog]     !== 'Yes';
  const needsX        = !existingRow || existingRow[COL.x]        !== 'Yes';
  const needsLinkedIn = !existingRow || existingRow[COL.linkedin]  !== 'Yes';
  const needsDiscord  = !existingRow || existingRow[COL.discord]   !== 'Yes';

  console.log('[FFX] Platform needs:', { needsBlog, needsX, needsLinkedIn, needsDiscord });

  // ── 6. Run platforms ───────────────────────────────────────────────────────
  const status = {
    blog:     existingRow?.[COL.blog]     === 'Yes' ? 'skipped' : 'pending',
    x:        existingRow?.[COL.x]        === 'Yes' ? 'skipped' : 'pending',
    linkedin: existingRow?.[COL.linkedin]  === 'Yes' ? 'skipped' : 'pending',
    discord:  existingRow?.[COL.discord]   === 'Yes' ? 'skipped' : 'pending',
  };

  const baseUrl = new URL(request.url).origin;

  // Blog
  if (needsBlog) {
    try {
      const res = await callWorker(`${baseUrl}/publish`, content);
      if (res.ok) {
        status.blog = 'Yes';
        console.log('[FFX] Blog published');
      } else {
        const err = await res.json().catch(() => ({}));
        status.blog = `Error: ${err.error || res.status}`;
        console.log('[FFX] Blog failed:', status.blog);
      }
    } catch (err) {
      status.blog = `Error: ${err.message}`;
      console.log('[FFX] Blog error:', err.message);
    }
  }

  // X (Twitter)
  if (needsX) {
    try {
      const res = await callWorker(`${baseUrl}/tweet`, { slug });
      if (res.ok) {
        status.x = 'Yes';
        console.log('[FFX] X posted');
      } else {
        const err = await res.json().catch(() => ({}));
        status.x = `Error: ${err.message || res.status}`;
        console.log('[FFX] X failed:', status.x);
      }
    } catch (err) {
      status.x = `Error: ${err.message}`;
      console.log('[FFX] X error:', err.message);
    }
  }

  // LinkedIn
  if (needsLinkedIn) {
    try {
      const res = await callWorker(`${baseUrl}/linkedin`, { slug });
      if (res.ok) {
        status.linkedin = 'Yes';
        console.log('[FFX] LinkedIn posted');
      } else {
        const err = await res.json().catch(() => ({}));
        status.linkedin = `Error: ${err.message || res.status}`;
        console.log('[FFX] LinkedIn failed:', status.linkedin);
      }
    } catch (err) {
      status.linkedin = `Error: ${err.message}`;
      console.log('[FFX] LinkedIn error:', err.message);
    }
  }

  // Discord
  if (needsDiscord) {
    try {
      const res = await callWorker(`${baseUrl}/discord`, { slug });
      if (res.ok) {
        status.discord = 'Yes';
        console.log('[FFX] Discord posted');
      } else {
        const err = await res.json().catch(() => ({}));
        status.discord = `Error: ${err.message || res.status}`;
        console.log('[FFX] Discord failed:', status.discord);
      }
    } catch (err) {
      status.discord = `Error: ${err.message}`;
      console.log('[FFX] Discord error:', err.message);
    }
  }

  // ── 7. Update or add Excel row ─────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0];
  const ytUrl = content.youtubeUrl || content.yt_url || '';

  try {
    if (existingRow && rowIndex > 0) {
      await updateExcelRow(graphToken, env, rowIndex, status, existingRow);
      console.log('[FFX] Excel row updated at index', rowIndex);
    } else {
      await appendExcelRow(graphToken, env, [
        slug,
        content.title || '',
        today,
        status.blog,
        status.x,
        status.linkedin,
        'Manual',
        'No',
        ytUrl,
        status.discord,
      ]);
      console.log('[FFX] Excel new row added');
    }
  } catch (err) {
    console.log('[FFX] Excel write failed (non-fatal):', err.message);
  }

  // ── 8. Clean up KV ────────────────────────────────────────────────────────
  const videoId = extractVideoId(content.youtubeUrl || '');
  if (videoId) await env.FFX_CONTENT.delete(`video:${videoId}`);
  await env.FFX_CONTENT.delete(`slug:${slug}`);
  console.log('[FFX] KV cleaned up');

  // ── 9. Return full status ──────────────────────────────────────────────────
  return resp({ success: true, slug, status }, 200, headers);
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
// MICROSOFT GRAPH HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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
    throw new Error(`Token request failed ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

function driveItemUrl(env, path) {
  // Access via SharePoint personal site drive
  const userPath = env.MS_USER_PATH; // personal/salmankhanfx_fortitudefx_com
  return `https://graph.microsoft.com/v1.0/sites/${env.MS_SHAREPOINT_HOST}:/${userPath}:/drive/items/${env.MS_FILE_ID}/workbook${path}`;
}

async function getExcelRows(token, env) {
  const url = driveItemUrl(env, `/worksheets('${SHEET_NAME}')/usedRange`);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Excel read failed ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.values || [];
}

async function updateExcelRow(token, env, rowIndex, newStatus, existingRow) {
  // rowIndex is 0-based array index — convert to 1-based Excel row (add 1 for header)
  const excelRowNumber = rowIndex + 1; // +1 because row 0 in array = row 1 in Excel (header), so row 1 in array = row 2 in Excel

  const updatedRow = [...existingRow];
  if (newStatus.blog     !== 'skipped') updatedRow[COL.blog]     = newStatus.blog;
  if (newStatus.x        !== 'skipped') updatedRow[COL.x]        = newStatus.x;
  if (newStatus.linkedin !== 'skipped') updatedRow[COL.linkedin]  = newStatus.linkedin;
  if (newStatus.discord  !== 'skipped') updatedRow[COL.discord]   = newStatus.discord;

  const url = driveItemUrl(env, `/worksheets('${SHEET_NAME}')/rows/itemAt(index=${excelRowNumber})`);

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [updatedRow] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Excel update failed ${res.status}: ${err}`);
  }
}

async function appendExcelRow(token, env, rowValues) {
  // Get current used range to find next empty row
  const rows = await getExcelRows(token, env);
  const nextRow = rows.length + 1; // 1-based, rows.length includes header

  const colEnd = String.fromCharCode(64 + rowValues.length); // A=65, so 64+length gives correct col
  const rangeAddr = `A${nextRow}:${colEnd}${nextRow}`;

  const url = driveItemUrl(env, `/worksheets('${SHEET_NAME}')/range(address='${rangeAddr}')`);

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [rowValues] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Excel append failed ${res.status}: ${err}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function callWorker(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const parts = u.pathname.split('/');
      const si = parts.indexOf('shorts');
      if (si !== -1) return parts[si + 1];
    }
  } catch {}
  return null;
}

function resp(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
