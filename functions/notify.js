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

  const { jobId, videoId, youtubeUrl, title } = body;
  if (!jobId) {
    return new Response(JSON.stringify({ error: 'jobId is required' }), { status: 400, headers });
  }

  console.log('[FFX Notify] Sending press link for job:', jobId);

  // Link opens FFX Press with job pre-loaded
  const pressLink = `https://fortitudefx.com/press?job=${jobId}`;

  const emailHtml = `<p>Your content is ready for review.</p>
${title ? `<p><strong>${title}</strong></p>` : ''}
${youtubeUrl ? `<p><strong>Video:</strong> <a href="${youtubeUrl}">${youtubeUrl}</a></p>` : ''}
<p><a href="${pressLink}" style="font-size:18px;font-weight:bold;">Review &amp; Publish &rarr;</a></p>
<p style="color:#999;font-size:12px;">${pressLink}</p>
<p style="color:#999;font-size:11px;">This link is valid for 24 hours.</p>`;

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
      subject: `FFX — Content Ready for Review`,
      htmlContent: emailHtml,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.log('[FFX Notify] Brevo failed:', err);
    return new Response(JSON.stringify({ error: `Email failed: ${res.status}` }), { status: 502, headers });
  }

  console.log('[FFX Notify] Email sent successfully');
  return new Response(JSON.stringify({ success: true, pressLink }), { status: 200, headers });
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
