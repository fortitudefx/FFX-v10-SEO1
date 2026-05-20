// ─────────────────────────────────────────────────────────────────────────────
// FFX Publish Confirm — Master Orchestrator
// Calls platform Workers, writes published status to published:{videoId} permanently
// Stores FULL globalContent + regionalContent for Press republishing
// video:{videoId} is written by consumer Worker only — never touched here
// published:{videoId} is written here only — permanent, no TTL
// Clean separation — no race conditions ever
// ─────────────────────────────────────────────────────────────────────────────

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

  const { content, regionalContent, platforms } = body;

  if (!content || !content.slug) {
    return resp({ error: 'content with slug is required' }, 400, headers);
  }

  const slug = content.slug;
  const userSelected = platforms || { blog: true, x: true, linkedin: true, discord: true };

  const platformUrls = {
    blog:     `https://fortitudefx.com/article?slug=${slug}`,
    x:        'https://x.com/fortitudefx',
    linkedin: 'https://www.linkedin.com/in/salman-khan-fortitudefx',
    tumblr:   'https://fortitudefx.tumblr.com',
    discord:  'https://fortitudefx.com/vipdiscord',
  };

  console.log('[FFX] slug:', slug, 'platforms:', userSelected);
  if (regionalContent) console.log('[FFX] regionalContent slug:', regionalContent.slug);

  const baseUrl = new URL(request.url).origin;

  const status = {
    blog:         userSelected.blog     ? 'pending' : 'not_selected',
    blogRegional: (userSelected.blog && regionalContent) ? 'pending' : 'not_selected',
    x:            userSelected.x        ? 'pending' : 'not_selected',
    linkedin:     userSelected.linkedin ? 'pending' : 'not_selected',
    tumblr:       userSelected.tumblr   ? 'pending' : 'not_selected',
    discord:      userSelected.discord  ? 'pending' : 'not_selected',
  };

  // ── Blog Global ───────────────────────────────────────────────────────────
  if (userSelected.blog) {
    try {
      const res = await callWorker(`${baseUrl}/publish`, {
        ...content,
        skipSitemapAndIndex: false,
      });
      status.blog = res.ok
        ? platformUrls.blog
        : `Error: ${(await res.json().catch(() => ({}))).error || res.status}`;
      console.log('[FFX] Blog Global:', status.blog);
    } catch (err) {
      status.blog = `Error: ${err.message}`;
      console.log('[FFX] Blog Global error:', err.message);
    }
  }

  // ── Blog Regional ─────────────────────────────────────────────────────────
  if (userSelected.blog && regionalContent && regionalContent.slug) {
    try {
      const res = await callWorker(`${baseUrl}/publish`, {
        ...regionalContent,
        skipSitemapAndIndex: false,
      });
      const regionalUrl = `https://fortitudefx.com/article?slug=${regionalContent.slug}`;
      status.blogRegional = res.ok
        ? regionalUrl
        : `Error: ${(await res.json().catch(() => ({}))).error || res.status}`;
      console.log('[FFX] Blog Regional:', status.blogRegional);
    } catch (err) {
      status.blogRegional = `Error: ${err.message}`;
      console.log('[FFX] Blog Regional error:', err.message);
    }
  }

  // ── X ────────────────────────────────────────────────────────────────────
  if (userSelected.x) {
    try {
      const res = await callWorker(`${baseUrl}/tweet`, {
        slug,
        tweet1: content.tweet1, tweet2: content.tweet2,
        tweet3: content.tweet3, tweet4: content.tweet4,
        tweet5: content.tweet5, tweet6: content.tweet6,
      });
      if (res.ok) {
        const xData = await res.json().catch(() => ({}));
        const firstTweetId = xData.results?.[0]?.tweet_id || '';
        status.x = firstTweetId
          ? `https://x.com/fortitudefx/status/${firstTweetId}`
          : platformUrls.x;
      } else {
        status.x = `Error: ${(await res.json().catch(() => ({}))).message || res.status}`;
      }
      console.log('[FFX] X:', status.x);
    } catch (err) {
      status.x = `Error: ${err.message}`;
    }
  }

  // ── LinkedIn ──────────────────────────────────────────────────────────────
  if (userSelected.linkedin) {
    try {
      const res = await callWorker(`${baseUrl}/linkedin`, {
        slug, linkedin: content.linkedin,
      });
      if (res.ok) {
        const liData = await res.json().catch(() => ({}));
        const postId = liData.post_id || '';
        status.linkedin = postId
          ? `https://www.linkedin.com/feed/update/${encodeURIComponent(postId)}`
          : platformUrls.linkedin;
      } else {
        const liData = await res.json().catch(() => ({}));
        status.linkedin = `Error: ${liData.message || res.status}`;
      }
      console.log('[FFX] LinkedIn:', status.linkedin);
    } catch (err) {
      status.linkedin = `Error: ${err.message}`;
    }
  }

  // ── Tumblr ────────────────────────────────────────────────────────────────
  if (userSelected.tumblr) {
    try {
      const res = await callWorker(`${baseUrl}/tumblr`, {
        slug, tumblr: content.tumblr,
      });
      status.tumblr = res.ok
        ? platformUrls.tumblr
        : `Error: ${(await res.json().catch(() => ({}))).message || res.status}`;
      console.log('[FFX] Tumblr:', status.tumblr);
    } catch (err) {
      status.tumblr = `Error: ${err.message}`;
    }
  }

  // ── Discord ───────────────────────────────────────────────────────────────
  if (userSelected.discord) {
    try {
      const res = await callWorker(`${baseUrl}/discord`, {
        slug, discord: content.discord,
      });
      if (res.ok) {
        const discordData = await res.json().catch(() => ({}));
        status.discord = discordData.messageLink || platformUrls.discord;
      } else {
        const errData = await res.json().catch(() => ({}));
        status.discord = `Error: ${errData.message || res.status}`;
      }
      console.log('[FFX] Discord:', status.discord);
    } catch (err) {
      status.discord = `Error: ${err.message}`;
    }
  }

  // ── Write to published:{videoId} — PERMANENT, no TTL ─────────────────────
  try {
    if (env.FFX_KV) {
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

      const videoId = extractVideoId(content.youtubeUrl || content.yt_url || '');
      const now = new Date();
      const dubaiTime = new Date(now.getTime() + (4 * 60 * 60 * 1000));
      const timestamp = dubaiTime.toISOString().replace('T', ' ').substring(0, 19);

      if (videoId) {
        const existingPublished = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' }) || {};
        const existingPlatforms = existingPublished.platforms || {};
        const updatedPlatforms = { ...existingPlatforms };

        // Write per-platform status — only platforms that ran and succeeded
        if (userSelected.blog && status.blog && !status.blog.startsWith('Error') && status.blog !== 'not_selected') {
          updatedPlatforms.blog = { status: status.blog, publishedAt: timestamp };
        }
        if (userSelected.blog && regionalContent && status.blogRegional && !status.blogRegional.startsWith('Error') && status.blogRegional !== 'not_selected') {
          updatedPlatforms.blogRegional = { status: status.blogRegional, publishedAt: timestamp };
        }
        if (userSelected.x && status.x && !status.x.startsWith('Error') && status.x !== 'not_selected') {
          updatedPlatforms.x = { status: status.x, publishedAt: timestamp };
        }
        if (userSelected.linkedin && status.linkedin && !status.linkedin.startsWith('Error') && status.linkedin !== 'not_selected') {
          updatedPlatforms.linkedin = { status: status.linkedin, publishedAt: timestamp };
        }
        if (userSelected.tumblr && status.tumblr && !status.tumblr.startsWith('Error') && status.tumblr !== 'not_selected') {
          updatedPlatforms.tumblr = { status: status.tumblr, publishedAt: timestamp };
        }
        if (userSelected.discord && status.discord && !status.discord.startsWith('Error') && status.discord !== 'not_selected') {
          updatedPlatforms.discord = { status: status.discord, publishedAt: timestamp };
        }

        const publishedEntry = {
          videoId,
          youtubeUrl: content.youtubeUrl || content.yt_url || '',
          slug: content.slug,
          title: content.title || '',
          region: content.region || 'Global',
          updatedAt: timestamp,
          // Store FULL content objects for Press republishing
          // video:{videoId} expires after 24hrs — published:{videoId} is permanent
          // Press reads globalContent + regionalContent from here for republish
          globalContent: content,
          regionalContent: regionalContent || null,
          platforms: updatedPlatforms,
        };

        // No TTL — published content is permanent
        await env.FFX_KV.put(`published:${videoId}`, JSON.stringify(publishedEntry));
        console.log('[FFX] published: KV written permanently for videoId:', videoId);

        // Clear video:{videoId} immediately — content is now permanent in published:{videoId}
        // Non-fatal — publish already succeeded if this fails
        try { await env.FFX_KV.delete(`video:${videoId}`); console.log('[FFX] video: KV cleared for videoId:', videoId); } catch {}

      } else {
        console.log('[FFX] No videoId found in content — published: KV not written');
      }
    }
  } catch (kvErr) {
    console.log('[FFX] KV write failed (non-fatal):', kvErr.message);
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
