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

import {
  sourceMode, isDryRun, keywordsPerRun,
  readDemandMap, writeDemandMap, selectTargets, markClaimed,
  retrieveNuggetIds, keywordId,
} from '../lib/keyword/select.js';
import { ensureDemandMap, ensureCorpus } from '../lib/keyword/seed.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const QUEUE_KEY        = 'queue:index';
const QUEUE_TARGET     = 10;
const QUEUE_TOPUP_AT   = 3;
const QUEUE_TOPUP_BY   = 7;

// Alert Salman when the winnable demand-map runway drops to/below this many
// distinct topics (he asked to be told when winnable targets run low).
const WINNABLE_LOW_WATERMARK = 5;

export default {
  async scheduled(event, env, ctx) {
    // Two schedules share this Worker (see wrangler.toml):
    //   "10 5 …" = dedicated intelligence-engine run (own invocation, fresh budget)
    //   everything else ("0 5 …") = the signals/pipeline run
    if (event.cron === '10 5 * * MON,TUE,WED,THU,FRI') {
      ctx.waitUntil(runEngine(env));
    } else {
      ctx.waitUntil(runCron(env));
    }
  }
};

// ── Dedicated intelligence-engine trigger ─────────────────────────────────────
// Runs in its OWN cron invocation (10:05 UTC) with a full Worker budget, AFTER the
// 05:00 signals run has written seo:signals/ga4:signals. This replaces the old
// tail-of-runCron trigger that kept getting cut off (brief stale 3 weeks while
// signals stayed fresh). Explicit success/error logging — no silent path — so the
// next failure shows up in `wrangler tail ffx-cron` as a real line.
async function runEngine(env) {
  console.log('[ffx-cron] Engine run: triggering intelligence engine…');
  try {
    const intelRes = await fetch('https://fortitudefx.com/api/intelligence-engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (intelRes.ok) {
      let stamp = 'unknown';
      try {
        const b = await env.FFX_KV.get('intelligence:brief', { type: 'json' });
        stamp = (b && b.generatedAt) || 'no-generatedAt';
      } catch (readErr) { stamp = 'brief-read-failed: ' + readErr.message; }
      console.log('[ffx-cron] Intelligence engine OK — brief.generatedAt=' + stamp);
    } else {
      const body = await intelRes.text().catch(function () { return ''; });
      console.error('[ffx-cron] Intelligence engine FAILED — status ' + intelRes.status + ' body=' + body.slice(0, 300));
    }
  } catch (e) {
    console.error('[ffx-cron] Intelligence engine ERROR — ' + e.message);
  }
}

