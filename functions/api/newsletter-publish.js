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

    // ── Step 0: Read previous last_sent so we can write prevIssueDate ────
    var prevLastSent = await env.FFX_KV.get('newsletter:last_sent', { type: 'json' }).catch(function() { return null; });
    var prevIssueDate = (prevLastSent && prevLastSent.issueDate && prevLastSent.issueDate !== draft.issueDate) ? prevLastSent.issueDate : null;

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
      status:       'published',
      publishedAt:  new Date().toISOString(),
      campaignId:   campaignId,
      emailHtml:    emailHtml,
      prevIssueDate: prevIssueDate,
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
    // Store everything intelligence engine needs to avoid repetition next issue
    var lifestyleForLastSent = {};
    var ls6 = draft.lifestyle || {};
    ['travel','luxury','women','tech','fitness','entertainment'].forEach(function(k) {
      if (ls6[k] && ls6[k].title) {
        lifestyleForLastSent[k] = { title: ls6[k].title, sourceLabel: ls6[k].sourceLabel || '' };
      }
    });
    await env.FFX_KV.put('newsletter:last_sent', JSON.stringify({
      issueNumber:      draft.issueNumber,
      issueDate:        draft.issueDate,
      sentAt:           issue.publishedAt,
      campaignId:       campaignId,
      exclusiveTitle:   draft.perspective && draft.perspective.title || '',
      perspectiveTitle: draft.perspective && draft.perspective.title || '',
      trendingTopic:    draft.trendingQ && draft.trendingQ.question || '',
      lifestyleTitles:  lifestyleForLastSent,
    }));

    // ── Step 6b: Write newsletter:performance for intelligence engine ────
    var perfKey = 'newsletter:performance:' + draft.issueDate;
    var lifestylePerf = {};
    var lsPerf = draft.lifestyle || {};
    ['travel','luxury','women','tech','fitness','entertainment'].forEach(function(k) {
      if (lsPerf[k] && lsPerf[k].title) {
        lifestylePerf[k] = {
          title:       lsPerf[k].title,
          sourceLabel: lsPerf[k].sourceLabel || '',
          sourceUrl:   lsPerf[k].sourceUrl   || '',
        };
      }
    });
    var perfData = {
      issueNumber:      draft.issueNumber,
      issueDate:        draft.issueDate,
      sentAt:           issue.publishedAt,
      campaignId:       campaignId,
      subject:          draft.subject || '',
      perspectiveTitle: draft.perspective && draft.perspective.title || '',
      trendingQuestion: draft.trendingQ && draft.trendingQ.question || '',
      featuredSlugs:    draft.featuredSlugs || [],
      lifestyleSections: lifestylePerf,
      // Stats populated 48hrs after send by newsletter-performance.js
      openRate:         null,
      clickRate:        null,
      unsubscribeCount: null,
      statsUpdatedAt:   null,
    };
    await env.FFX_KV.put(perfKey, JSON.stringify(perfData));

    // ── Step 6c: Write newsletter:article_refs for cross-linking ─────────
    var allSlugs = draft.featuredSlugs || [];
    var refData = { issueNumber: draft.issueNumber, issueDate: draft.issueDate };
    for (var si = 0; si < allSlugs.length; si++) {
      var refSlug = allSlugs[si];
      if (!refSlug) continue;
      try {
        var existing = await env.FFX_KV.get('newsletter:article_refs:' + refSlug, { type: 'json' }).catch(function(){ return []; });
        if (!Array.isArray(existing)) existing = [];
        var alreadyHas = existing.some(function(r){ return r.issueDate === draft.issueDate; });
        if (!alreadyHas) {
          existing.push(refData);
          await env.FFX_KV.put('newsletter:article_refs:' + refSlug, JSON.stringify(existing));
        }
      } catch(refErr) { /* non-fatal */ }
    }

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

  // ── Section header bar ───────────────────────────────────────────────────
  function sectionBar(label, color) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td style="background:' + color + ';padding:11px 36px;">'
      + '<p style="margin:0;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#ffffff;">' + esc(label) + '</p>'
      + '</td></tr></table>';
  }

  // ── Section spacer — clean gap between sections ──────────────────────────
  function gap() {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td height="28" bgcolor="#f0f0f5" style="font-size:0;line-height:0;">&nbsp;</td>'
      + '</tr></table>';
  }

  // ── Body text ────────────────────────────────────────────────────────────
  function bodyText(text) {
    return '<p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:15px;color:#333344;line-height:1.82;">' + esc(text) + '</p>';
  }

  // ── Source link ──────────────────────────────────────────────────────────
  function sourceLink(url, label) {
    if (!url) return '';
    return '<p style="margin:0 0 20px;"><a href="' + esc(url) + '" target="_blank" style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#e06b1a;text-decoration:none;letter-spacing:0.04em;">Via ' + esc(label || 'Source') + ' &rarr;</a></p>';
  }

  // ── Article link ─────────────────────────────────────────────────────────
  function articleLink(slug, title, color) {
    if (!slug || !title) return '';
    var url = 'https://fortitudefx.com/article?slug=' + encodeURIComponent(slug);
    return '<p style="margin:8px 0 16px;"><a href="' + esc(url) + '" target="_blank" style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:' + (color || '#7a5cff') + ';text-decoration:none;letter-spacing:0.04em;">Related: ' + esc(title) + ' &rarr;</a></p>';
  }

  // ── Horizontal rule ──────────────────────────────────────────────────────
  function rule() {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="#eeeeee" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>';
  }

  // ── Spacer ───────────────────────────────────────────────────────────────
  function spacer(h) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="' + h + '" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>';
  }

  // ── Article card ─────────────────────────────────────────────────────────
  function articleCard(article) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">'
      + '<tr><td>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
      + '<tr><td bgcolor="#1a1a2e" style="padding:7px 16px;">'
      + '<p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#c9a84c;">' + esc(article.category || 'Strategy') + '</p>'
      + '</td></tr>'
      + '<tr><td bgcolor="#f8f8fb" style="padding:16px 18px 18px;border:1px solid #e8e8f0;border-top:none;">'
      + '<p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:17px;font-weight:700;color:#1a1a2e;line-height:1.28;">' + esc(article.title) + '</p>'
      + (article.excerpt ? '<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:13px;color:#666677;line-height:1.65;">' + esc(article.excerpt.substring(0, 120)) + '&hellip;</p>' : '')
      + '<a href="' + esc(article.url) + '" target="_blank" style="display:inline-block;padding:8px 18px;background:#1a1a2e;color:#c9a84c;font-family:Arial,sans-serif;font-size:11px;font-weight:700;text-decoration:none;letter-spacing:0.08em;text-transform:uppercase;">Read Article &rarr;</a>'
      + '</td></tr></table>'
      + '</td></tr></table>';
  }

  // ── Lifestyle card ───────────────────────────────────────────────────────
  function lifestyleCard(label, title, bodyTxt, color, bgColor, imageUrl, sourceUrl, sourceLabel) {
    var imgBlock = imageUrl
      ? ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
         + '<td style="padding:0;font-size:0;line-height:0;">'
         + '<img src="' + esc(imageUrl) + '" width="600" alt="' + esc(label) + '" style="display:block;width:100%;max-width:600px;height:220px;object-fit:cover;" />'
         + '</td></tr></table>')
      : '';
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">'
      + '<tr><td style="border-top:3px solid ' + color + ';">'
      + imgBlock
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td style="background:' + (bgColor || '#16181f') + ';padding:18px 22px 16px;">'
      + '<p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:16px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:' + color + ';">' + esc(label) + '</p>'
      + '<p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;line-height:1.3;">' + esc(title) + '</p>'
      + '<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:13px;color:#aaaacc;line-height:1.70;">' + esc(bodyTxt) + '</p>'
      + (sourceUrl ? '<a href="' + esc(sourceUrl) + '" target="_blank" style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:' + color + ';text-decoration:none;letter-spacing:0.06em;text-transform:uppercase;">Via ' + esc(sourceLabel || 'Source') + ' &rarr;</a>' : '')
      + '</td></tr></table>'
      + '</td></tr></table>';
  }

  var body = '';

  // Issue intro line
  body += spacer(24);
  body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 36px 8px;">'
    + '<p style="margin:0 0 3px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#1a1a2e;">Issue #' + draft.issueNumber + ' &nbsp;&middot;&nbsp; ' + esc(formatDateDisplay(draft.issueDate)) + '</p>'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#9999aa;">Bi-weekly intelligence for the serious forex trader.</p>'
    + '</td></tr></table>';
  body += spacer(16);

  // ── 1. Setup of the Fortnight — FIRST ────────────────────────────────────
  if (draft.setup && draft.setup.hasSetup) {
    body += sectionBar('Setup of the Fortnight', '#c9a84c');
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td bgcolor="#fffdf5" style="padding:24px 36px;">';
    if (draft.setup.imageUrl) {
      body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;"><tr>'
        + '<td style="padding:0;font-size:0;line-height:0;">'
        + '<img src="' + esc(draft.setup.imageUrl) + '" width="528" alt="Chart Setup" style="display:block;width:100%;max-width:528px;border-radius:4px;border:1px solid #e0d0a0;" />'
        + '</td></tr></table>';
    }
    if (draft.setup.note) { body += bodyText(draft.setup.note); }
    body += '</td></tr></table>';
    body += gap();
  }

  // ── 2. THE FFX PERSPECTIVE — flagship editorial, bold and dominant ────────
  if (draft.perspective && draft.perspective.title) {
    var perspectiveUrl = 'https://fortitudefx.com/newsletter-issue?date=' + draft.issueDate + '#perspective';
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#0a0a12" style="padding:0;">'
      // 5px solid gold top bar
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="5" bgcolor="#c9a84c" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:28px 36px 32px;">'
      // THE FFX PERSPECTIVE — large, bold, gold — hits the eyes first
      + '<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:22px;font-weight:900;color:#c9a84c;letter-spacing:0.14em;text-transform:uppercase;line-height:1;">THE FFX PERSPECTIVE</p>'
      // Short gold underline
      + '<table role="presentation" width="80" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;"><tr><td height="3" bgcolor="#c9a84c" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'
      // Article title — Georgia serif, white, 28px
      + '<p style="margin:0 0 18px;font-family:Georgia,\'Times New Roman\',serif;font-size:28px;font-weight:700;color:#ffffff;line-height:1.22;letter-spacing:-0.01em;">' + esc(draft.perspective.title) + '</p>'
      // Hook text
      + '<p style="margin:0 0 22px;font-family:Arial,sans-serif;font-size:15px;color:rgba(255,255,255,0.82);line-height:1.85;">' + esc(draft.perspective.hookText || (draft.perspective.fullText || '').substring(0, 200)) + '</p>'
      // CTA
      + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:' + (draft.perspective.relatedArticleSlug ? '14px' : '0') + ';"><tr>'
      + '<td bgcolor="#c9a84c" style="border-radius:4px;">'
      + '<a href="' + esc(perspectiveUrl) + '" target="_blank" style="display:inline-block;padding:13px 28px;font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#000000;text-decoration:none;letter-spacing:0.10em;text-transform:uppercase;">Read Full Perspective &rarr;</a>'
      + '</td></tr></table>'
      + (draft.perspective.relatedArticleSlug
        ? '<p style="margin:14px 0 0;"><a href="https://fortitudefx.com/article?slug=' + esc(draft.perspective.relatedArticleSlug) + '" target="_blank" style="font-family:Arial,sans-serif;font-size:12px;color:rgba(201,168,76,0.65);text-decoration:none;letter-spacing:0.03em;">Related: ' + esc(draft.perspective.relatedArticleTitle || '') + ' &rarr;</a></p>'
        : '')
      + '</td></tr></table>'
      + '</td></tr></table>';
    body += gap();
  }

  // ── 3. On This Day ────────────────────────────────────────────────────────
  if (draft.onThisDay && draft.onThisDay.event) {
    body += sectionBar('On This Day in Markets' + (draft.onThisDay.year ? ' \u2014 ' + draft.onThisDay.year : ''), '#c9a84c');
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td bgcolor="#ffffff" style="padding:20px 36px;">'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td style="padding:18px 22px;border-left:4px solid #c9a84c;background:#fffdf5;">'
      + '<p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#1a1a2e;line-height:1.35;">' + esc(draft.onThisDay.event) + '</p>'
      + (draft.onThisDay.lesson ? '<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:13px;color:#555566;line-height:1.70;">' + esc(draft.onThisDay.lesson) + '</p>' : '')
      + (draft.onThisDay.wikiUrl ? '<a href="' + esc(draft.onThisDay.wikiUrl) + '" target="_blank" style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#c9a84c;text-decoration:none;letter-spacing:0.04em;">Read on Wikipedia &rarr;</a>' : '')
      + '</td></tr></table>'
      + '</td></tr></table>';
    body += gap();
  }

  // ── 4. Trending Question ─────────────────────────────────────────────────
  if (draft.trendingQ && draft.trendingQ.question) {
    body += sectionBar('Trending Question', '#7a5cff');
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td bgcolor="#f8f7ff" style="padding:28px 36px 20px;">'
      + '<p style="margin:0 0 4px;font-family:Georgia,serif;font-size:56px;color:#7a5cff;line-height:1;opacity:0.35;">&ldquo;</p>'
      + '<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:20px;font-weight:700;color:#1a1a2e;line-height:1.30;letter-spacing:-0.01em;">' + esc(draft.trendingQ.question) + '</p>'
      + rule()
      + spacer(14)
      + '<p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:15px;color:#333344;line-height:1.82;">' + esc(draft.trendingQ.answer) + '</p>'
      + (draft.trendingQ.relatedArticleSlug ? articleLink(draft.trendingQ.relatedArticleSlug, draft.trendingQ.relatedArticleTitle, '#7a5cff') : '')
      + '</td></tr></table>';
    body += gap();
  }

  // ── 5. Articles ───────────────────────────────────────────────────────────
  if (draft.articles && draft.articles.length > 0) {
    body += sectionBar('This Fortnight on the Blog', '#7a5cff');
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td bgcolor="#ffffff" style="padding:20px 36px 8px;">';
    for (var a = 0; a < draft.articles.length; a++) { body += articleCard(draft.articles[a]); }
    body += '</td></tr></table>';
    body += gap();
  }

  // ── 6. The Lifestyle Edit ─────────────────────────────────────────────────
  var ls = draft.lifestyle || {};
  var lsDefs = [
    { key:'travel',        label:'Trading Freedom \u2014 Travel & Destination', color:'#e06b1a', bg:'#1a0e08' },
    { key:'luxury',        label:'Luxury',                                       color:'#c9a84c', bg:'#1a1608' },
    { key:'women',         label:'Lifestyle',                                       color:'#7a5cff', bg:'#0f0c1f' },
    { key:'tech',          label:'Tech & AI',                                    color:'#38bdf8', bg:'#071820' },
    { key:'fitness',       label:'Fitness, Diet & Mindset',                      color:'#3ecf8e', bg:'#081a12' },
    { key:'entertainment', label:'Entertainment',                                color:'#a855f7', bg:'#160d1f' },
  ];
  var hasLifestyle = lsDefs.some(function(d) { return ls[d.key] && ls[d.key].title; });
  if (hasLifestyle) {
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td bgcolor="#06060a" style="padding:36px 36px 8px;text-align:center;border-top:3px solid #c9a84c;">'
      + '<p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:18px;font-weight:900;letter-spacing:0.18em;text-transform:uppercase;color:#c9a84c;">The Lifestyle Edit</p>'
      + '<p style="margin:0;font-family:Georgia,\'Times New Roman\',serif;font-size:30px;font-style:italic;font-weight:400;color:#ffffff;line-height:1.2;">The life the consistency builds toward.</p>'
      + '</td></tr></table>';
    body += spacer(8);
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#06060a" style="padding:8px 36px 36px;">';
    lsDefs.forEach(function(d) {
      var data = ls[d.key] || {};
      if (data.title) { body += lifestyleCard(d.label, data.title, data.body || '', d.color, d.bg, data.imageUrl || '', data.sourceUrl || '', data.sourceLabel || ''); }
    });
    body += '</td></tr></table>';
    body += gap();
  }

  // ── 7. Mindset Line ───────────────────────────────────────────────────────
  if (draft.mindsetLine) {
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
      + '<td bgcolor="#1a1a2e" style="padding:32px 36px;">'
      + '<p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:#c9a84c;">FFX Mindset Line</p>'
      + '<p style="margin:0;font-family:Georgia,\'Times New Roman\',serif;font-size:21px;font-weight:400;color:#ffffff;line-height:1.50;font-style:italic;">&ldquo;' + esc(draft.mindsetLine) + '&rdquo;</p>'
      + '</td></tr></table>';
    body += spacer(8);
  }

  // ── 8. Discord CTA ────────────────────────────────────────────────────────
  body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td bgcolor="#f0eeff" style="padding:32px 36px;text-align:center;border-top:3px solid #7a5cff;">'
    + '<p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:20px;font-weight:700;color:#1a1a2e;">Not in the Discord yet?</p>'
    + '<p style="margin:0 0 20px;font-family:Arial,sans-serif;font-size:14px;color:#555566;line-height:1.70;">Real-time chart markups, daily recaps, direct access to Salman.</p>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>'
    + '<td bgcolor="#7a5cff" style="border-radius:999px;">'
    + '<a href="https://discord.com/invite/fWAPJdR8TR" target="_blank" style="display:inline-block;padding:13px 32px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.06em;text-transform:uppercase;">Join Free &rarr;</a>'
    + '</td></tr></table>'
    + '</td></tr></table>';

  return buildMasterTemplate({
    issueNumber:  draft.issueNumber,
    issueDate:    draft.issueDate,
    bodyHtml:     body,
    footerNote:   'You are receiving this because you joined FortitudeFX\u2122. <a href="https://fortitudefx.com/newsletter-issue?date=' + draft.issueDate + '" style="color:#7a5cff;text-decoration:none;">View online</a> &middot; <a href="{{unsubscribe}}" style="color:#aaaabc;text-decoration:none;">Unsubscribe</a>',
  });
}


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
    + '<style type="text/css">@import url(\'https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700&display=swap\');'
    + 'body,table,td,p,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}'
    + 'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse!important;}'
    + 'img{border:0;height:auto;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}'
    + '@media only screen and (max-width:620px){.em-container{width:100%!important;}.em-hero{font-size:28px!important;}}'
    + '</style>'
    + '</head>'
    + '<body style="margin:0;padding:0;background-color:#e8e8f0;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e8e8f0">'
    + '<tr><td align="center" style="padding:24px 0;">'
    + '<table role="presentation" class="em-container" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;">'

    // Top accent bar
    + '<tr>'
    + '<td width="300" height="5" bgcolor="#7a5cff" style="font-size:0;line-height:0;">&nbsp;</td>'
    + '<td width="300" height="5" bgcolor="#e06b1a" style="font-size:0;line-height:0;">&nbsp;</td>'
    + '</tr>'

    // HEADER — solid dark
    + '<tr><td colspan="2" bgcolor="#0a0a12" style="padding:24px 36px 20px;">'

    // Brand row
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;"><tr>'
    + '<td style="vertical-align:middle;">'
    + '<a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td style="vertical-align:middle;padding-right:10px;">'
    + '<a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;display:block;"><img src="https://fortitudefx.com/favicon-192x192.png" alt="FFX" width="48" height="48" style="display:block;border-radius:9px;border:1px solid rgba(122,92,255,0.55);" /></a>'
    + '</td>'
    + '<td style="vertical-align:middle;">'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.14em;color:#ffffff;">FORTITUDEFX&#8482;</p>'
    + '<p style="margin:3px 0 0;font-family:Arial,sans-serif;font-size:10px;color:rgba(255,255,255,0.40);letter-spacing:0.07em;">fortitudefx.com</p>'
    + '</td></tr></table></a>'
    + '</td>'
    + '<td style="vertical-align:middle;text-align:right;">'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#c9a84c;border:1px solid #3a3010;background:#1a1608;padding:4px 12px;display:inline-block;">ISSUE #' + issueNum + '</p>'
    + '</td>'
    + '</tr></table>'

    // Catch The Wick headline — left: kicker + CTW. Right: #1 + 2 Candles. 1 Story.
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;"><tr>'
    + '<td style="vertical-align:middle;" width="360">'
    + '<p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;color:#c9a84c;">&#9679;&nbsp; BI-WEEKLY &nbsp;&#183;&nbsp; ' + esc(dateDisp) + '</p>'
    + '<p class="em-hero" style="margin:0;font-family:Georgia,serif;font-size:36px;font-weight:700;color:#ffffff;line-height:1.0;letter-spacing:-0.02em;">Catch The Wick<span style="font-size:14px;vertical-align:super;font-weight:400;">&#8482;</span></p>'
    + '</td>'
    + '<td style="vertical-align:middle;text-align:right;" width="200">'
    + '<p style="margin:0;font-family:Georgia,serif;font-size:52px;font-weight:900;color:#e06b1a;line-height:1.0;">#' + issueNum + '</p>'
    + '<p style="margin:4px 0 0;font-family:Georgia,serif;font-size:22px;font-weight:900;color:#ffffff;line-height:1.05;letter-spacing:-0.01em;">2 Candles.</p>'
    + '<p style="margin:0;font-family:Georgia,serif;font-size:22px;font-weight:900;color:#e06b1a;line-height:1.05;letter-spacing:-0.01em;">1 Story.<span style="font-size:11px;vertical-align:super;line-height:0;">&#8482;</span></p>'
    + '</td>'
    + '</tr></table>'

    // Social icons — exact copy from welcome email submit.js
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td style="padding-right:10px;"><a href="https://www.youtube.com/@FortitudeFX" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-youtube.png" width="20" height="20" alt="YouTube" style="display:inline-block;vertical-align:middle;" /></a></td>'
    + '<td style="padding-right:10px;"><a href="https://instagram.com/fortitudefx_official" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-instagram.png" width="20" height="20" alt="Instagram" style="display:inline-block;vertical-align:middle;" /></a></td>'
    + '<td style="padding-right:10px;"><a href="https://tiktok.com/@fortitudefx_official" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-tiktok.png" width="20" height="20" alt="TikTok" style="display:inline-block;vertical-align:middle;" /></a></td>'
    + '<td><a href="https://x.com/_fortitudefx" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-x.png" width="18" height="18" alt="X" style="display:inline-block;vertical-align:middle;" /></a></td>'
    + '</tr></table>'

    + '</td></tr>'

    // BODY
    + '<tr><td colspan="2" bgcolor="#ffffff">' + opts.bodyHtml + '</td></tr>'

    // SIGN OFF
    + '<tr><td colspan="2" bgcolor="#ffffff" style="padding:8px 36px 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="#eeeeee" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="14" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    + '<p style="margin:0 0 2px;font-family:Arial,sans-serif;font-size:15px;color:#1a1a2e;font-weight:600;">&#8212; Salman</p>'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#999999;">FortitudeFX&#8482; &nbsp;&#183;&nbsp; Catch The Wick&#8482;</p>'
    + '</td></tr>'

    // Bottom accent
    + '<tr>'
    + '<td width="300" height="4" bgcolor="#7a5cff" style="font-size:0;line-height:0;">&nbsp;</td>'
    + '<td width="300" height="4" bgcolor="#e06b1a" style="font-size:0;line-height:0;">&nbsp;</td>'
    + '</tr>'

    // FOOTER
    + '<tr><td colspan="2" bgcolor="#f4f4f8" style="padding:16px 36px;">'
    + '<p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;line-height:1.65;">' + (opts.footerNote || '') + '</p>'
    + '<p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;">&copy; 2026 FortitudeFX&#8482;. Dubai, UAE. &nbsp;&#183;&nbsp; <a href="https://fortitudefx.com/privacy" style="color:#7a5cff;text-decoration:none;">Privacy</a></p>'
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
