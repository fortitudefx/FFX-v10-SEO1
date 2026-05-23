/**
 * FFX CRON WORKER — ffx-cron/index.js
 *
 * Schedule: Mon–Fri 9am Dubai time (5am UTC)
 *
 * Logic:
 * 1. Fetch latest videos from YouTube channel
 * 2. For each video — check published:{videoId} in KV
 *    → exists: skip (already processed)
 *    → not exists: candidate for processing
 * 3. If new video found → queue it → done for today
 * 4. If no new videos → scan channel back-catalogue newest first
 *    → find oldest unprocessed → queue it
 * 5. One video per cron run — queue drains naturally
 * 6. On any error → send alert email via Brevo
 */

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_RESULTS = 50; // max per YouTube API page

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  }
};

async function runCron(env) {
  try {
    console.log('[ffx-cron] Starting cron run');

    // Step 1 — check for new uploads first (last 24 hours)
    const newVideo = await findNewVideo(env);

    if (newVideo) {
      console.log(`[ffx-cron] New video found: ${newVideo.videoId} — ${newVideo.title}`);
      await queueVideo(env, newVideo);
      return;
    }

    console.log('[ffx-cron] No new videos — scanning back catalogue');

    // Step 2 — no new videos, work through back catalogue
    const backlogVideo = await findBacklogVideo(env);

    if (backlogVideo) {
      console.log(`[ffx-cron] Backlog video found: ${backlogVideo.videoId} — ${backlogVideo.title}`);
      await queueVideo(env, backlogVideo);
      return;
    }

    console.log('[ffx-cron] All videos processed — nothing to queue');

  } catch (err) {
    console.error('[ffx-cron] Fatal error:', err);
    await sendAlertEmail(env, {
      subject: '[FFX Cron] Fatal error',
      message: `Cron run failed with error: ${err.message}\n\nStack: ${err.stack}`
    });
  }
}

/**
 * Find a video uploaded in the last 25 hours not yet in KV
 * Returns first unprocessed new video or null
 */
async function findNewVideo(env) {
  // publishedAfter = 25hrs ago (buffer for timezone drift)
  const since = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  const url = `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${env.YOUTUBE_CHANNEL_ID}&type=video&order=date&publishedAfter=${since}&maxResults=10&key=${env.YOUTUBE_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`YouTube search API failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  const items = data.items || [];

  for (const item of items) {
    const videoId = item.id.videoId;
    const title   = item.snippet.title;

    // Check KV — if published record exists, skip
    const existing = await env.FFX_KV.get(`published:${videoId}`);
    if (existing) {
      console.log(`[ffx-cron] Already published: ${videoId} — skipping`);
      continue;
    }

    // Check if already in queue (video: key with 24hr TTL)
    const inQueue = await env.FFX_KV.get(`video:${videoId}`);
    if (inQueue) {
      console.log(`[ffx-cron] Already in queue: ${videoId} — skipping`);
      continue;
    }

    return {
      videoId,
      title,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  return null;
}

/**
 * Scan full channel back-catalogue newest first
 * Find first video not in published: KV
 * Returns video or null if all processed
 */
async function findBacklogVideo(env) {
  let pageToken = null;

  do {
    const pageParam = pageToken ? `&pageToken=${pageToken}` : '';
    const url = `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${env.YOUTUBE_CHANNEL_ID}&type=video&order=date&maxResults=${MAX_RESULTS}${pageParam}&key=${env.YOUTUBE_API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`YouTube search API failed (backlog): ${res.status} ${err}`);
    }

    const data = await res.json();
    const items = data.items || [];

    for (const item of items) {
      const videoId = item.id.videoId;
      const title   = item.snippet.title;

      // Skip if already published
      const existing = await env.FFX_KV.get(`published:${videoId}`);
      if (existing) continue;

      // Skip if already in queue
      const inQueue = await env.FFX_KV.get(`video:${videoId}`);
      if (inQueue) continue;

      return {
        videoId,
        title,
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`
      };
    }

    pageToken = data.nextPageToken || null;

  } while (pageToken);

  return null;
}

/**
 * Queue a video for processing by ffx-consumer
 * Same payload structure as generate.js
 */
async function queueVideo(env, video) {
  try {
    await env.FFX_QUEUE.send({
      videoId:    video.videoId,
      youtubeUrl: video.youtubeUrl,
      source:     'cron',
      queuedAt:   new Date().toISOString()
    });

    console.log(`[ffx-cron] Queued: ${video.videoId}`);

  } catch (err) {
    throw new Error(`Queue send failed for ${video.videoId}: ${err.message}`);
  }
}

/**
 * Send alert email via Brevo on error
 */
async function sendAlertEmail(env, { subject, message }) {
  try {
    const payload = {
      sender:     { name: 'FFX Cron',          email: 'salmankhanfx@fortitudefx.com' },
      to:         [{ name: 'Salman',            email: 'salmankhanfx@fortitudefx.com' }],
      subject,
      textContent: message
    };

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key':      env.BREVO_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.error('[ffx-cron] Alert email failed:', await res.text());
    }

  } catch (err) {
    console.error('[ffx-cron] Could not send alert email:', err);
  }
}
