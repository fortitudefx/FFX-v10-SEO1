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

  // ── Component helpers ────────────────────────────────────────────────────

  // Full-width dark section header bar
  function sectionBar(icon, label, color) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 0;background:' + color + ';">'
      + '<tr><td style="padding:10px 32px;">'
      + '<p style="margin:0;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#ffffff;">' + icon + '&nbsp;&nbsp;' + esc(label) + '</p>'
      + '</td></tr></table>';
  }

  // Section heading inside white body
  function sectionHeading(text) {
    return '<p style="margin:0 0 12px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#1a1a2e;line-height:1.22;letter-spacing:-0.01em;">' + esc(text) + '</p>';
  }

  // Body text
  function bodyText(text) {
    return '<p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:15px;color:#333344;line-height:1.82;">' + esc(text) + '</p>';
  }

  // Gold quote card
  function goldCard(content) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">'
      + '<tr><td style="padding:20px 24px;border-left:4px solid #c9a84c;background:#fffdf5;border-radius:0 10px 10px 0;">'
      + content + '</td></tr></table>';
  }

  // Article card — editorial style with colored category bar
  function articleCard(article) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;border-radius:10px;overflow:hidden;border:1px solid #e8e8f0;">'
      + '<tr><td style="padding:0;">'
      // Category bar
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#1a1a2e;padding:7px 18px;">'
      + '<p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:#c9a84c;">' + esc(article.category || 'Strategy') + '</p>'
      + '</td></tr></table>'
      // Content
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:16px 18px 18px;background:#ffffff;">'
      + '<p style="margin:0 0 8px;font-family:Georgia,serif;font-size:18px;font-weight:700;color:#1a1a2e;line-height:1.28;">' + esc(article.title) + '</p>'
      + (article.excerpt ? '<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:13px;color:#666677;line-height:1.68;">' + esc(article.excerpt.substring(0, 140)) + '&hellip;</p>' : '')
      + '<a href="' + esc(article.url) + '" target="_blank" style="display:inline-block;padding:8px 20px;background:#1a1a2e;color:#c9a84c;font-family:Arial,sans-serif;font-size:11px;font-weight:700;text-decoration:none;letter-spacing:0.08em;text-transform:uppercase;border-radius:4px;">Read Article &rarr;</a>'
      + '</td></tr></table>'
      + '</td></tr></table>';
  }

  // Lifestyle card — premium dark treatment with top color bar
  function lifestyleCard(icon, label, title, body, color, bgColor) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;border-radius:10px;overflow:hidden;">'
      + '<tr><td>'
      // Color top bar
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:' + color + ';padding:8px 18px;">'
      + '<p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:#ffffff;">' + icon + '&nbsp;&nbsp;' + esc(label) + '</p>'
      + '</td></tr></table>'
      // Content on dark bg
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:' + (bgColor || '#16181f') + ';padding:18px 20px;">'
      + '<p style="margin:0 0 8px;font-family:Georgia,serif;font-size:17px;font-weight:700;color:#ffffff;line-height:1.3;">' + esc(title) + '</p>'
      + '<p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:rgba(255,255,255,0.68);line-height:1.72;">' + esc(body) + '</p>'
      + '</td></tr></table>'
      + '</td></tr></table>';
  }

  // White content section wrapper
  function section(content) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:28px 32px 4px;">' + content + '</td></tr></table>';
  }

  // ── Build body ────────────────────────────────────────────────────────────
  var body = '';

  // Issue intro line inside body
  body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 32px 8px;">'
    + '<p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#1a1a2e;letter-spacing:0.04em;">Issue #' + draft.issueNumber + ' &nbsp;&middot;&nbsp; ' + esc(formatDateDisplay(draft.issueDate)) + '</p>'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#9999aa;">Bi-weekly intelligence for the serious forex trader.</p>'
    + '</td></tr></table>';

  // ── Week in Markets ───────────────────────────────────────────────────────
  if (draft.weekInMarkets) {
    body += sectionBar('&#128200;', 'Week in Markets', '#e06b1a');
    body += section(
      sectionHeading('What the market did \u2014 and what it told us.')
      + bodyText(draft.weekInMarkets)
    );
  }

  // ── On This Day ───────────────────────────────────────────────────────────
  if (draft.onThisDay && draft.onThisDay.event) {
    body += sectionBar('&#128337;', 'On This Day in Markets \u2014 ' + (draft.onThisDay.year || ''), '#c9a84c');
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 32px 4px;">';
    body += goldCard(
      '<p style="margin:0 0 8px;font-family:Georgia,serif;font-size:17px;font-weight:700;color:#1a1a2e;line-height:1.35;">' + esc(draft.onThisDay.event) + '</p>'
      + (draft.onThisDay.lesson ? '<p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#555566;line-height:1.70;">' + esc(draft.onThisDay.lesson) + '</p>' : '')
    );
    body += '</td></tr></table>';
  }

  // ── Trending Question ─────────────────────────────────────────────────────
  if (draft.trendingQ && draft.trendingQ.question) {
    body += sectionBar('&#10067;', 'Trending Question', '#7a5cff');
    body += section(
      sectionHeading(draft.trendingQ.question)
      + bodyText(draft.trendingQ.answer || '')
    );
  }

  // ── Newsletter Exclusive ──────────────────────────────────────────────────
  if (draft.exclusiveArticle && draft.exclusiveArticle.title) {
    body += sectionBar('&#11088;', 'Newsletter Exclusive \u2014 Not on the Blog', '#1a1a2e');
    body += section(
      sectionHeading(draft.exclusiveArticle.title)
      + bodyText(draft.exclusiveArticle.body || '')
    );
  }

  // ── Setup of the Fortnight ────────────────────────────────────────────────
  if (draft.setup && draft.setup.hasSetup) {
    body += sectionBar('&#128200;', 'Setup of the Fortnight', '#c9a84c');
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 32px 4px;">';
    if (draft.setup.imageUrl) {
      body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;"><tr><td style="text-align:center;"><img src="' + esc(draft.setup.imageUrl) + '" alt="Chart Setup" style="max-width:100%;border-radius:8px;border:1px solid #e0e0e8;" /></td></tr></table>';
    }
    if (draft.setup.note) { body += bodyText(draft.setup.note); }
    body += '</td></tr></table>';
  }

  // ── Articles ──────────────────────────────────────────────────────────────
  if (draft.articles && draft.articles.length > 0) {
    body += sectionBar('&#128196;', 'This Fortnight on the Blog', '#7a5cff');
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 32px 4px;">';
    for (var a = 0; a < draft.articles.length; a++) { body += articleCard(draft.articles[a]); }
    body += '</td></tr></table>';
  }

  // ── Lifestyle Edit — full dark section ───────────────────────────────────
  var ls = draft.lifestyle || {};
  var lifestyleDefs = [
    { key:'travel',        icon:'&#9992;', label:'Trading Freedom \u2014 Travel & Destination', color:'#e06b1a', bg:'#1a0e08' },
    { key:'luxury',        icon:'&#9899;', label:'Luxury',                                       color:'#c9a84c', bg:'#1a1608' },
    { key:'women',         icon:'&#127942;',label:'Women & Lifestyle',                           color:'#7a5cff', bg:'#0f0c1f' },
    { key:'tech',          icon:'&#9881;', label:'Tech & AI',                                    color:'#38bdf8', bg:'#071820' },
    { key:'fitness',       icon:'&#128170;',label:'Fitness, Diet & Mindset',                     color:'#3ecf8e', bg:'#081a12' },
    { key:'entertainment', icon:'&#127916;',label:'Entertainment',                               color:'#a855f7', bg:'#160d1f' },
  ];
  var hasLifestyle = lifestyleDefs.some(function(d){ return ls[d.key] && ls[d.key].title && ls[d.key].body; });
  if (hasLifestyle) {
    // Full-width lifestyle header — dark premium
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#06060a;padding:24px 32px 8px;">'
      + '<p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;color:#c9a84c;">&#127774;&nbsp;&nbsp;The Lifestyle Edit</p>'
      + '<p style="margin:0;font-family:Georgia,serif;font-size:18px;font-weight:700;color:#ffffff;">The life the consistency builds toward.</p>'
      + '</td></tr></table>';
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#06060a;padding:12px 32px 24px;">';
    lifestyleDefs.forEach(function(d) {
      var data = ls[d.key] || {};
      if (data.title && data.body) {
        body += lifestyleCard(d.icon, d.label, data.title, data.body, d.color, d.bg);
      }
    });
    body += '</td></tr></table>';
  }

  // ── Mindset Line ──────────────────────────────────────────────────────────
  if (draft.mindsetLine) {
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#1a1a2e;padding:28px 32px;">'
      + '<p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:#c9a84c;">FFX Mindset Line</p>'
      + '<p style="margin:0;font-family:Georgia,serif;font-size:20px;font-weight:700;color:#ffffff;line-height:1.42;font-style:italic;">&ldquo;' + esc(draft.mindsetLine) + '&rdquo;</p>'
      + '</td></tr></table>';
  }

  // ── Discord CTA ────────────────────────────────────────────────────────────
  body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#f0eeff;padding:28px 32px;text-align:center;border-top:3px solid #7a5cff;">'
    + '<p style="margin:0 0 6px;font-family:Georgia,serif;font-size:20px;font-weight:700;color:#1a1a2e;">Not in the Discord yet?</p>'
    + '<p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:14px;color:#555566;line-height:1.70;">Join the free FortitudeFX community. Get real-time chart markups, daily recaps, and direct access.</p>'
    + '<a href="https://discord.com/invite/fWAPJdR8TR" target="_blank" style="display:inline-block;padding:13px 32px;background:#7a5cff;color:#ffffff;font-family:Arial,sans-serif;font-size:13px;font-weight:700;text-decoration:none;border-radius:999px;letter-spacing:0.06em;text-transform:uppercase;">Join Free &rarr;</a>'
    + '</td></tr></table>';

  return buildMasterTemplate({ issueNumber: draft.issueNumber, issueDate: draft.issueDate, bodyHtml: body, footerNote: 'You are receiving this because you joined FortitudeFX\u2122. <a href="https://fortitudefx.com/newsletter-issue?date=' + draft.issueDate + '" style="color:#7a5cff;text-decoration:none;">View online</a> &middot; <a href="{{unsubscribe}}" style="color:#aaaabc;text-decoration:none;">Unsubscribe</a>' });
}

