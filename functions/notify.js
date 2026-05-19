// ─────────────────────────────────────────────────────────────────────────────
// FFX Notify
// POST /notify → checks KV first → sends email if content exists
//              → queues generation if content not ready
// Email sent here if content exists, by consumer if generation needed
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

  // ── CHECK 1: Content already in KV — send email immediately, skip generation
  try {
    const existing = await env.FFX_KV.get(`video:${videoId}`, { type: 'json' });
    if (existing) {
      console.log('[FFX Notify] Content already in KV — sending email directly');
      const title = existing.title || '';
      await sendEmail(env, youtubeUrl, videoId, title);
      return new Response(JSON.stringify({
        success: true,
        message: 'Content already ready — email sent now'
      }), { status: 200, headers });
    }
  } catch (err) {
    console.error('[FFX Notify] KV check failed:', err.message);
  }

  // ── CHECK 2: Lock — same video already generating
  try {
    const lock = await env.FFX_KV.get('lock:generating');
    if (lock) {
      const lockData = JSON.parse(lock);
      if (lockData.videoId === videoId) {
        return new Response(JSON.stringify({
          success: true,
          message: 'Generation already in progress — email will arrive when content is ready (2-3 minutes)'
        }), { status: 200, headers });
      }
      return new Response(JSON.stringify({
        error: 'Another video is currently being generated. Please wait a few minutes and try again.'
      }), { status: 429, headers });
    }
  } catch {}

  // ── QUEUE: Content not ready, no lock — queue fresh generation
  const jobId = `${Date.now()}-${videoId}`;

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

  try {
    await env.ffx_generate_queue.send({ jobId, videoId, youtubeUrl, existingSlug: null });
    console.log('[FFX Notify] Job queued:', jobId, '— consumer will send email on completion');
  } catch (err) {
    console.error('[FFX Notify] Queue send failed:', err.message);
    try { await env.FFX_KV.delete(`job:${jobId}`); } catch {}
    return new Response(JSON.stringify({ error: 'Failed to queue generation. Try again.' }), { status: 500, headers });
  }

  return new Response(JSON.stringify({
    success: true,
    message: 'Generation started — email will arrive when content is ready (2-3 minutes)'
  }), { status: 200, headers });
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
// Called when content already exists in KV — guaranteed ready
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail(env, youtubeUrl, videoId, videoTitle) {
  if (!env.BREVO_API_KEY) throw new Error('BREVO_API_KEY not set');
  if (!env.APPROVAL_EMAIL) throw new Error('APPROVAL_EMAIL not set');

  const pressLink = `https://fortitudefx.com/press?video=${videoId}`;
  const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

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
  <p style="font-size:14px;color:#b8b8b8;margin:0 0 24px;line-height:1.6;">Global + Regional articles generated. All platforms ready. Open Press to review and publish.</p>

  <a href="${youtubeUrl}" style="display:block;margin-bottom:24px;border-radius:8px;overflow:hidden;text-decoration:none;">
    <img src="${thumbnailUrl}" alt="${videoTitle || 'Video thumbnail'}" style="width:100%;display:block;border-radius:8px;" />
  </a>

  <p style="font-size:15px;font-weight:600;color:#ffffff;margin:0 0 24px;">${videoTitle || ''}</p>

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
      subject: `FFX — Content Ready · Expires ${expiryStr}`,
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
