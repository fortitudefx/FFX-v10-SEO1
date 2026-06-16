// functions/api/youtube-signals.js
// POST /api/youtube-signals               → Refresh All KPIs (fetch stats for all published videos)
// POST /api/youtube-signals?action=publish → Mark video as published (with which title was used)
// GET  /api/youtube-signals               → Return all performance records for dashboard table
//
// KV keys written:
//   youtube:published:{videoId}    — flag + metadata for a video marked as published
//   youtube:published:index        — array of all FFX-published videoIds + metadata
//   youtube:performance:{videoId}  — actual YouTube stats joined with what Claude generated
//   youtube:title:learning         — rolling array of performance records for intelligence engine
//   youtube:signals                — channel snapshot (read daily by intelligence engine)
//
// Requires: YOUTUBE_API_KEY in Cloudflare Pages environment variables

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// ── GET — return all performance records ──────────────────────────────────
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  // ── Single video published record lookup ─────────────────────────────────
  // GET /api/youtube-signals?action=get&videoId=xxx
  // Returns the published record for a single video — actualTitle, thumbnailHook etc.
  if (url.searchParams.get('action') === 'get') {
    const videoId = url.searchParams.get('videoId');
    if (!videoId) return json({ error: 'videoId required' }, 400, HEADERS);
    try {
      const pub = await env.FFX_KV.get('youtube:published:' + videoId, { type: 'json' }).catch(() => null);
      return json(pub || {}, 200, HEADERS);
    } catch(err) {
      return json({ error: err.message }, 500, HEADERS);
    }
  }

  try {
    // Read published index
    const publishedIndex = await env.FFX_KV.get('youtube:published:index', { type: 'json' }).catch(() => null);
    if (!publishedIndex || !publishedIndex.length) {
      return json({ records: [], channelSignals: null }, 200, HEADERS);
    }

    // Read performance record for each published video
    const records = [];
    for (const entry of publishedIndex) {
      try {
        const perf = await env.FFX_KV.get('youtube:performance:' + entry.videoId, { type: 'json' }).catch(() => null);
        const pub  = await env.FFX_KV.get('youtube:published:' + entry.videoId, { type: 'json' }).catch(() => null);
        records.push({
          videoId:     entry.videoId,
          publishedAt: entry.publishedAt,
          performance: perf || null,
          published:   pub  || null,
        });
      } catch(e) {}
    }

    // Read channel signals
    const channelSignals = await env.FFX_KV.get('youtube:signals', { type: 'json' }).catch(() => null);

    return json({ records, channelSignals }, 200, HEADERS);

  } catch(err) {
    console.error('[youtube-signals] GET error:', err.message);
    return json({ error: err.message }, 500, HEADERS);
  }
}

// ── POST — two actions: publish or refresh KPIs ───────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  const url    = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'publish') {
    return handleMarkPublished(request, env);
  }

  return handleRefreshKPIs(env);
}

