// Cloudflare Pages Function - FortitudeFX Brevo integration
// File: /functions/submit.js
// Used by: joinfree.html (path=Free), waitlist.html (path=VIP|Bootcamp), contact.html (path=Contact)

export async function onRequestPost(context) {

  // 1. Parse body
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const {
    firstName,
    lastName,
    email,
    path,
    turnstileToken,
    VIP_PLAN,
    VIP_PRICE,
    TRADING_STAGE,
    PROMO_CODE,
    NOTE,
    CONTACT_CATEGORY
  } = payload;

  // 2. Basic validation
  if (!firstName || !email || !path) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  // 3. Turnstile verification
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
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    formData.toString()
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

  const attributes = {
    FIRSTNAME: firstName,
    LASTNAME:  lastName || '',
    FFX_PATH:  path
  };

  if (VIP_PLAN)         attributes.VIP_PLAN         = VIP_PLAN;
  if (VIP_PRICE)        attributes.VIP_PRICE        = VIP_PRICE;
  if (TRADING_STAGE)    attributes.TRADING_STAGE    = TRADING_STAGE;
  if (NOTE)             attributes.NOTE             = NOTE;
  if (PROMO_CODE)       attributes.PROMO_CODE       = PROMO_CODE;
  if (CONTACT_CATEGORY) attributes.CONTACT_CATEGORY = CONTACT_CATEGORY;

  const brevoBody = {
    email,
    attributes,
    listIds:       [4],
    updateEnabled: true
  };

  try {
    const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body:    JSON.stringify(brevoBody)
    });

    if (brevoRes.status !== 201 && brevoRes.status !== 204) {
      const brevoData = await brevoRes.json().catch(() => ({}));
      return json({ error: brevoData.message || 'Could not save your details. Please try again.' }, brevoRes.status);
    }
  } catch (err) {
    return json({ error: 'Network error. Please try again.' }, 500);
  }

  // 5. Send confirmation emails via Brevo SMTP API
  // All emails non-blocking - contact already saved above

  // Helper to send via Brevo transactional API
  async function sendEmail(to, toName, subject, htmlContent, replyToEmail, replyToName) {
    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
        body:    JSON.stringify({
          sender:  { name: 'Salman | FortitudeFX', email: 'salmankhanfx@fortitudefx.com' },
          to:      [{ email: to, name: toName }],
          replyTo: { email: replyToEmail || 'support@fortitudefx.com', name: replyToName || 'FortitudeFX Support' },
          subject,
          htmlContent
        })
      });
    } catch (err) {
      // Silent fail - contact already saved
    }
  }

  // 5a. Join Free - welcome email to user
  if (path === 'Free') {
    const welcomeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You're in. Welcome to FortitudeFX.</title>
</head>
<body style="margin:0;padding:0;background-color:#06060a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#06060a;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#0d0d14;border-radius:16px;border:1px solid rgba(122,92,255,0.20);overflow:hidden;">
          <tr><td style="height:3px;background:linear-gradient(90deg,#7a5cff,#e06b1a);font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td style="padding:40px 48px 32px;border-bottom:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a5cff;">FORTITUDEFX</p>
              <p style="margin:6px 0 0;font-family:Arial,sans-serif;font-size:11px;color:rgba(255,255,255,0.35);letter-spacing:0.06em;">CATCH THE WICK</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 48px;">
              <p style="margin:0 0 28px;font-family:Arial,sans-serif;font-size:26px;font-weight:700;color:#ffffff;line-height:1.2;">Hi ${firstName},</p>
              <p style="margin:0 0 20px;font-family:Arial,sans-serif;font-size:16px;color:rgba(255,255,255,0.75);line-height:1.75;">You just joined a community built around one idea &mdash; that trading should be mechanical, not emotional. Structure over instinct. Execution over hope.</p>
              <p style="margin:0 0 32px;font-family:Arial,sans-serif;font-size:16px;color:rgba(255,255,255,0.75);line-height:1.75;">The FortitudeFX Discord is where that idea lives daily. Real markets. Real markups. The Catch The Wick framework applied session by session, in real time.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;"><tr><td style="height:1px;background:rgba(255,255,255,0.08);font-size:0;line-height:0;">&nbsp;</td></tr></table>
              <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:16px;color:rgba(255,255,255,0.75);line-height:1.75;">Your access is active. Click below to join.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:40px;">
                <tr>
                  <td style="border-radius:999px;background-color:#e06b1a;">
                    <a href="https://discord.com/invite/fWAPJdR8TR" target="_blank" style="display:inline-block;padding:14px 36px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.03em;">Join the Discord &rarr;</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;"><tr><td style="height:1px;background:rgba(255,255,255,0.08);font-size:0;line-height:0;">&nbsp;</td></tr></table>
              <p style="margin:0 0 32px;font-family:Arial,sans-serif;font-size:15px;color:rgba(255,255,255,0.45);line-height:1.7;">If you ever have a question, reply to this email directly. We read everything.</p>
              <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:16px;color:#ffffff;font-weight:600;">&#8212; Salman</p>
              <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:rgba(255,255,255,0.40);">FortitudeFX</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 48px;border-top:1px solid rgba(255,255,255,0.06);background-color:#0a0a12;">
              <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:11px;color:rgba(255,255,255,0.25);line-height:1.6;">You are receiving this email because you joined the FortitudeFX free community at <a href="https://fortitudefx.com/joinfree" style="color:rgba(122,92,255,0.6);text-decoration:none;">fortitudefx.com</a>.</p>
              <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:rgba(255,255,255,0.25);">&copy; 2026 FortitudeFX. Dubai, UAE.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await sendEmail(
      email,
      firstName,
      "You're in. Welcome to FortitudeFX.",
      welcomeHtml,
      'support@fortitudefx.com',
      'Salman | FortitudeFX'
    );
  }

  // 5b. Contact form - acknowledgement to user + notification to Salman
  if (path === 'Contact') {

    // Acknowledgement to user
    const contactAckHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Got your message.</title>
</head>
<body style="margin:0;padding:0;background-color:#06060a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#06060a;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#0d0d14;border-radius:16px;border:1px solid rgba(122,92,255,0.20);overflow:hidden;">
          <tr><td style="height:3px;background:linear-gradient(90deg,#7a5cff,#e06b1a);font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td style="padding:40px 48px 32px;border-bottom:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a5cff;">FORTITUDEFX</p>
              <p style="margin:6px 0 0;font-family:Arial,sans-serif;font-size:11px;color:rgba(255,255,255,0.35);letter-spacing:0.06em;">CATCH THE WICK</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 48px;">
              <p style="margin:0 0 28px;font-family:Arial,sans-serif;font-size:26px;font-weight:700;color:#ffffff;line-height:1.2;">Hi ${firstName},</p>
              <p style="margin:0 0 20px;font-family:Arial,sans-serif;font-size:16px;color:rgba(255,255,255,0.75);line-height:1.75;">Your message has been received.</p>
              <p style="margin:0 0 32px;font-family:Arial,sans-serif;font-size:16px;color:rgba(255,255,255,0.75);line-height:1.75;">We will get back to you within 24 hours.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;"><tr><td style="height:1px;background:rgba(255,255,255,0.08);font-size:0;line-height:0;">&nbsp;</td></tr></table>
              <p style="margin:0 0 32px;font-family:Arial,sans-serif;font-size:15px;color:rgba(255,255,255,0.45);line-height:1.7;">If it is urgent, reply directly to this email.</p>
              <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:16px;color:#ffffff;font-weight:600;">&#8212; Salman</p>
              <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:rgba(255,255,255,0.40);">FortitudeFX</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 48px;border-top:1px solid rgba(255,255,255,0.06);background-color:#0a0a12;">
              <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:11px;color:rgba(255,255,255,0.25);line-height:1.6;">You are receiving this email because you contacted FortitudeFX at <a href="https://fortitudefx.com/contact" style="color:rgba(122,92,255,0.6);text-decoration:none;">fortitudefx.com</a>.</p>
              <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:rgba(255,255,255,0.25);">&copy; 2026 FortitudeFX. Dubai, UAE.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await sendEmail(
      email,
      firstName,
      'Got your message.',
      contactAckHtml,
      'support@fortitudefx.com',
      'Salman | FortitudeFX'
    );

    // Internal notification to Salman
    const internalHtml = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#333;line-height:1.6;">
      <p><strong>New contact form submission</strong></p>
      <p><strong>Name:</strong> ${firstName} ${lastName || ''}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Category:</strong> ${CONTACT_CATEGORY || 'Not specified'}</p>
      <p><strong>Message:</strong></p>
      <p style="background:#f5f5f5;padding:12px;border-radius:6px;">${(NOTE || 'No message provided').replace(/\n/g, '<br>')}</p>
    </div>`;

    await sendEmail(
      'contact@fortitudefx.com',
      'FortitudeFX',
      '[FFX Contact] ' + (CONTACT_CATEGORY || 'General Inquiry') + ' from ' + firstName + ' ' + (lastName || ''),
      internalHtml,
      email,
      firstName + ' ' + (lastName || '')
    );
  }

  return json({ success: true }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
