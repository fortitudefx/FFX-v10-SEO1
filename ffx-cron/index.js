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
    ctx.waitUntil(runCron(env));
  }
};

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
  queue[idx].jobId = jobId;
  await env.FFX_KV.put(QUEUE_KEY, JSON.stringify(queue));
}
  console.log('[ffx-cron] Generation triggered:', item.videoId, 'jobId:', jobId);
}

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
