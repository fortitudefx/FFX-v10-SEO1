// ─────────────────────────────────────────────────────────────────────────────
// FFX Article Content
// GET /article-content?slug=SLUG → returns full article from KV
// Reads published:{videoId}.globalContent first (permanent)
// Falls back to video:{videoId} (24hr TTL) then legacy paths
// Returns siblingSlug + siblingRegion for "Also available for [region] traders" link
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV not bound' }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return new Response(JSON.stringify({ error: 'slug is required' }), { status: 400, headers });
  }

  try {
    // 1. Read article metadata
    const articleMeta = await env.FFX_KV.get(`article:${slug}`, { type: 'json' });

    if (!articleMeta) {
      return new Response(JSON.stringify({ error: 'Article not found' }), { status: 404, headers });
    }

    const videoId = articleMeta.videoId;
    let body = '';
    let fullContent = {};
    let siblingSlug = null;
    let siblingRegion = null;
    let siblingTitle = null;

    if (videoId) {
      // 2a. Check published:{videoId} first — permanent
      // Full article body lives in globalContent — not in platforms.blog.content
      try {
        const publishedEntry = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' });
        if (publishedEntry?.globalContent?.body) {
          fullContent = publishedEntry.globalContent;
          body = fullContent.body;
          console.log('[FFX Article] Served from published globalContent:', slug);
        } else if (publishedEntry?.platforms?.blog?.content?.body) {
          // Legacy fallback — old entries stored body inside platforms.blog.content
          fullContent = publishedEntry.platforms.blog.content;
          body = fullContent.body;
          console.log('[FFX Article] Served from published platforms.blog.content:', slug);
        }

        // Sibling article — regional variant of the same video
        // If this is the global article, sibling is regional and vice versa
        if (publishedEntry?.regionalContent?.slug) {
          const regionalSlug   = publishedEntry.regionalContent.slug;
          const regionalRegion = publishedEntry.regionalContent.region || publishedEntry.region || 'Regional';
          const regionalTitle  = publishedEntry.regionalContent.title || '';

          if (slug === publishedEntry.globalContent?.slug) {
            // This is the global article — sibling is regional
            siblingSlug   = regionalSlug;
            siblingRegion = regionalRegion;
            siblingTitle  = regionalTitle;
          } else if (slug === regionalSlug) {
            // This is the regional article — sibling is global
            siblingSlug   = publishedEntry.globalContent?.slug || null;
            siblingRegion = 'Global';
            siblingTitle  = publishedEntry.globalContent?.title || '';
          }
        }
      } catch {}

      // 2b. Fallback to video:{videoId} — generated content, 24hr TTL
      if (!body) {
        try {
          const videoEntry = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });
          if (videoEntry) {
            const blogContent =
              videoEntry?.platforms?.blog_global?.content ||
              videoEntry?.content ||
              null;
            if (blogContent) {
              fullContent = blogContent;
              body = blogContent.body || '';
              console.log('[FFX Article] Served from video KV:', slug);
            }
          }
        } catch {}
      }
    }

    // 3. Legacy fallback — video:slug:{slug}
    if (!body) {
      try {
        const slugEntry = await env.FFX_KV.get(`video:slug:${slug}`, { type: 'json' });
        if (slugEntry?.content) {
          fullContent = slugEntry.content;
          body = slugEntry.content.body || '';
        }
      } catch {}
    }

    // 4. Final fallback — articles.json on GitHub raw
    // For manually written articles with no videoId that were added directly to articles.json
    if (!body) {
      try {
        const GITHUB_RAW = 'https://raw.githubusercontent.com/fortitudefx/FFX-v10-SEO1/main/articles.json';
        const ghRes = await fetch(GITHUB_RAW, { headers: { 'Cache-Control': 'no-cache' } });
        if (ghRes.ok) {
          const allArticles = await ghRes.json();
          const found = Array.isArray(allArticles) ? allArticles.find(a => a.slug === slug) : null;
          if (found && found.body) {
            body = found.body;
            fullContent = found;
            console.log('[FFX Article] Served from articles.json GitHub fallback:', slug);
          }
        }
      } catch (ghErr) {
        console.log('[FFX Article] GitHub fallback failed (non-fatal):', ghErr.message);
      }
    }

    // 5. Read article:links:{slug} — pending internal links added without touching published
    // Appended to body on the fly — published record is never modified
    if (body) {
      try {
        const pendingLinks = await env.FFX_KV.get('article:links:' + slug, { type: 'json' }).catch(() => null);
        if (pendingLinks && Array.isArray(pendingLinks.links) && pendingLinks.links.length > 0) {
          // Insert each link as a paragraph before the CTA section
          let linksHtml = pendingLinks.links.map(function(l) {
            return '<p>For further reading, see <a href="' + l.targetUrl + '">' + l.targetTitle + '</a>.</p>';
          }).join('');
          // Insert before discord CTA if present, otherwise append
          const ctaIdx = body.indexOf('discord.gg/fortitudefx');
          if (ctaIdx !== -1) {
            // Find the start of the paragraph containing the CTA
            const paraStart = body.lastIndexOf('<p', ctaIdx);
            if (paraStart !== -1) {
              body = body.slice(0, paraStart) + linksHtml + body.slice(paraStart);
            } else {
              body = body + linksHtml;
            }
          } else {
            body = body + linksHtml;
          }
          console.log('[FFX Article] Appended', pendingLinks.links.length, 'pending links for:', slug);
        }
      } catch (linkErr) {
        console.log('[FFX Article] Pending links read failed (non-fatal):', linkErr.message);
      }
    }

    const article = {
      slug:         articleMeta.slug,
      title:        articleMeta.title    || fullContent.title    || '',
      excerpt:      articleMeta.excerpt  || fullContent.excerpt  || '',
      category:     articleMeta.category || fullContent.category || 'Strategy',
      tags:         Array.isArray(articleMeta.tags) ? articleMeta.tags : (fullContent.tags || []),
      readTime:     articleMeta.readTime || fullContent.readTime || '5 min read',
      date:         articleMeta.date     || fullContent.date     || '',
      body:         body || fullContent.body || '',
      youtubeUrl:   articleMeta.youtubeUrl || fullContent.youtubeUrl || '',
      videoId:      articleMeta.videoId  || '',
      region:       articleMeta.region   || fullContent.region   || 'Global',
      draft:        articleMeta.draft    || false,
      // Sibling article for "Also available for [region] traders" link
      siblingSlug,
      siblingRegion,
      siblingTitle,
    };

    return new Response(JSON.stringify({ success: true, article }), { status: 200, headers });

  } catch (err) {
    console.log('[FFX Article] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
