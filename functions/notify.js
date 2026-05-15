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

  const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f0f4;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f4;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,0.08);overflow:hidden;max-width:600px;width:100%;">

      <!-- Gradient stripe -->
      <tr><td style="height:7px;background:linear-gradient(90deg,#7c3aed,#f97316);font-size:0;line-height:0;">&nbsp;</td></tr>

      <!-- Hero header -->
      <tr><td style="background:#0a0a12;padding:32px 40px;">
        <!-- Logo row -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:middle;">
              <a href="https://fortitudefx.com" style="text-decoration:none;">
                <img src="https://fortitudefx.com/favicon-192x192.png" width="36" height="36" alt="FFX" style="border-radius:6px;vertical-align:middle;display:inline-block;border:0;">
                <span style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;letter-spacing:0.1em;vertical-align:middle;margin-left:10px;">FORTITUDEFX</span>
                <span style="font-family:Arial,sans-serif;font-size:11px;color:#9ca3af;letter-spacing:0.12em;vertical-align:middle;margin-left:8px;">CATCH THE WICK™</span>
              </a>
            </td>
          </tr>
        </table>

        <!-- Kicker pill -->
        <div style="margin-top:20px;">
          <span style="display:inline-block;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);border-radius:20px;padding:5px 14px;">
            <span style="display:inline-block;width:6px;height:6px;background:#7c3aed;border-radius:50%;vertical-align:middle;margin-right:8px;"></span>
            <span style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#a78bfa;letter-spacing:0.1em;vertical-align:middle;">CONTENT APPROVAL</span>
          </span>
        </div>

        <!-- Hero title + 2 Candles -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">Time to publish<br>new content</div>
              <div style="font-family:Arial,sans-serif;font-size:13px;color:#9ca3af;margin-top:8px;">Tap below to review and publish</div>
            </td>
            <td style="vertical-align:middle;text-align:right;width:140px;">
              <a href="https://fortitudefx.com" style="text-decoration:none;">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:400;color:#ffffff;line-height:1.2;">2 Candles.</div>
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:400;color:#f97316;line-height:1.2;">1 Story.</div>
              </a>
            </td>
          </tr>
        </table>

        <!-- Social icons -->
        <table cellpadding="0" cellspacing="0" style="margin-top:24px;">
          <tr>
            <td style="padding-right:8px;"><a href="https://youtube.com/@fortitudefx" style="text-decoration:none;display:inline-block;background:rgba(255,255,255,0.1);border-radius:6px;padding:7px 10px;line-height:0;"><img src="https://fortitudefx.com/email-icon-youtube.png" width="18" height="18" alt="YouTube" style="display:block;border:0;"></a></td>
            <td style="padding-right:8px;"><a href="https://instagram.com/fortitudefx" style="text-decoration:none;display:inline-block;background:rgba(255,255,255,0.1);border-radius:6px;padding:7px 10px;line-height:0;"><img src="https://fortitudefx.com/email-icon-instagram.png" width="18" height="18" alt="Instagram" style="display:block;border:0;"></a></td>
            <td style="padding-right:8px;"><a href="https://tiktok.com/@fortitudefx" style="text-decoration:none;display:inline-block;background:rgba(255,255,255,0.1);border-radius:6px;padding:7px 10px;line-height:0;"><img src="https://fortitudefx.com/email-icon-tiktok.png" width="18" height="18" alt="TikTok" style="display:block;border:0;"></a></td>
            <td><a href="https://x.com/fortitudefx" style="text-decoration:none;display:inline-block;background:rgba(255,255,255,0.1);border-radius:6px;padding:7px 10px;line-height:0;"><img src="https://fortitudefx.com/email-icon-x.png" width="18" height="18" alt="X" style="display:block;border:0;"></a></td>
          </tr>
        </table>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:36px 40px;">

        <!-- Video info -->
        <div style="background:#f8f9fa;border-radius:8px;padding:16px 20px;margin-bottom:28px;border-left:4px solid #7c3aed;">
          <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#9ca3af;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;">Video to publish</div>
          <a href="${youtubeUrl}" style="font-family:Arial,sans-serif;font-size:14px;color:#7c3aed;text-decoration:none;word-break:break-all;">${youtubeUrl}</a>
          ${note ? `<div style="font-family:Arial,sans-serif;font-size:13px;color:#555;margin-top:8px;">${note}</div>` : ''}
        </div>

        <!-- CTA Button -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center">
              <a href="${generateLink}" style="display:inline-block;background:#7c3aed;color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:700;text-decoration:none;padding:16px 48px;border-radius:8px;letter-spacing:0.02em;">Open Generate &amp; Publish →</a>
            </td>
          </tr>
        </table>

        <div style="margin-top:12px;text-align:center;">
          <a href="${generateLink}" style="font-family:Arial,sans-serif;font-size:12px;color:#9ca3af;text-decoration:none;word-break:break-all;">${generateLink}</div>
        </div>

        <!-- Sign off -->
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#444444;margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb;">
          — Salman / FortitudeFX
        </div>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f8f9fa;padding:20px 40px;border-top:1px solid #e5e7eb;">
        <div style="font-family:Arial,sans-serif;font-size:12px;color:#9ca3af;text-align:center;">
          <a href="https://fortitudefx.com/privacy" style="color:#9ca3af;text-decoration:underline;">Privacy Policy</a>
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

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
