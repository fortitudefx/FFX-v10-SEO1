// FFX /publish Worker
// ALWAYS: writes article + all platform content to articles.json
// CONDITIONALLY: rebuilds sitemap (no Google ping — indexing is via GSC Request-Indexing, manual)

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

    const extractVideoId = (url) => {
      try {
        const u = new URL(url || '');
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

    // ── 1. Write article metadata to KV ────────────────────────────────────
    if (env.FFX_KV) {
      // ── [collision guard] never let a DIFFERENT video's publish silently clobber
      // an existing article URL. Slugs are AI-authored with no uniqueness guarantee,
      // so two same-topic videos can mint the same slug. Block ONLY a proven
      // video-vs-video collision (both records carry a non-empty, differing videoId);
      // a same-videoId re-publish (overwrites its own record) and a genuinely new slug
      // proceed unchanged. Fail loudly (409) rather than auto-rename — the platform
      // posts already reference this slug's URL, so silently changing it would break them.
      try {
        const existingMeta = await env.FFX_KV.get(`article:${slug}`, { type: 'json' }).catch(() => null);
        if (existingMeta && existingMeta.videoId && videoId && existingMeta.videoId !== videoId) {
          console.error(`[FFX] SLUG COLLISION BLOCKED: article:${slug} is already owned by videoId=${existingMeta.videoId}; refusing to overwrite from videoId=${videoId}. Nothing published — assign a unique slug and retry.`);
          return new Response(JSON.stringify({
            error: 'Slug collision — this slug already belongs to a different video. Publish aborted so the existing article URL is not overwritten. Assign a unique slug and retry.',
            slug,
            existingVideoId: existingMeta.videoId,
            incomingVideoId: videoId,
          }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      } catch (guardErr) {
        // fail OPEN on a transient read error — the guard only ever blocks on a positive
        // collision detection, so it never introduces a new failure mode for KV hiccups.
        console.error('[FFX] slug collision guard read failed (non-fatal, proceeding):', guardErr.message);
      }

      try {
        const articleMeta = {
          slug, title,
          excerpt: excerpt || '',
          category: category || 'Strategy',
          tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
          readTime: readTime || '5 min read',
          date: articleDate,
          region: body.region || 'Global',
          youtubeUrl: youtubeUrl || yt_url || '',
          videoId: videoId || '',
          createdAt: new Date().toISOString(),
        };
        await env.FFX_KV.put(`article:${slug}`, JSON.stringify(articleMeta));
        console.log('[FFX] KV article metadata written for slug:', slug);

        // ── Component 1: Update articles:index ────────────────────────────
        // Permanent lookup table of all published articles for internal
        // linking (consumer) and directive resolution (intelligence engine)
        try {
          const indexRaw = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(() => null);
          const index = Array.isArray(indexRaw) ? indexRaw : [];

          // Build index entry — lightweight, only what linking needs
          const indexEntry = {
            slug,
            title,
            excerpt:    excerpt || '',
            category:   category || 'Strategy',
            tags:       Array.isArray(articleMeta.tags) ? articleMeta.tags : [],
            publishedAt: new Date().toISOString(),
            youtubeUrl: youtubeUrl || yt_url || '',
          };

          // Dedupe-on-write [WF]: remove ALL existing entries for this slug — this
          // collapses any legacy duplicate / title:null twin of THIS slug — then
          // prepend the fresh record. Guarantees exactly one entry per slug, always
          // carrying its real title (`title` is non-empty: enforced at the top of this
          // handler). Scoped to the published slug only — NOT a bulk index cleanup.
          const deduped = index.filter(a => a && a.slug !== slug);
          if (title) deduped.unshift(indexEntry); // never append a title:null stub

          await env.FFX_KV.put('articles:index', JSON.stringify(deduped));
          console.log('[FFX] articles:index updated, total articles:', deduped.length);
        } catch (idxErr) {
          console.error('[FFX] articles:index update failed (non-fatal):', idxErr.message);
        }
      } catch (kvErr) {
        console.log('[FFX] KV article write failed (non-fatal):', kvErr.message);
      }

      // ── 1b: Update content:performance — set publishedAt (measurement pipeline) ──
      try {
        const perfKey = `content:performance:${slug}`;
        const existing = await env.FFX_KV.get(perfKey, { type: 'json' }).catch(() => null);
        const now = new Date().toISOString();
        if (existing) {
          // Update existing record with publish timestamp
          existing.publishedAt = now;
          existing.status      = 'published';
          await env.FFX_KV.put(perfKey, JSON.stringify(existing));
        } else {
          // Article published without going through consumer (manual) — create record
          await env.FFX_KV.put(perfKey, JSON.stringify({
            slug, title,
            contentPillar:  category || 'Strategy',
            region:         body.region || 'Global',
            videoId:        videoId || null,
            youtubeUrl:     youtubeUrl || yt_url || null,
            targetQuery:    null,
            briefVersion:   null,
            promptInjected: false,
            generatedAt:    null,
            publishedAt:    now,
            status:         'published',
            snapshot7:      null,
            snapshot30:     null,
            snapshot90:     null,
          }));
        }
        console.log('[FFX] content:performance publishedAt set for slug:', slug);
      } catch (perfErr) {
        console.error('[FFX] content:performance update failed (non-fatal):', perfErr.message);
      }

      // ── 1c: Write platform:performance records (measurement pipeline) ────
      try {
        const now = new Date().toISOString();
        const platforms = [];
        if (!skipSitemapAndIndex) platforms.push('blog');
        if (body.platforms?.x)        platforms.push('x');
        if (body.platforms?.linkedin) platforms.push('linkedin');
        if (body.platforms?.discord)  platforms.push('discord');
        if (body.platforms?.tumblr)   platforms.push('tumblr');

        for (const platform of platforms) {
          try {
            await env.FFX_KV.put(
              `platform:performance:${platform}:${slug}`,
              JSON.stringify({
                platform,
                slug,
                title,
                publishedAt:  now,
                videoId:      videoId || null,
                region:       body.region || 'Global',
                engagement:   null, // populated later by Intelligence Agent
                trafficBack:  null, // populated by GA4 signals
                status:       'published',
              })
            );
          } catch (e) {
            console.error(`[FFX] platform:performance:${platform} write failed (non-fatal):`, e.message);
          }
        }
        console.log('[FFX] platform:performance records written for:', platforms.join(', '));
      } catch (platErr) {
        console.error('[FFX] platform:performance write failed (non-fatal):', platErr.message);
      }
    }

    // ── 2. CONDITIONALLY: sitemap only ────────────────────────────────────
    if (!skipSitemapAndIndex) {

      let articleSlugs = [];
      try {
        if (env.FFX_KV) {
          const kvList = await env.FFX_KV.list({ prefix: 'article:' });
          // Only real article metadata keys — exclude article:links:{slug} (internal-link records)
          const articleKeys = kvList.keys.filter(k => !k.name.startsWith('article:links:'));
          const slugEntries = await Promise.all(
            articleKeys.map(k => env.FFX_KV.get(k.name, { type: 'json' }))
          );
          // Dedupe by slug — every article URL must appear exactly once (§D1)
          const seenSlug = new Set();
          articleSlugs = slugEntries
            .filter(a => a && a.slug && !seenSlug.has(a.slug) && seenSlug.add(a.slug))
            .map(a => ({ slug: a.slug, date: a.date || articleDate }));
        }
      } catch (kvErr) {
        console.log('[FFX] KV article list failed, using current slug only:', kvErr.message);
        articleSlugs = [{ slug, date: articleDate }];
      }

      // Real, current date — emitted on every regeneration instead of a frozen literal (§D2)
      const todayIso = new Date().toISOString().split('T')[0];
      // All indexable public pages (index,follow). Excludes /pricing and /press
      // (both meta noindex) so the sitemap never advertises a non-indexable URL.
      const staticPages = [
        { loc: 'https://fortitudefx.com/',           lastmod: todayIso, changefreq: 'weekly',  priority: '1.0' },
        { loc: 'https://fortitudefx.com/bootcamp',   lastmod: todayIso, changefreq: 'weekly',  priority: '0.9' },
        { loc: 'https://fortitudefx.com/vipdiscord', lastmod: todayIso, changefreq: 'weekly',  priority: '0.9' },
        { loc: 'https://fortitudefx.com/blog',       lastmod: todayIso, changefreq: 'weekly',  priority: '0.8' },
        { loc: 'https://fortitudefx.com/newsletter', lastmod: todayIso, changefreq: 'weekly',  priority: '0.7' },
        { loc: 'https://fortitudefx.com/waitlist',   lastmod: todayIso, changefreq: 'weekly',  priority: '0.7' },
        { loc: 'https://fortitudefx.com/joinfree',   lastmod: todayIso, changefreq: 'monthly', priority: '0.6' },
        { loc: 'https://fortitudefx.com/contact',    lastmod: todayIso, changefreq: 'yearly',  priority: '0.6' },
        { loc: 'https://fortitudefx.com/privacy',    lastmod: todayIso, changefreq: 'yearly',  priority: '0.3' },
      ];

      const articleEntries = articleSlugs.map(a => ({
        loc: `https://fortitudefx.com/article?slug=${a.slug}`,
        lastmod: a.date || articleDate,
        changefreq: 'monthly',
        priority: '0.7'
      }));

      // Final safety dedupe by loc — every URL appears exactly once regardless of source (§D1)
      const seenLoc = new Set();
      const uniqueEntries = [...staticPages, ...articleEntries]
        .filter(u => u.loc && !seenLoc.has(u.loc) && seenLoc.add(u.loc));

      const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${uniqueEntries.map(u => `  <url>
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
          content: (() => {
            const bytes = new TextEncoder().encode(sitemapXml);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
          })(),
          branch: GITHUB_BRANCH,
          ...(sitemapSha && { sha: sitemapSha })
        })
      });

      console.log('[FFX] sitemap.xml updated');
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

async function getGoogleAccessToken(serviceAccountEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
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

  const encoder   = new TextEncoder();
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

//end of file
