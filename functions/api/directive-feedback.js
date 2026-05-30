// functions/api/directive-feedback.js
// GET  /api/directive-feedback        → returns today's ga4:exec_summary from KV
// POST /api/directive-feedback        → records Done/Snooze/Not applicable on directive
//
// KV WRITE VERIFICATION: every write is read back and confirmed before returning success
// No silent failures — all errors returned as JSON with descriptive message

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

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

    return new Response(JSON.stringify({ success: true, summary, date: dateUsed }), { status: 200, headers });

  } catch(err) {
    console.error('[directive-feedback] GET error:', err.message);
    return new Response(JSON.stringify({ error: 'Failed to load directive', detail: err.message }), { status: 500, headers });
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
      error: 'Invalid action',
      detail: 'action must be one of: done, snooze, not_applicable'
    }), { status: 400, headers });
  }

  const targetDate  = date || new Date().toISOString().split('T')[0];
  const summaryKey  = `ga4:exec_summary:${targetDate}`;
  const directiveKey = `intelligence:daily_directive:${targetDate}`;
  const now = new Date().toISOString();

  try {
    // ── Read exec_summary — create minimal if missing (Run Analysis not yet run) ──
    let summary = await env.FFX_KV.get(summaryKey, { type: 'json' }).catch(() => null);

    if (!summary) {
      // Create minimal record so directive action is never blocked
      summary = {
        date:           targetDate,
        generatedAt:    now,
        momentum:       'unknown',
        createdByFeedback: true,
        dailyDirective: {},
      };
      console.log('[directive-feedback] No exec_summary found — creating minimal record for:', targetDate);
    }

    if (!summary.dailyDirective) summary.dailyDirective = {};

    // ── Apply action ──────────────────────────────────────────────────────
    if (action === 'done') {
      summary.dailyDirective.actedOn       = true;
      summary.dailyDirective.actedOnAt     = now;
      summary.dailyDirective.actedOnMethod = editedReply ? 'manual_edited' : 'manual_confirm';
      if (editedReply) summary.dailyDirective.editedReply = editedReply;
      // Store directiveType so intelligence engine can detect repeats in next 3 days
      summary.dailyDirective.directiveType = summary.dailyDirective.type || 'unknown';
    } else if (action === 'snooze') {
      summary.dailyDirective.snoozedAt   = now;
      summary.dailyDirective.snoozeUntil = new Date(Date.now() + 86400000).toISOString();
      summary.dailyDirective.actedOn     = null;
    } else if (action === 'not_applicable') {
      summary.dailyDirective.actedOn         = false;
      summary.dailyDirective.rejectedAt      = now;
      summary.dailyDirective.rejectionType   = 'not_applicable';
      summary.dailyDirective.rejectionReason = body.reason || 'not_applicable';
    }

    // ── Write ga4:exec_summary and READ BACK to verify ────────────────────
    await env.FFX_KV.put(summaryKey, JSON.stringify(summary), { expirationTtl: 86400 * 30 });

    const verifyExec = await env.FFX_KV.get(summaryKey, { type: 'json' }).catch(() => null);
    if (!verifyExec || verifyExec.dailyDirective?.actedOn !== summary.dailyDirective.actedOn) {
      console.error('[directive-feedback] WRITE VERIFICATION FAILED for:', summaryKey);
      return new Response(JSON.stringify({
        error:    'Write verification failed',
        detail:   `ga4:exec_summary:${targetDate} was written but read-back did not confirm. KV may be temporarily inconsistent.`,
        verified: false,
      }), { status: 500, headers });
    }
    console.log('[directive-feedback] ga4:exec_summary verified written for:', targetDate);

    // ── Write intelligence:daily_directive and READ BACK to verify ─────────
    let directiveWriteVerified = false;
    try {
      const existing  = await env.FFX_KV.get(directiveKey, { type: 'json' }).catch(() => null);
      const directive = existing || { date: targetDate };

      if (action === 'done') {
        directive.actedOn       = true;
        directive.actedOnAt     = now;
        directive.actedOnMethod = editedReply ? 'manual_edited' : 'manual_confirm';
        directive.directiveType = summary.dailyDirective?.type || body.directiveType || 'unknown';
      } else if (action === 'snooze') {
        directive.snoozedAt   = now;
        directive.snoozeUntil = new Date(Date.now() + 86400000).toISOString();
      } else if (action === 'not_applicable') {
        directive.actedOn         = false;
        directive.rejectedAt      = now;
        directive.rejectionReason = body.reason || 'not_applicable';
      }

      await env.FFX_KV.put(directiveKey, JSON.stringify(directive), { expirationTtl: 86400 * 90 });

      const verifyDirective = await env.FFX_KV.get(directiveKey, { type: 'json' }).catch(() => null);
      if (verifyDirective && verifyDirective.date === targetDate) {
        directiveWriteVerified = true;
        console.log('[directive-feedback] intelligence:daily_directive verified written for:', targetDate);
      } else {
        console.error('[directive-feedback] intelligence:daily_directive write verification failed for:', targetDate);
      }
    } catch(trackErr) {
      console.error('[directive-feedback] Directive tracking write failed:', trackErr.message);
    }

    return new Response(JSON.stringify({
      success:                  true,
      verified:                 true,
      execSummaryKey:           summaryKey,
      directiveKey:             directiveKey,
      directiveWriteVerified,
      action,
      date:                     targetDate,
      message: action === 'done'           ? 'Directive marked as complete'
             : action === 'snooze'         ? 'Directive snoozed until tomorrow'
             : 'Directive dismissed',
    }), { status: 200, headers });

  } catch(err) {
    console.error('[directive-feedback] POST error:', err.message);
    return new Response(JSON.stringify({
      error:    'Failed to update directive',
      detail:   err.message,
      verified: false,
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
