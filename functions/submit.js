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

  // 4. Brevo contact save
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

  // 5. Email sending via Brevo SMTP - non-blocking
  async function sendEmail(to, toName, subject, htmlContent, replyToEmail, replyToName) {
    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
        body:    JSON.stringify({
          sender:  { name: 'Salman | FortitudeFX', email: 'salmankhanfx@fortitudefx.com' },
          to:      [{ email: to, name: toName }],
          replyTo: { email: replyToEmail || 'support@fortitudefx.com', name: replyToName || 'FortitudeFX' },
          subject,
          htmlContent
        })
      });
    } catch (err) {
      // Silent fail - contact already saved
    }
  }

  // Master email template - FFX hero style
  // Dark hero header (glow + kicker pill) + white body
  function ffxEmail({ kickerText, heroTitle, heroSubtitle, bodyHtml, footerNote, ctaUrl, ctaLabel }) {
    const cta = ctaUrl ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr>
          <td style="border-radius:999px;background-color:#e06b1a;">
            <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.02em;">${ctaLabel} &rarr;</a>
          </td>
        </tr>
      </table>` : '';

    return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>FortitudeFX</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f0f4;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0f0f4;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border-radius:14px;overflow:hidden;border:1px solid rgba(122,92,255,0.30);">

        <!-- HERO HEADER - dark with glows -->
        <tr>
          <td style="background-color:#0a0a12;padding:32px 40px 28px;border-bottom:1px solid rgba(122,92,255,0.25);">

            <!-- Logo row -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;">
              <tr>
                <td>
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="vertical-align:middle;padding-right:10px;">
                        <img src="https://fortitudefx.com/favicon-192x192.png" alt="FFX" width="36" height="36" style="display:block;border-radius:9px;border:1px solid rgba(122,92,255,0.50);" />
                      </td>
                      <td style="vertical-align:middle;">
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.14em;color:#ffffff;">FORTITUDEFX</p>
                        <p style="margin:3px 0 0;font-family:Arial,sans-serif;font-size:9px;color:rgba(255,255,255,0.40);letter-spacing:0.07em;">CATCH THE WICK</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Kicker pill -->
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
              <tr>
                <td style="background:rgba(122,92,255,0.14);border:1px solid rgba(122,92,255,0.32);border-radius:999px;padding:4px 14px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="vertical-align:middle;padding-right:7px;">
                        <div style="width:6px;height:6px;border-radius:50%;background:#7a5cff;"></div>
                      </td>
                      <td style="vertical-align:middle;">
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.10em;color:rgba(255,255,255,0.70);">${kickerText}</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Hero text -->
            <p style="margin:0 0 5px;font-family:Arial,sans-serif;font-size:26px;font-weight:700;color:#ffffff;line-height:1.15;">${heroTitle}</p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;">${heroSubtitle}</p>

          </td>
        </tr>

        <!-- WHITE BODY -->
        <tr>
          <td style="background-color:#ffffff;padding:32px 40px 8px;">
            ${bodyHtml}
            ${cta}
          </td>
        </tr>

        <!-- SIGN OFF -->
        <tr>
          <td style="background-color:#ffffff;padding:0 40px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
              <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
            </table>
            <p style="margin:0 0 2px;font-family:Arial,sans-serif;font-size:15px;color:#1a1a2e;font-weight:600;">&#8212; Salman</p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;">FortitudeFX</p>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background-color:#f8f8fb;padding:18px 40px;border-top:1px solid #f0f0f4;">
            <p style="margin:0 0 5px;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;line-height:1.6;">${footerNote}</p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;">&copy; 2026 FortitudeFX. Dubai, UAE. &nbsp;&middot;&nbsp; <a href="https://fortitudefx.com/privacy" style="color:#7a5cff;text-decoration:none;">Privacy Policy</a></p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  }

  // 5a. Join Free - welcome email
  if (path === 'Free') {
    const bodyHtml = `
      <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#1a1a2e;">Hi ${firstName},</p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">You just joined a community built around one idea &mdash; that trading should be mechanical, not emotional. Structure over instinct. Execution over hope.</p>

      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">The FortitudeFX Discord is where that idea lives daily. Real markets. Real markups. The Catch The Wick framework applied session by session, in real time.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;">Your access is active. Click below to join.</p>`;

    const footerNote = `You are receiving this because you joined the FortitudeFX free community at <a href="https://fortitudefx.com/joinfree" style="color:#7a5cff;text-decoration:none;">fortitudefx.com/joinfree</a>. Reply to this email anytime.`;

    const html = ffxEmail({
      kickerText:   'FREE COMMUNITY ACCESS',
      heroTitle:    "You're in.",
      heroSubtitle: 'Welcome to FortitudeFX.',
      bodyHtml,
      footerNote,
      ctaUrl:       'https://discord.com/invite/fWAPJdR8TR',
      ctaLabel:     'Join Discord'
    });

    // Body text after CTA
    const afterCta = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;line-height:1.7;">If you ever have a question, reply to this email directly. We read everything.</p>`;

    // Insert afterCta before sign-off by appending to bodyHtml
    const finalHtml = html.replace(
      '<!-- SIGN OFF -->',
      `<tr><td style="background-color:#ffffff;padding:0 40px 8px;">${afterCta}</td></tr><!-- SIGN OFF -->`
    );

    await sendEmail(
      email,
      firstName,
      "You're in. Welcome to FortitudeFX.",
      finalHtml,
      'support@fortitudefx.com',
      'Salman | FortitudeFX'
    );
  }

  // 5b. Contact - ack to user + internal notification
  if (path === 'Contact') {

    const bodyHtml = `
      <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#1a1a2e;">Hi ${firstName},</p>

      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">Your message has been received.</p>

      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">We will get back to you within 24 hours.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>

      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;line-height:1.7;">If it is urgent, reply directly to this email.</p>`;

    const footerNote = `You are receiving this because you contacted FortitudeFX at <a href="https://fortitudefx.com/contact" style="color:#7a5cff;text-decoration:none;">fortitudefx.com/contact</a>. Reply to this email anytime.`;

    const html = ffxEmail({
      kickerText:   'MESSAGE RECEIVED',
      heroTitle:    'Got your message.',
      heroSubtitle: 'We read everything.',
      bodyHtml,
      footerNote,
      ctaUrl:       null,
      ctaLabel:     null
    });

    await sendEmail(
      email,
      firstName,
      'Got your message.',
      html,
      'support@fortitudefx.com',
      'Salman | FortitudeFX'
    );

    // Internal notification to Salman - plain functional
    const internalHtml = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#333;line-height:1.7;padding:20px;">
      <p style="margin:0 0 16px;font-size:18px;font-weight:700;color:#1a1a2e;">New Contact Form Submission</p>
      <p style="margin:0 0 8px;"><strong>Name:</strong> ${firstName} ${lastName || ''}</p>
      <p style="margin:0 0 8px;"><strong>Email:</strong> <a href="mailto:${email}" style="color:#7a5cff;">${email}</a></p>
      <p style="margin:0 0 8px;"><strong>Category:</strong> ${CONTACT_CATEGORY || 'Not specified'}</p>
      <p style="margin:0 0 8px;"><strong>Message:</strong></p>
      <p style="margin:0;background:#f5f5f8;padding:16px;border-radius:8px;border-left:3px solid #e06b1a;">${(NOTE || 'No message provided').replace(/\n/g, '<br>')}</p>
    </div>`;

    await sendEmail(
      'contact@fortitudefx.com',
      'FortitudeFX',
      '[FFX] ' + (CONTACT_CATEGORY || 'General Inquiry') + ' from ' + firstName + ' ' + (lastName || ''),
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
