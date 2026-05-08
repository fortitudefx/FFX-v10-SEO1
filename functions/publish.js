// FFX /publish Worker
// - Saves article to articles.json
// - Rewrites sitemap.xml to include all articles

export async function onRequestPost(context) {
  const { request, env } = context;

  const GITHUB_TOKEN  = env.GITHUB_TOKEN;
  const GITHUB_OWNER  = 'fortitudefx';
  const GITHUB_REPO   = 'FFX-v10-SEO1';
  const GITHUB_BRANCH = 'main';

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
      { loc: 'https://fortitudefx.com/',            lastmod: '2026-04-26', changefreq: 'weekly',  priority: '1.0' },
      { loc: 'https://fortitudefx.com/bootcamp',    lastmod: '2026-04-26', changefreq: 'weekly',  priority: '0.9' },
      { loc: 'https://fortitudefx.com/vipdiscord',  lastmod: '2026-04-26', changefreq: 'weekly',  priority: '0.9' },
      { loc: 'https://fortitudefx.com/waitlist',    lastmod: '2026-04-26', changefreq: 'weekly',  priority: '0.7' },
      { loc: 'https://fortitudefx.com/blog',        lastmod: '2026-04-26', changefreq: 'weekly',  priority: '0.8' },
      { loc: 'https://fortitudefx.com/privacy',     lastmod: '2026-04-26', changefreq: 'yearly',  priority: '0.3' },
    ];

    const today = articleDate;

    const articleEntries = articles.map(a => ({
      loc: `https://fortitudefx.com/article?slug=${a.slug}`,
      lastmod: a.date || today,
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

    // Read current sitemap SHA
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

    const writeSitemap = await fetch(sitemapUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'FFX-Worker',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sitemapPayload)
    });

    if (!writeSitemap.ok) {
      const err = await writeSitemap.text();
      // Non-fatal — article saved, sitemap failed
      return new Response(JSON.stringify({
        success: true,
        warning: 'Article saved but sitemap update failed',
        detail: err,
        slug
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── 4. DONE ────────────────────────────────────────────────────────────
    return new Response(JSON.stringify({ success: true, slug }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
    });
  }
}
