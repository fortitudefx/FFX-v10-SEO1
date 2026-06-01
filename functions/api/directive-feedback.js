// functions/api/directive-feedback.js
// POST /api/directive-feedback — records that a directive was acted on
// Writes to intelligence:brief_log:{date} and intelligence:directive_outcome

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const { date, directiveType, actedOn } = body;
  if (!date || !directiveType) {
    return json({ error: 'date and directiveType are required' }, 400, headers);
  }

  const today = date || new Date().toISOString().split('T')[0];

  try {
    // Update intelligence:brief_log:{date} — mark recommendation actedOn
    try {
      const briefLog = await env.FFX_KV.get('intelligence:brief_log:' + today, { type: 'json' }).catch(function(){ return null; });
      if (briefLog && Array.isArray(briefLog.recommendations)) {
        briefLog.recommendations.forEach(function(rec) {
          if (rec.type === directiveType || rec.type === 'priority_action') {
            rec.actedOn    = true;
            rec.actedOnAt  = new Date().toISOString();
          }
        });
        await env.FFX_KV.put('intelligence:brief_log:' + today, JSON.stringify(briefLog));
      }
    } catch(logErr) {
      console.error('[directive-feedback] brief_log update failed (non-fatal):', logErr.message);
    }

    // Write directive outcome record for feedback loop
    const outcomeKey = 'intelligence:directive_outcome:' + today + ':' + directiveType;
    const existing   = await env.FFX_KV.get(outcomeKey, { type: 'json' }).catch(function(){ return null; });

    const outcome = existing || {
      directiveType,
      actedOn:   false,
      actedOnAt: null,
      outcome:   null,
      accurate:  null,
    };

    outcome.actedOn   = !!actedOn;
    outcome.actedOnAt = new Date().toISOString();
    outcome.date      = today;

    await env.FFX_KV.put(outcomeKey, JSON.stringify(outcome));
    console.log('[directive-feedback] Written:', directiveType, 'actedOn:', actedOn);

    return json({ success: true, directiveType, date: today }, 200, headers);

  } catch(err) {
    console.error('[directive-feedback] Error:', err.message);
    return json({ error: err.message }, 500, headers);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