// ── Mark as Published ─────────────────────────────────────────────────────
async function handleMarkPublished(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400, HEADERS);
  }

  const { videoId, titleUsed, ownTitle, hookUsed } = body;
  if (!videoId) return json({ error: 'videoId required' }, 400, HEADERS);
  if (!titleUsed) return json({ error: 'titleUsed required: primary|alt1|alt2|own' }, 400, HEADERS);

  try {
    // Read the metadata Claude generated for this video
    const meta = await env.FFX_KV.get('youtube:metadata:' + videoId, { type: 'json' }).catch(() => null);
    if (!meta) {
      return json({ error: 'No SEO package found for this video. Generate the SEO package first.' }, 400, HEADERS);
    }

    // Resolve actual title used
    let actualTitle = '';
    if (titleUsed === 'primary') {
      actualTitle = meta.primaryTitle || '';
    } else if (titleUsed === 'alt1') {
      actualTitle = (meta.titleAlternatives && meta.titleAlternatives[0] && meta.titleAlternatives[0].title) || meta.primaryTitle || '';
    } else if (titleUsed === 'alt2') {
      actualTitle = (meta.titleAlternatives && meta.titleAlternatives[1] && meta.titleAlternatives[1].title) || meta.primaryTitle || '';
    } else if (titleUsed === 'own') {
      actualTitle = ownTitle || '';
    }

    const now = new Date().toISOString();

    // Write youtube:published:{videoId}
    const publishedRecord = {
      videoId,
      publishedAt:  now,
      titleUsed,    // which option: primary|alt1|alt2|own
      actualTitle,  // the exact text that went into YouTube
      claudeTitle:  meta.primaryTitle || '',
      thumbnailHook: hookUsed || (meta.thumbnailConcept && meta.thumbnailConcept.textOverlay) || null,
      visualScene:   (meta.thumbnailConcept && meta.thumbnailConcept.visualScene) || null,
      emotionalRegister: (meta.thumbnailConcept && meta.thumbnailConcept.emotionalRegister) || null,
      colourTemperature: (meta.thumbnailConcept && meta.thumbnailConcept.colourTemperature) || null,
      usedClaudeTitle: titleUsed !== 'own',
      usedPrimaryTitle: titleUsed === 'primary',
      tags:          meta.tags || [],
      youtubeUrl:    meta.youtubeUrl || ('https://www.youtube.com/watch?v=' + videoId),
      statsUpdatedAt: null,
    };

    await env.FFX_KV.put('youtube:published:' + videoId, JSON.stringify(publishedRecord));

    // Clear generation checkpoint on publish — video is live, no more retries needed
    try { await env.FFX_KV.delete('video:checkpoint:' + videoId); } catch {}

    // Update youtube:published:index
    const index = await env.FFX_KV.get('youtube:published:index', { type: 'json' }).catch(() => []);
    const arr   = Array.isArray(index) ? index : [];
    const existing = arr.findIndex(function(e) { return e.videoId === videoId; });
    const indexEntry = { videoId, publishedAt: now, actualTitle, titleUsed };
    if (existing !== -1) {
      arr[existing] = indexEntry;
    } else {
      arr.unshift(indexEntry); // newest first
    }
    await env.FFX_KV.put('youtube:published:index', JSON.stringify(arr));

    console.log('[youtube-signals] Marked as published:', videoId, '| titleUsed:', titleUsed, '| actual:', actualTitle);

    return json({
      success: true,
      videoId,
      actualTitle,
      titleUsed,
      publishedAt: now,
    }, 200, HEADERS);

  } catch(err) {
    console.error('[youtube-signals] handleMarkPublished error:', err.message);
    return json({ error: err.message }, 500, HEADERS);
  }
}

