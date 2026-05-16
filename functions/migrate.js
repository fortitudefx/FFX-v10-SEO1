// ─────────────────────────────────────────────────────────────────────────────
// FFX Migration Worker — ONE TIME USE
// POST /migrate → reads articles.json + Excel → writes all entries to KV
// Delete this file after migration is confirmed complete
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_NAME = 'FFX Articles';
const GITHUB_RAW = 'https://raw.githubusercontent.com/fortitudefx/FFX-v10-SEO1/main/articles.json';

const COL = {
  lastUpdated: 0, // A
  slug:        1, // B
  title:       2, // C
  date:        3, // D
  blog:        4, // E
  x:           5, // F
  linkedin:    6, // G
  medium:      7, // H
  tumblr:      8, // I
  yt_url:      9, // J
  discord:     10, // K
};

export async function onRequestPost(context) {
  const { env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV binding not found' }), { status: 500, headers });
  }

  const results = [];

  // ── 1. Read articles.json from GitHub ─────────────────────────────────────
  let articles = [];
  try {
    const res = await fetch(GITHUB_RAW, { headers: { 'User-Agent': 'FFX-Migration' } });
    if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status}`);
    articles = await res.json();
    console.log('[FFX Migrate] articles.json loaded:', articles.length, 'articles');
  } catch (err) {
    return new Response(JSON.stringify({ error: `articles.json read failed: ${err.message}` }), { status: 500, headers });
  }

  // ── 2. Read Excel via Graph API ────────────────────────────────────────────
  let excelRows = [];
  try {
    const token = await getGraphToken(env);
    const url = `https://graph.microsoft.com/v1.0/sites/${env.MS_SHAREPOINT_HOST}/drive/items/${env.MS_FILE_ID}/workbook/worksheets('${SHEET_NAME}')/usedRange?$select=formulas`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Excel read failed: ${res.status}`);
    excelRows = (await res.json()).formulas || [];
    console.log('[FFX Migrate] Excel rows loaded:', excelRows.length - 1, 'data rows');
  } catch (err) {
    console.log('[FFX Migrate] Excel read failed (non-fatal):', err.message);
  }

  // Build Excel lookup by slug
  const excelBySlug = {};
  const excelByYtUrl = {};
  for (let i = 1; i < excelRows.length; i++) {
    const row = excelRows[i];
    const slug = row[COL.slug] || '';
    const ytUrl = row[COL.yt_url] || '';
    if (slug) excelBySlug[slug] = row;
    if (ytUrl) excelByYtUrl[normaliseYtUrl(ytUrl)] = row;
  }

  // ── 3. Migrate each article ────────────────────────────────────────────────
  for (const article of articles) {
    const { slug, title, excerpt, category, tags, readTime, date, yt_url, youtubeUrl } = article;
    const ytUrlRaw = youtubeUrl || yt_url || '';
    const videoId = extractVideoId(ytUrlRaw);
    const now = new Date().toISOString();

    // Find matching Excel row
    const excelRow = excelBySlug[slug] || excelByYtUrl[normaliseYtUrl(ytUrlRaw)] || null;

    // Build platform status from Excel row
    const platforms = {};
    if (excelRow) {
      const mapStatus = (val) => {
        if (!val || val === '') return { status: 'pending', updatedAt: now };
        return { status: String(val), updatedAt: excelRow[COL.lastUpdated] || now };
      };
      platforms.blog     = mapStatus(excelRow[COL.blog]);
      platforms.x        = mapStatus(excelRow[COL.x]);
      platforms.linkedin = mapStatus(excelRow[COL.linkedin]);
      platforms.tumblr   = mapStatus(excelRow[COL.tumblr]);
      platforms.discord  = mapStatus(excelRow[COL.discord]);
    }

    // Build article metadata for article:{slug}
    const articleMeta = {
      slug,
      title: title || '',
      excerpt: excerpt || '',
      category: category || 'Strategy',
      tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()) : []),
      readTime: readTime || '5 min read',
      date: date || '',
      region: article.region || 'Global',
      youtubeUrl: ytUrlRaw,
      videoId: videoId || '',
      createdAt: date || now,
      migratedAt: now,
    };

    // Build full video entry for video:{videoId}
    const videoEntry = {
      videoId: videoId || slug,
      youtubeUrl: ytUrlRaw,
      slug,
      title: title || '',
      region: article.region || 'Global',
      regionCycleIndex: 0,
      createdAt: date || now,
      updatedAt: now,
      migratedAt: now,
      content: article,
      platforms,
    };

    // Write to KV
    try {
      await env.FFX_KV.put(`article:${slug}`, JSON.stringify(articleMeta));

      const kvKey = videoId ? `video:${videoId}` : `video:slug:${slug}`;
      await env.FFX_KV.put(kvKey, JSON.stringify(videoEntry));

      results.push({
        slug,
        videoId: videoId || null,
        title: title || '',
        excelFound: !!excelRow,
        platforms: Object.keys(platforms).length > 0 ? platforms : 'no excel data',
        status: 'success',
      });

      console.log('[FFX Migrate] Migrated:', slug, '| videoId:', videoId || 'none');
    } catch (err) {
      results.push({ slug, status: 'error', error: err.message });
      console.log('[FFX Migrate] Failed:', slug, err.message);
    }
  }

  // ── 4. Write region cycle config ──────────────────────────────────────────
  try {
    const existing = await env.FFX_KV.get('config:regionCycle');
    if (!existing) {
      await env.FFX_KV.put('config:regionCycle', JSON.stringify(0));
      console.log('[FFX Migrate] Region cycle initialised to 0');
    } else {
      console.log('[FFX Migrate] Region cycle already set:', existing);
    }
  } catch (err) {
    console.log('[FFX Migrate] Region cycle write failed:', err.message);
  }

  return new Response(JSON.stringify({
    success: true,
    migrated: results.filter(r => r.status === 'success').length,
    failed: results.filter(r => r.status === 'error').length,
    total: articles.length,
    results,
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

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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

function normaliseYtUrl(url) {
  return extractVideoId(url) || url;
}

async function getGraphToken(env) {
  const res = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  if (!res.ok) throw new Error(`Token failed ${res.status}`);
  return (await res.json()).access_token;
}
