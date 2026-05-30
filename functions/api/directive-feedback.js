// functions/api/directive-feedback.js
// GET  /api/directive-feedback        → returns today's ga4:exec_summary from KV
// POST /api/directive-feedback        → records Done/Snooze/Not applicable on directive
//
// Written by: Daily Directive buttons on dashboard-seo.html
// Read by:    dashboard-seo.html loadDailyDirective()
//
// Error handling: every KV op wrapped in try/catch
// Nothing fails silently — all errors returned as JSON with descriptive message

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // Try today first, fall back to yesterday
    let summary = await env.FFX_KV.get(`ga4:exec_summary:${today}`, { type: 'json' }).catch(() => null);
    let dateUsed = today;
    if (!summary) {
      summary  = await env.FFX_KV.get(`ga4:exec_summary:${yesterday}`, { type: 'json' }).catch(() => null);
      dateUsed = yesterday;
    }

    if (!summary) {
      return new Response(JSON.stringify({
        success: true,
        summary: null,
        message: 'No directive available yet. Run Analysis from the SEO dashboard to generate today\'s directive.'
      }), { status: 200, headers });
    }

    return new Response(JSON.stringify({
      success: true,
      summary,
      date:    dateUsed,
    }), { status: 200, headers });

  } catch(err) {
    console.error('[directive-feedback] GET error:', err.message);
    return new Response(JSON.stringify({
      error:   'Failed to load directive',
      detail:  err.message
    }), { status: 500, headers });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { action, date, editedReply } = body;

  if (!action || !['done', 'snooze', 'not_applicable'].includes(action)) {
    return new Response(JSON.stringify({
      error:   'Invalid action',
      detail:  'action must be one of: done, snooze, not_applicable'
    }), { status: 400, headers });
  }

  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    const summaryKey = `ga4:exec_summary:${targetDate}`;
    const summary    = await env.FFX_KV.get(summaryKey, { type: 'json' }).catch(() => null);

    if (!summary) {
      return new Response(JSON.stringify({
        error:  'No directive found for date: ' + targetDate,
        detail: 'The directive may have expired or not yet been generated'
      }), { status: 404, headers });
    }

    const now = new Date().toISOString();

    // Update directive based on action
    if (!summary.dailyDirective) summary.dailyDirective = {};

    if (action === 'done') {
      summary.dailyDirective.actedOn       = true;
      summary.dailyDirective.actedOnAt     = now;
      summary.dailyDirective.actedOnMethod = 'manual_confirm';
      if (editedReply) {
        summary.dailyDirective.editedReply = editedReply;
        summary.dailyDirective.actedOnMethod = 'manual_edited';
      }
      console.log('[directive-feedback] Marked done for date:', targetDate);

    } else if (action === 'snooze') {
      const snoozeUntil = new Date(Date.now() + 86400000).toISOString();
      summary.dailyDirective.snoozedAt   = now;
      summary.dailyDirective.snoozeUntil = snoozeUntil;
      summary.dailyDirective.actedOn     = null; // not acted on, just deferred
      console.log('[directive-feedback] Snoozed until:', snoozeUntil);

    } else if (action === 'not_applicable') {
      const { reason } = body;
      summary.dailyDirective.actedOn         = false;
      summary.dailyDirective.rejectedAt      = now;
      summary.dailyDirective.rejectionType   = 'not_applicable';
      summary.dailyDirective.rejectionReason = reason || 'not_applicable';
      console.log('[directive-feedback] Dismissed, reason:', reason || 'not_applicable');
    }

    // Write updated summary back to KV
    await env.FFX_KV.put(summaryKey, JSON.stringify(summary), { expirationTtl: 86400 * 30 });

    // Also write to intelligence:daily_directive:{date} for accuracy tracking
    try {
      const directiveKey = `intelligence:daily_directive:${targetDate}`;
      const existing     = await env.FFX_KV.get(directiveKey, { type: 'json' }).catch(() => null);
      const directive    = existing || { date: targetDate };

      if (action === 'done') {
        directive.actedOn       = true;
        directive.actedOnAt     = now;
        directive.actedOnMethod = editedReply ? 'manual_edited' : 'manual_confirm';
      } else if (action === 'snooze') {
        directive.snoozedAt   = now;
        directive.snoozeUntil = new Date(Date.now() + 86400000).toISOString();
      } else if (action === 'not_applicable') {
        directive.actedOn         = false;
        directive.rejectedAt      = now;
        directive.rejectionReason = body.reason || 'not_applicable';
      }

      await env.FFX_KV.put(directiveKey, JSON.stringify(directive), { expirationTtl: 86400 * 90 });
    } catch(trackErr) {
      console.error('[directive-feedback] Directive tracking write failed (non-fatal):', trackErr.message);
    }

    return new Response(JSON.stringify({
      success: true,
      action,
      date:    targetDate,
      message: action === 'done'           ? 'Directive marked as complete'
             : action === 'snooze'         ? 'Directive snoozed until tomorrow'
             : 'Directive dismissed'
    }), { status: 200, headers });

  } catch(err) {
    console.error('[directive-feedback] POST error:', err.message);
    return new Response(JSON.stringify({
      error:  'Failed to update directive',
      detail: err.message
    }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
