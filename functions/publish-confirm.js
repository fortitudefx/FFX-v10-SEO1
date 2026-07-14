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

  // ── REGIONAL DISABLED (Global-only, 2026-07-07) ──────────────────────────
  // WHY: regional English variants duplicate/cannibalize their global sibling and signal
  //      thin content on a young low-authority domain. Decision: 1 global article per video.
  // REVIVE WHEN: domain has real ranking authority AND we add genuinely localized content
  //      (region-specific substance) with correct self-canonical + hreflang alternates.
  // TO REVIVE: set GLOBAL_ONLY = false below + uncomment the paired blocks in
  //      ffx-consumer/index.js and dashboard-queue.html (~:635).
  // GUARANTEED BACKSTOP: even if regionalContent somehow arrives, it is never published.
  // ─────────────────────────────────────────────────────────────────────────
  const GLOBAL_ONLY = true;
  // ── Blog Regional ─────────────────────────────────────────────────────────
  if (!GLOBAL_ONLY && userSelected.blog && regionalContent && regionalContent.slug) {
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
        articleUrl: `https://fortitudefx.com/article?slug=${slug}`,
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

  // ── Skip platforms with NO content ──────────────────────────────────────────
  // A keyword article has no tumblr text; posting an empty platform just fails
  // ("Article not found for slug"). Deselect empty platforms so they are neither
  // posted nor counted as a failure (honest: shown as not_selected, not Error).
  if (userSelected.tumblr   && !content.tumblr)                      { userSelected.tumblr = false;   status.tumblr = 'not_selected';   console.log('[FFX] tumblr skipped — no content'); }
  if (userSelected.linkedin && !content.linkedin)                    { userSelected.linkedin = false; status.linkedin = 'not_selected'; console.log('[FFX] linkedin skipped — no content'); }
  if (userSelected.discord  && !content.discord)                     { userSelected.discord = false;  status.discord = 'not_selected';  console.log('[FFX] discord skipped — no content'); }
  if (userSelected.x        && !(content.tweet1 || content.tweet2))  { userSelected.x = false;        status.x = 'not_selected';        console.log('[FFX] x skipped — no tweets'); }

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

      // Key the published record by the real content.videoId (e.g. kw-order-block)
      // and only fall back to a URL-extracted id. Keyword articles have no
      // youtubeUrl, so without this fallback they'd get videoId=null → no published
      // record → invisible in the press dashboard, AND (previously) a stray URL keyed
      // it under the WRONG video's id. content.videoId is authoritative.
      const videoId = content.videoId || extractVideoId(content.youtubeUrl || content.yt_url || '') || null;
      const now = new Date();
      const dubaiTime = new Date(now.getTime() + (4 * 60 * 60 * 1000));
      const timestamp = dubaiTime.toISOString().replace('T', ' ').substring(0, 19);

      if (videoId) {
        const existingPublished = await env.FFX_KV.get(`published:${videoId}`, { type: 'json' }) || {};
        const existingPlatforms = existingPublished.platforms || {};
        const updatedPlatforms  = { ...existingPlatforms };

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

        const fieldsToCheck = {
          blog:     ['body'],
          x:        ['tweet1','tweet2','tweet3','tweet4','tweet5','tweet6'],
          linkedin: ['linkedin'],
          discord:  ['discord'],
          tumblr:   ['tumblr'],
        };

        let remainingEditedFields = Array.isArray(existingPublished.editedFields)
          ? [...existingPublished.editedFields]
          : [];

        Object.entries(fieldsToCheck).forEach(([platform, fields]) => {
          const s = status[platform];
          const published = s && !s.startsWith('Error') && s !== 'not_selected' && s !== 'pending';
          if (published) {
            remainingEditedFields = remainingEditedFields.filter(f => !fields.includes(f));
          }
        });

        const existingPendingEdits = existingPublished.pendingEdits || {};
        const updatedPendingEdits  = { ...existingPendingEdits };
        Object.entries(fieldsToCheck).forEach(([platform, fields]) => {
          const s = status[platform];
          const published = s && !s.startsWith('Error') && s !== 'not_selected' && s !== 'pending';
          if (published) {
            fields.forEach(f => delete updatedPendingEdits[f]);
          }
        });
        if (status.x && !status.x.startsWith('Error') && status.x !== 'not_selected' && status.x !== 'pending') {
          delete updatedPendingEdits.x_thread;
        }

        const publishedEntry = {
          videoId,
          youtubeUrl:      content.youtubeUrl || content.yt_url || '',
          slug:            content.slug,
          title:           content.title || '',
          region:          content.region || 'Global',
          // Carry the source so the press dashboard renders the keyword SEO card and
          // the per-platform regen routes correctly (keyword vs video path).
          source:          content.source || (String(videoId).startsWith('kw-') ? 'keyword' : undefined),
          keyword:         content.keyword || null,
          cluster:         content.cluster || null,
          updatedAt:       timestamp,
          globalContent:   content,
          regionalContent: regionalContent || null,
          platforms:       updatedPlatforms,
          editedFields:    remainingEditedFields,
          pendingEdits:    updatedPendingEdits,
        };

        await env.FFX_KV.put(`published:${videoId}`, JSON.stringify(publishedEntry));
        console.log('[FFX] published: KV written permanently for videoId:', videoId);

        // ── CHANGE 12: Update content:performance:{slug} with publishedAt and status ──
        // Non-fatal — publish already succeeded if this fails
        let contentPerfVerified = false;
        let contentPerfError    = null;
        try {
          if (slug) {
            const perfKey = `content:performance:${slug}`;
            const perf    = await env.FFX_KV.get(perfKey, { type: 'json' }).catch(() => null);
            if (perf) {
              perf.publishedAt = now.toISOString();
              perf.status      = 'published';
              await env.FFX_KV.put(perfKey, JSON.stringify(perf));

              // ── Read back to verify write succeeded ──────────────────────
              const perfVerify = await env.FFX_KV.get(perfKey, { type: 'json' }).catch(() => null);
              if (perfVerify && perfVerify.status === 'published' && perfVerify.publishedAt) {
                contentPerfVerified = true;
                console.log('[FFX] content:performance VERIFIED published for slug:', slug);
              } else {
                contentPerfError = 'Write verification failed — status not confirmed in read-back';
                console.error('[FFX] content:performance write verification FAILED for slug:', slug);
              }
            } else {
              contentPerfError = `content:performance:${slug} not found — record may not have been created by consumer`;
              console.log('[FFX] content:performance not found for slug:', slug);
            }
          }
        } catch(perfErr) {
          contentPerfError = perfErr.message;
          console.error('[FFX] content:performance update failed:', perfErr.message);
        }

        // Clear video:{videoId} immediately
        try { await env.FFX_KV.delete(`video:${videoId}`); console.log('[FFX] video: KV cleared for videoId:', videoId); } catch {}

        // Delete regen staging keys
        const regenPlatformMap = { blog: 'article', x: 'x', linkedin: 'linkedin', tumblr: 'tumblr', discord: 'discord' };
        for (const [platform, regenKey] of Object.entries(regenPlatformMap)) {
          const s = status[platform];
          const succeeded = s && !s.startsWith('Error') && s !== 'not_selected' && s !== 'pending';
          if (succeeded) {
            try { await env.FFX_KV.delete(`regen:${videoId}:${regenKey}`); } catch {}
          }
        }
        console.log('[FFX] regen staging keys cleared for published platforms');

        // ── Section 31: Trigger health check on first publish of the day ──
        try {
          const today   = now.toISOString().split('T')[0];
          const lastRun = await env.FFX_KV.get('health:last_run').catch(() => null);
          if (lastRun !== today) {
            await env.FFX_KV.put('health:last_run', today);
            fetch(`${baseUrl}/api/health-check`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
              .then(r => console.log('[FFX] Health check triggered:', r.status))
              .catch(e => console.error('[FFX] Health check trigger failed (non-fatal):', e.message));
          }
        } catch(healthErr) {
          console.error('[FFX] Health check trigger error (non-fatal):', healthErr.message);
        }

      } else {
        console.log('[FFX] No videoId found in content — published: KV not written');
      }
    }
  } catch (kvErr) {
    console.log('[FFX] KV write failed (non-fatal):', kvErr.message);
  }

  // ── HONEST VERDICT (SH-4, 2026-07-11) ────────────────────────────────────────
  // FIX: previously this returned `success:true` + HTTP 200 UNCONDITIONALLY, so a
  // failed article publish (e.g. slug-collision 409) still read as success while the
  // other platforms posted. Now: success is true ONLY IF every platform the user
  // SELECTED actually succeeded. This changes REPORTING ONLY — no platform's publish
  // logic above is touched. A platform "succeeded" iff its status is a real result
  // (not 'pending', not 'not_selected', not an 'Error: …' string). blogRegional is
  // excluded from the verdict: it is intentionally disabled by GLOBAL_ONLY and is not
  // a user-selectable platform key.
  const REPORT_PLATFORMS = ['blog', 'x', 'linkedin', 'tumblr', 'discord'];
  const succeeded = (s) => !!s && s !== 'pending' && s !== 'not_selected' && !String(s).startsWith('Error');
  const cleanErr  = (s) => String(s == null ? 'unknown error' : s).replace(/^Error:\s*/, '');

  const selectedPlatforms = REPORT_PLATFORMS.filter((k) => userSelected[k]);
  const platformResults = {};
  selectedPlatforms.forEach((k) => {
    platformResults[k] = succeeded(status[k])
      ? { ok: true,  result: status[k] }
      : { ok: false, error: cleanErr(status[k]) };
  });
  const posted = selectedPlatforms.filter((k) => platformResults[k].ok);
  const failed = selectedPlatforms.filter((k) => !platformResults[k].ok);
  const allOk  = failed.length === 0;

  // The article/blog is the anchor — surface its outcome explicitly and clearly.
  const articleSelected = !!userSelected.blog;
  const articleOk       = succeeded(status.blog);
  const articleFailed   = articleSelected && !articleOk;

  let error = null;
  if (!allOk) {
    if (articleFailed) {
      error = `Article did NOT publish — ${cleanErr(status.blog)}`;
      const otherFails = failed.filter((k) => k !== 'blog');
      if (otherFails.length) error += ` | also failed: ${otherFails.join(', ')}`;
      if (posted.length)     error += ` | these DID post and now link to a URL that is NOT this article: ${posted.join(', ')}`;
    } else {
      error = `Publish incomplete — failed: ${failed.map((k) => `${k} (${platformResults[k].error})`).join('; ')}`;
      if (posted.length) error += ` | posted: ${posted.join(', ')}`;
    }
    console.error('[FFX] PUBLISH NOT FULLY SUCCESSFUL:', error);
  }

  // Non-2xx on any failure so the honest verdict propagates through press-publish's
  // existing `!res.ok` handling to the dashboard (which then shows red, not green).
  // 409 when the article itself failed (usually a slug collision); 502 when only
  // ancillary social platforms failed.
  const httpStatus = allOk ? 200 : (articleFailed ? 409 : 502);

  return resp({
    success: allOk,
    slug,
    error,                                 // null on full success
    articlePublished: articleSelected ? articleOk : null,
    platforms: platformResults,            // per-platform breakdown: { ok, result | error }
    posted,                                // platforms that actually posted
    failed,                                // selected platforms that failed
    status,                                // raw per-platform status (unchanged shape — back-compat)
    contentPerfVerified: typeof contentPerfVerified !== 'undefined' ? contentPerfVerified : null,
    contentPerfError:    typeof contentPerfError    !== 'undefined' ? contentPerfError    : null,
  }, httpStatus, headers);
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
