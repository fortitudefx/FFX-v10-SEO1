// FFX /publish Worker
// 1. Saves article to articles.json
// 2. Rebuilds sitemap.xml
// 3. Pings Google Indexing API

export async function onRequestPost(context) {
  const { request, env } = context;

  const GITHUB_TOKEN  = env.GITHUB_TOKEN;
  const GITHUB_OWNER  = 'fortitudefx';
  const GITHUB_REPO   = 'FFX-v10-SEO1';
  const GITHUB_BRANCH = 'main';

  const GOOGLE_SA_EMAIL = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const GOOGLE_SA_KEY   = env.GOOGLE_PRIVATE_KEY;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const { slug, title, excerpt, category, tags, readTime, body: articleBody, date } = body;

    if (!slug || !title || !articleBody) {
      return new Response(JSON.stringify({ error: 'Missing required fields: slug, title, body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const articleDate = date || new Date().toISOString().split('T')[0];

    // ── 1. READ current articles.json ──────────────────────────────────────
    const articlesUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/articles.json?ref=${GITHUB_BRANCH}`;
    const articlesRes = await fetch(articlesUrl, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'FFX-Worker' }
    });

    let articles = [];
    let articlesSha = null;

    if (articlesRes.ok) {
      const articlesData = await articlesRes.json();
      articlesSha = articlesData.sha;
      articles = JSON.parse(atob(articlesData.content.replace(/\n/g, '')));
    }

    // Dedup by slug
    const exists = articles.findIndex(a => a.slug === slug);
    const newArticle = {
      slug,
      title,
      excerpt: excerpt || '',
      category: category || 'Trading',
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
      readTime: readTime || '5 min read',
      date: articleDate,
      body: articleBody
    };

    if (exists >= 0) {
      articles[exists] = newArticle;
    } else {
      articles.unshift(newArticle);
    }

    // ── 2. WRITE articles.json ─────────────────────────────────────────────
    const articlesPayload = {
      message: `publish: ${slug}`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(articles, null, 2)))),
      branch: GITHUB_BRANCH,
      ...(articlesSha && { sha: articlesSha })
    };

    const writeArticles = await fetch(articlesUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'FFX-Worker',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(articlesPayload)
    });

    if (!writeArticles.ok) {
      const err = await writeArticles.text();
      return new Response(JSON.stringify({ error: 'Failed to write articles.json', detail: err }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── 3. REBUILD sitemap.xml ─────────────────────────────────────────────
    const staticPages = [
      { loc: 'https://fortitudefx.com/',           lastmod: '2026-04-26', changefreq: 'weekly',  priority: '1.0' },
      { loc: 'https://fortitudefx.com/bootcamp',   lastmod: '2026-04-26', changefreq: 'weekly',  priority: '0.9' },
      { loc: 'https://fortitudefx.com/vipdiscord', lastmod: '2026-04-26', changefreq: 'weekly',  priority: '0.9' },
      { loc: 'https://fortitudefx.com/waitlist',   lastmod: '2026-04-26', changefreq: 'weekly',  priority: '0.7' },
      { loc: 'https://fortitudefx.com/blog',       lastmod: '2026-04-26', changefreq: 'weekly',  priority: '0.8' },
      { loc: 'https://fortitudefx.com/privacy',    lastmod: '2026-04-26', changefreq: 'yearly',  priority: '0.3' },
    ];

    const articleEntries = articles.map(a => ({
      loc: `https://fortitudefx.com/article?slug=${a.slug}`,
      lastmod: a.date || articleDate,
      changefreq: 'monthly',
      priority: '0.7'
    }));

    const allUrls = [...staticPages, ...articleEntries];

    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

    const sitemapUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/sitemap.xml?ref=${GITHUB_BRANCH}`;
    const sitemapRes = await fetch(sitemapUrl, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'FFX-Worker' }
    });

    let sitemapSha = null;
    if (sitemapRes.ok) {
      const sitemapData = await sitemapRes.json();
      sitemapSha = sitemapData.sha;
    }

    const sitemapPayload = {
      message: `sitemap: add ${slug}`,
      content: btoa(unescape(encodeURIComponent(sitemapXml))),
      branch: GITHUB_BRANCH,
      ...(sitemapSha && { sha: sitemapSha })
    };

    await fetch(sitemapUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'FFX-Worker',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sitemapPayload)
    });

    // ── 4. PING Google Indexing API ────────────────────────────────────────
    try {
      const articleUrl = `https://fortitudefx.com/article?slug=${slug}`;
      const token = await getGoogleAccessToken(GOOGLE_SA_EMAIL, GOOGLE_SA_KEY);
      await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: articleUrl, type: 'URL_UPDATED' })
      });
    } catch (indexErr) {
      // Non-fatal — article and sitemap already saved
      console.error('Google Indexing API error:', indexErr.message);
    }

    // ── 5. DONE ────────────────────────────────────────────────────────────
    return new Response(JSON.stringify({ success: true, slug }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
    });
  }
}

// ── JWT helper for Google Service Account auth ─────────────────────────────
async function getGoogleAccessToken(serviceAccountEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const encode = obj => btoa(JSON.stringify(obj))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const unsignedToken = `${encode(header)}.${encode(payload)}`;

  // Clean up PEM key
  const pemContents = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\\n/g, '')
    .replace(/\n/g, '')
    .trim();

  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(unsignedToken)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${unsignedToken}.${signatureB64}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}