// ── Master template — premium wide layout ────────────────────────────────────
function buildMasterTemplate(opts) {
  var esc = function(s) { return String(s || ''); };
  var issueNum  = opts.issueNumber || 1;
  var issueDate = opts.issueDate   || '';
  var dateDisp  = formatDateDisplay(issueDate);

  return '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">'
    + '<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head>'
    + '<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>'
    + '<meta http-equiv="X-UA-Compatible" content="IE=edge"/>'
    + '<title>Catch The Wick&#8482; | FortitudeFX</title>'
    + '<style type="text/css">'
    + 'body,table,td,p,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}'
    + 'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse!important;}'
    + 'img{border:0;height:auto;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}'
    + '@media only screen and (max-width:620px){'
    + '.em-container{width:100%!important;}'
    + '.em-hero-title{font-size:32px!important;}'
    + '.em-section-pad{padding-left:20px!important;padding-right:20px!important;}'
    + '}'
    + '</style>'
    + '</head>'
    + '<body style="margin:0;padding:0;background-color:#e8e8f0;">'

    // Outer wrapper — no side padding so it fills screen
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e8e8f0">'
    + '<tr><td align="center" style="padding:24px 0;">'

    // ── EMAIL CONTAINER — 600px standard for max compatibility ───────────
    // 600px is the industry standard — going wider breaks Outlook and Gmail mobile
    + '<table role="presentation" class="em-container" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;">'

    // ── TOP ACCENT BAR — two solid color cells, no gradient ──────────────
    + '<tr>'
    + '<td width="300" height="5" bgcolor="#7a5cff" style="font-size:0;line-height:0;">&nbsp;</td>'
    + '<td width="300" height="5" bgcolor="#e06b1a" style="font-size:0;line-height:0;">&nbsp;</td>'
    + '</tr>'

    // ── HEADER — solid dark background, fully email-safe ─────────────────
    + '<tr><td bgcolor="#0a0a12" style="padding:32px 40px 28px;">'

    // Row 1: Brand + Issue number
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
    + '<tr>'
    + '<td style="vertical-align:middle;">'
    + '<a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;">'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.22em;color:#7a7aaa;text-transform:uppercase;">FORTITUDEFX&#8482;</p>'
    + '</a>'
    + '</td>'
    + '<td style="vertical-align:middle;text-align:right;">'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#c9a84c;border:1px solid #3a3010;background:#1a1608;padding:4px 12px;display:inline-block;">ISSUE #' + issueNum + '</p>'
    + '</td>'
    + '</tr>'
    + '</table>'

    // Spacer
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="20" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'

    // Row 2: CATCH THE WICK dominant headline
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
    + '<tr>'
    + '<td style="vertical-align:bottom;" width="380">'
    + '<p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;color:#c9a84c;">BI-WEEKLY INTELLIGENCE &nbsp;&middot;&nbsp; ' + esc(dateDisp) + '</p>'
    + '<p class="em-hero-title" style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:44px;font-weight:700;color:#ffffff;line-height:1.0;letter-spacing:-0.02em;">Catch The Wick&#8482;</p>'
    + '<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:400;color:#666688;line-height:1.2;">2 Candles. 1 Story.&#8482;</p>'
    + '</td>'
    + '<td style="vertical-align:bottom;text-align:right;" width="180">'
    + '<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:64px;font-weight:700;color:#e06b1a;line-height:1.0;">#' + issueNum + '</p>'
    + '</td>'
    + '</tr>'
    + '</table>'

    // Spacer
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="24" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'

    // Row 3: Social icons — solid backgrounds only
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0">'
    + '<tr>'
    + '<td style="padding-right:8px;">'
    + '<a href="https://www.youtube.com/@FortitudeFX" target="_blank" style="display:block;width:36px;height:36px;background-color:#1e1e2e;border:1px solid #333350;border-radius:6px;text-decoration:none;text-align:center;line-height:36px;">'
    + '<img src="https://fortitudefx.com/email-icon-youtube.png" width="18" height="18" alt="YouTube" style="display:inline-block;vertical-align:middle;border:0;"/>'
    + '</a>'
    + '</td>'
    + '<td style="padding-right:8px;">'
    + '<a href="https://instagram.com/fortitudefx_official" target="_blank" style="display:block;width:36px;height:36px;background-color:#1e1e2e;border:1px solid #333350;border-radius:6px;text-decoration:none;text-align:center;line-height:36px;">'
    + '<img src="https://fortitudefx.com/email-icon-instagram.png" width="18" height="18" alt="Instagram" style="display:inline-block;vertical-align:middle;border:0;"/>'
    + '</a>'
    + '</td>'
    + '<td style="padding-right:8px;">'
    + '<a href="https://x.com/_fortitudefx" target="_blank" style="display:block;width:36px;height:36px;background-color:#1e1e2e;border:1px solid #333350;border-radius:6px;text-decoration:none;text-align:center;line-height:36px;">'
    + '<img src="https://fortitudefx.com/email-icon-x.png" width="16" height="16" alt="X" style="display:inline-block;vertical-align:middle;border:0;"/>'
    + '</a>'
    + '</td>'
    + '<td>'
    + '<a href="https://discord.com/invite/fWAPJdR8TR" target="_blank" style="display:inline-block;padding:0 14px;height:36px;line-height:36px;background-color:#2a1e5e;border:1px solid #4a3a8e;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-size:10px;font-weight:700;color:#c8b8ff;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;">Join Discord</a>'
    + '</td>'
    + '</tr>'
    + '</table>'

    + '</td></tr>'
    // ── END HEADER ────────────────────────────────────────────────────────

    // ── BODY ──────────────────────────────────────────────────────────────
    + '<tr><td bgcolor="#ffffff">' + opts.bodyHtml + '</td></tr>'

    // ── SIGN OFF ──────────────────────────────────────────────────────────
    + '<tr><td bgcolor="#ffffff" style="padding:8px 40px 32px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="#eeeeee" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="16" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    + '<p style="margin:0 0 2px;font-family:Arial,sans-serif;font-size:15px;color:#1a1a2e;font-weight:600;">&#8212; Salman</p>'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#999999;">FortitudeFX&#8482; &nbsp;&middot;&nbsp; Catch The Wick&#8482;</p>'
    + '</td></tr>'

    // ── BOTTOM ACCENT BAR ─────────────────────────────────────────────────
    + '<tr>'
    + '<td width="300" height="4" bgcolor="#7a5cff" style="font-size:0;line-height:0;">&nbsp;</td>'
    + '<td width="300" height="4" bgcolor="#e06b1a" style="font-size:0;line-height:0;">&nbsp;</td>'
    + '</tr>'

    // ── FOOTER ────────────────────────────────────────────────────────────
    + '<tr><td colspan="2" bgcolor="#f4f4f8" style="padding:16px 40px;border-top:1px solid #e8e8f0;">'
    + '<p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;line-height:1.65;">' + esc(opts.footerNote) + '</p>'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;">&copy; 2026 FortitudeFX&#8482;. Dubai, UAE. &nbsp;&middot;&nbsp; <a href="https://fortitudefx.com/privacy" style="color:#7a5cff;text-decoration:none;">Privacy</a></p>'
    + '</td></tr>'

    + '</table>'
    + '</td></tr></table>'
    + '</body></html>';
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
