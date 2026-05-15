// ─────────────────────────────────────────────────────────────────────────────
// FFX Approve Worker
// POST /approve → decode payload → publish to platform → update Excel + config
// Called when Salman taps Approve/Deny in approval email
// No storage — full content payload comes in the POST body from email form
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_NAME = 'FFX Articles';

const COL = {
  lastUpdated: 0,  // A
  slug:        1,  // B
  title:       2,  // C
  date:        3,  // D
  blog:        4,  // E
  x:           5,  // F
  linkedin:    6,  // G
  medium:      7,  // H
  tumblr:      8,  // I
  yt_url:      9,  // J
  discord:     10, // K
  region:      11, // L
};

export async function onRequestPost(context) {
  const { request, env } = context;

  console.log('[FFX Approve] Request received');

  // Parse form POST body
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return htmlResponse('Error', 'Invalid form data.', false);
  }

  const payloadB64 = formData.get('payload');
  const platform   = formData.get('platform');
  const decision   = formData.get('decision');

  if (!payloadB64 || !platform || !decision) {
    return htmlResponse('Error', 'Missing required fields.', false);
  }

  if (decision === 'deny') {
    console.log('[FFX Approve] Denied:', platform);
    return htmlResponse('Denied', `${platform} was denied. Nothing posted.`, true);
  }

  // Decode article payload
  let article;
  try {
    const json = decodeURIComponent(escape(atob(payloadB64)));
    article = JSON.parse(json);
  } catch (err) {
    console.log('[FFX Approve] Payload decode failed:', err.message);
    return htmlResponse('Error', 'Could not decode content payload. Please try again.', false);
  }

  console.log('[FFX Approve] Approving platform:', platform, 'slug:', article.slug);

  const baseUrl = new URL(request.url).origin;
  let result = 'Yes';

  // ── Publish to selected platform ──────────────────────────────────────────
  try {
    if (platform === 'blog') {
      const res = await fetch(`${baseUrl}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...article, skipSitemapAndIndex: false }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        result = `Error: ${err.error || res.status}`;
      }
    } else if (platform === 'x') {
      const res = await fetch(`${baseUrl}/tweet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: article.slug,
          tweet1: article.tweet1, tweet2: article.tweet2,
          tweet3: article.tweet3, tweet4: article.tweet4,
          tweet5: article.tweet5, tweet6: article.tweet6,
        }),
      });
      if (!res.ok) result = `Error: ${res.status}`;
    } else if (platform === 'linkedin') {
      const res = await fetch(`${baseUrl}/linkedin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: article.slug, linkedin: article.linkedin }),
      });
      if (!res.ok) result = `Error: ${res.status}`;
    } else if (platform === 'discord') {
      const res = await fetch(`${baseUrl}/discord`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: article.slug, discord: article.discord }),
      });
      if (!res.ok) result = `Error: ${res.status}`;
    } else if (platform === 'tumblr') {
      const res = await fetch(`${baseUrl}/tumblr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: article.slug, tumblr: article.tumblr }),
      });
      if (!res.ok) result = `Error: ${res.status}`;
    }
  } catch (err) {
    result = `Error: ${err.message}`;
    console.log('[FFX Approve] Platform publish error:', err.message);
  }

  console.log('[FFX Approve] Platform result:', platform, result);

  // ── Update Excel ──────────────────────────────────────────────────────────
  try {
    await updateExcel(env, article, platform, result);
    console.log('[FFX Approve] Excel updated');
  } catch (err) {
    console.log('[FFX Approve] Excel update failed (non-fatal):', err.message);
  }

  // ── Increment region cycle if blog approved for Global article ────────────
  if (platform === 'blog' && result === 'Yes' && article.region === 'Global') {
    try {
      await incrementRegionCycle(env);
      console.log('[FFX Approve] Region cycle incremented');
    } catch (err) {
      console.log('[FFX Approve] Region cycle increment failed (non-fatal):', err.message);
    }
  }

  const success = result === 'Yes';
  return htmlResponse(
    success ? 'Published' : 'Error',
    success
      ? `✅ ${platform.toUpperCase()} published successfully for "${article.title}"`
      : `❌ ${platform.toUpperCase()} failed: ${result}`,
    success
  );
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
// EXCEL
// ─────────────────────────────────────────────────────────────────────────────

