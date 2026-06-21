// Cloudflare Pages Function - FortitudeFX Brevo integration
// File: /functions/submit.js
// Used by: joinfree.html (path=Free), waitlist.html (path=VIP|Bootcamp), contact.html (path=Contact)

export async function onRequestPost(context) {

  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const {
    firstName, lastName, email, path, turnstileToken,
    VIP_PLAN, VIP_PRICE, TRADING_STAGE, PROMO_CODE, NOTE, CONTACT_CATEGORY, FFX_BILLING
  } = payload;

  if (!firstName || !email || !path) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  // Turnstile
  const TURNSTILE_SECRET_KEY = context.env.TURNSTILE_SECRET_KEY;
  if (!TURNSTILE_SECRET_KEY) return json({ error: 'Server configuration error.' }, 500);
  if (!turnstileToken) return json({ error: 'Security check required. Please complete the verification.' }, 400);

  const formData = new URLSearchParams();
  formData.append('secret', TURNSTILE_SECRET_KEY);
  formData.append('response', turnstileToken);
  const ip = context.request.headers.get('CF-Connecting-IP');
  if (ip) formData.append('remoteip', ip);

  const tsRes  = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData.toString()
  });
  const tsData = await tsRes.json().catch(() => ({}));
  if (!tsData.success) return json({ error: 'Security check failed. Please try again.' }, 400);

  // Brevo contact save
  const BREVO_API_KEY = context.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) return json({ error: 'Server configuration error.' }, 500);

  // Base attributes
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const attributes = { FIRSTNAME: firstName, LASTNAME: lastName || '', FFX_PATH: path, FFX_JOINED_DATE: today };
  if (TRADING_STAGE)    attributes.TRADING_STAGE    = TRADING_STAGE;
  if (NOTE)             attributes.NOTE             = NOTE;
  if (PROMO_CODE)       attributes.PROMO_CODE       = PROMO_CODE;
  if (CONTACT_CATEGORY) attributes.CONTACT_CATEGORY = CONTACT_CATEGORY;

  // Founding member attributes — set for VIP and Bootcamp paths
  if (path === 'VIP' || path === 'Bootcamp') {
    attributes.FFX_PRICE       = 75;           // Number — founding price locked
    attributes.FFX_FOUNDING    = 'Yes';        // Text — founding member flag
    attributes.FFX_JOINED_DATE = today;        // Text — date joined waitlist
    attributes.FFX_BILLING     = FFX_BILLING || 'monthly'; // Text — billing frequency
  }

  try {
    const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({ email, attributes, listIds: [4], updateEnabled: true })
    });
    if (brevoRes.status !== 201 && brevoRes.status !== 204) {
      const d = await brevoRes.json().catch(() => ({}));
      return json({ error: d.message || 'Could not save your details. Please try again.' }, brevoRes.status);
    }
  } catch {
    return json({ error: 'Network error. Please try again.' }, 500);
  }

  // Email sender helper
  async function sendEmail(to, toName, subject, htmlContent, replyToEmail, replyToName) {
    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
        body: JSON.stringify({
          sender:  { name: 'Salman | FortitudeFX', email: 'salmankhanfx@fortitudefx.com' },
          to:      [{ email: to, name: toName }],
          replyTo: { email: replyToEmail || 'support@fortitudefx.com', name: replyToName || 'FortitudeFX' },
          subject,
          htmlContent
        })
      });
    } catch { /* silent fail - contact already saved */ }
  }

  // Master FFX email template
  function ffxEmail({ kickerText, heroTitle, heroSubtitle, bodyHtml, footerNote, ctaUrl, ctaLabel, secondaryCtaUrl, secondaryCtaLabel, afterCtaHtml }) {

    const ctaBlock = ctaUrl ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;">
        <tr>
          <td style="border-radius:999px;background-color:#e06b1a;">
            <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.02em;">${ctaLabel} &#8594;</a>
          </td>
        </tr>
      </table>` : '';

    const secondaryCtaBlock = secondaryCtaUrl ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr>
          <td style="border-radius:999px;background-color:#5865F2;">
            <a href="${secondaryCtaUrl}" target="_blank" style="display:inline-block;padding:10px 24px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.02em;">${secondaryCtaLabel} &#8594;</a>
          </td>
        </tr>
      </table>` : '';

    const afterCta = afterCtaHtml || '';

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
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border-radius:14px;overflow:hidden;border:1px solid rgba(201,168,76,0.30);">

        <!-- Gradient strip -->
        <tr>
          <td style="height:7px;background:linear-gradient(90deg,#C9A84C 0%,#e06b1a 100%);font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <!-- Dark hero header -->
        <tr>
          <td style="background-color:#0a0a12;padding:28px 40px 24px;border-bottom:1px solid rgba(201,168,76,0.20);">

            <!-- Logo row -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
              <tr>
                <td>
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="vertical-align:middle;padding-right:10px;">
                        <a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;display:block;"><img src="https://fortitudefx.com/favicon-192x192.png" alt="FFX" width="48" height="48" style="display:block;border-radius:9px;border:1px solid rgba(201,168,76,0.50);" /></a>
                      </td>
                      <td style="vertical-align:middle;">
                        <a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;"><p style="margin:0;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.14em;color:#ffffff;">FORTITUDEFX&#8482;</p></a>
                        <a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;"><p style="margin:3px 0 0;font-family:Arial,sans-serif;font-size:10px;color:rgba(255,255,255,0.40);letter-spacing:0.07em;">CATCH THE WICK&#8482;</p></a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Hero content row -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;">
              <tr>
                <td style="vertical-align:middle;padding-right:20px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;">
                    <tr>
                      <td style="background:rgba(201,168,76,0.12);border:1px solid rgba(201,168,76,0.32);border-radius:999px;padding:4px 14px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                          <tr>
                            <td style="vertical-align:middle;padding-right:7px;">
                              <div style="width:6px;height:6px;border-radius:50%;background:#C9A84C;"></div>
                            </td>
                            <td style="vertical-align:middle;">
                              <p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.10em;color:rgba(255,255,255,0.70);">${kickerText}</p>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:26px;font-weight:700;color:#ffffff;line-height:1.15;">${heroTitle}</p>
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;">${heroSubtitle}</p>
                </td>
                <td style="vertical-align:middle;text-align:right;white-space:nowrap;">
                  <a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;"><p style="margin:0;font-family:Georgia,serif;font-size:32px;font-weight:900;color:#ffffff;line-height:1.05;letter-spacing:-0.01em;">2 Candles.</p>
                  <p style="margin:0;font-family:Georgia,serif;font-size:32px;font-weight:900;color:#e06b1a;line-height:1.05;letter-spacing:-0.01em;">1 Story.<span style="font-size:16px;vertical-align:super;line-height:0;">&#8482;</span></p></a>
                </td>
              </tr>
            </table>

            <!-- Social icons row -->
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:10px;">
                  <a href="https://www.youtube.com/@FortitudeFX" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;">
                    <img src="https://fortitudefx.com/email-icon-youtube.png" width="20" height="20" alt="YouTube" style="display:inline-block;vertical-align:middle;" />
                  </a>
                </td>
                <td style="padding-right:10px;">
                  <a href="https://instagram.com/fortitudefx_official" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;">
                    <img src="https://fortitudefx.com/email-icon-instagram.png" width="20" height="20" alt="Instagram" style="display:inline-block;vertical-align:middle;" />
                  </a>
                </td>
                <td style="padding-right:10px;">
                  <a href="https://tiktok.com/@fortitudefx_official" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;">
                    <img src="https://fortitudefx.com/email-icon-tiktok.png" width="20" height="20" alt="TikTok" style="display:inline-block;vertical-align:middle;" />
                  </a>
                </td>
                <td>
                  <a href="https://x.com/_fortitudefx" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;">
                    <img src="https://fortitudefx.com/email-icon-x.png" width="18" height="18" alt="X" style="display:inline-block;vertical-align:middle;" />
                  </a>
                </td>
              </tr>
            </table>

          </td>
        </tr>

        <!-- White body -->
        <tr>
          <td style="background-color:#ffffff;padding:32px 40px 8px;">
            ${bodyHtml}
            ${ctaBlock}
            ${secondaryCtaBlock}
            ${afterCta}
          </td>
        </tr>

        <!-- Sign off -->
        <tr>
          <td style="background-color:#ffffff;padding:0 40px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
              <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
            </table>
            <p style="margin:0 0 2px;font-family:Arial,sans-serif;font-size:15px;color:#1a1a2e;font-weight:600;">&#8212; Salman</p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;">FortitudeFX&#8482;</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background-color:#f8f8fb;padding:18px 40px;border-top:1px solid #f0f0f4;">
            <p style="margin:0 0 5px;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;line-height:1.6;">${footerNote}</p>
            <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;">&copy; 2026 FortitudeFX&#8482;. Dubai, UAE. &nbsp;&middot;&nbsp; <a href="https://fortitudefx.com/privacy" style="color:#C9A84C;text-decoration:none;">Privacy Policy</a></p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  }

  // ─── JOIN FREE ───────────────────────────────────────────────────────────────
  if (path === 'Free') {
    const bodyHtml = `
      <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#1a1a2e;">Hi ${firstName},</p>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">Glad to have you here.</p>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">FortitudeFX&#8482; was built around a simple idea &mdash; trading should feel structured, not stressful. Most traders trade emotionally because they don&rsquo;t have a clear plan or clear rules for entering. The Catch The Wick&#8482; framework fixes that. Mechanical execution. Wait for things to align, let the market come to you, and execute when the story is clear.</p>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">One candle sets the narrative. The next candle reveals intent through the wick. That&rsquo;s it. &ldquo;2 Candles. 1 Story.&rdquo;</p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">You do not need to chase the market to make money from it. There is always another candle &mdash; and every candle is an opportunity. That alone removes most of the stress and emotional pressure. The goal is freedom of time, freedom of mind, and eventually financial freedom. Trading should fit into your life, not consume it.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
      <p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#1a1a2e;letter-spacing:0.04em;">START HERE</p>
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1340366861099073677" style="color:#C9A84C;text-decoration:none;">Road Map</a></p>
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1340307009018527747" style="color:#C9A84C;text-decoration:none;">FFX Trade Plan</a></p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1365422976757010482" style="color:#C9A84C;text-decoration:none;">Acronyms</a></p>
      <p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#1a1a2e;letter-spacing:0.04em;">DAILY CHANNELS</p>
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1364581791637307453" style="color:#C9A84C;text-decoration:none;">FortitudeFX&#8482; Markups</a></p>
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1502065935639646459" style="color:#C9A84C;text-decoration:none;">Blog Updates</a></p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1340383941516988559" style="color:#C9A84C;text-decoration:none;">General Chat</a></p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
      <p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#1a1a2e;letter-spacing:0.04em;">MUST WATCH</p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">&#8594; <a href="https://youtu.be/wDM__Q1aSNY?si=RbM2sfNnLJpom75I" style="color:#C9A84C;text-decoration:none;">Video</a></p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">Take your time, explore the channels, and make yourself at home. If you need help getting started, feel free to reach out anytime.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>`;

    const afterCtaHtml = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
      <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;line-height:1.7;">If you ever have a question, reply to this email directly. We read everything.</p>`;

    await sendEmail(
      email, firstName,
      "You're in. Welcome to FortitudeFX\u2122.",
      ffxEmail({
        kickerText:   'FREE COMMUNITY ACCESS',
        heroTitle:    "You're in.",
        heroSubtitle: 'Welcome to FortitudeFX\u2122.',
        bodyHtml,
        afterCtaHtml,
        footerNote:   'You are receiving this because you joined the FortitudeFX\u2122 free community at <a href="https://fortitudefx.com/joinfree" style="color:#C9A84C;text-decoration:none;">fortitudefx.com/joinfree</a>. Reply to this email anytime.',
        ctaUrl:       'https://discord.com/invite/fWAPJdR8TR',
        ctaLabel:     'Join Discord'
      }),
      'support@fortitudefx.com', 'Salman | FortitudeFX'
    );

    await sendEmail(
      'salmankhanfx@fortitudefx.com', 'Salman',
      '[FFX] New Member \u00b7 ' + firstName + ' ' + email,
      '<html><body><p>New free member: ' + firstName + ' &lt;' + email + '&gt;</p></body></html>'
    );
  }

  // ─── VIP / BOOTCAMP WAITLIST ──────────────────────────────────────────────────
  if (path === 'VIP' || path === 'Bootcamp') {
    const isVIP = path === 'VIP';

    const bodyHtml = `
      <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#1a1a2e;">Hi ${firstName},</p>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">Glad to have you here.</p>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">Your spot on the FortitudeFX&#8482; ${isVIP ? 'VIP Discord' : 'Catch The Wick&#8482; Bootcamp'} waitlist has been secured.</p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">No payment has been taken. We will contact you directly before anything is processed. You will be among the first to know when doors open.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">FortitudeFX&#8482; was built around a simple idea &mdash; trading should feel structured, not stressful. Most traders trade emotionally because they don&rsquo;t have a clear plan or clear rules for entering. The Catch The Wick&#8482; framework fixes that. Mechanical execution. Wait for things to align, let the market come to you, and execute when the story is clear.</p>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">One candle sets the narrative. The next candle reveals intent through the wick. That&rsquo;s it. &ldquo;2 Candles. 1 Story.&rdquo;</p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">You do not need to chase the market to make money from it. There is always another candle &mdash; and every candle is an opportunity. That alone removes most of the stress and emotional pressure. The goal is freedom of time, freedom of mind, and eventually financial freedom. Trading should fit into your life, not consume it.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
      <p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#1a1a2e;letter-spacing:0.04em;">START HERE</p>
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1340366861099073677" style="color:#C9A84C;text-decoration:none;">Road Map</a></p>
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1340307009018527747" style="color:#C9A84C;text-decoration:none;">FFX Trade Plan</a></p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1365422976757010482" style="color:#C9A84C;text-decoration:none;">Acronyms</a></p>
      <p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#1a1a2e;letter-spacing:0.04em;">DAILY CHANNELS</p>
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1364581791637307453" style="color:#C9A84C;text-decoration:none;">FortitudeFX&#8482; Markups</a></p>
      <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1502065935639646459" style="color:#C9A84C;text-decoration:none;">Blog Updates</a></p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.75;">&#8594; <a href="https://discord.com/channels/1340307007730745366/1340383941516988559" style="color:#C9A84C;text-decoration:none;">General Chat</a></p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
      <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;line-height:1.7;">If you have any questions in the meantime, reply to this email directly.</p>`;

    await sendEmail(
      email, firstName,
      isVIP ? 'Your VIP Discord spot is reserved.' : 'Your Bootcamp spot is reserved.',
      ffxEmail({
        kickerText:      isVIP ? 'VIP DISCORD WAITLIST' : 'BOOTCAMP WAITLIST',
        heroTitle:       'Spot secured.',
        heroSubtitle:    isVIP ? 'VIP Discord \u00b7 FortitudeFX\u2122' : 'Catch The Wick\u2122 Bootcamp',
        bodyHtml,
        footerNote:      'You are receiving this because you joined the FortitudeFX\u2122 waitlist at <a href="https://fortitudefx.com/waitlist" style="color:#C9A84C;text-decoration:none;">fortitudefx.com/waitlist</a>. Reply to this email anytime.',
        ctaUrl:          null,
        ctaLabel:        null,
        secondaryCtaUrl:   null,
        secondaryCtaLabel: null
      }),
      'support@fortitudefx.com', 'Salman | FortitudeFX'
    );

    await sendEmail(
      'salmankhanfx@fortitudefx.com', 'Salman',
      '[FFX] ' + (isVIP ? 'VIP Waitlist' : 'Bootcamp Waitlist') + ' \u00b7 ' + firstName + ' ' + email,
      '<html><body><p>' + (isVIP ? 'VIP Waitlist' : 'Bootcamp Waitlist') + ': ' + firstName + ' &lt;' + email + '&gt;' + (VIP_PLAN ? ' \u00b7 Plan: ' + VIP_PLAN : '') + '</p></body></html>'
    );
  }

  // ─── CONTACT ──────────────────────────────────────────────────────────────────
  if (path === 'Contact') {
    const bodyHtml = `
      <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#1a1a2e;">Hi ${firstName},</p>
      <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">Your message has been received.</p>
      <p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">We will get back to you within 24 hours.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>
      <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;line-height:1.7;">If it is urgent, reply directly to this email.</p>`;

    await sendEmail(
      email, firstName,
      'Got your message.',
      ffxEmail({
        kickerText:   'MESSAGE RECEIVED',
        heroTitle:    'Got your message.',
        heroSubtitle: 'We read everything.',
        bodyHtml,
        footerNote:   'You are receiving this because you contacted FortitudeFX\u2122 at <a href="https://fortitudefx.com/contact" style="color:#C9A84C;text-decoration:none;">fortitudefx.com/contact</a>. Reply to this email anytime.',
        ctaUrl:       null,
        ctaLabel:     null
      }),
      'support@fortitudefx.com', 'Salman | FortitudeFX'
    );

    await sendEmail(
      'contact@fortitudefx.com', 'FortitudeFX',
      '[FFX] ' + (CONTACT_CATEGORY || 'General Inquiry') + ' from ' + firstName + ' ' + (lastName || ''),
      `<div style="font-family:Arial,sans-serif;font-size:15px;color:#333;line-height:1.7;padding:20px;">
        <p style="margin:0 0 16px;font-size:18px;font-weight:700;color:#1a1a2e;">New Contact Form Submission</p>
        <p style="margin:0 0 8px;"><strong>Name:</strong> ${firstName} ${lastName || ''}</p>
        <p style="margin:0 0 8px;"><strong>Email:</strong> <a href="mailto:${email}" style="color:#C9A84C;">${email}</a></p>
        <p style="margin:0 0 8px;"><strong>Category:</strong> ${CONTACT_CATEGORY || 'Not specified'}</p>
        <p style="margin:0 0 8px;"><strong>Message:</strong></p>
        <p style="margin:0;background:#f5f5f8;padding:16px;border-radius:8px;border-left:3px solid #e06b1a;">${(NOTE || 'No message provided').replace(/\n/g, '<br>')}</p>
      </div>`,
      email, firstName + ' ' + (lastName || '')
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