async function runCron(env) {
  try {
    const mode = sourceMode(env);
    console.log('[ffx-cron] Starting cron run — SOURCE_MODE:', mode);

    if (mode === 'keyword') {
      // ── Steps 1–3, KEYWORD SOURCE ──────────────────────────────────────
      // Pick the next N winnable, distinct-topic targets from the demand map,
      // ground them in Salman's nuggets, and enqueue. The video steps are
      // skipped entirely; the shared signals steps (4–7) still run below.
      await runKeywordSource(env);
    } else {
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

    // ── Step 5b: YouTube search signals ─────────────────────────────────────
    // Fetches what people search on YouTube in the forex/trading niche
    // 3 API calls × 100 quota units = 300 units (daily limit 10,000)
    try {
      const YT_PILLARS = [
        'catch the wick forex',
        'forex price action strategy',
        'candlestick trading system',
      ];
      const ytSearchResults = [];
      for (var pi = 0; pi < YT_PILLARS.length; pi++) {
        try {
          const q = YT_PILLARS[pi];
          const sRes = await fetch(
            'https://www.googleapis.com/youtube/v3/search?part=snippet&q='
            + encodeURIComponent(q)
            + '&type=video&relevanceLanguage=en&maxResults=10&key='
            + env.YOUTUBE_API_KEY
          );
          if (sRes.ok) {
            const sData = await sRes.json();
            const items = (sData.items || []).map(function(item) {
              return {
                title:       item.snippet.title,
                channelName: item.snippet.channelTitle,
                videoId:     item.id && item.id.videoId,
              };
            });
            ytSearchResults.push({ query: q, results: items });
          }
        } catch(sqErr) {
          console.error('[ffx-cron] YT search pillar ' + pi + ' failed (non-fatal):', sqErr.message);
        }
      }

      if (ytSearchResults.length > 0) {
        const competitorTitles = [];
        ytSearchResults.forEach(function(sr) {
          sr.results.forEach(function(r) {
            if (r.channelName && !r.channelName.toLowerCase().includes('fortitudefx')) {
              competitorTitles.push({ title: r.title, query: sr.query, channel: r.channelName });
            }
          });
        });
        const ytSignals = {
          fetchedAt: new Date().toISOString(),
          pillarsSearched: YT_PILLARS,
          searchResults: ytSearchResults,
          competitorTitles: competitorTitles.slice(0, 20),
          titlePatterns: extractTitlePatterns(competitorTitles),
        };
        await env.FFX_KV.put('youtube:search:global:signals', JSON.stringify(ytSignals));
        console.log('[ffx-cron] YouTube search signals written:', competitorTitles.length, 'competitor titles');
      }
    } catch(ytSigErr) {
      console.error('[ffx-cron] YouTube search signals failed (non-fatal):', ytSigErr.message);
    }

    // ── Step 6: Intelligence engine — MOVED OUT ───────────────────────────
    // The engine trigger now runs in its own dedicated cron invocation
    // (runEngine, "10 5 …") with a fresh Worker budget. Keeping it at the tail
    // of this long signals run was exhausting the budget and cutting off the
    // brief write (3-week outage). Do NOT re-add the engine fetch here.

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
// KEYWORD SOURCE (SOURCE_MODE=keyword) — Steps 1–3 replacement
// Pick the next N winnable, distinct-canonical-topic targets from demand:map,
// ground each in Salman's nuggets, and enqueue a keyword job. One article per
// canonical topic. The quality gate — not this cadence — is the control on what
// ever reaches a live page. Nothing here publishes; jobs land in the queue for
// Salman to review and publish.
// ─────────────────────────────────────────────────────────────────────────────

async function runKeywordSource(env) {
  // Self-seed on first run — no manual step, no key. demand:map from committed
  // data; gate:corpus (deterministic) from the 26 via the live site.
  try {
    const sm = await ensureDemandMap(env);
    if (sm.seeded) console.log('[ffx-cron][keyword] Self-seeded demand:map —', sm.count, 'targets');
    const sc = await ensureCorpus(env, 'https://fortitudefx.com', fetch);
    if (sc.seeded) console.log('[ffx-cron][keyword] Self-seeded gate:corpus —', sc.count, 'of', sc.attempted, 'articles');
  } catch (seedErr) {
    console.error('[ffx-cron][keyword] Self-seed failed (non-fatal):', seedErr.message);
  }

  const map = await readDemandMap(env);
  if (!map.length) {
    console.error('[ffx-cron][keyword] demand:map still empty after self-seed — skipping.');
    return;
  }

  const want = keywordsPerRun(env);
  const dryRun = isDryRun(env);
  const { picks, winnableRemaining, ambiguousRemaining } = selectTargets(map, want);

  if (!picks.length) {
    console.error('[ffx-cron][keyword] No winnable unclaimed targets left in demand:map.');
    await sendAlertEmail(env, {
      subject: '[FFX Keyword] Winnable targets exhausted',
      message: 'The demand map has no winnable, unclaimed topics left to generate.\n\n'
        + 'Ambiguous (manual-review) topics still available: ' + ambiguousRemaining + '.\n'
        + 'Next: widen the demand map (DataForSEO discovery) or switch cadence to enrichment of existing pages.',
    });
    return;
  }

  const nowIso = new Date().toISOString();
  let enqueued = 0;
  for (const target of picks) {
    try {
      const nuggetIds = await retrieveNuggetIds(env, target, 8);
      const jobId = `${Date.now()}-${keywordId(target.keyword)}`;

      await env.FFX_KV.put(`job:${jobId}`, JSON.stringify({
        status: 'pending', keyword: target.keyword, targetQuery: target.keyword,
        createdAt: nowIso, source: 'cron-keyword', dryRun,
      }), { expirationTtl: 86400 });

      await env.FFX_QUEUE.send({
        jobId,
        source: 'cron-keyword',
        keyword: target.keyword,
        targetQuery: target.keyword,
        canonical: target.canonical,
        cluster: target.cluster,
        proprietaryTerm: target.proprietary_term,
        nuggetTags: target.nugget_tags,
        nuggetIds,
        dryRun,
      });

      // Surface the target in the queue (SEO-card row) unless this is a dry run.
      if (!dryRun) {
        await addKeywordToQueueBottom(env, target, jobId, nuggetIds.length);
      }

      // Mark claimed in the map so no other run picks it up.
      markClaimed(target, { at: nowIso });
      enqueued++;
      console.log('[ffx-cron][keyword] Enqueued:', target.keyword,
        '| topic:', target.canonical, '| nuggets:', nuggetIds.length, dryRun ? '| DRY_RUN' : '');
    } catch (e) {
      console.error('[ffx-cron][keyword] Enqueue failed for', target.keyword, '—', e.message);
    }
  }

  if (enqueued > 0) await writeDemandMap(env, map);
  console.log('[ffx-cron][keyword] Enqueued', enqueued, 'of', want,
    '| winnable topics remaining:', winnableRemaining);

  // Runway alert — tell Salman before it runs dry.
  if (winnableRemaining <= WINNABLE_LOW_WATERMARK || enqueued < want) {
    await sendAlertEmail(env, {
      subject: `[FFX Keyword] Winnable runway low — ${winnableRemaining} topics left`,
      message: `Enqueued ${enqueued}/${want} today.\n\n`
        + `Distinct WINNABLE topics still unclaimed: ${winnableRemaining} `
        + `(~${(winnableRemaining / want).toFixed(1)} more weekdays at ${want}/day).\n`
        + `Ambiguous (manual) topics: ${ambiguousRemaining}.\n\n`
        + `Next step when this hits zero: widen the demand map, or drop cadence to enrichment.`,
    });
  }
}

// Keyword queue row — parallels addToQueueBottom but carries SEO-card fields so
// dashboard-queue.html can render the demand target instead of a video thumbnail.
async function addKeywordToQueueBottom(env, target, jobId, nuggetCount) {
  const queue = await getQueue(env);
  const vid = keywordId(target.keyword);
  if (queue.some(item => item.videoId === vid)) return;
  queue.push({
    videoId:     vid,
    source:      'keyword',
    keyword:     target.keyword,
    targetQuery: target.keyword,
    canonical:   target.canonical,
    cluster:     target.cluster,
    volume:      target.volume,
    kd:          target.kd,
    nuggetCount: nuggetCount,
    title:       target.keyword,   // replaced with the real title once generated
    addedAt:     new Date().toISOString(),
    addedBy:     'cron-keyword',
    jobId,
    wasGenerated: false,
  });
  await env.FFX_KV.put(QUEUE_KEY, JSON.stringify(queue));
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

function extractTitlePatterns(competitorTitles) {
  if (!competitorTitles || !competitorTitles.length) return [];
  // Count opening words to find dominant title patterns on YouTube for this niche
  var openingWords = {};
  competitorTitles.forEach(function(ct) {
    if (!ct.title) return;
    var words = ct.title.split(' ');
    var first = words[0] ? words[0].toUpperCase().replace(/[^A-Z]/g,'') : '';
    if (first && first.length > 1) {
      openingWords[first] = (openingWords[first] || 0) + 1;
    }
  });
  return Object.entries(openingWords)
    .sort(function(a,b) { return b[1] - a[1]; })
    .slice(0, 8)
    .map(function(e) { return { word: e[0], count: e[1] }; });
}

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
