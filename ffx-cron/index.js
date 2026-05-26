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
// 4. On any error → send alert email via Brevo
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
      return;
    }

    const firstItem = updatedQueue[0];
    console.log('[ffx-cron] Triggering generation for:', firstItem.videoId, firstItem.title);
    await triggerGeneration(env, firstItem);

  } catch (err) {
    console.error('[ffx-cron] Fatal error:', err.message);
    await sendAlertEmail(env, {
      subject: '[FFX Cron] Fatal error',
      message: `Cron run failed: ${err.message}\n\nStack: ${err.stack || 'no stack'}`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getQueue(env) {
  const raw = await env.FFX_KV.get(QUEUE_KEY, { type: 'json' }).catch(() => null);
  return Array.isArray(raw) ? raw : [];
}

async function addToQueueTop(env, video) {
  const queue = await getQueue(env);
  // Don't add if already in queue
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
// FIND NEW VIDEO (last 25hrs)
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
  return total >= 60;
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

    // Skip if already published
    const published = await env.FFX_KV.get(`published:${videoId}`).catch(() => null);
    if (published) continue;

    // Skip if already in queue
    if (queue.some(q => q.videoId === videoId)) continue;

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
// FIND BACKLOG VIDEOS — newest first, skip published and already queued
// ─────────────────────────────────────────────────────────────────────────────

async function findBacklogVideos(env, limit, currentQueue) {
  const results   = [];
  let pageToken   = null;
  const queuedIds = new Set(currentQueue.map(q => q.videoId));

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

      // Skip if already in queue
      if (queuedIds.has(videoId)) continue;

      // Skip if already published
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
// TRIGGER GENERATION — sends to ffx-generate-queue
// ─────────────────────────────────────────────────────────────────────────────

async function triggerGeneration(env, item) {
  // Check if already generating (lock exists)
  const lock = await env.FFX_KV.get('lock:generating').catch(() => null);
  if (lock) {
    const lockData = JSON.parse(lock);
    console.log('[ffx-cron] Generation already in progress for:', lockData.videoId, '— skipping');
    return;
  }

  // Check if already generated (video: key exists with content)
  const existing = await env.FFX_KV.get(`video:${item.videoId}`).catch(() => null);
  if (existing) {
    console.log('[ffx-cron] Already generated:', item.videoId, '— skipping generation');
    return;
  }

  // Generate unique jobId
  const jobId = `${Date.now()}-${item.videoId}`;

  // Write pending job
  await env.FFX_KV.put(
    `job:${jobId}`,
    JSON.stringify({ status: 'pending', videoId: item.videoId, createdAt: new Date().toISOString() }),
    { expirationTtl: 86400 }
  );

  // Send to queue
  await env.FFX_QUEUE.send({
    jobId,
    videoId:    item.videoId,
    youtubeUrl: item.youtubeUrl,
    source:     'cron',
  });

  // Mark queue item as wasGenerated
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
// ALERT EMAIL via Brevo
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
