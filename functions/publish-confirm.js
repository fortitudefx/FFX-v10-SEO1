// ─────────────────────────────────────────────────────────────────────────────
// FFX Publish Confirm — Master Orchestrator
//
// Receives full content from browser.
// Passes content fields DIRECTLY to platform Workers — no GitHub fetch needed.
// Workers post immediately with the content they receive.
// articles.json is written by /publish in parallel — platform Workers don't wait for it.
//
// Sequence:
// 1. Write to articles.json via /publish (async)
// 2. Call platform Workers with content directly
// 3. Update Excel
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

  console.log('[FFX] publish-confirm received');

  let body;
  try { body = await request.json(); } catch {
    return resp({ error: 'Invalid JSON body' }, 400, headers);
  }

  const { content, platforms } = body;

  if (!content || !content.slug) {
    return resp({ error: 'content with slug is required' }, 400, headers);
  }

  const slug = content.slug;
  const userSelected = platforms || { blog: true, x: true, linkedin: true, discord: true };

  console.log('[FFX] slug:', slug, 'platforms:', userSelected);

  // ── Get Graph token ────────────────────────────────────────────────────────
  let graphToken;
  try {
    graphToken = await getGraphToken(env);
  } catch (err) {
    return resp({ error: `Graph auth failed: ${err.message}` }, 500, headers);
  }

  // ── Read Excel ─────────────────────────────────────────────────────────────
  let excelRows;
  try {
    excelRows = await getExcelRows(graphToken, env);
  } catch (err) {
    return resp({ error: `Excel read failed: ${err.message}` }, 500, headers);
  }

  const rowIndex = excelRows.findIndex((r, i) => i > 0 && r[COL.slug] === slug);
  const existingRow = rowIndex > 0 ? excelRows[rowIndex] : null;

  // ── Determine what to run ──────────────────────────────────────────────────
  const shouldRun = (platform, colIndex) => {
    if (!userSelected[platform]) return false;
    const val = existingRow?.[colIndex] || '';
    return val !== 'Yes' && val !== 'Skipped';
  };

  const getInit = (platform, colIndex) => {
    if (!userSelected[platform]) return 'Skipped';
    const val = existingRow?.[colIndex] || '';
    if (val === 'Yes' || val === 'Skipped') return val;
    return 'pending';
  };

  const status = {
    blog:     getInit('blog',     COL.blog),
    x:        getInit('x',        COL.x),
    linkedin: getInit('linkedin', COL.linkedin),
    discord:  getInit('discord',  COL.discord),
  };

  const baseUrl = new URL(request.url).origin;

  // ── Blog — write to articles.json + sitemap + Google index ────────────────
  if (shouldRun('blog', COL.blog)) {
    try {
      const res = await callWorker(`${baseUrl}/publish`, content);
      status.blog = res.ok ? 'Yes' : `Error: ${(await res.json().catch(() => ({}))).error || res.status}`;
      console.log('[FFX] Blog:', status.blog);
    } catch (err) {
      status.blog = `Error: ${err.message}`;
    }
  }

  // ── X — pass tweet content directly, no GitHub fetch ──────────────────────
  if (shouldRun('x', COL.x)) {
    try {
      const res = await callWorker(`${baseUrl}/tweet`, {
        slug,
        tweet1: content.tweet1,
        tweet2: content.tweet2,
        tweet3: content.tweet3,
        tweet4: content.tweet4,
        tweet5: content.tweet5,
        tweet6: content.tweet6,
      });
      status.x = res.ok ? 'Yes' : `Error: ${(await res.json().catch(() => ({}))).message || res.status}`;
      console.log('[FFX] X:', status.x);
    } catch (err) {
      status.x = `Error: ${err.message}`;
    }
  }

  // ── LinkedIn — pass linkedin content directly, no GitHub fetch ─────────────
  if (shouldRun('linkedin', COL.linkedin)) {
    try {
      const res = await callWorker(`${baseUrl}/linkedin`, {
        slug,
        linkedin: content.linkedin,
      });
      status.linkedin = res.ok ? 'Yes' : `Error: ${(await res.json().catch(() => ({}))).message || res.status}`;
      console.log('[FFX] LinkedIn:', status.linkedin);
    } catch (err) {
      status.linkedin = `Error: ${err.message}`;
    }
  }

  // ── Discord — pass discord content directly, no GitHub fetch ───────────────
  if (shouldRun('discord', COL.discord)) {
    try {
      const res = await callWorker(`${baseUrl}/discord`, {
        slug,
        discord: content.discord,
      });
      status.discord = res.ok ? 'Yes' : `Error: ${(await res.json().catch(() => ({}))).message || res.status}`;
      console.log('[FFX] Discord:', status.discord);
    } catch (err) {
      status.discord = `Error: ${err.message}`;
    }
  }

  // ── Update or add Excel row ────────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0];
  const ytUrl = content.youtubeUrl || content.yt_url || '';

  try {
    if (existingRow && rowIndex > 0) {
      await updateExcelRow(graphToken, env, rowIndex, status, existingRow, userSelected);
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
    }
    console.log('[FFX] Excel updated');
  } catch (err) {
    console.log('[FFX] Excel write failed (non-fatal):', err.message);
  }

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
// GRAPH HELPERS
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
  if (!res.ok) throw new Error(`Token failed ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

function workbookUrl(env, path) {
  return `https://graph.microsoft.com/v1.0/sites/${env.MS_SHAREPOINT_HOST}/drive/items/${env.MS_FILE_ID}/workbook${path}`;
}

async function getExcelRows(token, env) {
  const res = await fetch(workbookUrl(env, `/worksheets('${SHEET_NAME}')/usedRange`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Excel read ${res.status}: ${await res.text()}`);
  return (await res.json()).values || [];
}

async function updateExcelRow(token, env, rowIndex, newStatus, existingRow, userSelected) {
  const row = [...existingRow];
  if (userSelected.blog     && newStatus.blog     !== 'pending') row[COL.blog]     = newStatus.blog;
  if (userSelected.x        && newStatus.x        !== 'pending') row[COL.x]        = newStatus.x;
  if (userSelected.linkedin && newStatus.linkedin  !== 'pending') row[COL.linkedin]  = newStatus.linkedin;
  if (userSelected.discord  && newStatus.discord   !== 'pending') row[COL.discord]   = newStatus.discord;
  if (!userSelected.blog     && !existingRow[COL.blog])     row[COL.blog]     = 'Skipped';
  if (!userSelected.x        && !existingRow[COL.x])        row[COL.x]        = 'Skipped';
  if (!userSelected.linkedin && !existingRow[COL.linkedin])  row[COL.linkedin]  = 'Skipped';
  if (!userSelected.discord  && !existingRow[COL.discord])   row[COL.discord]   = 'Skipped';

  const res = await fetch(workbookUrl(env, `/worksheets('${SHEET_NAME}')/rows/itemAt(index=${rowIndex})`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Excel update ${res.status}: ${await res.text()}`);
}

async function appendExcelRow(token, env, rowValues) {
  const rows = await getExcelRows(token, env);
  const nextRow = rows.length + 1;
  const colEnd = String.fromCharCode(64 + rowValues.length);
  const res = await fetch(workbookUrl(env, `/worksheets('${SHEET_NAME}')/range(address='A${nextRow}:${colEnd}${nextRow}')`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [rowValues] }),
  });
  if (!res.ok) throw new Error(`Excel append ${res.status}: ${await res.text()}`);
}

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
