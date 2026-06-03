// ─────────────────────────────────────────────────────────────────────────────
// FFX Cron Worker
// Schedule: Mon–Fri 9am Dubai time (5am UTC)
//
// Logic:
// 1. Check for new YouTube video uploaded in last 25hrs → add to TOP of queue
// 2. Check queue length:
//    → empty: pull 10 newest unprocessed from back-catalogue → add to queue
//    → 3 or fewer: top up with 7 more
//    → 4+: do nothing
// 3. Trigger generation on first item in queue
// 4. Collect fresh SEO + GA4 signals
// 5. Update intelligence:targets with actuals vs targets
// 6. Trigger intelligence engine
// ─────────────────────────────────────────────────────────────────────────────

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const QUEUE_KEY        = 'queue:index';
const QUEUE_TARGET     = 10;
const QUEUE_TOPUP_AT   = 3;
const QUEUE_TOPUP_BY   = 7;

export default {
  async scheduled(event, env, ctx) {
    // Route by cron expression
    // "0 3 * * *"         = daily 7am Dubai (UTC+4) — indexing engine only
    // "0 5 * * 1,2,3,4,5" = Mon-Fri 9am Dubai      — full pipeline
    if (event.cron === '0 3 * * *') {
      ctx.waitUntil(runIndexingOnly(env));
    } else {
      ctx.waitUntil(runCron(env));
    }
  },

  async fetch(request, env, ctx) {
    // HTTP endpoint so dashboard can trigger indexing scan directly
    // POST /run-indexing → trigger scan, return 202 immediately
    var url = new URL(request.url);
    var CORS = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method === 'POST' && url.pathname === '/run-indexing') {
      ctx.waitUntil(runIndexingOnly(env));
      return new Response(JSON.stringify({ started: true }), { status: 202, headers: CORS });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// INDEXING ONLY — runs on the 0 3 * * * schedule (daily 7am Dubai)
// ─────────────────────────────────────────────────────────────────────────────

async function runIndexingOnly(env) {
  try {
    console.log('[ffx-cron] Starting indexing-only run');
    await runIndexingEngine(env);
    console.log('[ffx-cron] Indexing-only run complete');
  } catch (err) {
    console.error('[ffx-cron] Indexing-only run error:', err.message);
    await sendAlertEmail(env, {
      subject: '[FFX Cron] Indexing engine error',
      message: 'Indexing engine run failed: ' + err.message,
    });
  }
}

async function runCron(env) {
  try {
    console.log('[ffx-cron] Starting cron run');

    // ── Step 1: Check for new video uploaded in last 25hrs ────────────────
    const newVideo = await findNewVideo(env);
    if (newVideo) {
      console.log('[ffx-cron] New video found:', newVideo.videoId, newVideo.title);
      await addToQueueTop(env, newVideo);
    }

    // ── Step 2: Check queue length and top up if needed ───────────────────
    const queue = await getQueue(env);
    console.log('[ffx-cron] Current queue length:', queue.length);

    if (queue.length === 0) {
      console.log('[ffx-cron] Queue empty — pulling', QUEUE_TARGET, 'videos from back-catalogue');
      const videos = await findBacklogVideos(env, QUEUE_TARGET, queue);
      for (const v of videos) await addToQueueBottom(env, v);
      console.log('[ffx-cron] Added', videos.length, 'videos to queue');
    } else if (queue.length <= QUEUE_TOPUP_AT) {
      console.log('[ffx-cron] Queue low (', queue.length, ') — topping up with', QUEUE_TOPUP_BY);
      const videos = await findBacklogVideos(env, QUEUE_TOPUP_BY, queue);
      for (const v of videos) await addToQueueBottom(env, v);
      console.log('[ffx-cron] Added', videos.length, 'videos to queue');
    } else {
      console.log('[ffx-cron] Queue healthy — no top-up needed');
    }

    // ── Step 3: Trigger generation on first queue item ────────────────────
    const updatedQueue = await getQueue(env);
    if (!updatedQueue.length) {
      console.log('[ffx-cron] Queue empty after top-up — all videos processed');
    } else {
      const firstItem = updatedQueue[0];
      console.log('[ffx-cron] Triggering generation for:', firstItem.videoId, firstItem.title);
      await triggerGeneration(env, firstItem);
    }

    // ── Step 4: Collect fresh SEO + GA4 signals ───────────────────────────
    console.log('[ffx-cron] Collecting SEO signals...');
    try {
      const seoRes = await fetch('https://fortitudefx.com/api/seo-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (seoRes.ok) {
        console.log('[ffx-cron] SEO signals collected');
      } else {
        console.error('[ffx-cron] SEO signals failed:', seoRes.status);
      }
    } catch(e) {
      console.error('[ffx-cron] SEO signals error:', e.message);
    }

    console.log('[ffx-cron] Collecting GA4 signals...');
    try {
      const ga4Res = await fetch('https://fortitudefx.com/api/ga4-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (ga4Res.ok) {
        console.log('[ffx-cron] GA4 signals collected');
      } else {
        console.error('[ffx-cron] GA4 signals failed:', ga4Res.status);
      }
    } catch(e) {
      console.error('[ffx-cron] GA4 signals error:', e.message);
    }

    // ── Step 5: Update intelligence:targets with actuals ──────────────────
    console.log('[ffx-cron] Updating target actuals...');
    try {
      await updateTargetActuals(env);
      console.log('[ffx-cron] Target actuals updated');
    } catch(e) {
      console.error('[ffx-cron] Target actuals error:', e.message);
    }

    // ── Step 6: Trigger intelligence engine ───────────────────────────────
    console.log('[ffx-cron] Triggering intelligence engine...');
    try {
      const intelRes = await fetch('https://fortitudefx.com/api/intelligence-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (intelRes.ok) {
        console.log('[ffx-cron] Intelligence engine triggered');
      } else {
        console.error('[ffx-cron] Intelligence engine failed:', intelRes.status);
      }
    } catch(e) {
      console.error('[ffx-cron] Intelligence engine error:', e.message);
    }

    // ── Step 7: Check 72hr reply performance ──────────────────────────────
    // Reads reply_performance records older than 72hrs, queries GA4 referral
    // traffic for each UTM source, updates overallResult, feeds intelligence engine
    console.log('[ffx-cron] Checking 72hr reply performance...');
    try {
      await checkReplyPerformance(env);
      console.log('[ffx-cron] Reply performance check complete');
    } catch(e) {
      console.error('[ffx-cron] Reply performance check error (non-fatal):', e.message);
    }

    // ── Step 8: Run indexing engine ──────────────────────────────────────
    console.log('[ffx-cron] Running indexing engine...');
    try {
      await runIndexingEngine(env);
      console.log('[ffx-cron] Indexing engine complete');
    } catch(e) {
      console.error('[ffx-cron] Indexing engine error (non-fatal):', e.message);
    }

    console.log('[ffx-cron] Cron run complete');

  } catch (err) {
    console.error('[ffx-cron] Fatal error:', err.message);
    await sendAlertEmail(env, {
      subject: '[FFX Cron] Fatal error',
      message: `Cron run failed: ${err.message}\n\nStack: ${err.stack || 'no stack'}`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: UPDATE TARGET ACTUALS
// Reads latest signals, compares vs targets, writes status
// ─────────────────────────────────────────────────────────────────────────────

async function updateTargetActuals(env) {
  const [targetsRaw, seoRaw, ga4Raw] = await Promise.all([
    env.FFX_KV.get('intelligence:targets', { type: 'json' }).catch(() => null),
    env.FFX_KV.get('seo:signals',          { type: 'json' }).catch(() => null),
    env.FFX_KV.get('ga4:signals',          { type: 'json' }).catch(() => null),
  ]);

  if (!targetsRaw) {
    console.log('[ffx-cron] No targets found — skipping actuals update');
    return;
  }

  const targets = targetsRaw;
  const current = targets.current;
  if (!current || !current.targets) return;

  // Pull actuals from signals
  const seoActuals = {
    impressions: seoRaw?.totals?.impressions || 0,
    clicks:      seoRaw?.totals?.clicks      || 0,
    avgPosition: seoRaw?.totals?.position    || 0,
  };

  const ga4Actuals = {
    users:       ga4Raw?.totals?.users       || 0,
    sessions:    ga4Raw?.totals?.sessions    || 0,
    avgDuration: ga4Raw?.totals?.avgDuration || 0,
    bounceRate:  ga4Raw?.totals?.bounceRate  || 0,
  };

  // Map actuals to target keys
  const actualMap = {
    impressions:  seoActuals.impressions,
    clicks:       seoActuals.clicks,
    avgPosition:  seoActuals.avgPosition,
    users:        ga4Actuals.users,
    sessions:     ga4Actuals.sessions,
    avgDuration:  ga4Actuals.avgDuration,
    bounceRate:   ga4Actuals.bounceRate,
  };

  // Calculate status for each KPI
  const amberAlerts = [];
  const redAlerts   = [];
  let   overallWorst = 'on_track';

  for (const [key, entry] of Object.entries(current.targets)) {
    if (!(key in actualMap)) continue;

    const actual = actualMap[key];
    const target = entry.target;
    const direction = entry.direction || 'above'; // 'above' = higher is better, 'below' = lower is better

    entry.actual = actual;

    // Calculate ratio — direction aware
    let ratio;
    if (direction === 'below') {
      // Lower is better (bounce rate, position)
      ratio = target > 0 ? target / Math.max(actual, 0.001) : 1;
    } else {
      ratio = target > 0 ? actual / target : 1;
    }

    // Set status
    if (ratio >= 1.15)      entry.status = 'ahead';
    else if (ratio >= 0.85) entry.status = 'on_track';
    else if (ratio >= 0.70) entry.status = 'behind';
    else                    entry.status = 'critical';

    // Track alerts
    if (entry.status === 'critical') {
      redAlerts.push(key);
      overallWorst = 'critical';
    } else if (entry.status === 'behind' && overallWorst !== 'critical') {
      amberAlerts.push(key);
      if (overallWorst === 'on_track') overallWorst = 'behind';
    }
  }

  // Update current week
  current.amberAlerts  = amberAlerts;
  current.redAlerts    = redAlerts;
  current.overallStatus = overallWorst;
  current.lastUpdated  = new Date().toISOString();

  // Identify primary gap
  if (redAlerts.length > 0) {
    current.primaryGap = redAlerts[0];
    current.primaryGapCause = redAlerts.includes('articlesPublished')
      ? 'Content output is the upstream cause — fix this first'
      : 'Strategy gap — signals not improving despite publishing';
  } else if (amberAlerts.length > 0) {
    current.primaryGap = amberAlerts[0];
    current.primaryGapCause = 'Behind target — monitor for 2 more weeks before adapting';
  } else {
    current.primaryGap      = null;
    current.primaryGapCause = null;
  }

  // Append to history weekly (Mondays only)
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 1) {
    if (!targets.history) targets.history = [];
    targets.history.push({
      weekOf:        current.weekOf,
      weekNumber:    current.weekNumber,
      overallStatus: current.overallStatus,
      actuals:       { ...actualMap },
      primaryGap:    current.primaryGap,
      updatedAt:     new Date().toISOString(),
    });
    // Keep last 52 weeks
    targets.history = targets.history.slice(-52);

    // Advance week number for next week
    current.weekNumber = (current.weekNumber || 1) + 1;
    current.weekOf     = new Date().toISOString().split('T')[0];

    // Set next week targets from milestones if available
    const wk = current.weekNumber;
    const milestone = wk <= 4  ? targets.milestones?.week4  :
                      wk <= 8  ? targets.milestones?.week8  :
                      wk <= 13 ? targets.milestones?.week13 : null;
    if (milestone) {
      if (milestone.seo?.impressions) current.targets.impressions.target = Math.round(milestone.seo.impressions / 4);
      if (milestone.ga4?.users)       current.targets.users.target       = Math.round(milestone.ga4.users / 4);
      if (milestone.ga4?.sessions)    current.targets.sessions.target    = Math.round(milestone.ga4.sessions / 4);
    }
  }

  await env.FFX_KV.put('intelligence:targets', JSON.stringify(targets));
  console.log('[ffx-cron] Targets updated — overall:', overallWorst, '| red:', redAlerts.join(',') || 'none', '| amber:', amberAlerts.join(',') || 'none');
}

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE HELPERS — unchanged
// ─────────────────────────────────────────────────────────────────────────────

async function getQueue(env) {
  const raw = await env.FFX_KV.get(QUEUE_KEY, { type: 'json' }).catch(() => null);
  return Array.isArray(raw) ? raw : [];
}

async function addToQueueTop(env, video) {
  const queue = await getQueue(env);
  if (queue.some(item => item.videoId === video.videoId)) {
    console.log('[ffx-cron] Already in queue:', video.videoId);
    return;
  }
  queue.unshift({
    videoId:    video.videoId,
    title:      video.title,
    youtubeUrl: video.youtubeUrl,
    addedAt:    new Date().toISOString(),
    addedBy:    'cron-new',
    wasGenerated: false,
  });
  await env.FFX_KV.put(QUEUE_KEY, JSON.stringify(queue));
  console.log('[ffx-cron] Added to top of queue:', video.videoId);
}

async function addToQueueBottom(env, video) {
  const queue = await getQueue(env);
  if (queue.some(item => item.videoId === video.videoId)) return;
  queue.push({
    videoId:    video.videoId,
    title:      video.title,
    youtubeUrl: video.youtubeUrl,
    addedAt:    new Date().toISOString(),
    addedBy:    'cron',
    wasGenerated: false,
  });
  await env.FFX_KV.put(QUEUE_KEY, JSON.stringify(queue));
}

// ─────────────────────────────────────────────────────────────────────────────
// FIND NEW VIDEO (last 25hrs) — FIX: 180s threshold (was 60s)
// ─────────────────────────────────────────────────────────────────────────────

async function isLongFormVideo(videoId, apiKey) {
  const url = `${YOUTUBE_API_BASE}/videos?part=contentDetails&id=${videoId}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return true;
  const data = await res.json();
  const duration = data.items?.[0]?.contentDetails?.duration || '';
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return true;
  const hours = parseInt(match[1] || 0);
  const mins  = parseInt(match[2] || 0);
  const secs  = parseInt(match[3] || 0);
  const total = hours * 3600 + mins * 60 + secs;
  return total >= 180; // FIX: 3 minutes minimum (was 60s)
}

async function findNewVideo(env) {
  const since = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const url   = `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${env.YOUTUBE_CHANNEL_ID}&type=video&order=date&publishedAfter=${since}&maxResults=10&key=${env.YOUTUBE_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube search API failed: ${res.status} ${await res.text()}`);

  const data  = await res.json();
  const items = data.items || [];
  const queue = await getQueue(env);

  for (const item of items) {
    const videoId = item.id?.videoId;
    if (!videoId) continue;

    const published = await env.FFX_KV.get(`published:${videoId}`).catch(() => null);
    if (published) continue;

    if (queue.some(q => q.videoId === videoId)) continue;

    // Check parked queue — never re-add parked videos
    const parked = await env.FFX_KV.get('queue:parked', { type: 'json' }).catch(() => null);
    if (Array.isArray(parked) && parked.some(p => p.videoId === videoId)) continue;

    const isLong = await isLongFormVideo(videoId, env.YOUTUBE_API_KEY);
    if (!isLong) continue;

    return {
      videoId,
      title:      item.snippet.title,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIND BACKLOG VIDEOS — unchanged except parked check added
// ─────────────────────────────────────────────────────────────────────────────

async function findBacklogVideos(env, limit, currentQueue) {
  const results   = [];
  let pageToken   = null;
  const queuedIds = new Set(currentQueue.map(q => q.videoId));

  // Load parked videos — never add them back
  const parked    = await env.FFX_KV.get('queue:parked', { type: 'json' }).catch(() => null);
  const parkedIds = new Set(Array.isArray(parked) ? parked.map(p => p.videoId) : []);

  do {
    const pageParam = pageToken ? `&pageToken=${pageToken}` : '';
    const url = `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${env.YOUTUBE_CHANNEL_ID}&type=video&order=date&maxResults=50${pageParam}&key=${env.YOUTUBE_API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube backlog API failed: ${res.status} ${await res.text()}`);

    const data  = await res.json();
    const items = data.items || [];

    for (const item of items) {
      if (results.length >= limit) break;

      const videoId = item.id?.videoId;
      if (!videoId) continue;

      if (queuedIds.has(videoId))  continue;
      if (parkedIds.has(videoId))  continue; // Never re-add parked videos

      const published = await env.FFX_KV.get(`published:${videoId}`).catch(() => null);
      if (published) continue;

      const isLong = await isLongFormVideo(videoId, env.YOUTUBE_API_KEY);
      if (!isLong) continue;

      results.push({
        videoId,
        title:      item.snippet.title,
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      });
      queuedIds.add(videoId);
    }

    if (results.length >= limit) break;
    pageToken = data.nextPageToken || null;

  } while (pageToken);

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER GENERATION — unchanged
// ─────────────────────────────────────────────────────────────────────────────

async function triggerGeneration(env, item) {
  const lock = await env.FFX_KV.get('lock:generating').catch(() => null);
  if (lock) {
    const lockData = JSON.parse(lock);
    console.log('[ffx-cron] Generation already in progress for:', lockData.videoId, '— skipping');
    return;
  }

  const existing = await env.FFX_KV.get(`video:${item.videoId}`).catch(() => null);
  if (existing) {
    console.log('[ffx-cron] Already generated:', item.videoId, '— skipping generation');
    return;
  }

  const jobId = `${Date.now()}-${item.videoId}`;

  await env.FFX_KV.put(
    `job:${jobId}`,
    JSON.stringify({ status: 'pending', videoId: item.videoId, createdAt: new Date().toISOString() }),
    { expirationTtl: 86400 }
  );

  await env.FFX_QUEUE.send({
    jobId,
    videoId:    item.videoId,
    youtubeUrl: item.youtubeUrl,
    source:     'cron',
  });

  const queue = await getQueue(env);
  const idx   = queue.findIndex(q => q.videoId === item.videoId);
  if (idx !== -1) {
    queue[idx].wasGenerated = true;
    queue[idx].jobId        = jobId;
    await env.FFX_KV.put(QUEUE_KEY, JSON.stringify(queue));
  }

  console.log('[ffx-cron] Generation triggered:', item.videoId, 'jobId:', jobId);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7: CHECK 72HR REPLY PERFORMANCE
// Reads all reply_performance records, finds those 72hrs+ old still pending,
// fetches GA4 referral data for UTM source, updates overallResult
// ─────────────────────────────────────────────────────────────────────────────

async function checkReplyPerformance(env) {
  const list = await env.FFX_KV.list({ prefix: 'intelligence:reply_performance:' }).catch(() => null);
  if (!list || !list.keys.length) {
    console.log('[ffx-cron] No reply performance records to check');
    return;
  }

  const now       = new Date();
  const ga4Signals = await env.FFX_KV.get('ga4:signals', { type: 'json' }).catch(() => null);

  let updated = 0;

  for (const key of list.keys) {
    try {
      const perf = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
      if (!perf) continue;
      if (perf.overallResult !== 'pending') continue; // Already scored

      const postedAt = new Date(perf.postedAt || 0);
      const ageHrs   = (now - postedAt) / 3600000;
      if (ageHrs < 72) continue; // Not yet 72hrs

      // ── Score based on GA4 referral traffic ────────────────────────────
      // GA4 signals track topSources — check if platform appears as referral
      let trafficGenerated = 0;
      if (ga4Signals && ga4Signals.topSources && perf.platform) {
        const platformLower = perf.platform.toLowerCase();
        const match = ga4Signals.topSources.find(s =>
          s.source && s.source.toLowerCase().includes(platformLower)
        );
        if (match) trafficGenerated = match.sessions || 0;
      }

      // ── Determine overall result ────────────────────────────────────────
      // high: 5+ sessions from this platform referral
      // medium: 1-4 sessions
      // low: 0 sessions but reply was posted (engagement value)
      let overallResult;
      if (trafficGenerated >= 5)      overallResult = 'high';
      else if (trafficGenerated >= 1) overallResult = 'medium';
      else                            overallResult = 'low';

      perf.trafficGenerated = trafficGenerated;
      perf.overallResult    = overallResult;
      perf.checkedAt        = now.toISOString();
      perf.accurate         = trafficGenerated > 0; // Generated any traffic = accurate prediction

      await env.FFX_KV.put(key.name, JSON.stringify(perf), { expirationTtl: 86400 * 30 });
      updated++;
      console.log('[ffx-cron] Reply performance scored:', perf.id, '| result:', overallResult, '| traffic:', trafficGenerated);

    } catch(perfErr) {
      console.error('[ffx-cron] Reply performance check error for key:', key.name, perfErr.message);
    }
  }

  console.log('[ffx-cron] Reply performance: scored', updated, 'records');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8 + HTTP /run-indexing — FULL INDEXING ENGINE
// Runs entirely in cron Worker (Paid plan: 15min CPU for cron, no CPU limit for fetch)
// All crypto, API calls, and KV writes happen here — never in Pages Functions
// ─────────────────────────────────────────────────────────────────────────────

var IX_SC_PROPERTY  = 'sc-domain:fortitudefx.com';
var IX_SITE_BASE    = 'https://fortitudefx.com';
var IX_STATUS_KEY   = 'indexing:status';
var IX_PROGRESS_KEY = 'indexing:progress';
var IX_HISTORY_TTL  = 7776000;
var IX_STATUS_TTL   = 90000;

var IX_STATIC_PAGES = [
  'https://fortitudefx.com/',
  'https://fortitudefx.com/blog',
  'https://fortitudefx.com/bootcamp',
  'https://fortitudefx.com/vipdiscord',
  'https://fortitudefx.com/waitlist',
  'https://fortitudefx.com/privacy',
];

async function writeIndexProgress(env, step, total, label) {
  try {
    await env.FFX_KV.put(IX_PROGRESS_KEY, JSON.stringify({
      step: step, total: total, label: label,
      updatedAt: new Date().toISOString(),
    }), { expirationTtl: 600 });
  } catch(e) {}
}

async function runIndexingEngine(env) {
  try {
    console.log('[indexing-engine] Starting scan');
    await writeIndexProgress(env, 1, 6, 'Getting Google OAuth token');

    // Step 1: Get OAuth token (refresh token path - same as google-auth.js)
    var oauthToken = await ixGetOAuthToken(env);
    if (!oauthToken) {
      console.error('[indexing-engine] OAuth token failed');
      await writeIndexProgress(env, 1, 6, 'OAuth token failed - check GOOGLE_REFRESH_TOKEN');
      return;
    }
    console.log('[indexing-engine] OAuth token acquired');
    await writeIndexProgress(env, 2, 6, 'Building URL list from KV');

    // Step 2: Build URL list
    var urls = await ixBuildUrlList(env);
    console.log('[indexing-engine] URL list: ' + urls.length + ' URLs');
    await writeIndexProgress(env, 3, 6, 'Inspecting ' + urls.length + ' URLs via Search Console');

    // Step 3: Inspect each URL
    var results = [];
    for (var i = 0; i < urls.length; i++) {
      var inspection = await ixInspectUrl(oauthToken, urls[i]);
      results.push(inspection);
      if (i > 0 && i % 10 === 0) {
        await ixSleep(1000);
      }
    }
    console.log('[indexing-engine] Inspected ' + results.length + ' URLs');
    await writeIndexProgress(env, 4, 6, 'Classifying ' + results.length + ' results');

    // Step 4: Classify
    var indexed    = [];
    var notIndexed = [];
    var errors     = [];

    for (var j = 0; j < results.length; j++) {
      var r = results[j];
      if (r.error) { errors.push({ url: r.url, error: r.error }); continue; }
      if (r.verdict === 'PASS') {
        indexed.push({ url: r.url, lastCrawled: r.lastCrawlTime || null });
      } else {
        var cause = ixClassify(r);
        notIndexed.push({
          url:           r.url,
          verdict:       r.verdict          || 'UNKNOWN',
          indexingState: r.indexingState    || 'UNKNOWN',
          robotsState:   r.robotsTxtState   || 'UNKNOWN',
          cause:         cause,
          lastCrawled:   r.lastCrawlTime    || null,
          rawReason:     r.coverageState    || null,
          canonicalUrl:  r.canonicalUrl     || null,
          userCanonical: r.userCanonical    || null,
        });
      }
    }
    await writeIndexProgress(env, 5, 6, 'Submitting URLs to Google Indexing API');

    // Step 5: Submit fixable URLs via Indexing API (service account)
    var submittedNow = [];
    if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY_PEM) {
      var saToken = await ixGetServiceAccountToken(env);
      if (saToken) {
        for (var k = 0; k < notIndexed.length; k++) {
          var item = notIndexed[k];
          if (item.cause === 'not_submitted' || item.cause === 'canonical_mismatch' || item.cause === 'unknown') {
            var submitted = await ixSubmitUrl(saToken, item.url);
            item.submittedAt   = submitted ? new Date().toISOString() : null;
            item.submitSuccess = submitted;
            if (submitted) submittedNow.push(item.url);
          }
        }
        console.log('[indexing-engine] Submitted ' + submittedNow.length + ' URLs');
      }
    } else {
      console.log('[indexing-engine] No service account — skipping Indexing API submission');
    }
    await writeIndexProgress(env, 6, 6, 'Writing results to KV');

    // Step 6: Compare vs yesterday, write KV
    var prevStatus     = await env.FFX_KV.get(IX_STATUS_KEY, { type: 'json' }).catch(function() { return null; });
    var newlyIndexed   = [];
    var newlyDropped   = [];

    if (prevStatus) {
      var prevNotMap = {};
      var prevIdxMap = {};
      (prevStatus.notIndexed || []).forEach(function(p) { prevNotMap[p.url] = true; });
      (prevStatus.indexed    || []).forEach(function(p) { prevIdxMap[p.url] = true; });
      indexed.forEach(function(p)    { if (prevNotMap[p.url]) newlyIndexed.push(p.url); });
      notIndexed.forEach(function(p) { if (prevIdxMap[p.url]) newlyDropped.push(p.url); });
    }

    // Build pending-verification list — fixes applied but not yet confirmed by Google
    var pendingVerification = await ixBuildPendingVerification(env, notIndexed, submittedNow, prevStatus);

    var today = new Date().toISOString().split('T')[0];
    var statusRecord = {
      date:               today,
      runAt:              new Date().toISOString(),
      totalUrls:          urls.length,
      indexedCount:       indexed.length,
      notIndexedCount:    notIndexed.length,
      submittedCount:     submittedNow.length,
      errorCount:         errors.length,
      indexed:            indexed,
      notIndexed:         notIndexed,
      errors:             errors,
      newlyIndexed:       newlyIndexed,
      newlyDropped:       newlyDropped,
      pendingVerification: pendingVerification,
    };

    await env.FFX_KV.put(IX_STATUS_KEY, JSON.stringify(statusRecord), { expirationTtl: IX_STATUS_TTL });
    await env.FFX_KV.put('indexing:history:' + today, JSON.stringify({
      date:            today,
      totalUrls:       urls.length,
      indexedCount:    indexed.length,
      notIndexedCount: notIndexed.length,
      submittedCount:  submittedNow.length,
      newlyIndexed:    newlyIndexed,
      newlyDropped:    newlyDropped,
    }), { expirationTtl: IX_HISTORY_TTL });

    // Update learning
    try {
      var learning = await env.FFX_KV.get('indexing:learning', { type: 'json' }).catch(function() { return { runs: 0, causeCounts: {} }; });
      learning.runs = (learning.runs || 0) + 1;
      learning.lastRun = today;
      learning.causeCounts = learning.causeCounts || {};
      notIndexed.forEach(function(n) { learning.causeCounts[n.cause] = (learning.causeCounts[n.cause] || 0) + 1; });
      await env.FFX_KV.put('indexing:learning', JSON.stringify(learning));
    } catch(e) {}

    // Clear progress
    try { await env.FFX_KV.delete(IX_PROGRESS_KEY); } catch(e) {}

    console.log('[indexing-engine] Complete — indexed:' + indexed.length + ' not-indexed:' + notIndexed.length + ' submitted:' + submittedNow.length + ' newlyIndexed:' + newlyIndexed.length);

    return statusRecord;

  } catch (err) {
    console.error('[indexing-engine] Fatal:', err.message);
    try { await env.FFX_KV.delete(IX_PROGRESS_KEY); } catch(e) {}
    return { error: err.message };
  }
}

// Build pending-verification list
// Tracks fixes we applied and whether Google has confirmed them yet
async function ixBuildPendingVerification(env, notIndexed, submittedNow, prevStatus) {
  var existing = {};
  try {
    var prev = await env.FFX_KV.get('indexing:pending_verification', { type: 'json' }).catch(function() { return []; });
    (prev || []).forEach(function(p) { existing[p.url] = p; });
  } catch(e) {}

  var submittedSet = {};
  submittedNow.forEach(function(u) { submittedSet[u] = true; });

  var notIndexedSet = {};
  notIndexed.forEach(function(n) { notIndexedSet[n.url] = true; });

  // Add newly submitted URLs to pending list
  for (var i = 0; i < submittedNow.length; i++) {
    var u = submittedNow[i];
    if (!existing[u]) {
      existing[u] = {
        url:          u,
        action:       'submitted_to_google',
        fixedAt:      new Date().toISOString(),
        verifyAfter:  new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
        status:       'pending',
        note:         'Submitted to Google Indexing API — check back in 14 days',
      };
    }
  }

  // Also track canonical fixes (blog.html fix deployed — these should self-resolve)
  // Check if any previously-canonical-mismatch URLs are now indexed
  var result = [];
  var keys = Object.keys(existing);
  for (var j = 0; j < keys.length; j++) {
    var item = existing[keys[j]];
    // If now indexed — mark verified
    if ((prevStatus) && (prevStatus.indexed || []).some(function(idx) { return idx.url === item.url; })) {
      item.status = 'verified_fixed';
      item.verifiedAt = new Date().toISOString();
    }
    // If still not indexed and past verify window — mark needs review
    if (item.status === 'pending' && new Date(item.verifyAfter) < new Date()) {
      if (notIndexedSet[item.url]) {
        item.status = 'still_not_indexed';
        item.note   = 'Fix applied but page still not indexed after 14+ days — needs manual review';
      } else {
        item.status = 'verified_fixed';
        item.verifiedAt = new Date().toISOString();
      }
    }
    result.push(item);
  }

  // Write back
  try { await env.FFX_KV.put('indexing:pending_verification', JSON.stringify(result)); } catch(e) {}
  return result;
}

// OAuth token refresh (replicates google-auth.js logic for cron Worker context)
var IX_CLIENT_ID = '805135063067-mb9ap5knagr29280dmg1s63gcbd2f01t.apps.googleusercontent.com';
async function ixGetOAuthToken(env) {
  if (!env.GOOGLE_REFRESH_TOKEN || !env.GOOGLE_CLIENT_SECRET) return null;
  try {
    var cached    = await env.FFX_KV.get('google:access_token',        { type: 'text' }).catch(function() { return null; });
    var cachedExp = await env.FFX_KV.get('google:access_token_expiry', { type: 'text' }).catch(function() { return null; });
    if (cached && cachedExp && Date.now() < parseInt(cachedExp) - 60000) return cached;

    var body = 'client_id='     + encodeURIComponent(env.GOOGLE_CLIENT_ID || IX_CLIENT_ID) +
               '&client_secret=' + encodeURIComponent(env.GOOGLE_CLIENT_SECRET) +
               '&refresh_token=' + encodeURIComponent(env.GOOGLE_REFRESH_TOKEN) +
               '&grant_type=refresh_token';
    var res  = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
    });
    if (!res.ok) return null;
    var data = await res.json();
    if (!data.access_token) return null;
    var exp = Date.now() + (data.expires_in || 3600) * 1000;
    await env.FFX_KV.put('google:access_token',        data.access_token, { expirationTtl: 3300 });
    await env.FFX_KV.put('google:access_token_expiry', String(exp),       { expirationTtl: 3300 });
    return data.access_token;
  } catch(e) { return null; }
}

// Service account token (JWT) for Google Indexing API
async function ixGetServiceAccountToken(env) {
  var serviceAccountEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  var privateKeyPem       = env.GOOGLE_PRIVATE_KEY_PEM;
  if (!serviceAccountEmail || !privateKeyPem) return null;
  try {
    var now     = Math.floor(Date.now() / 1000);
    var header  = { alg: 'RS256', typ: 'JWT' };
    var payload = {
      iss:   serviceAccountEmail,
      scope: 'https://www.googleapis.com/auth/indexing',
      aud:   'https://oauth2.googleapis.com/token',
      exp:   now + 3600,
      iat:   now,
    };
    var encode = function(obj) {
      return btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    };
    var unsignedToken = encode(header) + '.' + encode(payload);
    var pemContents = privateKeyPem
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\n/g, '').replace(/\r/g, '').trim();

    var binaryKey = Uint8Array.from(atob(pemContents), function(c) { return c.charCodeAt(0); });
    var cryptoKey = await crypto.subtle.importKey(
      'pkcs8', binaryKey.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
    );
    var encoder   = new TextEncoder();
    var signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(unsignedToken));
    var sigB64    = btoa(String.fromCharCode.apply(null, new Uint8Array(signature)))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    var jwt = unsignedToken + '.' + sigB64;
    var tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
    });
    var tokenData = await tokenRes.json();
    return tokenData.access_token || null;
  } catch(e) { console.error('[indexing-engine] SA token error:', e.message); return null; }
}

// Build full URL list from KV article records + static pages
async function ixBuildUrlList(env) {
  var urls = IX_STATIC_PAGES.slice();
  try {
    var kvList      = await env.FFX_KV.list({ prefix: 'article:' });
    var articleKeys = kvList.keys.filter(function(k) { return k.name.indexOf('article:links:') === -1; });
    for (var i = 0; i < articleKeys.length; i++) {
      var meta = await env.FFX_KV.get(articleKeys[i].name, { type: 'json' }).catch(function() { return null; });
      if (!meta || !meta.slug) continue;
      var articleUrl = IX_SITE_BASE + '/article?slug=' + meta.slug;
      if (urls.indexOf(articleUrl) === -1) urls.push(articleUrl);
    }
  } catch(e) { console.error('[indexing-engine] URL list error (non-fatal):', e.message); }
  return urls;
}

// Inspect a single URL via Search Console URL Inspection API
async function ixInspectUrl(oauthToken, pageUrl) {
  try {
    var res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + oauthToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl: IX_SC_PROPERTY }),
    });
    if (!res.ok) { return { url: pageUrl, error: 'HTTP ' + res.status }; }
    var data        = await res.json();
    var idxResult   = data.inspectionResult || {};
    var idxStatus   = idxResult.indexStatusResult || {};
    return {
      url:            pageUrl,
      verdict:        idxStatus.verdict          || 'VERDICT_UNSPECIFIED',
      coverageState:  idxStatus.coverageState    || null,
      robotsTxtState: idxStatus.robotsTxtState   || null,
      indexingState:  idxStatus.indexingState    || null,
      lastCrawlTime:  idxStatus.lastCrawlTime    || null,
      pageFetchState: idxStatus.pageFetchState   || null,
      canonicalUrl:   idxStatus.googleCanonical  || null,
      userCanonical:  idxStatus.userCanonical    || null,
    };
  } catch(e) { return { url: pageUrl, error: e.message }; }
}

// Classify root cause from inspection result
function ixClassify(r) {
  var coverage = (r.coverageState    || '').toLowerCase();
  var robots   = (r.robotsTxtState   || '').toLowerCase();
  var fetch_   = (r.pageFetchState   || '').toLowerCase();
  var indexing = (r.indexingState    || '').toLowerCase();
  if (robots   === 'blocked')                                           return 'robots_blocked';
  if (fetch_.indexOf('redirect')     !== -1)                           return 'redirect';
  if (fetch_.indexOf('not_found')    !== -1 || coverage.indexOf('not found') !== -1) return 'soft_404';
  if (indexing  === 'indexing_not_allowed' || coverage.indexOf('noindex') !== -1) return 'noindex';
  if (r.canonicalUrl && r.userCanonical && r.canonicalUrl !== r.userCanonical) return 'canonical_mismatch';
  if (coverage.indexOf('crawled') !== -1 && coverage.indexOf('not indexed') !== -1) return 'thin_content';
  if (coverage.indexOf('duplicate') !== -1)                            return 'thin_content';
  if (coverage.indexOf('discovered') !== -1)                           return 'not_submitted';
  if (!r.lastCrawlTime)                                                return 'not_submitted';
  return 'unknown';
}

// Submit URL to Google Indexing API
async function ixSubmitUrl(saToken, pageUrl) {
  try {
    var res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + saToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pageUrl, type: 'URL_UPDATED' }),
    });
    if (!res.ok) { console.error('[indexing-engine] Submit failed for ' + pageUrl + ': ' + res.status); return false; }
    return true;
  } catch(e) { return false; }
}

function ixSleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ─────────────────────────────────────────────────────────────────────────────
// ALERT EMAIL via Brevo — unchanged
// ─────────────────────────────────────────────────────────────────────────────

async function sendAlertEmail(env, { subject, message }) {
  if (!env.BREVO_API_KEY) return;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
      body: JSON.stringify({
        sender:      { name: 'FFX Cron', email: 'salmankhanfx@fortitudefx.com' },
        to:          [{ email: env.APPROVAL_EMAIL || 'salmankhanfx@fortitudefx.com' }],
        subject,
        textContent: message,
      }),
    });
    if (!res.ok) console.error('[ffx-cron] Alert email failed:', await res.text());
  } catch (err) {
    console.error('[ffx-cron] Could not send alert email:', err.message);
  }
}
