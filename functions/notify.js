// ─────────────────────────────────────────────────────────────────────────────
// FFX Notify Worker
// POST /notify → sends reminder email with pre-filled generate link
// Used by: notify.html (manual testing) and Cron (automatic, future)
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { youtubeUrl, note } = body;
  if (!youtubeUrl) {
    return new Response(JSON.stringify({ error: 'youtubeUrl is required' }), { status: 400, headers });
  }

  console.log('[FFX Notify] Sending reminder for:', youtubeUrl);

  // Generate link to generate.html with URL pre-filled
  const generateLink = `https://fortitudefx.com/generate?url=${encodeURIComponent(youtubeUrl)}`;

  const emailHtml = `<p>Time to publish a new video.</p>
<p><strong>Video:</strong> <a href="${youtubeUrl}">${youtubeUrl}</a></p>
<p><a href="${generateLink}" style="font-size:18px;font-weight:bold;">Open Generate &amp; Publish &rarr;</a></p>
<p style="color:#999;font-size:12px;">${generateLink}</p>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: 'FortitudeFX', email: 'salmankhanfx@fortitudefx.com' },
      to: [{ email: env.APPROVAL_EMAIL }],
      replyTo: { email: 'support@fortitudefx.com' },
      subject: `FFX — Time to Publish`,
      htmlContent: emailHtml,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.log('[FFX Notify] Brevo failed:', err);
    return new Response(JSON.stringify({ error: `Email failed: ${res.status}` }), { status: 502, headers });
  }

  console.log('[FFX Notify] Email sent successfully');
  return new Response(JSON.stringify({ success: true, generateLink }), { status: 200, headers });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
