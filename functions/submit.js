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
    // Waitlist fields
    VIP_PLAN,
    VIP_PRICE,
    TRADING_STAGE,
    PROMO_CODE,
    // Contact + shared fields
    NOTE,
    CONTACT_CATEGORY
  } = payload;

  // 2. Basic validation
  if (!firstName || !email || !path) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  // 3. Turnstile verification (form-encoded as required by Cloudflare)
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

  if (VIP_PLAN)          attributes.VIP_PLAN          = VIP_PLAN;
  if (VIP_PRICE)         attributes.VIP_PRICE         = VIP_PRICE;
  if (TRADING_STAGE)     attributes.TRADING_STAGE     = TRADING_STAGE;
  if (NOTE)              attributes.NOTE              = NOTE;
  if (PROMO_CODE)        attributes.PROMO_CODE        = PROMO_CODE;
  if (CONTACT_CATEGORY)  attributes.CONTACT_CATEGORY  = CONTACT_CATEGORY;

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

  // 5. Send transactional email notification for Contact submissions
  if (path === 'Contact') {
    try {
      const emailBody = {
        sender:     { name: 'FortitudeFX Contact', email: 'contact@fortitudefx.com' },
        to:         [{ email: 'contact@fortitudefx.com', name: 'FortitudeFX' }],
        replyTo:    { email: email, name: firstName + ' ' + (lastName || '') },
        subject:    '[FFX Contact] ' + (CONTACT_CATEGORY || 'General Inquiry') + ' from ' + firstName + ' ' + (lastName || ''),
        htmlContent: '<p><strong>Name:</strong> ' + firstName + ' ' + (lastName || '') + '</p>' +
                     '<p><strong>Email:</strong> ' + email + '</p>' +
                     '<p><strong>Category:</strong> ' + (CONTACT_CATEGORY || 'Not specified') + '</p>' +
                     '<p><strong>Message:</strong></p><p>' + (NOTE || 'No message provided').replace(/\n/g, '<br>') + '</p>'
      };

      await fetch('https://api.brevo.com/v3/smtp/email', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
        body:    JSON.stringify(emailBody)
      });
      // Email send failure is non-blocking - contact still saved in Brevo
    } catch (err) {
      // Silent fail on email - contact is already saved
    }
  }

  return json({ success: true }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
