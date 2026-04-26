// Cloudflare Pages Function — FortitudeFX Brevo integration
// File location in your repo: /functions/submit.js
//
// Called by waitlist.html via fetch('/functions/submit')
// The BREVO_API_KEY is stored in Cloudflare Pages → Settings → Environment Variables

export async function onRequest(context) {
  // Only allow POST
  if (context.request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Parse the incoming JSON body
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Pull API key from Cloudflare environment variables
  const BREVO_API_KEY = context.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    return new Response('Server configuration error', { status: 500 });
  }

  // Forward to Brevo
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

    if (!res.ok) {
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
