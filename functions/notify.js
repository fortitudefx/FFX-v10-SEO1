// ─────────────────────────────────────────────────────────────────────────────
// FFX Notify
// POST /notify → triggers generation via queue → sends email with Press link
// Accepts: { youtubeUrl }
// Used by: notify.html (manual) and Cron (future)
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

  const { youtubeUrl } = body;
  if (!youtubeUrl) {
    return new Response(JSON.stringify({ error: 'youtubeUrl is required' }), { status: 400, headers });
  }

  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    return new Response(JSON.stringify({ error: 'Could not parse YouTube video ID from URL' }), { status: 400, headers });
  }

  console.log('[FFX Notify] Received youtubeUrl:', youtubeUrl, 'videoId:', videoId);

  // Check for existing generating lock
  try {
    const lock = await env.FFX_KV.get('lock:generating');
    if (lock) {
      const lockData = JSON.parse(lock);
      if (lockData.videoId === videoId) {
        // Same video already generating — send email with existing jobId
        const pressLink = `https://fortitudefx.com/press?job=${lockData.jobId}`;
        await sendEmail(env, youtubeUrl, lockData.jobId, pressLink);
        return new Response(JSON.stringify({
          success: true,
          pressLink,
          message: 'Generation already in progress — email sent with existing job link'
        }), { status: 200, headers });
      }
      return new Response(JSON.stringify({
        error: 'Another video is currently being generated. Please wait a few minutes and try again.'
      }), { status: 429, headers });
    }
  } catch {}

  // Generate jobId
  const jobId = `${Date.now()}-${videoId}`;

  // Write pending job to KV — 24hr TTL
  try {
    await env.FFX_KV.put(
      `job:${jobId}`,
      JSON.stringify({ status: 'pending', videoId, createdAt: new Date().toISOString() }),
      { expirationTtl: 86400 }
    );
  } catch (err) {
    console.error('[FFX Notify] KV job write failed:', err.message);
    return new Response(JSON.stringify({ error: 'Failed to create job. Try again.' }), { status: 500, headers });
  }

  // Send to queue
  try {
    await env.ffx_generate_queue.send({
      jobId,
      videoId,
      youtubeUrl,
      existingSlug: null,
    });
    console.log('[FFX Notify] Job queued:', jobId);
  } catch (err) {
    console.error('[FFX Notify] Queue send failed:', err.message);
    try { await env.FFX_KV.delete(`job:${jobId}`); } catch {}
    return new Response(JSON.stringify({ error: 'Failed to queue generation. Try again.' }), { status: 500, headers });
  }

  // Send email with Press link
  const pressLink = `https://fortitudefx.com/press?job=${jobId}`;
  try {
    await sendEmail(env, youtubeUrl, jobId, pressLink);
  } catch (err) {
    console.error('[FFX Notify] Email failed:', err.message);
    // Job is already queued — generation will run even if email fails
    return new Response(JSON.stringify({
      error: `Generation queued but email failed: ${err.message}. Check Brevo.`
    }), { status: 502, headers });
  }

  console.log('[FFX Notify] Done — job queued and email sent');
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

// ─────────────────────────────────────────────────────────────────────────────
// SEND EMAIL via Brevo
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail(env, youtubeUrl, jobId, pressLink) {
  // Calculate expiry — 24 hours from now
  const expiry = new Date(Date.now() + 86400000);
  const expiryStr = expiry.toLocaleString('en-GB', {
    timeZone: 'Asia/Dubai',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  const emailHtml = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#0c0c0c;color:#e8e8e8;padding:40px 32px;border-radius:8px;">
  <div style="font-family:'Courier New',monospace;font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#787878;margin-bottom:24px;">FortitudeFX™ — Internal</div>

  <h1 style="font-size:22px;font-weight:700;color:#ffffff;margin:0 0 8px;letter-spacing:-0.02em;">Content Ready for Review</h1>
  <p style="font-size:14px;color:#b8b8b8;margin:0 0 32px;line-height:1.6;">Global + Regional articles generated. All platforms ready. Open Press to review and publish.</p>

  ${youtubeUrl ? `<p style="font-size:13px;color:#787878;margin:0 0 24px;font-family:'Courier New',monospace;word-break:break-all;">Video: <a href="${youtubeUrl}" style="color:#6aa3d8;text-decoration:none;">${youtubeUrl}</a></p>` : ''}

  <a href="${pressLink}" style="display:block;background:#ffffff;color:#000000;text-align:center;padding:16px 24px;border-radius:6px;font-size:15px;font-weight:700;text-decoration:none;margin-bottom:24px;">Review &amp; Publish in FFX Press →</a>

  <p style="font-family:'Courier New',monospace;font-size:11px;color:#484848;word-break:break-all;margin:0 0 8px;">${pressLink}</p>
  <p style="font-size:12px;color:#484848;margin:0;">Expires: ${expiryStr}</p>
</div>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: 'FortitudeFX™', email: 'salmankhanfx@fortitudefx.com' },
      to: [{ email: env.APPROVAL_EMAIL }],
      replyTo: { email: 'support@fortitudefx.com' },
      subject: `FFX — Content Ready for Review`,
      htmlContent: emailHtml,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo ${res.status}: ${err}`);
  }

  console.log('[FFX Notify] Email sent to:', env.APPROVAL_EMAIL);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT VIDEO ID
// ─────────────────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const parts = u.pathname.split('/');
      const si = parts.indexOf('shorts');
      if (si !== -1) return parts[si + 1];
    }
  } catch {}
  return null;
}
