// FFX /publish Worker
//
// ALWAYS: writes article + all platform content to articles.json
// CONDITIONALLY: rebuilds sitemap + pings Google index
//
// Called by publish-confirm.js:
//   - Always first with skipSitemapAndIndex: true (keeps articles.json current)
//   - When Blog selected: called with skipSitemapAndIndex: false (full publish)
//
// This ensures "Load Existing Content" always returns fresh content
// and platform Workers always have current data in articles.json

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

    const {
      slug, title, excerpt, category, tags, readTime,
      body: articleBody, date,
      linkedin, discord, tumblr, mediumIntro,
      tweet1, tweet2, tweet3, tweet4, tweet5, tweet6,
      x_thread, youtubeUrl, yt_url,
      skipSitemapAndIndex,
    } = body;

    if (!slug || !title || !articleBody) {
      return new Response(JSON.stringify({ error: 'Missing required fields: slug, title, body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const rawDate = date || new Date().toISOString().split('T')[0];
    const articleDate = rawDate.replace(/['"]/g, '').trim();

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
      const base64 = articlesData.content.replace(/\n/g, '');
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      articles = JSON.parse(new TextDecoder().decode(bytes));
    }

    // Build full article object — all fields including all platform content
    const newArticle = {
      slug,
      title,
      excerpt: excerpt || '',
      category: category || 'Strategy',
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
      readTime: readTime || '5 min read',
      date: articleDate,
      yt_url: youtubeUrl || yt_url || '',
      linkedin: linkedin || '',
      discord: discord || '',
      tumblr: tumblr || '',
      mediumIntro: mediumIntro || '',
      tweet1: tweet1 || (Array.isArray(x_thread) ? x_thread[0] : '') || '',
      tweet2: tweet2 || (Array.isArray(x_thread) ? x_thread[1] : '') || '',
      tweet3: tweet3 || (Array.isArray(x_thread) ? x_thread[2] : '') || '',
      tweet4: tweet4 || (Array.isArray(x_thread) ? x_thread[3] : '') || '',
      tweet5: tweet5 || (Array.isArray(x_thread) ? x_thread[4] : '') || '',
      tweet6: tweet6 || (Array.isArray(x_thread) ? x_thread[5] : '') || '',
      body: articleBody,
    };

    // Dedup by slug — update if exists, prepend if new
    const exists = articles.findIndex(a => a.slug === slug);
    if (exists >= 0) {
      articles[exists] = newArticle;
    } else {
      articles.unshift(newArticle);
    }

    // ── 2. ALWAYS write articles.json ──────────────────────────────────────
    const articlesPayload = {
      message: `publish: ${slug}`,
      content: (() => { const bytes = new TextEncoder().encode(JSON.stringify(articles, null, 2)); let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]); return btoa(binary); })(),
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

    console.log('[FFX] articles.json written for slug:', slug);

    // ── 2b. KV — write article metadata + full content ────────────────────
    try {
      if (env.FFX_KV) {
        // Extract videoId from youtubeUrl
        const extractVideoId = (url) => {
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
        };

        const videoId = extractVideoId(youtubeUrl || yt_url || '');

        // article:{slug} — lightweight blog metadata for blog listing
        const articleMeta = {
          slug,
          title,
          excerpt: newArticle.excerpt,
          category: newArticle.category,
          tags: newArticle.tags,
          readTime: newArticle.readTime,
          date: articleDate,
          region: body.region || 'Global',
          youtubeUrl: youtubeUrl || yt_url || '',
          videoId: videoId || '',
          createdAt: new Date().toISOString(),
        };
        await env.FFX_KV.put(`article:${slug}`, JSON.stringify(articleMeta));

        // video:{videoId} — full content store for FFX Press and load-from-memory
        if (videoId) {
          // Read existing entry to preserve platform status if already set
          const existing = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' }) || {};
          const videoEntry = {
            ...existing,
            videoId,
            youtubeUrl: youtubeUrl || yt_url || '',
            slug,
            title,
            region: body.region || 'Global',
            regionCycleIndex: body.regionCycleIndex || 0,
            createdAt: existing.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            content: newArticle,
          };
          await env.FFX_KV.put(`video:${videoId}`, JSON.stringify(videoEntry));
          console.log('[FFX] KV written for videoId:', videoId);
        }
      }
    } catch (kvErr) {
      console.log('[FFX] KV write failed (non-fatal):', kvErr.message);
    }

    // ── 3. CONDITIONALLY: sitemap + Google index ───────────────────────────
    if (!skipSitemapAndIndex) {

      // Rebuild sitemap.xml
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

      const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...staticPages, ...articleEntries].map(u => `  <url>
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
        const sd = await sitemapRes.json();
        sitemapSha = sd.sha;
      }

      await fetch(sitemapUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'FFX-Worker',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: `sitemap: add ${slug}`,
          content: (() => { const bytes = new TextEncoder().encode(sitemapXml); let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]); return btoa(binary); })(),
          branch: GITHUB_BRANCH,
          ...(sitemapSha && { sha: sitemapSha })
        })
      });

      console.log('[FFX] sitemap.xml updated');

      // NOTE: Google Indexing API removed — only valid for JobPosting/BroadcastEvent
      // Sitemap submission is the correct mechanism for blog articles
    }

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
  const header  = { alg: 'RS256', typ: 'JWT' };
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

  const pemContents = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\\n/g, '').replace(/\n/g, '').trim();

  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );

  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(unsignedToken));
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${unsignedToken}.${signatureB64}`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  return (await tokenRes.json()).access_token;
}