// ── Refresh All KPIs ──────────────────────────────────────────────────────
async function handleRefreshKPIs(env) {
  if (!env.YOUTUBE_API_KEY) {
    return json({
      error: 'YOUTUBE_API_KEY not set in Cloudflare Pages environment variables. Add it in Cloudflare Dashboard → Pages → FFX project → Settings → Environment variables.',
    }, 500, HEADERS);
  }

  try {
    // Read published index — only fetch stats for FFX-system videos
    const publishedIndex = await env.FFX_KV.get('youtube:published:index', { type: 'json' }).catch(() => null);
    if (!publishedIndex || !publishedIndex.length) {
      return json({ error: 'No published videos found. Mark videos as published first using the Generate tab.' }, 400, HEADERS);
    }

    const videoIds = publishedIndex.map(function(e) { return e.videoId; });

    // ── Fetch YouTube video statistics in batches of 50 ──────────────────
    const allStats = {};
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const statsUrl = YT_API_BASE + '/videos?part=statistics,snippet&id=' + batch.join(',') + '&key=' + env.YOUTUBE_API_KEY;
      const res = await fetch(statsUrl);
      if (!res.ok) {
        const errText = await res.text();
        throw new Error('YouTube API videos.list failed: ' + res.status + ' ' + errText);
      }
      const data = await res.json();
      for (const item of (data.items || [])) {
        allStats[item.id] = {
          viewCount:    parseInt(item.statistics.viewCount    || 0),
          likeCount:    parseInt(item.statistics.likeCount    || 0),
          commentCount: parseInt(item.statistics.commentCount || 0),
          title:        item.snippet.title || '',
          publishedAt:  item.snippet.publishedAt || null,
        };
      }
    }

    // ── Fetch subscribersGained per video via YouTube Analytics API ─────────
    // Requires yt-analytics.readonly OAuth scope — gracefully skips if 403
    const subsGainedMap = {};
    try {
      const accessToken = await getAccessToken(env);
      if (accessToken) {
        for (const videoId of videoIds) {
          try {
            const pub = await env.FFX_KV.get('youtube:published:' + videoId, { type: 'json' }).catch(() => null);
            const startDate = pub && pub.publishedAt
              ? pub.publishedAt.split('T')[0]
              : '2020-01-01';
            const analyticsUrl = 'https://youtubeanalytics.googleapis.com/v2/reports'
              + '?ids=channel==MINE'
              + '&startDate=' + startDate
              + '&endDate=' + new Date().toISOString().split('T')[0]
              + '&metrics=subscribersGained'
              + '&filters=video==' + videoId
              + '&dimensions=video';
            const aRes = await fetch(analyticsUrl, {
              headers: { 'Authorization': 'Bearer ' + accessToken },
            });
            if (aRes.ok) {
              const aData = await aRes.json();
              if (aData.rows && aData.rows[0]) {
                subsGainedMap[videoId] = parseInt(aData.rows[0][1] || 0);
              }
            }
            // 403 = scope not yet authorised — skip silently
          } catch(e) {}
        }
      }
    } catch(e) {
      console.error('[youtube-signals] subscribersGained fetch failed (non-fatal):', e.message);
    }

    // ── Fetch channel-level stats ─────────────────────────────────────────
    let channelStats = null;
    try {
      const chUrl = YT_API_BASE + '/channels?part=statistics&mine=true&key=' + env.YOUTUBE_API_KEY;
      // Note: mine=true requires OAuth. Use channelId directly instead.
      // Channel ID is in cron env but not Pages — use the known constant
      const CHANNEL_ID = 'UConuNkzv83jBubkaQpXwXjQ';
      const chUrlById  = YT_API_BASE + '/channels?part=statistics&id=' + CHANNEL_ID + '&key=' + env.YOUTUBE_API_KEY;
      const chRes = await fetch(chUrlById);
      if (chRes.ok) {
        const chData = await chRes.json();
        const ch = chData.items && chData.items[0];
        if (ch) {
          channelStats = {
            subscriberCount: parseInt(ch.statistics.subscriberCount || 0),
            totalViewCount:  parseInt(ch.statistics.viewCount       || 0),
            videoCount:      parseInt(ch.statistics.videoCount      || 0),
            fetchedAt:       new Date().toISOString(),
          };
        }
      }
    } catch(chErr) {
      console.error('[youtube-signals] Channel stats fetch failed (non-fatal):', chErr.message);
    }

    // ── Compute channel average views (from all fetched videos) ───────────
    const allViews = Object.values(allStats).map(function(s) { return s.viewCount; });
    const channelAvgViews = allViews.length > 0
      ? Math.round(allViews.reduce(function(a, b) { return a + b; }, 0) / allViews.length)
      : 0;

    // ── Write performance record per video + build learning entries ────────
    const updatedRecords = [];
    const learningEntries = [];

    for (const entry of publishedIndex) {
      const videoId = entry.videoId;
      const stats   = allStats[videoId];
      if (!stats) continue;

      const pub = await env.FFX_KV.get('youtube:published:' + videoId, { type: 'json' }).catch(() => null);
      if (!pub) continue;

      const now = new Date().toISOString();

      // Beat average?
      const beatAverage = channelAvgViews > 0 ? stats.viewCount > channelAvgViews : null;
      const viewsVsAvgPct = channelAvgViews > 0
        ? Math.round(((stats.viewCount - channelAvgViews) / channelAvgViews) * 100)
        : null;

      const perfRecord = {
        videoId,
        publishedAt:       pub.publishedAt,
        actualTitle:       pub.actualTitle,
        titleUsed:         pub.titleUsed,         // primary|alt1|alt2|own
        claudeTitle:       pub.claudeTitle,
        usedClaudeTitle:   pub.usedClaudeTitle,
        usedPrimaryTitle:  pub.usedPrimaryTitle,
        thumbnailHook:     pub.thumbnailHook,
        visualScene:       pub.visualScene,
        emotionalRegister: pub.emotionalRegister,
        colourTemperature: pub.colourTemperature,
        tags:              pub.tags || [],
        youtubeUrl:        pub.youtubeUrl,
        // Live stats
        viewCount:         stats.viewCount,
        likeCount:         stats.likeCount,
        commentCount:      stats.commentCount,
        subscribersGained: subsGainedMap[videoId] !== undefined ? subsGainedMap[videoId] : null,
        channelAvgViews,
        beatAverage,
        viewsVsAvgPct,
        statsUpdatedAt:    now,
      };

      await env.FFX_KV.put('youtube:performance:' + videoId, JSON.stringify(perfRecord));

      // Update published record with statsUpdatedAt
      pub.statsUpdatedAt = now;
      await env.FFX_KV.put('youtube:published:' + videoId, JSON.stringify(pub));

      updatedRecords.push(perfRecord);

      // Build learning entry — only if video has meaningful data (>100 views)
      if (stats.viewCount >= 100) {
        learningEntries.push({
          videoId,
          measuredAt:        now,
          titleUsed:         pub.titleUsed,
          actualTitle:       pub.actualTitle,
          usedClaudeTitle:   pub.usedClaudeTitle,
          usedPrimaryTitle:  pub.usedPrimaryTitle,
          thumbnailHook:     pub.thumbnailHook,
          visualScene:       pub.visualScene,
          emotionalRegister: pub.emotionalRegister,
          colourTemperature: pub.colourTemperature,
          viewCount:         stats.viewCount,
          likeCount:         stats.likeCount,
          commentCount:      stats.commentCount,
          channelAvgViews,
          beatAverage,
          viewsVsAvgPct,
          // Title format extraction for pattern learning
          titleStartsWithWord: pub.actualTitle ? pub.actualTitle.split(' ')[0].toUpperCase() : null,
          titleLength:         pub.actualTitle ? pub.actualTitle.length : null,
          titleHasNumber:      pub.actualTitle ? /\d/.test(pub.actualTitle) : false,
          titleHasQuestion:    pub.actualTitle ? pub.actualTitle.includes('?') : false,
        });
      }
    }

    // ── Write youtube:title:learning — rolling array, keep last 50 ────────
    if (learningEntries.length > 0) {
      const existing = await env.FFX_KV.get('youtube:title:learning', { type: 'json' }).catch(() => []);
      const arr = Array.isArray(existing) ? existing : [];

      for (const entry of learningEntries) {
        // Replace existing entry for same videoId, or append
        const idx = arr.findIndex(function(e) { return e.videoId === entry.videoId; });
        if (idx !== -1) {
          arr[idx] = entry;
        } else {
          arr.push(entry);
        }
      }

      // Keep last 50, sorted by viewCount desc so best performers are prominent
      const sorted = arr.sort(function(a, b) { return b.viewCount - a.viewCount; }).slice(0, 50);
      await env.FFX_KV.put('youtube:title:learning', JSON.stringify(sorted));
      console.log('[youtube-signals] youtube:title:learning updated with', learningEntries.length, 'entries');
    }

    // ── Write youtube:signals — channel snapshot for intelligence engine ───
    const ytSignals = {
      fetchedAt:        new Date().toISOString(),
      channelStats,
      channelAvgViews,
      totalFFXVideos:   publishedIndex.length,
      totalMeasured:    updatedRecords.length,
      topPerformers:    updatedRecords
        .sort(function(a, b) { return b.viewCount - a.viewCount; })
        .slice(0, 3)
        .map(function(r) {
          return {
            videoId:      r.videoId,
            title:        r.actualTitle,
            viewCount:    r.viewCount,
            beatAverage:  r.beatAverage,
            visualScene:  r.visualScene,
            thumbnailHook: r.thumbnailHook,
            titleUsed:    r.titleUsed,
          };
        }),
      titleChoiceStats: computeTitleChoiceStats(updatedRecords),
      visualSceneStats: computeVisualSceneStats(updatedRecords),
    };

    await env.FFX_KV.put('youtube:signals', JSON.stringify(ytSignals));
    console.log('[youtube-signals] youtube:signals written — channel avg views:', channelAvgViews);

    return json({
      success:      true,
      updatedCount: updatedRecords.length,
      records:      updatedRecords,
      channelStats,
      channelAvgViews,
    }, 200, HEADERS);

  } catch(err) {
    console.error('[youtube-signals] handleRefreshKPIs error:', err.message);
    return json({ error: err.message }, 500, HEADERS);
  }
}

