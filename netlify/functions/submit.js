// Netlify serverless function — FortitudeFX Brevo integration
// Sits at /.netlify/functions/submit
// Called by waitlist-v10.html instead of hitting Brevo directly.
// The BREVO_API_KEY is stored in Netlify environment variables — never in source code.

exports.handler = async function(event) {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    return { statusCode: 500, body: 'Server configuration error' };
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

    if (!res.ok) {
      return {
        statusCode: res.status,
        body: JSON.stringify({ message: data.message ?? 'Brevo error' })
      };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ message: err.message }) };
  }
};
