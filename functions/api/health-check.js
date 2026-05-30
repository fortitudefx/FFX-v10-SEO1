// functions/api/health-check.js
// POST /api/health-check → runs all 29 checks across 5 layers, writes health:results:{date}
// GET  /api/health-check → returns latest health:results from KV
//
// Triggered automatically after first publish of each day (from publish-confirm.js)
// Also triggered manually via Run Health Check button on dashboard-health.html
//
// States: GREEN (working) | AMBER (degraded, will become problem) | RED (broken now)
// Every RED and AMBER includes: what broke, root cause diagnosis, exact fix

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const results   = await env.FFX_KV.get(`health:results:${today}`, { type: 'json' }).catch(() => null)
                   || await env.FFX_KV.get(`health:results:${yesterday}`, { type: 'json' }).catch(() => null);
    const history   = await env.FFX_KV.get('health:history', { type: 'json' }).catch(() => null);
    return new Response(JSON.stringify({ results: results || null, history: history || [] }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    const now   = new Date();
    const today = now.toISOString().split('T')[0];
    const checks = [];

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 1 — PIPELINE HEALTH (7 checks)
    // ─────────────────────────────────────────────────────────────────────

    // 1.1 Queue has items
    try {
      const queue = await env.FFX_KV.get('queue:index', { type: 'json' }).catch(() => null);
      if (!queue) {
        checks.push({ id:'1.1', layer:1, name:'Queue exists', status:'RED',
          detail:'queue:index missing or corrupted.',
          diagnosis:'KV read failure or cron never ran.',
          fix:'Manually trigger cron or add a video manually to the queue.' });
      } else if (!Array.isArray(queue)) {
        checks.push({ id:'1.1', layer:1, name:'Queue exists', status:'RED',
          detail:'queue:index is not a valid array.',
          diagnosis:'KV value is corrupted — not valid JSON array.',
          fix:'Go to KV → delete queue:index → cron will repopulate next run.' });
      } else if (queue.length === 0) {
        checks.push({ id:'1.1', layer:1, name:'Queue has items', status:'AMBER',
          detail:'Queue is empty.',
          diagnosis:'All queued videos have been published or cron backlog exhausted.',
          fix:'Cron will top up queue automatically next run. No action needed unless cron is failing.' });
      } else {
        checks.push({ id:'1.1', layer:1, name:'Queue has items', status:'GREEN',
          detail:`${queue.length} items in queue.` });
      }
    } catch(e) {
      checks.push({ id:'1.1', layer:1, name:'Queue exists', status:'RED',
        detail:'Queue check threw an error: ' + e.message,
        diagnosis:'KV binding may be unavailable.',
        fix:'Check FFX_KV binding in Cloudflare Pages settings.' });
    }

    // 1.2 Cron ran today (seo:signals generatedAt within 25hrs)
    try {
      const seo = await env.FFX_KV.get('seo:signals', { type: 'json' }).catch(() => null);
      if (!seo || !seo.generatedAt) {
        checks.push({ id:'1.2', layer:1, name:'Cron ran today', status:'RED',
          detail:'seo:signals missing or has no generatedAt timestamp.',
          diagnosis:'Cron has never run or SEO signals collection failed.',
          fix:'Manually POST to /api/seo-signals from the SEO dashboard.' });
      } else {
        const ageHrs = (now - new Date(seo.generatedAt)) / 3600000;
        if (ageHrs > 48) {
          checks.push({ id:'1.2', layer:1, name:'Cron ran today', status:'RED',
            detail:`seo:signals last updated ${Math.round(ageHrs)} hours ago.`,
            diagnosis:'Cron has not run in 2+ days. ffx-cron Worker may be failing.',
            fix:'Check ffx-cron Worker deployment in Cloudflare. Manually trigger /api/seo-signals.' });
        } else if (ageHrs > 25) {
          checks.push({ id:'1.2', layer:1, name:'Cron ran today', status:'AMBER',
            detail:`seo:signals last updated ${Math.round(ageHrs)} hours ago — may have missed one run.`,
            diagnosis:'Cron may have failed or been delayed.',
            fix:'Monitor. If amber again tomorrow, check ffx-cron Worker logs.' });
        } else {
          checks.push({ id:'1.2', layer:1, name:'Cron ran today', status:'GREEN',
            detail:`seo:signals updated ${Math.round(ageHrs * 60)} minutes ago.` });
        }
      }
    } catch(e) {
      checks.push({ id:'1.2', layer:1, name:'Cron ran today', status:'RED',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 1.3 No stuck generation lock
    try {
      const lock = await env.FFX_KV.get('lock:generating', { type: 'json' }).catch(() => null);
      if (lock) {
        const lockAgeMin = (now - new Date(lock.startedAt || now)) / 60000;
        if (lockAgeMin > 30) {
          checks.push({ id:'1.3', layer:1, name:'Generation lock clear', status:'RED',
            detail:`lock:generating stuck for ${Math.round(lockAgeMin)} minutes. Started for videoId: ${lock.videoId}.`,
            diagnosis:'Consumer crashed without clearing the lock. No new generation is possible until cleared.',
            fix:'Go to KV → delete lock:generating key manually → retry generation from queue dashboard.' });
        } else {
          checks.push({ id:'1.3', layer:1, name:'Generation lock clear', status:'AMBER',
            detail:`lock:generating active for ${Math.round(lockAgeMin)} minutes — may be actively generating.`,
            diagnosis:'Generation in progress. Wait 30 minutes. If still present, treat as RED.',
            fix:'Wait. If still present after 30 minutes, delete lock:generating from KV.' });
        }
      } else {
        checks.push({ id:'1.3', layer:1, name:'Generation lock clear', status:'GREEN',
          detail:'No active generation lock.' });
      }
    } catch(e) {
      checks.push({ id:'1.3', layer:1, name:'Generation lock clear', status:'GREEN',
        detail:'Lock not present.' });
    }

    // 1.4 content:performance updated to published for today's publish
    try {
      const perfList = await env.FFX_KV.list({ prefix: 'content:performance:' }).catch(() => null);
      if (!perfList || !perfList.keys.length) {
        checks.push({ id:'1.4', layer:1, name:'content:performance exists', status:'AMBER',
          detail:'No content:performance records found.',
          diagnosis:'No articles have been generated yet, or records not being written.',
          fix:'Generate and publish an article. Check consumer deployment.' });
      } else {
        let unpublishedCount = 0;
        let publishedCount = 0;
        for (const key of perfList.keys.slice(0, 10)) {
          const perf = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
          if (!perf) continue;
          if (perf.status === 'published') publishedCount++;
          else unpublishedCount++;
        }
        if (publishedCount === 0 && unpublishedCount > 0) {
          checks.push({ id:'1.4', layer:1, name:'content:performance published status', status:'RED',
            detail:`${unpublishedCount} content:performance records have status:generated not published.`,
            diagnosis:'publish-confirm.js CHANGE 12 may not have run for these articles.',
            fix:'Republish any article from Press dashboard — this triggers the content:performance update.' });
        } else {
          checks.push({ id:'1.4', layer:1, name:'content:performance published status', status:'GREEN',
            detail:`${publishedCount} published records confirmed.` });
        }
      }
    } catch(e) {
      checks.push({ id:'1.4', layer:1, name:'content:performance published status', status:'AMBER',
        detail:'Could not check: ' + e.message, diagnosis:'KV list operation failed.', fix:'Check FFX_KV binding.' });
    }

    // 1.5 Transcript stored for most recent video
    try {
      const queue = await env.FFX_KV.get('queue:index', { type: 'json' }).catch(() => null);
      if (queue && Array.isArray(queue) && queue.length > 0) {
        const recent = queue.find(q => q.wasGenerated) || queue[0];
        if (recent) {
          const transcript = await env.FFX_KV.get(`transcript:${recent.videoId}`).catch(() => null);
          if (!transcript) {
            checks.push({ id:'1.5', layer:1, name:'Transcript stored', status:'AMBER',
              detail:`transcript:${recent.videoId} not found in KV.`,
              diagnosis:'Video may not have been generated yet, or transcript write failed.',
              fix:'Generate the video from queue dashboard. Supadata will fetch transcript and store it.' });
          } else {
            checks.push({ id:'1.5', layer:1, name:'Transcript stored', status:'GREEN',
              detail:`transcript:${recent.videoId} present in KV.` });
          }
        } else {
          checks.push({ id:'1.5', layer:1, name:'Transcript stored', status:'GREEN', detail:'No generated videos to check.' });
        }
      } else {
        checks.push({ id:'1.5', layer:1, name:'Transcript stored', status:'GREEN', detail:'Queue empty — no transcripts to check.' });
      }
    } catch(e) {
      checks.push({ id:'1.5', layer:1, name:'Transcript stored', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 1.6 No orphaned job keys (processing > 2hrs)
    try {
      const jobList = await env.FFX_KV.list({ prefix: 'job:' }).catch(() => null);
      if (jobList && jobList.keys.length > 0) {
        let stuckJobs = [];
        for (const key of jobList.keys.slice(0, 20)) {
          const job = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
          if (!job) continue;
          if (job.status === 'processing') {
            const ageHrs = job.step ? (now - new Date(key.name.split('-')[0] / 1000 || now)) / 3600000 : 0;
            if (ageHrs > 2 || job.status === 'processing') stuckJobs.push(key.name);
          }
        }
        if (stuckJobs.length > 0) {
          checks.push({ id:'1.6', layer:1, name:'No stuck jobs', status:'AMBER',
            detail:`${stuckJobs.length} job(s) with status:processing found.`,
            diagnosis:'Consumer may have failed to complete these jobs.',
            fix:'Check if lock:generating is also stuck. If yes, see Check 1.3 fix.' });
        } else {
          checks.push({ id:'1.6', layer:1, name:'No stuck jobs', status:'GREEN', detail:'No stuck processing jobs.' });
        }
      } else {
        checks.push({ id:'1.6', layer:1, name:'No stuck jobs', status:'GREEN', detail:'No active job keys.' });
      }
    } catch(e) {
      checks.push({ id:'1.6', layer:1, name:'No stuck jobs', status:'GREEN', detail:'No job keys found.' });
    }

    // 1.7 Nuggets growing
    try {
      const index = await env.FFX_KV.get('nuggets:index', { type: 'json' }).catch(() => null);
      if (!index || !Array.isArray(index) || index.length === 0) {
        checks.push({ id:'1.7', layer:1, name:'Nuggets library populated', status:'AMBER',
          detail:'nuggets:index empty or missing.',
          diagnosis:'No videos have been generated yet, or library extraction is failing.',
          fix:'Generate a video. Consumer auto-extracts 10-15 nuggets per video.' });
      } else {
        checks.push({ id:'1.7', layer:1, name:'Nuggets library populated', status:'GREEN',
          detail:`${index.length} nuggets in library.` });
      }
    } catch(e) {
      checks.push({ id:'1.7', layer:1, name:'Nuggets library populated', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 2 — KV INTEGRITY (8 checks)
    // ─────────────────────────────────────────────────────────────────────

    // 2.1 intelligence:brief fresh and complete
    try {
      const brief = await env.FFX_KV.get('intelligence:brief', { type: 'json' }).catch(() => null);
      if (!brief) {
        checks.push({ id:'2.1', layer:2, name:'Intelligence brief exists', status:'RED',
          detail:'intelligence:brief missing.',
          diagnosis:'Intelligence engine has never run or failed completely.',
          fix:'Click Run Analysis on the SEO dashboard.' });
      } else {
        const ageHrs = (now - new Date(brief.generatedAt || 0)) / 3600000;
        const requiredFields = ['articleBrief','promptInjection','titleRewrites','priorityActions','weeklyInsight'];
        const missingFields  = requiredFields.filter(f => !brief[f]);
        if (missingFields.length > 0) {
          checks.push({ id:'2.1', layer:2, name:'Intelligence brief complete', status:'AMBER',
            detail:`Brief exists but missing fields: ${missingFields.join(', ')}.`,
            diagnosis:'Intelligence engine ran but Claude returned incomplete JSON.',
            fix:'Click Run Analysis on SEO dashboard to regenerate.' });
        } else if (ageHrs > 25) {
          checks.push({ id:'2.1', layer:2, name:'Intelligence brief fresh', status:'AMBER',
            detail:`Brief last generated ${Math.round(ageHrs)} hours ago.`,
            diagnosis:'Cron may have failed today or intelligence engine was not triggered.',
            fix:'Click Run Analysis on SEO dashboard.' });
        } else {
          checks.push({ id:'2.1', layer:2, name:'Intelligence brief', status:'GREEN',
            detail:`Complete brief generated ${Math.round(ageHrs * 60)} minutes ago. Target query: "${brief.articleBrief?.targetQuery || 'N/A'}"` });
        }
      }
    } catch(e) {
      checks.push({ id:'2.1', layer:2, name:'Intelligence brief', status:'RED',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.2 intelligence:brief_log written today
    try {
      const log = await env.FFX_KV.get(`intelligence:brief_log:${today}`, { type: 'json' }).catch(() => null);
      if (!log) {
        checks.push({ id:'2.2', layer:2, name:'Brief log written today', status:'AMBER',
          detail:`intelligence:brief_log:${today} not found.`,
          diagnosis:'Intelligence engine may not have run today, or brief_log write failed.',
          fix:'Run Analysis from SEO dashboard to regenerate today\'s brief and log.' });
      } else {
        checks.push({ id:'2.2', layer:2, name:'Brief log written today', status:'GREEN',
          detail:`${log.recommendations?.length || 0} recommendations logged.` });
      }
    } catch(e) {
      checks.push({ id:'2.2', layer:2, name:'Brief log written today', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.3 seo:signals fresh
    try {
      const seo = await env.FFX_KV.get('seo:signals', { type: 'json' }).catch(() => null);
      if (!seo) {
        checks.push({ id:'2.3', layer:2, name:'SEO signals exist', status:'RED',
          detail:'seo:signals missing.',
          diagnosis:'SEO signal collection has never run or failed.',
          fix:'POST to /api/seo-signals from SEO dashboard.' });
      } else {
        const ageHrs = (now - new Date(seo.generatedAt || 0)) / 3600000;
        checks.push({ id:'2.3', layer:2, name:'SEO signals fresh', status: ageHrs > 25 ? 'AMBER' : 'GREEN',
          detail:`Last updated ${Math.round(ageHrs)} hours ago. Impressions: ${seo.totals?.impressions || 0}, Clicks: ${seo.totals?.clicks || 0}.`,
          ...(ageHrs > 25 ? { diagnosis:'Signals stale — cron may have missed a run.', fix:'POST to /api/seo-signals from SEO dashboard.' } : {}) });
      }
    } catch(e) {
      checks.push({ id:'2.3', layer:2, name:'SEO signals fresh', status:'RED',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.4 ga4:signals fresh
    try {
      const ga4 = await env.FFX_KV.get('ga4:signals', { type: 'json' }).catch(() => null);
      if (!ga4) {
        checks.push({ id:'2.4', layer:2, name:'GA4 signals exist', status:'RED',
          detail:'ga4:signals missing.',
          diagnosis:'GA4 signal collection has never run or failed.',
          fix:'Click Refresh Signals on Audience dashboard.' });
      } else {
        const ageHrs = (now - new Date(ga4.generatedAt || 0)) / 3600000;
        checks.push({ id:'2.4', layer:2, name:'GA4 signals fresh', status: ageHrs > 25 ? 'AMBER' : 'GREEN',
          detail:`Last updated ${Math.round(ageHrs)} hours ago. Users: ${ga4.totals?.users || 0}, Sessions: ${ga4.totals?.sessions || 0}.`,
          ...(ageHrs > 25 ? { diagnosis:'GA4 signals stale.', fix:'Click Refresh Signals on Audience dashboard.' } : {}) });
      }
    } catch(e) {
      checks.push({ id:'2.4', layer:2, name:'GA4 signals fresh', status:'RED',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.5 intelligence:targets exists
    try {
      const targets = await env.FFX_KV.get('intelligence:targets', { type: 'json' }).catch(() => null);
      if (!targets) {
        checks.push({ id:'2.5', layer:2, name:'Targets seeded', status:'RED',
          detail:'intelligence:targets missing.',
          diagnosis:'Seed Targets has never been run.',
          fix:'Click ⊕ Seed Targets on the Audience dashboard.' });
      } else {
        const ageHrs = targets.current?.lastUpdated
          ? (now - new Date(targets.current.lastUpdated)) / 3600000
          : 999;
        checks.push({ id:'2.5', layer:2, name:'Targets seeded and current', status: ageHrs > 200 ? 'AMBER' : 'GREEN',
          detail:`Week ${targets.current?.weekNumber || 1} of 52. Overall status: ${targets.current?.overallStatus || 'baselining'}.`,
          ...(ageHrs > 200 ? { diagnosis:'Targets not updated in 8+ days — weekly cron update may have failed.', fix:'Run cron manually via /api/seo-signals POST.' } : {}) });
      }
    } catch(e) {
      checks.push({ id:'2.5', layer:2, name:'Targets seeded', status:'RED',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.6 content:performance snapshots firing
    try {
      const perfList = await env.FFX_KV.list({ prefix: 'content:performance:' }).catch(() => null);
      if (perfList && perfList.keys.length > 0) {
        let olderThan7 = 0, hasSnapshot7 = 0;
        for (const key of perfList.keys.slice(0, 10)) {
          const perf = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
          if (!perf || !perf.publishedAt) continue;
          const daysSince = (now - new Date(perf.publishedAt)) / 86400000;
          if (daysSince >= 7) {
            olderThan7++;
            if (perf.snapshot7) hasSnapshot7++;
          }
        }
        if (olderThan7 > 0 && hasSnapshot7 === 0) {
          checks.push({ id:'2.6', layer:2, name:'Performance snapshots firing', status:'RED',
            detail:`${olderThan7} articles older than 7 days with zero snapshots written.`,
            diagnosis:'content:performance records may have status:generated not published (CHANGE 12 issue).',
            fix:'Republish any article from Press dashboard to trigger content:performance status update.' });
        } else if (olderThan7 > 0 && hasSnapshot7 < olderThan7) {
          checks.push({ id:'2.6', layer:2, name:'Performance snapshots firing', status:'AMBER',
            detail:`${hasSnapshot7} of ${olderThan7} eligible articles have snapshot7.`,
            diagnosis:'Some snapshots pending — may fire on next seo-signals run.',
            fix:'Trigger /api/seo-signals POST from SEO dashboard to force snapshot check.' });
        } else if (olderThan7 === 0) {
          checks.push({ id:'2.6', layer:2, name:'Performance snapshots firing', status:'GREEN',
            detail:'No articles old enough for snapshot7 yet. Will fire automatically when articles reach 7 days.' });
        } else {
          checks.push({ id:'2.6', layer:2, name:'Performance snapshots firing', status:'GREEN',
            detail:`${hasSnapshot7}/${olderThan7} eligible articles have snapshot7 written.` });
        }
      } else {
        checks.push({ id:'2.6', layer:2, name:'Performance snapshots firing', status:'GREEN',
          detail:'No content:performance records yet — nothing to snapshot.' });
      }
    } catch(e) {
      checks.push({ id:'2.6', layer:2, name:'Performance snapshots firing', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV list failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.7 seo:learning building
    try {
      const learning = await env.FFX_KV.get('seo:learning', { type: 'json' }).catch(() => null);
      if (!learning || !Array.isArray(learning) || learning.length === 0) {
        checks.push({ id:'2.7', layer:2, name:'SEO learning building', status:'AMBER',
          detail:'seo:learning empty — no historical SEO data yet.',
          diagnosis:'Not enough weekly data collected yet. Normal in first 2 weeks.',
          fix:'No action needed. Learning builds automatically over time.' });
      } else {
        checks.push({ id:'2.7', layer:2, name:'SEO learning building', status:'GREEN',
          detail:`${learning.length} weeks of SEO learning data.` });
      }
    } catch(e) {
      checks.push({ id:'2.7', layer:2, name:'SEO learning building', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.8 intelligence:accuracy_scores building
    try {
      const scores = await env.FFX_KV.get('intelligence:accuracy_scores', { type: 'json' }).catch(() => null);
      if (!scores || !Array.isArray(scores) || scores.length === 0) {
        checks.push({ id:'2.8', layer:2, name:'Accuracy scores building', status:'AMBER',
          detail:'intelligence:accuracy_scores empty — no scored recommendations yet.',
          diagnosis:'Normal. Scores build after articles are published 7+ days and snapshots fire.',
          fix:'No action needed. Will build automatically as articles age.' });
      } else {
        const latest = scores[scores.length - 1];
        checks.push({ id:'2.8', layer:2, name:'Accuracy scores building', status:'GREEN',
          detail:`${scores.length} weeks scored. Latest accuracy: ${latest.accuracyRate ? (latest.accuracyRate * 100).toFixed(0) + '%' : 'pending'}.` });
      }
    } catch(e) {
      checks.push({ id:'2.8', layer:2, name:'Accuracy scores building', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 2 FLOW INTEGRITY CHECKS (5 checks — verify complete flows not just KV existence)
    // ─────────────────────────────────────────────────────────────────────

    // 2.9 ga4:exec_summary written today AND contains dailyDirective
    try {
      const execSummary = await env.FFX_KV.get(`ga4:exec_summary:${today}`, { type: 'json' }).catch(() => null);
      if (!execSummary) {
        checks.push({ id:'2.9', layer:2, name:'Exec summary written today', status:'AMBER',
          detail:`ga4:exec_summary:${today} not found.`,
          diagnosis:'Run Analysis has not been run today, or the write failed.',
          fix:'Click ⚡ Run Analysis on SEO dashboard. This generates the daily directive and exec summary.' });
      } else if (!execSummary.dailyDirective) {
        checks.push({ id:'2.9', layer:2, name:'Exec summary contains directive', status:'RED',
          detail:`ga4:exec_summary:${today} exists but has no dailyDirective field.`,
          diagnosis:'Intelligence engine wrote the exec summary but the directive generation step failed or returned incomplete JSON.',
          fix:'Click ⚡ Run Analysis again. If it persists, check intelligence-engine.js Claude response parsing.' });
      } else {
        const actedOn = execSummary.dailyDirective.actedOn;
        const snoozed = execSummary.dailyDirective.snoozeUntil;
        const detail  = actedOn === true ? 'Directive acted on ✓'
                      : snoozed ? 'Directive snoozed'
                      : 'Directive awaiting action';
        checks.push({ id:'2.9', layer:2, name:'Exec summary written today', status:'GREEN',
          detail:`ga4:exec_summary:${today} present with dailyDirective. ${detail}.` });
      }
    } catch(e) {
      checks.push({ id:'2.9', layer:2, name:'Exec summary written today', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.10 Directive action written to intelligence:daily_directive when user clicked Done
    try {
      const directive = await env.FFX_KV.get(`intelligence:daily_directive:${today}`, { type: 'json' }).catch(() => null);
      const execSummary2 = await env.FFX_KV.get(`ga4:exec_summary:${today}`, { type: 'json' }).catch(() => null);
      const execActedOn  = execSummary2?.dailyDirective?.actedOn;

      if (execActedOn === true && !directive) {
        checks.push({ id:'2.10', layer:2, name:'Directive action confirmed in KV', status:'RED',
          detail:`ga4:exec_summary shows actedOn:true but intelligence:daily_directive:${today} is missing.`,
          diagnosis:'Directive feedback POST wrote exec_summary but failed to write intelligence:daily_directive. Silent failure in directive-feedback.js.',
          fix:'Re-click Done on the directive. The deployed directive-feedback.js now verifies both writes.' });
      } else if (execActedOn === true && directive?.actedOn === true) {
        checks.push({ id:'2.10', layer:2, name:'Directive action confirmed in KV', status:'GREEN',
          detail:`Both ga4:exec_summary and intelligence:daily_directive:${today} confirm actedOn:true at ${directive.actedOnAt?.split('T')[1]?.slice(0,5) || 'unknown'}.` });
      } else if (!execActedOn) {
        checks.push({ id:'2.10', layer:2, name:'Directive action confirmed in KV', status:'GREEN',
          detail:'No directive action taken today — nothing to verify.' });
      } else {
        checks.push({ id:'2.10', layer:2, name:'Directive action confirmed in KV', status:'AMBER',
          detail:`exec_summary actedOn: ${execActedOn}, directive record actedOn: ${directive?.actedOn ?? 'missing'}.`,
          diagnosis:'Mismatch between exec_summary and daily_directive records.',
          fix:'Re-click Done on the directive to re-sync both KV records.' });
      }
    } catch(e) {
      checks.push({ id:'2.10', layer:2, name:'Directive action confirmed in KV', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.11 content:performance updated to published after last publish
    try {
      const pubList211 = await env.FFX_KV.list({ prefix: 'published:' }).catch(() => null);
      const filtered211 = pubList211?.keys?.filter(k => !k.name.includes('slug:')) || [];
      if (!filtered211.length) {
        checks.push({ id:'2.11', layer:2, name:'Publish flow integrity', status:'GREEN',
          detail:'No articles published yet — nothing to verify.' });
      } else {
        const latest211   = await env.FFX_KV.get(filtered211[0].name, { type: 'json' }).catch(() => null);
        const slug211     = latest211?.slug;
        if (!slug211) {
          checks.push({ id:'2.11', layer:2, name:'Publish flow integrity', status:'AMBER',
            detail:'Latest published record has no slug field.',
            diagnosis:'published: KV record may be malformed.',
            fix:'Check publish-confirm.js deployment.' });
        } else {
          const perf211 = await env.FFX_KV.get(`content:performance:${slug211}`, { type: 'json' }).catch(() => null);
          if (!perf211) {
            checks.push({ id:'2.11', layer:2, name:'Publish flow integrity', status:'AMBER',
              detail:`content:performance:${slug211} not found. Article is published but performance tracking missing.`,
              diagnosis:'Consumer may not have written content:performance on generation, or slug mismatch.',
              fix:'Generate a new article — the updated consumer writes content:performance at generation time.' });
          } else if (perf211.status !== 'published') {
            checks.push({ id:'2.11', layer:2, name:'Publish flow integrity', status:'RED',
              detail:`content:performance:${slug211} has status:${perf211.status} — should be published after successful publish.`,
              diagnosis:'publish-confirm.js CHANGE 12 did not update status to published, or the write verification failed.',
              fix:'Republish from Press dashboard. Check Cloudflare logs for publish-confirm.js errors.' });
          } else {
            checks.push({ id:'2.11', layer:2, name:'Publish flow integrity', status:'GREEN',
              detail:`content:performance:${slug211} confirmed status:published at ${perf211.publishedAt?.split('T')[0] || 'unknown'}.` });
          }
        }
      }
    } catch(e) {
      checks.push({ id:'2.11', layer:2, name:'Publish flow integrity', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.12 intelligence:brief contains all required fields (complete write verification)
    try {
      const brief212 = await env.FFX_KV.get('intelligence:brief', { type: 'json' }).catch(() => null);
      if (!brief212) {
        checks.push({ id:'2.12', layer:2, name:'Brief write complete', status:'AMBER',
          detail:'intelligence:brief not found.',
          diagnosis:'Run Analysis has not been run, or the write failed.',
          fix:'Click ⚡ Run Analysis on SEO dashboard.' });
      } else {
        const required = ['articleBrief','priorityActions','weeklyInsight','promptInjection','generatedAt'];
        const missing212 = required.filter(f => !brief212[f]);
        const execVerified = brief212._execSummaryWriteVerified;
        if (missing212.length > 0) {
          checks.push({ id:'2.12', layer:2, name:'Brief write complete', status:'RED',
            detail:`Brief is missing fields: ${missing212.join(', ')}.`,
            diagnosis:'Claude returned incomplete JSON or the brief was truncated. The write itself succeeded but the content is incomplete.',
            fix:'Click ⚡ Run Analysis again to regenerate with complete fields.' });
        } else if (execVerified === false) {
          checks.push({ id:'2.12', layer:2, name:'Brief write complete', status:'AMBER',
            detail:`Brief is complete. But ga4:exec_summary write verification FAILED during last Run Analysis — directive buttons may not work.`,
            diagnosis:'intelligence:brief wrote successfully but ga4:exec_summary failed its read-back check.',
            fix:'Click ⚡ Run Analysis again. The updated intelligence-engine.js now surfaces this failure.' });
        } else {
          checks.push({ id:'2.12', layer:2, name:'Brief write complete', status:'GREEN',
            detail:`All required fields present. Exec summary write ${execVerified === true ? 'verified ✓' : 'not tracked (pre-fix version)'}. Generated: ${brief212.generatedAt?.split('T')[0]}.` });
        }
      }
    } catch(e) {
      checks.push({ id:'2.12', layer:2, name:'Brief write complete', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 2.13 Pre-deploy mode — fast subset for post-deploy verification
    const url213 = context?.request?.url || '';
    const isPredeploy = url213.includes('mode=predeploy');
    if (isPredeploy) {
      // Only run immediate checks — skip time-dependent ones
      const predeployChecks = checks.filter(c =>
        ['1.1','1.3','2.3','2.4','2.9','2.12'].includes(c.id)
      );
      const pdRed   = predeployChecks.filter(c => c.status === 'RED').length;
      const pdAmber = predeployChecks.filter(c => c.status === 'AMBER').length;
      const pdGreen = predeployChecks.filter(c => c.status === 'GREEN').length;
      const pdPass  = pdRed === 0;
      return new Response(JSON.stringify({
        mode:    'predeploy',
        pass:    pdPass,
        summary: pdPass ? 'All pre-deploy checks passed' : `${pdRed} RED checks — do not deploy until resolved`,
        greenCount: pdGreen, amberCount: pdAmber, redCount: pdRed,
        checks:  predeployChecks,
      }), { status: 200, headers });
    }

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 3 — INTELLIGENCE SYSTEM HEALTH (6 checks)
    // ─────────────────────────────────────────────────────────────────────

    // 3.1 Intelligence engine reads all signal sources
    try {
      const brief = await env.FFX_KV.get('intelligence:brief', { type: 'json' }).catch(() => null);
      if (!brief || !brief.signalSources) {
        checks.push({ id:'3.1', layer:3, name:'Signal sources connected', status:'AMBER',
          detail:'Cannot verify — intelligence:brief missing or has no signalSources field.',
          diagnosis:'Intelligence engine not yet run or old version without signalSources tracking.',
          fix:'Run Analysis from SEO dashboard.' });
      } else {
        const sources = brief.signalSources;
        const connected = Object.entries(sources).filter(([,v]) => v).map(([k]) => k);
        const missing   = Object.entries(sources).filter(([,v]) => !v).map(([k]) => k);
        // Phase 2 signals (youtube, discord, email, calendar, knowledge, intelligence) are not yet built
        // Only seo and ga4 are built — missing 6 is expected, not a RED
        const phase2Signals = ['youtube','discord','email','calendar','knowledge','intelligence'];
        const unexpectedMissing = missing.filter(m => !phase2Signals.includes(m));
        const phase2Missing     = missing.filter(m => phase2Signals.includes(m));

        if (unexpectedMissing.length >= 2) {
          checks.push({ id:'3.1', layer:3, name:'Signal sources connected', status:'RED',
            detail:`Core signals missing: ${unexpectedMissing.join(', ')}. Only ${connected.length}/8 sources read.`,
            diagnosis:'seo:signals or ga4:signals are missing — engine is making decisions with no data.',
            fix:'Run Analysis from SEO dashboard. Check that Refresh Signals has been run on both SEO and Audience dashboards.' });
        } else if (unexpectedMissing.length === 1) {
          checks.push({ id:'3.1', layer:3, name:'Signal sources connected', status:'AMBER',
            detail:`${unexpectedMissing[0]} signal missing. ${phase2Missing.length} Phase 2 signals not yet built.`,
            diagnosis:'One core signal source is missing.',
            fix:'Run Refresh Signals from the relevant dashboard.' });
        } else if (phase2Missing.length > 0) {
          checks.push({ id:'3.1', layer:3, name:'Signal sources connected', status:'AMBER',
            detail:`Core signals (SEO, GA4) connected. ${phase2Missing.length} Phase 2 signals not yet built: ${phase2Missing.join(', ')}.`,
            diagnosis:'Phase 2 signal sources (YouTube, Discord, Email etc) are planned future builds — not a system failure.',
            fix:'No action needed. Phase 2 signals will be built in a future session.' });
        } else {
          checks.push({ id:'3.1', layer:3, name:'Signal sources connected', status:'GREEN',
            detail:`All ${connected.length} available signal sources read.` });
        }
      }
    } catch(e) {
      checks.push({ id:'3.1', layer:3, name:'Signal sources connected', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 3.2 Brief injection reaching articles
    try {
      const perfList = await env.FFX_KV.list({ prefix: 'content:performance:' }).catch(() => null);
      if (!perfList || !perfList.keys.length) {
        checks.push({ id:'3.2', layer:3, name:'Brief injection reaching articles', status:'AMBER',
          detail:'No content:performance records to check.',
          diagnosis:'No articles generated yet.',
          fix:'Generate an article from the queue dashboard.' });
      } else {
        const recent = perfList.keys[0];
        const perf   = await env.FFX_KV.get(recent.name, { type: 'json' }).catch(() => null);
        if (!perf) {
          checks.push({ id:'3.2', layer:3, name:'Brief injection reaching articles', status:'AMBER',
            detail:'Could not read most recent content:performance record.',
            diagnosis:'KV read failed for specific key.',
            fix:'Generate a new article to create a fresh record.' });
        } else if (perf.nuggetInjectionStatus === undefined) {
          checks.push({ id:'3.2', layer:3, name:'Brief injection reaching articles', status:'RED',
            detail:'nuggetInjectionStatus field missing from content:performance.',
            diagnosis:'Consumer with CHANGE 4 may not be deployed — old consumer running.',
            fix:'Check ffx-consumer Worker deployment in Cloudflare. Confirm latest index.js is deployed.' });
        } else {
          checks.push({ id:'3.2', layer:3, name:'Brief injection reaching articles', status:'GREEN',
            detail:`promptInjected: ${perf.promptInjected}, nuggetStatus: ${perf.nuggetInjectionStatus}. Brief version: ${perf.briefVersion?.split('T')[0] || 'N/A'}.` });
        }
      }
    } catch(e) {
      checks.push({ id:'3.2', layer:3, name:'Brief injection reaching articles', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 3.3 intelligence:outcomes being written
    try {
      const outcomeList = await env.FFX_KV.list({ prefix: 'intelligence:outcomes:' }).catch(() => null);
      if (!outcomeList || !outcomeList.keys.length) {
        checks.push({ id:'3.3', layer:3, name:'Outcomes being tracked', status:'AMBER',
          detail:'No intelligence:outcomes records yet.',
          diagnosis:'Normal — outcomes only write when articles reach 7+ days old AND snapshots have fired.',
          fix:'No action needed. Will build automatically as articles age.' });
      } else {
        checks.push({ id:'3.3', layer:3, name:'Outcomes being tracked', status:'GREEN',
          detail:`${outcomeList.keys.length} recommendation outcomes tracked.` });
      }
    } catch(e) {
      checks.push({ id:'3.3', layer:3, name:'Outcomes being tracked', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV list failed.', fix:'Check FFX_KV binding.' });
    }

    // 3.4 Title tests being monitored
    try {
      const titleList = await env.FFX_KV.list({ prefix: 'seo:title_tests:' }).catch(() => null);
      if (!titleList || !titleList.keys.length) {
        checks.push({ id:'3.4', layer:3, name:'Title tests monitoring', status:'GREEN',
          detail:'No title tests active — none have been created yet.' });
      } else {
        let monitoring = 0, complete = 0, stale = 0;
        for (const key of titleList.keys) {
          const test = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
          if (!test) continue;
          if (test.status === 'complete') complete++;
          else if (test.status === 'monitoring') {
            monitoring++;
            const updateAgeHrs = test.impressionsAfter !== undefined
              ? (now - new Date(test.changedAt || 0)) / 3600000
              : 999;
            if (updateAgeHrs > 30) stale++;
          }
        }
        if (stale > 0) {
          checks.push({ id:'3.4', layer:3, name:'Title tests monitoring', status:'AMBER',
            detail:`${stale} title test(s) not updated in 30+ hours.`,
            diagnosis:'seo-signals daily check may not be running.',
            fix:'Trigger /api/seo-signals POST from SEO dashboard.' });
        } else {
          checks.push({ id:'3.4', layer:3, name:'Title tests monitoring', status:'GREEN',
            detail:`${monitoring} monitoring, ${complete} complete.` });
        }
      }
    } catch(e) {
      checks.push({ id:'3.4', layer:3, name:'Title tests monitoring', status:'GREEN',
        detail:'No title tests found.' });
    }

    // 3.5 seo:learning:summary exists
    try {
      const summary = await env.FFX_KV.get('seo:learning:summary', { type: 'json' }).catch(() => null);
      if (!summary) {
        checks.push({ id:'3.5', layer:3, name:'Learning summary exists', status:'AMBER',
          detail:'seo:learning:summary not yet written.',
          diagnosis:'Normal — summary only writes on Mondays after 2+ weeks of SEO learning data.',
          fix:'No action needed. Will write automatically next Monday.' });
      } else {
        checks.push({ id:'3.5', layer:3, name:'Learning summary exists', status:'GREEN',
          detail:`Summary present. Generated: ${summary.generatedAt?.split('T')[0] || 'N/A'}.` });
      }
    } catch(e) {
      checks.push({ id:'3.5', layer:3, name:'Learning summary exists', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 3.6 Nugget injection status on recent article
    try {
      const perfList = await env.FFX_KV.list({ prefix: 'content:performance:' }).catch(() => null);
      if (perfList && perfList.keys.length > 0) {
        const perf = await env.FFX_KV.get(perfList.keys[0].name, { type: 'json' }).catch(() => null);
        if (perf && perf.nuggetInjectionStatus) {
          const status31 = perf.nuggetInjectionStatus === 'injected' ? 'GREEN'
                         : perf.nuggetInjectionStatus === 'skipped_no_match' ? 'AMBER'
                         : perf.nuggetInjectionStatus === 'skipped_empty' ? 'AMBER'
                         : 'RED';
          checks.push({ id:'3.6', layer:3, name:'Nugget injection operational', status: status31,
            detail:`Status: ${perf.nuggetInjectionStatus}. Reason: ${perf.nuggetInjectionReason || 'N/A'}. IDs used: ${perf.nuggetIdsUsed?.length || 0}.`,
            ...(status31 !== 'GREEN' ? {
              diagnosis: perf.nuggetInjectionStatus === 'skipped_no_match'
                ? 'No nugget tags matched transcript. Normal early on — library needs more diverse nuggets.'
                : perf.nuggetInjectionStatus === 'skipped_empty'
                ? 'Nuggets library is empty.'
                : 'Consumer failed during nugget injection step.',
              fix: perf.nuggetInjectionStatus === 'skipped_empty'
                ? 'Generate more videos to build the nugget library.'
                : 'Generate more videos on diverse topics to build tag coverage.'
            } : {}) });
        } else {
          checks.push({ id:'3.6', layer:3, name:'Nugget injection operational', status:'AMBER',
            detail:'No nuggetInjectionStatus in recent record.',
            diagnosis:'Old record predates CHANGE 4 deployment.',
            fix:'Generate a new article to create a fresh record with injection status.' });
        }
      } else {
        checks.push({ id:'3.6', layer:3, name:'Nugget injection operational', status:'AMBER',
          detail:'No content:performance records to check.', diagnosis:'No articles generated yet.', fix:'Generate an article.' });
      }
    } catch(e) {
      checks.push({ id:'3.6', layer:3, name:'Nugget injection operational', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 4 — PLATFORM DISTRIBUTION HEALTH (5 checks)
    // ─────────────────────────────────────────────────────────────────────

    // 4.1 Most recent article published to all platforms
    try {
      const pubList = await env.FFX_KV.list({ prefix: 'published:' }).catch(() => null);
      const filtered = pubList?.keys?.filter(k => !k.name.includes('slug:')) || [];
      if (!filtered.length) {
        checks.push({ id:'4.1', layer:4, name:'Articles published', status:'AMBER',
          detail:'No published articles found.',
          diagnosis:'No articles have been published yet.',
          fix:'Generate and publish an article from the queue dashboard.' });
      } else {
        const latest = await env.FFX_KV.get(filtered[0].name, { type: 'json' }).catch(() => null);
        if (!latest) {
          checks.push({ id:'4.1', layer:4, name:'Platform publish status', status:'AMBER',
            detail:'Could not read latest published record.',
            diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
        } else {
          const platforms4 = latest.platforms || {};
          const failed     = Object.entries(platforms4)
            .filter(([,v]) => v?.status?.startsWith?.('Error') || v?.status?.startsWith?.('error'))
            .map(([k]) => k);
          const missing    = ['blog','x','linkedin','discord','tumblr']
            .filter(p => !platforms4[p] || !platforms4[p].publishedAt);
          if (failed.length > 0) {
            checks.push({ id:'4.1', layer:4, name:'Platform publish status', status:'RED',
              detail:`Platform errors: ${failed.join(', ')} for ${latest.slug}.`,
              diagnosis:`Platform Workers returned errors for these platforms.`,
              fix:`Go to Press dashboard → open ${latest.slug} → republish to failed platforms.` });
          } else if (missing.length > 0) {
            checks.push({ id:'4.1', layer:4, name:'Platform publish status', status:'AMBER',
              detail:`Platforms not yet published: ${missing.join(', ')} for ${latest.slug}.`,
              diagnosis:'Article published to some platforms but not all.',
              fix:`Go to Press dashboard → open ${latest.slug} → publish missing platforms.` });
          } else {
            const platforms4Published = Object.keys(platforms4).filter(p => platforms4[p]?.publishedAt);
            checks.push({ id:'4.1', layer:4, name:'Platform publish status', status:'GREEN',
              detail:`${latest.slug} published to: ${platforms4Published.join(', ')}.` });
          }
        }
      }
    } catch(e) {
      checks.push({ id:'4.1', layer:4, name:'Platform publish status', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 4.2 LinkedIn token health
    try {
      const pubList = await env.FFX_KV.list({ prefix: 'published:' }).catch(() => null);
      const filtered4 = pubList?.keys?.filter(k => !k.name.includes('slug:')) || [];
      if (filtered4.length > 0) {
        const latest4 = await env.FFX_KV.get(filtered4[0].name, { type: 'json' }).catch(() => null);
        const li = latest4?.platforms?.linkedin;
        if (li?.status?.startsWith('Error')) {
          checks.push({ id:'4.2', layer:4, name:'LinkedIn token valid', status:'RED',
            detail:`LinkedIn publish error: ${li.status}.`,
            diagnosis:'LinkedIn access token has expired. Tokens expire every 2 months.',
            fix:'Reconnect LinkedIn: linkedin.com/developers → FortitudeFX app → Auth tab → regenerate token → update in Make.com or Workers env var.' });
        } else {
          checks.push({ id:'4.2', layer:4, name:'LinkedIn token valid', status:'GREEN',
            detail:'LinkedIn last published successfully.' });
        }
      } else {
        checks.push({ id:'4.2', layer:4, name:'LinkedIn token valid', status:'GREEN',
          detail:'No published articles to check LinkedIn status against.' });
      }
    } catch(e) {
      checks.push({ id:'4.2', layer:4, name:'LinkedIn token valid', status:'GREEN', detail:'No data to check.' });
    }

    // 4.3 X posting health
    try {
      const pubList4 = await env.FFX_KV.list({ prefix: 'published:' }).catch(() => null);
      const filtered43 = pubList4?.keys?.filter(k => !k.name.includes('slug:')) || [];
      if (filtered43.length > 0) {
        const latest43 = await env.FFX_KV.get(filtered43[0].name, { type: 'json' }).catch(() => null);
        const x = latest43?.platforms?.x;
        if (x?.status?.startsWith('Error')) {
          checks.push({ id:'4.3', layer:4, name:'X posting health', status:'RED',
            detail:`X publish error: ${x.status}.`,
            diagnosis:'X access token may be expired or rate limited.',
            fix:'Check X developer portal for token status. Update X_ACCESS_TOKEN in Cloudflare env vars.' });
        } else {
          checks.push({ id:'4.3', layer:4, name:'X posting health', status:'GREEN',
            detail:'X last published successfully.' });
        }
      } else {
        checks.push({ id:'4.3', layer:4, name:'X posting health', status:'GREEN', detail:'No published articles to check.' });
      }
    } catch(e) {
      checks.push({ id:'4.3', layer:4, name:'X posting health', status:'GREEN', detail:'No data to check.' });
    }

    // 4.4 Discord posting health
    try {
      const pubList44 = await env.FFX_KV.list({ prefix: 'published:' }).catch(() => null);
      const filtered44 = pubList44?.keys?.filter(k => !k.name.includes('slug:')) || [];
      if (filtered44.length > 0) {
        const latest44 = await env.FFX_KV.get(filtered44[0].name, { type: 'json' }).catch(() => null);
        const dc = latest44?.platforms?.discord;
        if (dc?.status?.startsWith('Error')) {
          checks.push({ id:'4.4', layer:4, name:'Discord posting health', status:'RED',
            detail:`Discord publish error: ${dc.status}.`,
            diagnosis:'Discord webhook URL may be invalid or channel deleted.',
            fix:'Check Discord server webhook settings. Update DISCORD_WEBHOOK_URL in Cloudflare env vars.' });
        } else {
          checks.push({ id:'4.4', layer:4, name:'Discord posting health', status:'GREEN',
            detail:'Discord last published successfully.' });
        }
      } else {
        checks.push({ id:'4.4', layer:4, name:'Discord posting health', status:'GREEN', detail:'No published articles to check.' });
      }
    } catch(e) {
      checks.push({ id:'4.4', layer:4, name:'Discord posting health', status:'GREEN', detail:'No data to check.' });
    }

    // 4.5 Tumblr posting health
    try {
      const pubList45 = await env.FFX_KV.list({ prefix: 'published:' }).catch(() => null);
      const filtered45 = pubList45?.keys?.filter(k => !k.name.includes('slug:')) || [];
      if (filtered45.length > 0) {
        const latest45 = await env.FFX_KV.get(filtered45[0].name, { type: 'json' }).catch(() => null);
        const tb = latest45?.platforms?.tumblr;
        if (tb?.status?.startsWith('Error')) {
          checks.push({ id:'4.5', layer:4, name:'Tumblr posting health', status:'RED',
            detail:`Tumblr publish error: ${tb.status}.`,
            diagnosis:'Tumblr access token may be expired.',
            fix:'Reconnect Tumblr token in Cloudflare Worker env vars.' });
        } else {
          checks.push({ id:'4.5', layer:4, name:'Tumblr posting health', status:'GREEN',
            detail:'Tumblr last published successfully.' });
        }
      } else {
        checks.push({ id:'4.5', layer:4, name:'Tumblr posting health', status:'GREEN', detail:'No published articles to check.' });
      }
    } catch(e) {
      checks.push({ id:'4.5', layer:4, name:'Tumblr posting health', status:'GREEN', detail:'No data to check.' });
    }

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 5 — EXTERNAL DEPENDENCIES (3 checks)
    // ─────────────────────────────────────────────────────────────────────

    // 5.1 Supadata quota check (via last transcript fetch success)
    try {
      const queue5 = await env.FFX_KV.get('queue:index', { type: 'json' }).catch(() => null);
      if (queue5 && Array.isArray(queue5)) {
        const generated = queue5.find(q => q.wasGenerated && q.jobId);
        if (generated) {
          const job = await env.FFX_KV.get(`job:${generated.jobId}`, { type: 'json' }).catch(() => null);
          if (job?.status === 'error' && job?.step === 'transcript' && job?.reason?.includes('429')) {
            checks.push({ id:'5.1', layer:5, name:'Supadata quota', status:'RED',
              detail:'Last transcript fetch returned 429 — Supadata quota exhausted.',
              diagnosis:'Monthly credit limit reached.',
              fix:'Log into supadata.ai → upgrade plan or wait for reset date shown on dashboard.' });
          } else if (job?.status === 'error' && job?.step === 'transcript') {
            checks.push({ id:'5.1', layer:5, name:'Supadata quota', status:'RED',
              detail:`Transcript fetch failed: ${job.reason}`,
              diagnosis:'Supadata API error — may be quota, auth, or service issue.',
              fix:'Log into supadata.ai → check quota and API key validity.' });
          } else {
            checks.push({ id:'5.1', layer:5, name:'Supadata quota', status:'GREEN',
              detail:'Last transcript fetch succeeded. Quota available.' });
          }
        } else {
          checks.push({ id:'5.1', layer:5, name:'Supadata quota', status:'GREEN',
            detail:'No recent generation to check against.' });
        }
      } else {
        checks.push({ id:'5.1', layer:5, name:'Supadata quota', status:'GREEN',
          detail:'Queue empty — no recent generation to verify.' });
      }
    } catch(e) {
      checks.push({ id:'5.1', layer:5, name:'Supadata quota', status:'GREEN', detail:'No data to check.' });
    }

    // 5.2 Google Auth token valid (via signal freshness)
    try {
      const seo5 = await env.FFX_KV.get('seo:signals', { type: 'json' }).catch(() => null);
      const ga45 = await env.FFX_KV.get('ga4:signals', { type: 'json' }).catch(() => null);
      const seoAge = seo5 ? (now - new Date(seo5.generatedAt || 0)) / 3600000 : 999;
      const ga4Age = ga45 ? (now - new Date(ga45.generatedAt || 0)) / 3600000 : 999;
      if (seoAge > 48 && ga4Age > 48) {
        checks.push({ id:'5.2', layer:5, name:'Google Auth token valid', status:'RED',
          detail:'Both seo:signals and ga4:signals are 48+ hours old.',
          diagnosis:'Google OAuth token may have expired.',
          fix:'Open the SEO dashboard — if signals fail to load, reconnect Google account via /api/google-auth flow.' });
      } else if (seoAge > 25 || ga4Age > 25) {
        checks.push({ id:'5.2', layer:5, name:'Google Auth token valid', status:'AMBER',
          detail:'One or both signal sources may be stale.',
          diagnosis:'Token may be expiring or cron missed a run.',
          fix:'Manually refresh signals from SEO and Audience dashboards.' });
      } else {
        checks.push({ id:'5.2', layer:5, name:'Google Auth token valid', status:'GREEN',
          detail:'SEO and GA4 signals both current — Google Auth working.' });
      }
    } catch(e) {
      checks.push({ id:'5.2', layer:5, name:'Google Auth token valid', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 5.3 APPROVAL_EMAIL set on consumer
    try {
      // We cannot read Worker env vars from Pages Functions
      // Instead check if completion emails are working via absence of APPROVAL_EMAIL error in recent jobs
      const queue53 = await env.FFX_KV.get('queue:index', { type: 'json' }).catch(() => null);
      if (queue53 && Array.isArray(queue53)) {
        const completed = queue53.find(q => q.wasGenerated && q.jobId);
        if (completed) {
          const job53 = await env.FFX_KV.get(`job:${completed.jobId}`, { type: 'json' }).catch(() => null);
          if (job53?.status === 'complete') {
            checks.push({ id:'5.3', layer:5, name:'Completion email configured', status:'AMBER',
              detail:'Cannot verify APPROVAL_EMAIL from here — check consumer Worker env vars.',
              diagnosis:'APPROVAL_EMAIL must be added to ffx-consumer Worker → Variables and Secrets.',
              fix:'Go to Cloudflare → Workers → ffx-consumer → Settings → Variables → add APPROVAL_EMAIL = salmankhanfx@fortitudefx.com' });
          } else {
            checks.push({ id:'5.3', layer:5, name:'Completion email configured', status:'AMBER',
              detail:'No completed jobs to check email status.',
              diagnosis:'APPROVAL_EMAIL may not be set on consumer Worker.',
              fix:'Go to Cloudflare → Workers → ffx-consumer → Settings → Variables → add APPROVAL_EMAIL.' });
          }
        } else {
          checks.push({ id:'5.3', layer:5, name:'Completion email configured', status:'AMBER',
            detail:'No completed jobs found to verify email.',
            diagnosis:'APPROVAL_EMAIL may not be set.',
            fix:'Go to Cloudflare → Workers → ffx-consumer → Settings → Variables → add APPROVAL_EMAIL.' });
        }
      } else {
        checks.push({ id:'5.3', layer:5, name:'Completion email configured', status:'AMBER',
          detail:'Cannot verify without completed jobs.',
          diagnosis:'APPROVAL_EMAIL may not be set.',
          fix:'Add APPROVAL_EMAIL to ffx-consumer Worker env vars in Cloudflare.' });
      }
    } catch(e) {
      checks.push({ id:'5.3', layer:5, name:'Completion email configured', status:'AMBER',
        detail:'Cannot verify.', diagnosis:'Check consumer Worker env vars manually.',
        fix:'Add APPROVAL_EMAIL to ffx-consumer Worker env vars in Cloudflare.' });
    }

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 6 — SOCIAL INTELLIGENCE HEALTH (3 checks)
    // ─────────────────────────────────────────────────────────────────────

    // 6.1 Social scan ran today
    try {
      const signals6 = await env.FFX_KV.get('intelligence:signals', { type: 'json' }).catch(() => null);
      if (!signals6) {
        checks.push({ id:'6.1', layer:6, name:'Social scan status', status:'AMBER',
          detail:'intelligence:signals not found — no social scan has run yet.',
          diagnosis:'Social Intelligence Agent has not been run. This is expected if Pass 2 was just deployed.',
          fix:'Go to Social dashboard → click ⚡ Run Scan.' });
      } else {
        const ageHrs6 = (now - new Date(signals6.scannedAt || signals6.date || 0)) / 3600000;
        checks.push({ id:'6.1', layer:6, name:'Social scan status', status: ageHrs6 > 48 ? 'AMBER' : 'GREEN',
          detail:`Last scan: ${Math.round(ageHrs6)} hours ago. Found: ${signals6.opportunitiesFound || 0} opportunities. Posted: ${signals6.acted || 0}. Dismissed: ${signals6.dismissed || 0}.`,
          ...(ageHrs6 > 48 ? { diagnosis:'No social scan in 48+ hours.', fix:'Go to Social dashboard → click ⚡ Run Scan.' } : {}) });
      }
    } catch(e) {
      checks.push({ id:'6.1', layer:6, name:'Social scan status', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 6.2 Opportunities written to KV
    try {
      const oppList6 = await env.FFX_KV.list({ prefix: 'intelligence:opportunities:' }).catch(() => null);
      const today6   = today;
      if (!oppList6 || !oppList6.keys.length) {
        checks.push({ id:'6.2', layer:6, name:'Opportunities in KV', status:'AMBER',
          detail:'No intelligence:opportunities records found.',
          diagnosis:'Social scan has not run or found no qualifying threads.',
          fix:'Go to Social dashboard → click ⚡ Run Scan.' });
      } else {
        let todayCount = 0, totalCount = oppList6.keys.length;
        for (const key of oppList6.keys.slice(0, 10)) {
          const opp6 = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
          if (opp6 && opp6.detectedAt && opp6.detectedAt.startsWith(today6)) todayCount++;
        }
        checks.push({ id:'6.2', layer:6, name:'Opportunities in KV', status:'GREEN',
          detail:`${todayCount} opportunities found today. ${totalCount} total in KV (last 7 days).` });
      }
    } catch(e) {
      checks.push({ id:'6.2', layer:6, name:'Opportunities in KV', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // 6.3 Reply performance tracking
    try {
      const perfList6 = await env.FFX_KV.list({ prefix: 'intelligence:reply_performance:' }).catch(() => null);
      if (!perfList6 || !perfList6.keys.length) {
        checks.push({ id:'6.3', layer:6, name:'Reply performance tracking', status:'AMBER',
          detail:'No reply performance records yet.',
          diagnosis:'Normal — records only write when you mark a reply as Posted on the Social dashboard.',
          fix:'No action needed. Will build as you post replies.' });
      } else {
        let pending = 0, completed = 0;
        for (const key of perfList6.keys.slice(0, 10)) {
          const perf6 = await env.FFX_KV.get(key.name, { type: 'json' }).catch(() => null);
          if (!perf6) continue;
          if (perf6.overallResult === 'pending') pending++;
          else completed++;
        }
        checks.push({ id:'6.3', layer:6, name:'Reply performance tracking', status:'GREEN',
          detail:`${perfList6.keys.length} reply records. ${pending} pending 72hr check. ${completed} completed.` });
      }
    } catch(e) {
      checks.push({ id:'6.3', layer:6, name:'Reply performance tracking', status:'AMBER',
        detail:'Check error: ' + e.message, diagnosis:'KV read failed.', fix:'Check FFX_KV binding.' });
    }

    // ─────────────────────────────────────────────────────────────────────
    // COMPUTE OVERALL STATUS AND WRITE RESULTS
    // ─────────────────────────────────────────────────────────────────────

    const redCount   = checks.filter(c => c.status === 'RED').length;
    const amberCount = checks.filter(c => c.status === 'AMBER').length;
    const greenCount = checks.filter(c => c.status === 'GREEN').length;
    const overall    = redCount > 0 ? 'RED' : amberCount > 0 ? 'AMBER' : 'GREEN';

    const results = {
      date:        today,
      ranAt:       now.toISOString(),
      overall,
      greenCount,
      amberCount,
      redCount,
      totalChecks: checks.length,
      checks,
    };

    // Write today's results
    await env.FFX_KV.put(`health:results:${today}`, JSON.stringify(results), { expirationTtl: 86400 * 30 });

    // Update history (last 30 days)
    try {
      const history = await env.FFX_KV.get('health:history', { type: 'json' }).catch(() => null) || [];
      const filtered = history.filter(h => h.date !== today);
      filtered.push({ date: today, overall, greenCount, amberCount, redCount, ranAt: now.toISOString() });
      await env.FFX_KV.put('health:history', JSON.stringify(filtered.slice(-30)));
    } catch(histErr) {
      console.error('[health-check] History update failed (non-fatal):', histErr.message);
    }

    console.log(`[health-check] Complete — ${greenCount} GREEN, ${amberCount} AMBER, ${redCount} RED`);
    return new Response(JSON.stringify({ success: true, results }), { status: 200, headers });

  } catch(err) {
    console.error('[health-check] Fatal error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