async function updateExcel(env, article, platform, result) {
  const token = await getGraphToken(env);
  const rows  = await getExcelRows(token, env);

  const now = new Date();
  const dubaiTime = new Date(now.getTime() + (4 * 60 * 60 * 1000));
  const timestamp = dubaiTime.toISOString().replace('T', ' ').substring(0, 19);
  const today = new Date().toISOString().split('T')[0];

  const rowIndex = rows.findIndex((r, i) => i > 0 && r[COL.slug] === article.slug);

  if (rowIndex > 0) {
    // Update existing row
    const row = [...rows[rowIndex]];
    if (platform === 'blog')     row[COL.blog]     = result;
    if (platform === 'x')        row[COL.x]        = result;
    if (platform === 'linkedin')  row[COL.linkedin]  = result;
    if (platform === 'tumblr')    row[COL.tumblr]    = result;
    if (platform === 'discord')   row[COL.discord]   = result;
    row[COL.region]      = article.region || 'Global';
    row[COL.lastUpdated] = timestamp;
    await writeExcelRow(token, env, rowIndex + 1, row);
  } else {
    // Append new row
    const newRow = Array(12).fill('');
    newRow[COL.lastUpdated] = timestamp;
    newRow[COL.slug]        = article.slug;
    newRow[COL.title]       = article.title || '';
    newRow[COL.date]        = today;
    newRow[COL.yt_url]      = article.youtubeUrl || '';
    newRow[COL.region]      = article.region || 'Global';
    if (platform === 'blog')     newRow[COL.blog]     = result;
    if (platform === 'x')        newRow[COL.x]        = result;
    if (platform === 'linkedin')  newRow[COL.linkedin]  = result;
    if (platform === 'tumblr')    newRow[COL.tumblr]    = result;
    if (platform === 'discord')   newRow[COL.discord]   = result;
    await appendExcelRow(token, env, newRow, rows.length + 1);
  }
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
  if (!res.ok) throw new Error(`Graph token ${res.status}`);
  return (await res.json()).access_token;
}

function workbookUrl(env, path) {
  return `https://graph.microsoft.com/v1.0/sites/${env.MS_SHAREPOINT_HOST}/drive/items/${env.MS_FILE_ID}/workbook${path}`;
}

async function getExcelRows(token, env) {
  const res = await fetch(workbookUrl(env, `/worksheets('${SHEET_NAME}')/usedRange`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Excel read ${res.status}`);
  return (await res.json()).values || [];
}

async function writeExcelRow(token, env, excelRowNumber, row) {
  const colEnd = String.fromCharCode(64 + row.length);
  const rangeAddr = `A${excelRowNumber}:${colEnd}${excelRowNumber}`;
  const res = await fetch(workbookUrl(env, `/worksheets('${SHEET_NAME}')/range(address='${rangeAddr}')`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Excel write ${res.status}`);
}

async function appendExcelRow(token, env, row, nextRow) {
  const colEnd = String.fromCharCode(64 + row.length);
  const rangeAddr = `A${nextRow}:${colEnd}${nextRow}`;
  const res = await fetch(workbookUrl(env, `/worksheets('${SHEET_NAME}')/range(address='${rangeAddr}')`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Excel append ${res.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// REGION CYCLE
// ─────────────────────────────────────────────────────────────────────────────

async function incrementRegionCycle(env) {
  const REGIONS = ['GCC', 'US/Canada', 'EU/UK/Germany', 'SEA/Asia'];
  const GITHUB_TOKEN  = env.GITHUB_TOKEN;
  const GITHUB_OWNER  = 'fortitudefx';
  const GITHUB_REPO   = 'FFX-v10-SEO1';
  const GITHUB_BRANCH = 'main';

  const configPath = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/ffx-config.json?ref=${GITHUB_BRANCH}`;

  const cfgReadRes = await fetch(configPath, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'FFX-Worker' }
  });

  let currentIndex = 0;
  let cfgSha = null;

  if (cfgReadRes.ok) {
    const cfgData = await cfgReadRes.json();
    cfgSha = cfgData.sha;
    const cfgBase64 = cfgData.content.replace(/\n/g, '');
    const binaryStr = atob(cfgBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const cfgParsed = JSON.parse(new TextDecoder().decode(bytes));
    currentIndex = typeof cfgParsed.regionCycleIndex === 'number' ? cfgParsed.regionCycleIndex : 0;
  }

  const nextIndex = (currentIndex + 1) % REGIONS.length;
  const newConfig = { regionCycleIndex: nextIndex, regions: REGIONS };
  const encoded = (() => {
    const b = new TextEncoder().encode(JSON.stringify(newConfig, null, 2));
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  })();

  await fetch(configPath, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'FFX-Worker', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `config: region cycle ${currentIndex} → ${nextIndex} (${REGIONS[nextIndex]})`,
      content: encoded,
      branch: GITHUB_BRANCH,
      ...(cfgSha && { sha: cfgSha })
    })
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML RESPONSE — shown after tap in email
// ─────────────────────────────────────────────────────────────────────────────

function htmlResponse(title, message, success) {
  const color = success ? '#4caf7d' : '#e06060';
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>FFX — ${title}</title></head>
<body style="margin:0;padding:40px 20px;background:#f0f0f4;font-family:'Helvetica Neue',Arial,sans-serif;text-align:center;">
  <div style="max-width:400px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
    <div style="height:6px;background:linear-gradient(90deg,#7c3aed,#f97316);border-radius:3px;margin-bottom:28px;"></div>
    <div style="font-size:36px;margin-bottom:16px;">${success ? '✅' : '❌'}</div>
    <div style="font-size:20px;font-weight:700;color:#111;margin-bottom:12px;">${title}</div>
    <div style="font-size:14px;color:#444;line-height:1.6;">${message}</div>
    <div style="margin-top:24px;font-size:12px;color:#9ca3af;">— Salman / FortitudeFX</div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}
