// ─────────────────────────────────────────────────────────────────────────────
// FFX Publish Confirm — Master Orchestrator
// Calls platform Workers, writes published status to KV permanently
// Excel retired — all state in KV only
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

  const { content, platforms } = body;

  if (!content || !content.slug) {
    return resp({ error: 'content with slug is required' }, 400, headers);
  }

  const slug = content.slug;
  const userSelected = platforms || { blog: true, x: true, linkedin: true, discord: true };

  // Platform URLs — plain URLs, no Excel hyperlink formulas
  const platformUrls = {
    blog:     `https://fortitudefx.com/article?slug=${slug}`,
    x:        'https://x.com/fortitudefx',
    linkedin: 'https://www.linkedin.com/in/salman-khan-fortitudefx',
    tumblr:   'https://fortitudefx.tumblr.com',
    discord:  'https://fortitudefx.com/vipdiscord',
  };

  console.log('[FFX] slug:', slug, 'platforms:', userSelected);

  const baseUrl = new URL(request.url).origin;

  const status = {
    blog:     userSelected.blog     ? 'pending' : 'not_selected',
    x:        userSelected.x        ? 'pending' : 'not_selected',
    linkedin: userSelected.linkedin ? 'pending' : 'not_selected',
    tumblr:   userSelected.tumblr   ? 'pending' : 'not_selected',
    discord:  userSelected.discord  ? 'pending' : 'not_selected',
  };

  // ── Blog ──────────────────────────────────────────────────────────────────
  if (userSelected.blog) {
    try {
      const res = await callWorker(`${baseUrl}/publish`, {
        ...content,
        skipSitemapAndIndex: false,
      });
      status.blog = res.ok ? platformUrls.blog : `Error: ${(await res.json().catch(() => ({}))).error || res.status}`;
      console.log('[FFX] Blog:', status.blog);
    } catch (err) {
      status.blog = `Error: ${err.message}`;
      console.log('[FFX] Blog error:', err.message);
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
      status.tumblr = res.ok ? platformUrls.tumblr : `Error: ${(await res.json().catch(() => ({}))).message || res.status}`;
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

  // ── Write published status to KV — PERMANENT, no TTL ─────────────────────
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
        // Read existing KV — preserve all existing platform data
        const existing = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' }) || {};
        const existingPlatforms = existing.platforms || {};
        const updatedPlatforms = { ...existingPlatforms };

        // Only write platforms that ran and succeeded this session
        // Published platforms get no TTL — permanent
        if (userSelected.blog && status.blog && !status.blog.startsWith('Error') && status.blog !== 'not_selected') {
          updatedPlatforms.blog = {
            status: status.blog,
            content: { body: content.body, title: content.title, excerpt: content.excerpt },
            publishedAt: timestamp,
          };
        }
        if (userSelected.x && status.x && !status.x.startsWith('Error') && status.x !== 'not_selected') {
          updatedPlatforms.x = {
            status: status.x,
            content: { tweet1: content.tweet1, tweet2: content.tweet2, tweet3: content.tweet3, tweet4: content.tweet4, tweet5: content.tweet5, tweet6: content.tweet6 },
            publishedAt: timestamp,
          };
        }
        if (userSelected.linkedin && status.linkedin && !status.linkedin.startsWith('Error') && status.linkedin !== 'not_selected') {
          updatedPlatforms.linkedin = {
            status: status.linkedin,
            content: { linkedin: content.linkedin },
            publishedAt: timestamp,
          };
        }
        if (userSelected.tumblr && status.tumblr && !status.tumblr.startsWith('Error') && status.tumblr !== 'not_selected') {
          updatedPlatforms.tumblr = {
            status: status.tumblr,
            content: { tumblr: content.tumblr },
            publishedAt: timestamp,
          };
        }
        if (userSelected.discord && status.discord && !status.discord.startsWith('Error') && status.discord !== 'not_selected') {
          updatedPlatforms.discord = {
            status: status.discord,
            content: { discord: content.discord },
            publishedAt: timestamp,
          };
        }

        const videoEntry = {
          ...existing,
          videoId,
          youtubeUrl: content.youtubeUrl || content.yt_url || '',
          slug: content.slug,
          title: content.title || '',
          region: content.region || 'Global',
          updatedAt: timestamp,
          platforms: updatedPlatforms,
        };

        // No TTL — published content is permanent
        await env.FFX_KV.put(`video:${videoId}`, JSON.stringify(videoEntry));
        console.log('[FFX] KV video entry written permanently for videoId:', videoId);
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
