// functions/api/journey-status.js
// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY data source for the Email Journey dashboard.
//
// Reads TWO sources and joins them per contact:
//   1. Brevo List 4 — the contact list (FIRSTNAME/LASTNAME, email, FFX_PATH,
//      FFX_JOINED_DATE).  [same list the sequence worker reads]
//   2. KV email:log:{email}:{dayNum} — what has ACTUALLY been sent to each
//      person. dayNum is 1..7 (onboarding) or "fw:{week}:{emailNum}" (framework).
//
// Journey position (from what was actually sent):
//   - framework record present  → "Framework Week N" (highest week)
//   - onboarding record present → "Onboarding Day N" (highest day 1-7)
//   - no send record at all      → "Not started" (in Brevo, never sent — legacy)
//
// STRICTLY READ-ONLY: only env.FFX_KV.list (key names) + Brevo GET. Writes nothing,
// sends nothing. Idempotency/state keys are never touched.
// ─────────────────────────────────────────────────────────────────────────────

const BREVO_LIST_ID = 4;

export async function onRequestGet(context) {
  const env = context.env;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!env.FFX_KV)        return json({ error: 'FFX_KV not bound' }, 500, headers);
  if (!env.BREVO_API_KEY) return json({ error: 'BREVO_API_KEY not set' }, 500, headers);

  try {
    // ── 1. All send records from KV (one paginated list of KEY NAMES only) ──────
    // email -> { onboarding:Set<day>, framework:Set<week>, count }
    const sends = {};
    let cursor;
    do {
      const res = await env.FFX_KV.list({ prefix: 'email:log:', cursor: cursor, limit: 1000 });
      for (const k of res.keys) {
        const rest = k.name.slice('email:log:'.length); // "{email}:{dayNum}"
        const ci = rest.indexOf(':');                    // email has no ':'
        if (ci === -1) continue;
        const email  = rest.slice(0, ci).toLowerCase();
        const dayNum = rest.slice(ci + 1);
        if (!sends[email]) sends[email] = { onboarding: new Set(), framework: new Set(), count: 0 };
        sends[email].count++;
        if (dayNum.indexOf('fw:') === 0) {
          const wk = parseInt(dayNum.split(':')[1], 10);
          if (!isNaN(wk)) sends[email].framework.add(wk);
        } else {
          const d = parseInt(dayNum, 10);
          if (!isNaN(d)) sends[email].onboarding.add(d);
        }
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);

    // ── 2. All contacts from Brevo List 4 (paginated) ───────────────────────────
    const contacts = [];
    let offset = 0; const limit = 500; let more = true;
    while (more) {
      const r = await fetch(
        'https://api.brevo.com/v3/contacts?limit=' + limit + '&offset=' + offset + '&listId=' + BREVO_LIST_ID,
        { headers: { 'api-key': env.BREVO_API_KEY, 'accept': 'application/json' } }
      );
      if (!r.ok) {
        const t = await r.text().catch(function(){ return ''; });
        return json({ error: 'Brevo fetch failed: ' + r.status, detail: t.slice(0, 200) }, 502, headers);
      }
      const data  = await r.json();
      const batch = data.contacts || [];
      for (let i = 0; i < batch.length; i++) contacts.push(batch[i]);
      if (batch.length < limit) more = false; else offset += limit;
    }

    // ── 3. Join + compute journey position per contact ──────────────────────────
    const rows = contacts.map(function (c) {
      const a     = c.attributes || {};
      const email = String(c.email || '').toLowerCase();
      const s     = sends[email];
      let position = 'Not started';
      let sent = 0;
      if (s && s.count > 0) {
        sent = s.count;
        if (s.framework.size > 0)       position = 'Framework Week ' + Math.max.apply(null, Array.from(s.framework));
        else if (s.onboarding.size > 0) position = 'Onboarding Day ' + Math.max.apply(null, Array.from(s.onboarding));
      }
      return {
        name:       [a.FIRSTNAME, a.LASTNAME].filter(Boolean).join(' ').trim() || '—',
        email:      c.email || '',
        path:       a.FFX_PATH || '—',
        position:   position,
        emailsSent: sent,
        joinedDate: a.FFX_JOINED_DATE || ''
      };
    });

    // Newest join date on top; blank dates sink to the bottom; name as tiebreak.
    rows.sort(function (x, y) {
      const c = String(y.joinedDate).localeCompare(String(x.joinedDate));
      return c !== 0 ? c : String(x.name).localeCompare(String(y.name));
    });

    const counts = {
      total:      rows.length,
      notStarted: rows.filter(function (r){ return r.position === 'Not started'; }).length,
      onboarding: rows.filter(function (r){ return r.position.indexOf('Onboarding') === 0; }).length,
      framework:  rows.filter(function (r){ return r.position.indexOf('Framework') === 0; }).length
    };

    return json({ pulledAt: new Date().toISOString(), counts: counts, contacts: rows }, 200, headers);

  } catch (err) {
    return json({ error: err.message }, 500, headers);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }});
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status, headers: headers });
}
