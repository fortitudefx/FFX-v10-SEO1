// Cloudflare Pages Function — FortitudeFX Brevo integration
// File location in your repo: /functions/submit.js
//
// Called by waitlist.html via fetch('/functions/submit')
// The BREVO_API_KEY is stored in Cloudflare Pages → Settings → Environment Variables

export async function onRequestPost(context) {
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const BREVO_API_KEY = context.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    return new Response('Server configuration error', { status: 500 });
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key':      BREVO_API_KEY
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {// Cloudflare Pages Function — FortitudeFX Brevo integration
// File location in your repo: /functions/submit.js
//
// Handles:
//   - Turnstile token verification (TURNSTILE_SECRET_KEY env var)
//   - Brevo contact creation with firstName, lastName, FFX_PATH (BREVO_API_KEY env var)
//   - List ID 4 (FFX master list)
//   - Duplicate contact handling (Brevo 204 = already exists, treated as success)

export async function onRequestPost(context) {

  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const { firstName, lastName, email, path, turnstileToken } = payload;

  // ── 2. Basic field validation ──────────────────────────────────────────────
  if (!firstName || !email || !path) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  // ── 3. Turnstile verification ──────────────────────────────────────────────
  const TURNSTILE_SECRET_KEY = context.env.TURNSTILE_SECRET_KEY;
  if (!TURNSTILE_SECRET_KEY) {
    return json({ error: 'Server configuration error.' }, 500);
  }

  if (!turnstileToken) {
    return json({ error: 'Security check required. Please complete the verification.' }, 400);
  }

  const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret:   TURNSTILE_SECRET_KEY,
      response: turnstileToken,
      remoteip: context.request.headers.get('CF-Connecting-IP') ?? undefined
    })
  });

  const tsData = await tsRes.json().catch(() => ({}));
  if (!tsData.success) {
    return json({ error: 'Security check failed. Please try again.' }, 400);
  }

  // ── 4. Brevo contact creation ──────────────────────────────────────────────
  const BREVO_API_KEY = context.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    return json({ error: 'Server configuration error.' }, 500);
  }

  const brevoBody = {
    email,
    attributes: {
      FIRSTNAME: firstName,
      LASTNAME:  lastName ?? '',
      FFX_PATH:  path
    },
    listIds:          [4],
    updateEnabled:    true   // update existing contact instead of erroring
  };

  try {
    const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key':      BREVO_API_KEY
      },
      body: JSON.stringify(brevoBody)
    });

    // 201 = created, 204 = already exists (updateEnabled updates them)
    if (brevoRes.status === 201 || brevoRes.status === 204) {
      return json({ success: true }, 200);
    }

    const brevoData = await brevoRes.json().catch(() => ({}));
    return json({ error: brevoData.message ?? 'Could not save your details. Please try again.' }, brevoRes.status);

  } catch (err) {
    return json({ error: 'Network error. Please try again.' }, 500);
  }
}

// ── Helper ───────────────────────────────────────────────────────────────────
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
      return new Response(
        JSON.stringify({ message: data.message ?? 'Brevo error' }),
        { status: res.status, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ message: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
