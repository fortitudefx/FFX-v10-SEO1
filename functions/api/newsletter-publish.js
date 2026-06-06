// ─────────────────────────────────────────────────────────────────────────────
// FFX Newsletter Publish — Pages Function
// POST /api/newsletter-publish
//   body: { draft } — the edited draft object from the dashboard
//   1. Saves the issue permanently to KV
//   2. Creates Brevo campaign with HTML
//   3. Sends to List 4 immediately
//   4. Updates newsletter:index and newsletter:last_sent
//   Returns { success, campaignId, issueDate }
//
// PATCH /api/newsletter-publish
//   body: { draft } — saves draft edits without publishing
//   Returns { success }
// ─────────────────────────────────────────────────────────────────────────────

var CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

var BREVO_API = 'https://api.brevo.com/v3';
var LIST_ID   = 4;

// ── GET — send preview to single email ───────────────────────────────────────
// GET /api/newsletter-publish?preview=1&email=you@example.com
// Reads current draft from KV, sends to one address only via transactional API
export async function onRequestGet(context) {
  var env = context.env;
  try {
    var url   = new URL(context.request.url);
    var email = url.searchParams.get('email');
    if (!email) return new Response(JSON.stringify({ error: 'email param required' }), { status: 400, headers: CORS_HEADERS });
    if (!env.BREVO_API_KEY) return new Response(JSON.stringify({ error: 'BREVO_API_KEY not set' }), { status: 500, headers: CORS_HEADERS });

    // Read current draft
    var draft = await env.FFX_KV.get('newsletter:draft', { type: 'json' }).catch(function() { return null; });
    if (!draft) return new Response(JSON.stringify({ error: 'No draft found. Generate first.' }), { status: 404, headers: CORS_HEADERS });

    // Build email HTML
    var emailHtml = buildNewsletterEmail(draft);

    // Send transactional email to single address
    var sendRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
      body: JSON.stringify({
        sender:      { name: 'Salman | FortitudeFX', email: 'salmankhanfx@fortitudefx.com' },
        to:          [{ email: email, name: 'Preview' }],
        subject:     '[PREVIEW] ' + (draft.subject || 'FFX Newsletter Preview'),
        htmlContent: emailHtml,
      }),
    });

    var sendText = await sendRes.text();
    if (!sendRes.ok) {
      return new Response(JSON.stringify({ error: 'Preview send failed: ' + sendText.substring(0, 200) }), { status: 500, headers: CORS_HEADERS });
    }

    return new Response(JSON.stringify({ success: true, sentTo: email }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// ── PATCH — save draft edits ──────────────────────────────────────────────────
export async function onRequestPatch(context) {
  var env = context.env;
  try {
    var body  = await context.request.json().catch(function() { return {}; });
    var draft = body.draft;
    if (!draft) return new Response(JSON.stringify({ error: 'draft required' }), { status: 400, headers: CORS_HEADERS });
    draft.savedAt = new Date().toISOString();
    await env.FFX_KV.put('newsletter:draft', JSON.stringify(draft));
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// ── POST — publish and send ───────────────────────────────────────────────────
export async function onRequestPost(context) {
  var env = context.env;
  try {
    var body  = await context.request.json().catch(function() { return {}; });
    var draft = body.draft;
    if (!draft) return new Response(JSON.stringify({ error: 'draft required' }), { status: 400, headers: CORS_HEADERS });
    if (!env.BREVO_API_KEY) return new Response(JSON.stringify({ error: 'BREVO_API_KEY not set' }), { status: 500, headers: CORS_HEADERS });

    // ── Step 1: Build full email HTML ─────────────────────────────────────
    var emailHtml = buildNewsletterEmail(draft);

    // ── Step 2: Create Brevo campaign ────────────────────────────────────
    var campaignPayload = {
      name:     'FFX Newsletter #' + draft.issueNumber + ' — ' + draft.issueDate,
      subject:  draft.subject || ('FFX Intelligence Brief \u00b7 Issue #' + draft.issueNumber),
      sender:   { name: 'Salman | FortitudeFX', email: 'salmankhanfx@fortitudefx.com' },
      type:     'classic',
      htmlContent: emailHtml,
      recipients: { listIds: [LIST_ID] },
    };

    var createRes = await fetch(BREVO_API + '/emailCampaigns', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
      body:    JSON.stringify(campaignPayload),
    });

    var createText = await createRes.text();
    var createData;
    try { createData = JSON.parse(createText); } catch(e) {
      return new Response(JSON.stringify({ error: 'Brevo create campaign failed: ' + createText.substring(0, 200) }), { status: 500, headers: CORS_HEADERS });
    }

    if (!createRes.ok || !createData.id) {
      return new Response(JSON.stringify({ error: 'Brevo campaign creation failed: ' + (createData.message || createText) }), { status: 500, headers: CORS_HEADERS });
    }

    var campaignId = createData.id;

    // ── Step 3: Send immediately ──────────────────────────────────────────
    var sendRes = await fetch(BREVO_API + '/emailCampaigns/' + campaignId + '/sendNow', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
    });

    var sendText = await sendRes.text();
    if (!sendRes.ok && sendRes.status !== 204) {
      return new Response(JSON.stringify({ error: 'Brevo send failed: ' + sendText.substring(0, 200) }), { status: 500, headers: CORS_HEADERS });
    }

    // ── Step 4: Save issue permanently to KV ──────────────────────────────
    var issueKey = 'newsletter:issue:' + draft.issueDate;
    var issue = Object.assign({}, draft, {
      status:     'published',
      publishedAt: new Date().toISOString(),
      campaignId:  campaignId,
      emailHtml:   emailHtml,
    });
    await env.FFX_KV.put(issueKey, JSON.stringify(issue));

    // ── Step 5: Update newsletter:index ───────────────────────────────────
    var index = await env.FFX_KV.get('newsletter:index', { type: 'json' }).catch(function() { return []; });
    if (!Array.isArray(index)) index = [];
    var existingIdx = index.findIndex(function(i) { return i.date === draft.issueDate; });
    var indexEntry = {
      date:        draft.issueDate,
      issueNumber: draft.issueNumber,
      subject:     draft.subject,
      publishedAt: issue.publishedAt,
      campaignId:  campaignId,
    };
    if (existingIdx >= 0) index[existingIdx] = indexEntry;
    else index.unshift(indexEntry);
    await env.FFX_KV.put('newsletter:index', JSON.stringify(index));

    // ── Step 6: Update newsletter:last_sent ───────────────────────────────
    await env.FFX_KV.put('newsletter:last_sent', JSON.stringify({
      issueNumber: draft.issueNumber,
      issueDate:   draft.issueDate,
      sentAt:      issue.publishedAt,
      campaignId:  campaignId,
    }));

    // ── Step 7: Clear draft ───────────────────────────────────────────────
    try { await env.FFX_KV.delete('newsletter:draft'); } catch(e) {}

    return new Response(JSON.stringify({
      success:    true,
      campaignId: campaignId,
      issueDate:  draft.issueDate,
      issueNumber: draft.issueNumber,
    }), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD EMAIL HTML
// Uses the same ffxEmail pattern from submit.js
// Full newsletter sections rendered as inline HTML
// ─────────────────────────────────────────────────────────────────────────────
function buildNewsletterEmail(draft) {
  var esc = function(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };

  // Section divider
  var divider = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 24px;"><tr><td style="height:1px;background:linear-gradient(90deg,transparent,#e8e8f0 40%,#d0d0e8 60%,transparent);font-size:0;line-height:0;">&nbsp;</td></tr></table>';

  // Section label
  function sectionLabel(text, color) {
    return '<p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:' + (color || '#7a5cff') + ';">' + esc(text) + '</p>';
  }

  // Section heading
  function sectionHeading(text) {
    return '<p style="margin:0 0 12px;font-family:Georgia,serif;font-size:20px;font-weight:700;color:#1a1a2e;line-height:1.25;letter-spacing:-0.01em;">' + esc(text) + '</p>';
  }

  // Body text
  function bodyText(text) {
    return '<p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.78;">' + esc(text) + '</p>';
  }

  // Gold card block — left border gold treatment
  function goldCard(content) {
    return '<div style="margin:0 0 20px;padding:18px 20px;border-left:3px solid #c9a84c;background:rgba(201,168,76,0.05);border-radius:0 10px 10px 0;">' + content + '</div>';
  }

  // Lifestyle card
  function lifestyleCard(label, title, body, color) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">'
      + '<tr><td style="padding:18px 20px;background:#f8f8fb;border-radius:10px;border-left:3px solid ' + (color || '#7a5cff') + ';">'
      + '<p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:' + (color || '#7a5cff') + ';">' + esc(label) + '</p>'
      + '<p style="margin:0 0 8px;font-family:Georgia,serif;font-size:17px;font-weight:700;color:#1a1a2e;">' + esc(title) + '</p>'
      + '<p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#444455;line-height:1.72;">' + esc(body) + '</p>'
      + '</td></tr></table>';
  }

  // Article card
  function articleCard(article) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">'
      + '<tr><td style="padding:16px 18px;border-left:3px solid #c9a84c;background:#f8f8fb;border-radius:0 8px 8px 0;">'
      + '<p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#c9a84c;">' + esc(article.category || 'Strategy') + '</p>'
      + '<p style="margin:0 0 6px;font-family:Georgia,serif;font-size:16px;font-weight:700;color:#1a1a2e;line-height:1.3;">' + esc(article.title) + '</p>'
      + (article.excerpt ? '<p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:13px;color:#666677;line-height:1.65;">' + esc(article.excerpt.substring(0, 120)) + '&hellip;</p>' : '')
      + '<a href="' + esc(article.url) + '" target="_blank" style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#7a5cff;text-decoration:none;letter-spacing:0.04em;">Read article &rarr;</a>'
      + '</td></tr></table>';
  }

  // Build body HTML
  var bodyHtml = '';

  // 1. Greeting
  bodyHtml += '<p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:17px;font-weight:700;color:#1a1a2e;">Issue #' + draft.issueNumber + ' &nbsp;&middot;&nbsp; ' + esc(formatDateDisplay(draft.issueDate)) + '</p>';
  bodyHtml += '<p style="margin:0 0 28px;font-family:Arial,sans-serif;font-size:14px;color:#9999aa;">Bi-weekly intelligence for the serious forex trader.</p>';

  // 2. Week in Markets
  if (draft.weekInMarkets) {
    bodyHtml += divider;
    bodyHtml += sectionLabel('Week in Markets', '#e06b1a');
    bodyHtml += sectionHeading('What the market did — and what it told us.');
    bodyHtml += bodyText(draft.weekInMarkets);
  }

  // 3. On This Day in Markets
  if (draft.onThisDay && draft.onThisDay.event) {
    bodyHtml += divider;
    bodyHtml += sectionLabel('On This Day in Markets \u2014 ' + (draft.onThisDay.year || ''), '#c9a84c');
    bodyHtml += goldCard(
      '<p style="margin:0 0 8px;font-family:Georgia,serif;font-size:16px;font-weight:700;color:#1a1a2e;">' + esc(draft.onThisDay.event) + '</p>'
      + (draft.onThisDay.lesson ? '<p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#666677;line-height:1.65;">' + esc(draft.onThisDay.lesson) + '</p>' : '')
    );
  }

  // 4. Trending Question
  if (draft.trendingQ && draft.trendingQ.question) {
    bodyHtml += divider;
    bodyHtml += sectionLabel('Trending Question', '#7a5cff');
    bodyHtml += sectionHeading(draft.trendingQ.question);
    bodyHtml += bodyText(draft.trendingQ.answer || '');
  }

  // 5. Newsletter-Exclusive Article
  if (draft.exclusiveArticle && draft.exclusiveArticle.title) {
    bodyHtml += divider;
    bodyHtml += sectionLabel('Newsletter Exclusive \u2014 Not on the Blog', '#e06b1a');
    bodyHtml += sectionHeading(draft.exclusiveArticle.title);
    bodyHtml += bodyText(draft.exclusiveArticle.body || '');
  }

  // 6. Setup of the Fortnight
  if (draft.setup && draft.setup.hasSetup) {
    bodyHtml += divider;
    bodyHtml += sectionLabel('Setup of the Fortnight', '#c9a84c');
    bodyHtml += sectionHeading('The trade that printed.');
    if (draft.setup.imageUrl) {
      bodyHtml += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;"><tr><td style="text-align:center;"><img src="' + esc(draft.setup.imageUrl) + '" alt="Chart Setup" style="max-width:100%;border-radius:8px;border:1px solid #e0e0e8;" /></td></tr></table>';
    }
    if (draft.setup.note) {
      bodyHtml += bodyText(draft.setup.note);
    }
  }

  // 7. This Fortnight's Articles
  if (draft.articles && draft.articles.length > 0) {
    bodyHtml += divider;
    bodyHtml += sectionLabel('This Fortnight on the Blog', '#7a5cff');
    bodyHtml += sectionHeading('New articles for serious traders.');
    for (var a = 0; a < draft.articles.length; a++) {
      bodyHtml += articleCard(draft.articles[a]);
    }
  }

  // 8. Lifestyle Edit — all 6 sections
  var lifestyle = draft.lifestyle || {};
  if (lifestyle.travel || lifestyle.luxury || lifestyle.women || lifestyle.tech || lifestyle.fitness || lifestyle.entertainment) {
    bodyHtml += divider;
    bodyHtml += sectionLabel('The Lifestyle Edit', '#c9a84c');
    bodyHtml += '<p style="margin:0 0 20px;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;">The life the consistency builds toward.</p>';

    if (lifestyle.travel && lifestyle.travel.title) {
      bodyHtml += lifestyleCard('Trading Freedom \u2014 Travel & Destination', lifestyle.travel.title, lifestyle.travel.body, '#e06b1a');
    }
    if (lifestyle.luxury && lifestyle.luxury.title) {
      bodyHtml += lifestyleCard('Luxury', lifestyle.luxury.title, lifestyle.luxury.body, '#c9a84c');
    }
    if (lifestyle.women && lifestyle.women.title) {
      bodyHtml += lifestyleCard('Women & Lifestyle', lifestyle.women.title, lifestyle.women.body, '#7a5cff');
    }
    if (lifestyle.tech && lifestyle.tech.title) {
      bodyHtml += lifestyleCard('Tech & AI', lifestyle.tech.title, lifestyle.tech.body, '#38bdf8');
    }
    if (lifestyle.fitness && lifestyle.fitness.title) {
      bodyHtml += lifestyleCard('Fitness, Diet & Mindset', lifestyle.fitness.title, lifestyle.fitness.body, '#3ecf8e');
    }
    if (lifestyle.entertainment && lifestyle.entertainment.title) {
      bodyHtml += lifestyleCard('Entertainment', lifestyle.entertainment.title, lifestyle.entertainment.body, '#a855f7');
    }
  }

  // 9. Mindset Line
  if (draft.mindsetLine) {
    bodyHtml += divider;
    bodyHtml += goldCard(
      '<p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#c9a84c;">FFX Mindset Line</p>'
      + '<p style="margin:0;font-family:Georgia,serif;font-size:18px;font-weight:700;color:#1a1a2e;line-height:1.4;font-style:italic;">&ldquo;' + esc(draft.mindsetLine) + '&rdquo;</p>'
    );
  }

  // 10. Discord CTA
  bodyHtml += divider;
  bodyHtml += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:4px;background:#f0eeff;border-radius:12px;border:1px solid rgba(122,92,255,0.20);">'
    + '<tr><td style="padding:24px 28px;text-align:center;">'
    + '<p style="margin:0 0 6px;font-family:Georgia,serif;font-size:18px;font-weight:700;color:#1a1a2e;">Not in the Discord yet?</p>'
    + '<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:14px;color:#666677;">Join thousands of traders in the free FortitudeFX community.</p>'
    + '<a href="https://discord.com/invite/fWAPJdR8TR" target="_blank" style="display:inline-block;padding:11px 28px;background:#7a5cff;color:#ffffff;font-family:Arial,sans-serif;font-size:13px;font-weight:700;text-decoration:none;border-radius:999px;letter-spacing:0.04em;">Join Free &rarr;</a>'
    + '</td></tr></table>';

  // Wrap in master template
  return buildMasterTemplate({
    kickerText:  'INTELLIGENCE BRIEF \u00b7 ISSUE #' + draft.issueNumber,
    heroTitle:   'FFX Intelligence Brief',
    heroSubtitle: formatDateDisplay(draft.issueDate) + ' \u00b7 Bi-Weekly',
    bodyHtml:    bodyHtml,
    footerNote:  'You are receiving this because you joined the FortitudeFX\u2122 community. <a href="https://fortitudefx.com/newsletter/' + draft.issueDate + '" style="color:#7a5cff;text-decoration:none;">View online</a> &middot; <a href="{{unsubscribe}}" style="color:#aaaabc;text-decoration:none;">Unsubscribe</a>',
    ctaUrl:      null,
    ctaLabel:    null,
  });
}

// ── Master email template — same pattern as submit.js ffxEmail() ───────────
function buildMasterTemplate(opts) {
  var esc = function(s) { return String(s || ''); };
  var ctaBlock = opts.ctaUrl ? '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;"><tr><td style="border-radius:999px;background-color:#e06b1a;"><a href="' + esc(opts.ctaUrl) + '" target="_blank" style="display:inline-block;padding:12px 28px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.02em;">' + esc(opts.ctaLabel) + ' &#8594;</a></td></tr></table>' : '';

  return '<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><meta http-equiv="X-UA-Compatible" content="IE=edge"/><meta name="color-scheme" content="light"/><title>FortitudeFX Intelligence Brief</title></head>'
    + '<body style="margin:0;padding:0;background-color:#f0f0f4;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0f0f4;"><tr><td align="center" style="padding:40px 16px;">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border-radius:14px;overflow:hidden;border:1px solid rgba(122,92,255,0.30);">'
    // Gradient strip
    + '<tr><td style="height:7px;background:linear-gradient(90deg,#7a5cff 0%,#e06b1a 100%);font-size:0;line-height:0;">&nbsp;</td></tr>'
    // Dark hero header
    + '<tr><td style="background-color:#0a0a12;padding:28px 40px 24px;border-bottom:1px solid rgba(122,92,255,0.25);">'
    // Logo row
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;"><tr><td><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td style="vertical-align:middle;padding-right:10px;"><a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;display:block;"><img src="https://fortitudefx.com/favicon-192x192.png" alt="FFX" width="48" height="48" style="display:block;border-radius:9px;border:1px solid rgba(122,92,255,0.55);"/></a></td>'
    + '<td style="vertical-align:middle;"><a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;"><p style="margin:0;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.14em;color:#ffffff;">FORTITUDEFX&#8482;</p></a><a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;"><p style="margin:3px 0 0;font-family:Arial,sans-serif;font-size:10px;color:rgba(255,255,255,0.40);letter-spacing:0.07em;">CATCH THE WICK&#8482;</p></a></td>'
    + '</tr></table></td></tr></table>'
    // Hero content
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;"><tr>'
    + '<td style="vertical-align:middle;padding-right:20px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;"><tr><td style="background:rgba(122,92,255,0.14);border:1px solid rgba(122,92,255,0.32);border-radius:999px;padding:4px 14px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="vertical-align:middle;padding-right:7px;"><div style="width:6px;height:6px;border-radius:50%;background:#7a5cff;"></div></td><td style="vertical-align:middle;"><p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.10em;color:rgba(255,255,255,0.70);">' + esc(opts.kickerText) + '</p></td></tr></table></td></tr></table>'
    + '<p style="margin:0 0 4px;font-family:Georgia,serif;font-size:26px;font-weight:700;color:#ffffff;line-height:1.15;">' + esc(opts.heroTitle) + '</p>'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;">' + esc(opts.heroSubtitle) + '</p>'
    + '</td>'
    + '<td style="vertical-align:middle;text-align:right;white-space:nowrap;"><a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;"><p style="margin:0;font-family:Georgia,serif;font-size:32px;font-weight:900;color:#ffffff;line-height:1.05;letter-spacing:-0.01em;">2 Candles.</p><p style="margin:0;font-family:Georgia,serif;font-size:32px;font-weight:900;color:#e06b1a;line-height:1.05;letter-spacing:-0.01em;">1 Story.<span style="font-size:16px;vertical-align:super;line-height:0;">&#8482;</span></p></a></td>'
    + '</tr></table>'
    // Social icons
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td style="padding-right:10px;"><a href="https://www.youtube.com/@FortitudeFX" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-youtube.png" width="20" height="20" alt="YouTube" style="display:inline-block;vertical-align:middle;"/></a></td>'
    + '<td style="padding-right:10px;"><a href="https://instagram.com/fortitudefx_official" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-instagram.png" width="20" height="20" alt="Instagram" style="display:inline-block;vertical-align:middle;"/></a></td>'
    + '<td style="padding-right:10px;"><a href="https://x.com/_fortitudefx" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-x.png" width="18" height="18" alt="X" style="display:inline-block;vertical-align:middle;"/></a></td>'
    + '</tr></table>'
    + '</td></tr>'
    // White body
    + '<tr><td style="background-color:#ffffff;padding:32px 40px 8px;">' + opts.bodyHtml + ctaBlock + '</td></tr>'
    // Sign off
    + '<tr><td style="background-color:#ffffff;padding:0 40px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;"><tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr></table><p style="margin:0 0 2px;font-family:Arial,sans-serif;font-size:15px;color:#1a1a2e;font-weight:600;">&#8212; Salman</p><p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;">FortitudeFX&#8482;</p></td></tr>'
    // Footer
    + '<tr><td style="background-color:#f8f8fb;padding:18px 40px;border-top:1px solid #f0f0f4;"><p style="margin:0 0 5px;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;line-height:1.6;">' + esc(opts.footerNote) + '</p><p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;">&copy; 2026 FortitudeFX&#8482;. Dubai, UAE. &nbsp;&middot;&nbsp; <a href="https://fortitudefx.com/privacy" style="color:#7a5cff;text-decoration:none;">Privacy Policy</a></p></td></tr>'
    + '</table></td></tr></table></body></html>';
}

function formatDateDisplay(dateStr) {
  var d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