// ── Compute title choice stats for signals ────────────────────────────────
function computeTitleChoiceStats(records) {
  if (!records.length) return null;
  const byChoice = {};
  for (const r of records) {
    const key = r.titleUsed || 'unknown';
    if (!byChoice[key]) byChoice[key] = { count: 0, totalViews: 0, beatAvgCount: 0 };
    byChoice[key].count++;
    byChoice[key].totalViews += r.viewCount || 0;
    if (r.beatAverage) byChoice[key].beatAvgCount++;
  }
  const result = {};
  for (const [key, val] of Object.entries(byChoice)) {
    result[key] = {
      count:        val.count,
      avgViews:     val.count > 0 ? Math.round(val.totalViews / val.count) : 0,
      beatAvgRate:  val.count > 0 ? Math.round((val.beatAvgCount / val.count) * 100) : 0,
    };
  }
  return result;
}

// ── Compute visual scene stats for signals ────────────────────────────────
function computeVisualSceneStats(records) {
  if (!records.length) return null;
  const byScene = {};
  for (const r of records) {
    const key = r.visualScene || 'unknown';
    if (!byScene[key]) byScene[key] = { count: 0, totalViews: 0, beatAvgCount: 0 };
    byScene[key].count++;
    byScene[key].totalViews += r.viewCount || 0;
    if (r.beatAverage) byScene[key].beatAvgCount++;
  }
  const result = {};
  for (const [key, val] of Object.entries(byScene)) {
    result[key] = {
      count:       val.count,
      avgViews:    val.count > 0 ? Math.round(val.totalViews / val.count) : 0,
      beatAvgRate: val.count > 0 ? Math.round((val.beatAvgCount / val.count) * 100) : 0,
    };
  }
  return result;
}

// ── Google OAuth access token (cached in KV) ─────────────────────────────
async function getAccessToken(env) {
  try {
    var cached = await env.FFX_KV.get('google:access_token', { type: 'text' }).catch(function() { return null; });
    var expiry = await env.FFX_KV.get('google:access_token_expiry', { type: 'text' }).catch(function() { return null; });
    if (cached && expiry && Date.now() < parseInt(expiry) - 60000) return cached;
  } catch(e) {}
  var res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID || '805135063067-mb9ap5knagr29280dmg1s63gcbd2f01t.apps.googleusercontent.com',
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }).toString(),
  });
  if (!res.ok) return null; // Non-fatal — analytics scope may not be authorised yet
  var data = await res.json();
  var expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  try {
    await env.FFX_KV.put('google:access_token',        data.access_token, { expirationTtl: 3300 });
    await env.FFX_KV.put('google:access_token_expiry', String(expiresAt), { expirationTtl: 3300 });
  } catch(e) {}
  return data.access_token;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
