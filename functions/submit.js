// Cloudflare Pages Function - FortitudeFX Brevo integration
// File: /functions/submit.js
// Handles: Turnstile verification + Brevo contact creation (list 4)

export async function onRequestPost(context) {

  // 1. Parse body
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const { firstName, lastName, email, path, turnstileToken } = payload;

  // 2. Basic field validation
  if (!firstName || !email || !path) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  // 3. Turnstile verification
  // IMPORTANT: Cloudflare siteverify requires application/x-www-form-urlencoded not JSON
  const TURNSTILE_SECRET_KEY = context.env.TURNSTILE_SECRET_KEY;
  if (!TURNSTILE_SECRET_KEY) {
    return json({ error: 'Server configuration error.' }, 500);
  }

  if (!turnstileToken) {
    return json({ error: 'Security check required. Please complete the verification.' }, 400);
  }

  const formData = new URLSearchParams();
  formData.append('secret', TURNSTILE_SECRET_KEY);
  formData.append('response', turnstileToken);
  const ip = context.request.headers.get('CF-Connecting-IP');
  if (ip) formData.append('remoteip', ip);

  const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString()
  });

  const tsData = await tsRes.json().catch(() => ({}));
  if (!tsData.success) {
    return json({ error: 'Security check failed. Please try again.' }, 400);
  }

  // 4. Brevo contact creation
  const BREVO_API_KEY = context.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    return json({ error: 'Server configuration error.' }, 500);
  }

  const brevoBody = {
    email,
    attributes: {
      FIRSTNAME: firstName,
      LASTNAME:  lastName || '',
      FFX_PATH:  path
    },
    listIds:       [4],
    updateEnabled: true
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

    // 201 = created, 204 = already exists (updated)
    if (brevoRes.status === 201 || brevoRes.status === 204) {
      return json({ success: true }, 200);
    }

    const brevoData = await brevoRes.json().catch(() => ({}));
    return json({ error: brevoData.message || 'Could not save your details. Please try again.' }, brevoRes.status);

  } catch (err) {
    return json({ error: 'Network error. Please try again.' }, 500);
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
