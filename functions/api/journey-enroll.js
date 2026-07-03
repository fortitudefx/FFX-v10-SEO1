// functions/api/journey-enroll.js
// ─────────────────────────────────────────────────────────────────────────────
// Enroll legacy Brevo List-4 contacts into the onboarding sequence by setting
// their FFX_JOINED_DATE to TOMORROW, so the daily 03:00 UTC cron sends them
// Day 1 on its next run (then Day 2, ... Day 7, then framework) automatically.
//
// WHY TOMORROW (not today): the cron computes
//     dayNum = floor((now - FFX_JOINED_DATE) / 1 day) + 1
// so Day 1 (dayNum=1) is only "due" while daysSince==0. The next cron run is
// tomorrow 03:00 UTC; for dayNum==1 THEN, FFX_JOINED_DATE must be tomorrow's date.
// (join=today would make tomorrow's run dayNum=2 and silently skip Day 1.)
//
// WHERE the journey start lives: FFX_JOINED_DATE is a BREVO contact attribute —
// the cron reads it from Brevo, not KV. So enrollment WRITES to Brevo. KV is used
// only for an idempotency marker (journey:enrolled:{email}).
//
//   GET  /api/journey-enroll            → DRY-RUN. Computes the plan. Writes NOTHING.
//   POST /api/journey-enroll?key=<TOKEN> → EXECUTE. Sets FFX_JOINED_DATE (Brevo) +
//                                          writes the KV enrollment marker.
//
// Idempotent: a contact is SKIPPED if it already has an email:log send record
// (mid-sequence) OR a journey:enrolled marker (already set up). Safe to run twice.
// Sends NO email — the cron does that, tomorrow.
// ─────────────────────────────────────────────────────────────────────────────

const BREVO_LIST_ID = 4;
const ENROLL_KEY    = 'ffx-enroll-2026-07';

function tomorrowISO() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function json(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// All identifier segments (lowercased) that exist under a KV prefix, e.g.
// "email:log:{email}:{day}" -> email ; "journey:enrolled:{email}" -> email.
async function listIdsUnderPrefix(env, prefix) {
  const set = new Set();
  let cursor;
  do {
    const res = await env.FFX_KV.list({ prefix: prefix, cursor: cursor, limit: 1000 });
    for (const k of res.keys) {
      const rest = k.name.slice(prefix.length);
      const ci   = rest.indexOf(':');
      set.add((ci === -1 ? rest : rest.slice(0, ci)).toLowerCase());
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return set;
}

async function getAllContacts(env) {
  const contacts = [];
  let offset = 0; const limit = 500; let more = true;
  while (more) {
    const r = await fetch(
      'https://api.brevo.com/v3/contacts?limit=' + limit + '&offset=' + offset + '&listId=' + BREVO_LIST_ID,
      { headers: { 'api-key': env.BREVO_API_KEY, 'accept': 'application/json' } }
    );
    if (!r.ok) throw new Error('Brevo list fetch failed: ' + r.status);
    const data  = await r.json();
    const batch = data.contacts || [];
    for (let i = 0; i < batch.length; i++) contacts.push(batch[i]);
    if (batch.length < limit) more = false; else offset += limit;
  }
  return contacts;
}

async function run(context, execute) {
  const env = context.env;
  if (!env.FFX_KV)        return json({ error: 'FFX_KV not bound' }, 500);
  if (!env.BREVO_API_KEY) return json({ error: 'BREVO_API_KEY not set' }, 500);

  const joinDate  = tomorrowISO();
  const sentSet     = await listIdsUnderPrefix(env, 'email:log:');
  const enrolledSet = await listIdsUnderPrefix(env, 'journey:enrolled:');
  const contacts  = await getAllContacts(env);

  const plan = [];
  for (let i = 0; i < contacts.length; i++) {
    const c       = contacts[i];
    const a       = c.attributes || {};
    const email   = c.email || '';
    const emailLc = String(email).toLowerCase();

    let action = 'ENROLL';
    if (sentSet.has(emailLc))          action = 'SKIP — has email:log (mid-sequence)';
    else if (enrolledSet.has(emailLc)) action = 'SKIP — already enrolled';

    // First-name-only greeting (mirrors the worker fix: split FIRSTNAME to 1st token)
    const rawFirst     = a.FIRSTNAME || '';
    const greetingName = (rawFirst.trim().split(/\s+/)[0]) || 'there';
    const row = {
      name:             [a.FIRSTNAME, a.LASTNAME].filter(Boolean).join(' ').trim() || '—',
      email:            email,
      path:             a.FFX_PATH || 'Free (default)',
      rawFirstName:     rawFirst || '(none)',
      greetingWouldBe:  'Hi ' + greetingName + ',',
      multiWordFirst:   rawFirst.trim().split(/\s+/).length > 1,
      currentPosition:  (sentSet.has(emailLc) ? 'in sequence' : 'Not started'),
      currentJoinDate:  a.FFX_JOINED_DATE || '(none)',
      wouldSetJoinDate: joinDate,
      action:           action,
      executed:         false
    };

    if (execute && action === 'ENROLL') {
      const put = await fetch('https://api.brevo.com/v3/contacts/' + encodeURIComponent(email), {
        method: 'PUT',
        headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ attributes: { FFX_JOINED_DATE: joinDate } })
      });
      if (put.ok || put.status === 204) {
        await env.FFX_KV.put('journey:enrolled:' + emailLc,
          JSON.stringify({ enrolledAt: new Date().toISOString(), joinDate: joinDate }));
        row.executed = true;
      } else {
        row.action = 'FAILED — Brevo PUT ' + put.status;
      }
    }
    plan.push(row);
  }

  const toEnroll = plan.filter(function (r) { return r.action === 'ENROLL'; }).length;
  return json({
    mode:            execute ? 'EXECUTE' : 'DRY-RUN',
    ranAt:           new Date().toISOString(),
    targetJoinDate:  joinDate,
    note:            'FFX_JOINED_DATE=' + joinDate + ' (tomorrow) → the ' + joinDate + ' 03:00 UTC cron sends Day 1. No email sent now.',
    totalContacts:   contacts.length,
    wouldEnroll:     toEnroll,
    wouldSkip:       plan.length - toEnroll,
    multiWordFirstNames: plan.filter(function (r) { return r.multiWordFirst; }).length,
    executedCount:   plan.filter(function (r) { return r.executed; }).length,
    plan:            plan
  }, 200);
}

export async function onRequestGet(context) {
  // DRY-RUN only — never writes.
  return run(context, false);
}

export async function onRequestPost(context) {
  const url = new URL(context.request.url);
  if (url.searchParams.get('key') !== ENROLL_KEY) return json({ error: 'forbidden — execute requires ?key=' }, 403);
  return run(context, true);
}
