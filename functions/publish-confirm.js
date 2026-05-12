// ─────────────────────────────────────────────────────────────────────────────
// FFX Publish Confirm — Master Orchestrator
//
// 1. Read Excel to check platform statuses
// 2. Call platform Workers with content directly (no GitHub race condition)
// 3. Update Excel row using range address (not rows/itemAt which fails on SharePoint)
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

  // rowIndex is 0-based in the array (row 0 = header)
  const rowIndex = excelRows.findIndex((r, i) => i > 0 && r[COL.slug] === slug);
  const existingRow = rowIndex > 0 ? excelRows[rowIndex] : null;

  console.log('[FFX] Excel row found:', rowIndex > 0 ? `array index ${rowIndex} = Excel row ${rowIndex + 1}` : 'none');

  // ── Determine what to run ──────────────────────────────────────────────────
  const shouldRun = (platform, colIndex) => {
    if (!userSelected[platform]) return false;
    return true;
  };

  const getInit = (platform, colIndex) => {
    if (!userSelected[platform]) return 'not_selected';
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

  // ── ALWAYS write articles.json first ─────────────────────────────────────
  // Ensures Load Existing Content returns fresh data
  // and platform Workers always have current articles.json
  const blogNeedsRun = userSelected.blog && shouldRun('blog', COL.blog);
  try {
    const res = await callWorker(`${baseUrl}/publish`, {
      ...content,
      skipSitemapAndIndex: !blogNeedsRun,
    });
    if (blogNeedsRun) {
      status.blog = res.ok ? 'Yes' : `Error: ${(await res.json().catch(() => ({}))).error || res.status}`;
      console.log('[FFX] Blog:', status.blog);
    } else {
      console.log('[FFX] articles.json written (content only, blog not selected)');
    }
  } catch (err) {
    if (blogNeedsRun) status.blog = `Error: ${err.message}`;
    console.log('[FFX] publish error:', err.message);
  }

  // ── X — content passed directly ────────────────────────────────────────────
  if (shouldRun('x', COL.x)) {
    try {
      const res = await callWorker(`${baseUrl}/tweet`, {
        slug,
        tweet1: content.tweet1, tweet2: content.tweet2,
        tweet3: content.tweet3, tweet4: content.tweet4,
        tweet5: content.tweet5, tweet6: content.tweet6,
      });
      status.x = res.ok ? 'Yes' : `Error: ${(await res.json().catch(() => ({}))).message || res.status}`;
      console.log('[FFX] X:', status.x);
    } catch (err) {
      status.x = `Error: ${err.message}`;
    }
  }

  // ── LinkedIn — content passed directly ─────────────────────────────────────
  if (shouldRun('linkedin', COL.linkedin)) {
    try {
      const res = await callWorker(`${baseUrl}/linkedin`, {
        slug, linkedin: content.linkedin,
      });
      const liData = await res.json().catch(() => ({}));
      status.linkedin = res.ok ? 'Yes' : `Error: ${(await res.json().catch(() => ({}))).message || res.status}`;
      console.log('[FFX] LinkedIn:', status.linkedin);
    } catch (err) {
      status.linkedin = `Error: ${err.message}`;
    }
  }

  // ── Discord — content passed directly ──────────────────────────────────────
  if (shouldRun('discord', COL.discord)) {
    try {
      const res = await callWorker(`${baseUrl}/discord`, {
        slug, discord: content.discord,
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
      // Update existing row — rowIndex is 0-based array index
      // Excel row number = rowIndex + 1 (1-based, header is row 1)
      await updateExcelRow(graphToken, env, rowIndex + 1, status, existingRow, userSelected, excelRows[0].length);
    } else {
      await appendExcelRow(graphToken, env, [
        slug,
        content.title || '',
        today,
        userSelected.blog     ? status.blog     : '',
        userSelected.x        ? status.x        : '',
        userSelected.linkedin ? status.linkedin  : '',
        'Manual',
        'No',
        ytUrl,
        userSelected.discord  ? status.discord  : '',
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

async function updateExcelRow(token, env, excelRowNumber, newStatus, existingRow, userSelected, numCols) {
  // Build updated row — only touch cells for platforms that ran this session
  const row = [...existingRow];

  if (userSelected.blog     && newStatus.blog     !== 'pending' && newStatus.blog     !== 'not_selected') row[COL.blog]     = newStatus.blog;
  if (userSelected.x        && newStatus.x        !== 'pending' && newStatus.x        !== 'not_selected') row[COL.x]        = newStatus.x;
  if (userSelected.linkedin && newStatus.linkedin  !== 'pending' && newStatus.linkedin  !== 'not_selected') row[COL.linkedin]  = newStatus.linkedin;
  if (userSelected.discord  && newStatus.discord   !== 'pending' && newStatus.discord   !== 'not_selected') row[COL.discord]   = newStatus.discord;

  // Use range address — more reliable than rows/itemAt on SharePoint
  // excelRowNumber is 1-based (header=1, first data row=2)
  const colEnd = String.fromCharCode(64 + row.length);
  const rangeAddr = `A${excelRowNumber}:${colEnd}${excelRowNumber}`;

  console.log('[FFX] Updating Excel range:', rangeAddr);

  const res = await fetch(workbookUrl(env, `/worksheets('${SHEET_NAME}')/range(address='${rangeAddr}')`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) throw new Error(`Excel update ${res.status}: ${await res.text()}`);
}

async function appendExcelRow(token, env, rowValues) {
  const rows = await getExcelRows(token, env);
  const nextRow = rows.length + 1; // 1-based, after all existing rows
  const colEnd = String.fromCharCode(64 + rowValues.length);
  const rangeAddr = `A${nextRow}:${colEnd}${nextRow}`;

  console.log('[FFX] Appending Excel row at:', rangeAddr);

  const res = await fetch(workbookUrl(env, `/worksheets('${SHEET_NAME}')/range(address='${rangeAddr}')`), {
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
