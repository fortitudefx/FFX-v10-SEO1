// ─────────────────────────────────────────────────────────────────────────────
// FFX Publish Confirm — Master Orchestrator
// No Make.com. No KV deletion. Cloudflare only.
//
// Flow:
// 1. Read content from KV by slug
// 2. Get Microsoft Graph token (client credentials)
// 3. Find Excel row by slug
// 4. Run only platforms passed in request that are not Yes/Skipped in Excel
// 5. Update Excel after each platform
// 6. Return full status to generate.html
//
// Excel values: Yes / Skipped / Error: {detail} / empty
// ─────────────────────────────────────────────────────────────────────────────

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

  console.log('[FFX] publish-confirm: request received');

  // ── 1. Parse request ───────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); } catch {
    return resp({ error: 'Invalid JSON body' }, 400, headers);
  }

  const { slug, platforms } = body;
  if (!slug) return resp({ error: 'slug is required' }, 400, headers);

  // platforms = { blog: true, x: true, linkedin: false, discord: true }
  // true = user wants to post, false = user skipped by design
  const userSelected = platforms || { blog: true, x: true, linkedin: true, discord: true };

  console.log('[FFX] publish-confirm slug:', slug, 'platforms:', userSelected);

  // ── 2. Read content from KV ────────────────────────────────────────────────
  const stored = await env.FFX_CONTENT.get(`slug:${slug}`);
  if (!stored) {
    return resp({ error: 'Content not found or expired. Please generate again.' }, 404, headers);
  }

  let content;
  try { content = JSON.parse(stored); } catch {
    return resp({ error: 'Stored content is corrupted. Please generate again.' }, 500, headers);
  }

  // ── 3. Get Microsoft Graph token ───────────────────────────────────────────
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

  const rowIndex = excelRows.findIndex((r, i) => i > 0 && r[COL.slug] === slug);
  const existingRow = rowIndex > 0 ? excelRows[rowIndex] : null;

  console.log('[FFX] Excel row found:', rowIndex > 0 ? `row ${rowIndex + 1}` : 'none');

  // ── 5. Build platform run list ─────────────────────────────────────────────
  // Run platform if: user selected it AND Excel does not show Yes or Skipped
  const shouldRun = (platform, colIndex) => {
    if (!userSelected[platform]) return false; // user unchecked = skip by design
    const excelVal = existingRow?.[colIndex] || '';
    if (excelVal === 'Yes' || excelVal === 'Skipped') return false;
    return true;
  };

  const runBlog     = shouldRun('blog',     COL.blog);
  const runX        = shouldRun('x',        COL.x);
  const runLinkedIn = shouldRun('linkedin', COL.linkedin);
  const runDiscord  = shouldRun('discord',  COL.discord);

  console.log('[FFX] Will run:', { runBlog, runX, runLinkedIn, runDiscord });

  // ── 6. Build initial status ────────────────────────────────────────────────
  const getInitialStatus = (platform, colIndex) => {
    if (!userSelected[platform]) return 'Skipped';
    const excelVal = existingRow?.[colIndex] || '';
    if (excelVal === 'Yes') return 'Yes';
    if (excelVal === 'Skipped') return 'Skipped';
    return 'pending';
  };

  const status = {
    blog:     getInitialStatus('blog',     COL.blog),
    x:        getInitialStatus('x',        COL.x),
    linkedin: getInitialStatus('linkedin', COL.linkedin),
    discord:  getInitialStatus('discord',  COL.discord),
  };

  const baseUrl = new URL(request.url).origin;

  // ── 7. Run platforms ───────────────────────────────────────────────────────

  // Blog
  if (runBlog) {
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
    }
  }

  // X
  if (runX) {
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
    }
  }

  // LinkedIn
  if (runLinkedIn) {
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
    }
  }

  // Discord
  if (runDiscord) {
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
    }
  }

  // ── 8. Update or add Excel row ─────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0];
  const ytUrl = content.youtubeUrl || content.yt_url || '';

  try {
    if (existingRow && rowIndex > 0) {
      await updateExcelRow(graphToken, env, rowIndex, status, existingRow, userSelected);
      console.log('[FFX] Excel row updated');
    } else {
      await appendExcelRow(graphToken, env, [
        slug,
        content.title || '',
        today,
        userSelected.blog     ? status.blog     : 'Skipped',
        userSelected.x        ? status.x        : 'Skipped',
        userSelected.linkedin ? status.linkedin  : 'Skipped',
        'Manual',
        'No',
        ytUrl,
        userSelected.discord  ? status.discord  : 'Skipped',
      ]);
      console.log('[FFX] Excel new row added');
    }
  } catch (err) {
    console.log('[FFX] Excel write failed (non-fatal):', err.message);
  }

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

function workbookUrl(env, path) {
  return `https://graph.microsoft.com/v1.0/sites/${env.MS_SHAREPOINT_HOST}/drive/items/${env.MS_FILE_ID}/workbook${path}`;
}

async function getExcelRows(token, env) {
  const url = workbookUrl(env, `/worksheets('${SHEET_NAME}')/usedRange`);
  console.log('[FFX] Excel read URL:', url);

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

async function updateExcelRow(token, env, rowIndex, newStatus, existingRow, userSelected) {
  const updatedRow = [...existingRow];

  // Only update columns for platforms that actually ran this session
  if (userSelected.blog     && newStatus.blog     !== 'pending') updatedRow[COL.blog]     = newStatus.blog     === 'Yes' ? 'Yes' : newStatus.blog;
  if (userSelected.x        && newStatus.x        !== 'pending') updatedRow[COL.x]        = newStatus.x        === 'Yes' ? 'Yes' : newStatus.x;
  if (userSelected.linkedin && newStatus.linkedin  !== 'pending') updatedRow[COL.linkedin]  = newStatus.linkedin  === 'Yes' ? 'Yes' : newStatus.linkedin;
  if (userSelected.discord  && newStatus.discord   !== 'pending') updatedRow[COL.discord]   = newStatus.discord   === 'Yes' ? 'Yes' : newStatus.discord;

  // Mark unselected platforms as Skipped only if they were empty before
  if (!userSelected.blog     && !existingRow[COL.blog])     updatedRow[COL.blog]     = 'Skipped';
  if (!userSelected.x        && !existingRow[COL.x])        updatedRow[COL.x]        = 'Skipped';
  if (!userSelected.linkedin && !existingRow[COL.linkedin])  updatedRow[COL.linkedin]  = 'Skipped';
  if (!userSelected.discord  && !existingRow[COL.discord])   updatedRow[COL.discord]   = 'Skipped';

  const url = workbookUrl(env, `/worksheets('${SHEET_NAME}')/rows/itemAt(index=${rowIndex})`);

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
  const rows = await getExcelRows(token, env);
  const nextRow = rows.length + 1;
  const colEnd = String.fromCharCode(64 + rowValues.length);
  const rangeAddr = `A${nextRow}:${colEnd}${nextRow}`;

  const url = workbookUrl(env, `/worksheets('${SHEET_NAME}')/range(address='${rangeAddr}')`);

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

function resp(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
