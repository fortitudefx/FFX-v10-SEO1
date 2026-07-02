// ─────────────────────────────────────────────────────────────────────────────
// FFX /newsletter-issue — Server-Side Render (Phase 1, §A2)
//
// Claims GET /newsletter-issue and emits the COMPLETE per-issue page in the
// served bytes: real <title>, meta description, self-canonical, OG/Twitter,
// Article JSON-LD, the hero (issue #, date), and the full issue body — no
// indexable content behind client JS. Same model as functions/article.js.
//
// HARD RULES honoured:
//  - READ-ONLY against KV. Data via the read-only /api/newsletter?date= subrequest
//    (newsletter.js = env.FFX_KV.get only). Zero KV writes.
//  - URL unchanged (/newsletter-issue?date=…). Markup/CSS spliced byte-for-byte
//    from newsletter-issue.html; only the "Loading…" shell is replaced. The client
//    script is kept (it re-renders identically + powers the exclusive toggle).
//
// Error model (honest codes, never a 200 shell):
//  - No ?date           → 302 → /newsletter (the index; a bare issue URL is not a
//                          resource — friendlier than 404, not an indexable shell).
//  - Malformed / unknown date (incl. the current zero-issues state) → real 404 (404.html).
//  - Renderer cannot build an existing issue (transient API/KV failure) → 503 + Retry-After (503.html).
// ─────────────────────────────────────────────────────────────────────────────

const BASE    = 'https://fortitudefx.com';
const OG_IMG  = 'https://fortitudefx.com/og-fortitudefx.png';
const SITE    = 'FortitudeFX';

// attribute-safe + JSON-LD-safe escapers (as in article.js)
function attr(v) {
  return String(v == null ? '' : v).replace(/[<>"]/g, function (c) {
    return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
  }).replace(/\s+/g, ' ').trim();
}
function jsonLdSafe(obj) { return JSON.stringify(obj).replace(/</g, '\\u003c'); }
function htmlText(v) {
  return String(v == null ? '' : v).replace(/[<>&]/g, function (c) {
    return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;';
  });
}

// ── Helpers reproduced VERBATIM from newsletter-issue.html (so SSR bytes match
//    the client's render exactly after hydration) ──────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function section(labelHtml, contentHtml) { return '<div class="ni-section">' + labelHtml + contentHtml + '</div>'; }
function sectionLabel(text, color) {
  return '<div class="ni-section-label" style="color:' + (color || 'rgba(255,255,255,0.40)') + ';">' + text + '</div>';
}
// formatDate — UTC-based "15 June 2026" (deterministic; client re-renders per-tz on load)
const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];
function formatDate(d) {
  if (!d) return '';
  var dt = new Date(String(d));
  if (isNaN(dt.getTime())) return '';
  return dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear();
}

// ── Per-issue <head> meta (reproduces _middleware.buildNewsletterMeta + client setMeta) ──
function buildMeta(issue, date) {
  var url   = BASE + '/newsletter-issue?date=' + (issue.issueDate || date);
  var title = 'Issue #' + issue.issueNumber + ' · Catch The Wick™ | FortitudeFX';
  var raw   = issue.mindsetLine || (issue.weekInMarkets && issue.weekInMarkets.content) ||
              'FortitudeFX bi-weekly intelligence brief — markets, mindset, lifestyle, and the Catch The Wick framework.';
  var desc  = String(raw).replace(/<[^>]+>/g, '').slice(0, 160);
  var jsonld = '<script type="application/ld+json">' + jsonLdSafe({
    '@context': 'https://schema.org', '@type': 'Article',
    headline: 'Issue #' + issue.issueNumber + ' — Catch The Wick Bi-Weekly Brief',
    description: desc, image: OG_IMG, datePublished: issue.issueDate,
    author: { '@type': 'Person', name: 'Salman Khan', url: BASE },
    publisher: { '@type': 'Organization', name: SITE + '™', url: BASE,
      logo: { '@type': 'ImageObject', url: BASE + '/favicon-192x192.png' } },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url }, url: url
  }) + '</script>';
  return {
    title: attr(title), desc: attr(desc), url: attr(url), jsonld: jsonld,
    issueNum: htmlText('Issue #' + issue.issueNumber),
    h1title:  htmlText('Issue #' + issue.issueNumber + ' — Catch The Wick™ Bi-Weekly Brief'),
    heroMeta: htmlText(formatDate(issue.issueDate) + ' · Bi-Weekly Intelligence Brief'),
    breadcrumb: htmlText(formatDate(issue.issueDate))
  };
}

// ── Issue body (reproduces newsletter-issue.html:377-529 exactly) ───────────────
function buildBody(issue) {
  var html = '';

  if (issue.weekInMarkets && issue.weekInMarkets.content) {
    html += section(
      sectionLabel('&#128200; Week in Markets', '#e06b1a'),
      '<h2 class="ni-section-heading">What the market did — and what it told us.</h2>'
      + '<p class="ni-body-text">' + esc(issue.weekInMarkets.content) + '</p>'
      + (issue.weekInMarkets.sourceUrl
        ? '<a href="' + esc(issue.weekInMarkets.sourceUrl) + '" target="_blank" class="ni-source-link" style="color:#e06b1a;">Via ' + esc(issue.weekInMarkets.sourceLabel || 'Source') + ' &rarr;</a>'
        : ''));
  }

  if (issue.onThisDay && issue.onThisDay.event) {
    html += section(
      sectionLabel('&#128337; On This Day in Markets — ' + (issue.onThisDay.year || ''), '#c9a84c'),
      '<div class="ni-gold-card">'
      + '<div class="ni-gold-card-title">' + esc(issue.onThisDay.event) + '</div>'
      + (issue.onThisDay.lesson ? '<div class="ni-gold-card-body">' + esc(issue.onThisDay.lesson) + '</div>' : '')
      + (issue.onThisDay.wikiUrl ? '<a href="' + esc(issue.onThisDay.wikiUrl) + '" target="_blank" class="ni-source-link" style="color:#c9a84c;">Read on Wikipedia &rarr;</a>' : '')
      + '</div>');
  }

  if (issue.trendingQ && issue.trendingQ.question) {
    html += section(
      sectionLabel('&#10067; Trending Question', '#7a5cff'),
      '<div class="ni-pull-quote">'
      + '<span class="ni-pull-quote-mark">&ldquo;</span>'
      + '<div class="ni-pull-quote-question">' + esc(issue.trendingQ.question) + '</div>'
      + '<div class="ni-pull-quote-divider"></div>'
      + '<p class="ni-pull-quote-answer">' + esc(issue.trendingQ.answer) + '</p>'
      + '</div>'
      + (issue.trendingQ.relatedArticleSlug
        ? '<a href="/article?slug=' + esc(issue.trendingQ.relatedArticleSlug) + '" class="ni-article-link">&#128196; Related: ' + esc(issue.trendingQ.relatedArticleTitle || '') + ' &rarr;</a>'
        : ''));
  }

  if (issue.exclusiveArticle && issue.exclusiveArticle.title) {
    var fullText = issue.exclusiveArticle.fullText || '';
    var hookText = issue.exclusiveArticle.hookText || fullText.substring(0, 300);
    var hasMore  = fullText && fullText.length > hookText.length;
    html += '<div class="ni-exclusive" id="exclusive">'
      + '<div class="ni-exclusive-header">'
      + '<div class="ni-exclusive-badge">&#11088; Newsletter Exclusive</div>'
      + '<h2 class="ni-exclusive-title">' + esc(issue.exclusiveArticle.title) + '</h2>'
      + '</div>'
      + '<div class="ni-exclusive-body">'
      + '<p class="ni-exclusive-text">' + esc(hookText) + '</p>'
      + (hasMore
        ? '<div class="ni-exclusive-full" id="exclusiveFull">'
          + fullText.split('\n').filter(function(p){ return p.trim(); }).map(function(p){ return '<p class="ni-exclusive-text">' + esc(p) + '</p>'; }).join('')
          + '</div>'
          + '<button class="ni-exclusive-toggle" onclick="toggleExclusive(this)" id="exclusiveBtn">Read the full editorial &darr;</button>'
        : '')
      + (issue.exclusiveArticle.relatedArticleSlug
        ? '<a href="/article?slug=' + esc(issue.exclusiveArticle.relatedArticleSlug) + '" class="ni-article-link" style="margin-top:16px;display:inline-flex;">&#128196; Related: ' + esc(issue.exclusiveArticle.relatedArticleTitle || '') + ' &rarr;</a>'
        : '')
      + '</div>'
      + '</div>';
  }

  if (issue.setup && issue.setup.hasSetup) {
    html += section(
      sectionLabel('&#128200; Setup of the Fortnight', '#c9a84c'),
      (issue.setup.imageUrl ? '<img src="' + esc(issue.setup.imageUrl) + '" alt="Chart Setup" style="width:100%;border-radius:10px;border:1px solid rgba(255,255,255,0.09);margin-bottom:14px;display:block;" />' : '')
      + (issue.setup.note ? '<p class="ni-body-text">' + esc(issue.setup.note) + '</p>' : ''));
  }

  if (issue.articles && issue.articles.length > 0) {
    html += section(
      sectionLabel('&#128196; This Fortnight on the Blog', '#7a5cff'),
      '<div class="ni-article-grid">'
      + issue.articles.map(function(a) {
        return '<a href="' + esc(a.url) + '" class="ni-article-card">'
          + '<div class="ni-article-cat">' + esc(a.category || 'Strategy') + '</div>'
          + '<div class="ni-article-content">'
          + '<div class="ni-article-title">' + esc(a.title) + '</div>'
          + (a.excerpt ? '<div class="ni-article-excerpt">' + esc(a.excerpt.substring(0,110)) + '&hellip;</div>' : '')
          + '<div class="ni-article-cta">Read article &rarr;</div>'
          + '</div></a>';
      }).join('')
      + '</div>');
  }

  var ls = issue.lifestyle || {};
  var lsDefs = [
    { key:'travel',        label:'Trading Freedom — Travel & Destination', color:'#e06b1a', bg:'#1a0e08' },
    { key:'luxury',        label:'Luxury',                                       color:'#c9a84c', bg:'#1a1608' },
    { key:'women',         label:'Women & Lifestyle',                            color:'#7a5cff', bg:'#0f0c1f' },
    { key:'tech',          label:'Tech & AI',                                    color:'#38bdf8', bg:'#071820' },
    { key:'fitness',       label:'Fitness, Diet & Mindset',                     color:'#3ecf8e', bg:'#081a12' },
    { key:'entertainment', label:'Entertainment',                               color:'#a855f7', bg:'#160d1f' },
  ];
  var hasLifestyle = lsDefs.some(function(d) { return ls[d.key] && ls[d.key].title; });
  if (hasLifestyle) {
    html += '<div class="ni-section">'
      + '<div class="ni-lifestyle-header">'
      + '<div class="ni-section-label" style="color:#c9a84c;">&#127774; The Lifestyle Edit<span style="flex:1;height:1px;background:linear-gradient(90deg,rgba(201,168,76,0.25),transparent);display:inline-block;margin-left:12px;"></span></div>'
      + '<p class="ni-body-text" style="margin:0;">The life the consistency builds toward.</p>'
      + '</div>'
      + '<div class="ni-lifestyle-grid">';
    lsDefs.forEach(function(d) {
      var data = ls[d.key] || {};
      if (!data.title) return;
      html += '<div class="ni-ls-card" style="background:' + d.bg + ';">'
        + '<div class="ni-ls-bar" style="background:' + d.color + ';">'
        + '<div class="ni-ls-label">' + esc(d.label) + '</div>'
        + '</div>'
        + (data.imageUrl ? '<img src="' + esc(data.imageUrl) + '" alt="' + esc(d.label) + '" class="ni-ls-img" />' : '')
        + '<div class="ni-ls-body">'
        + '<div class="ni-ls-title">' + esc(data.title) + '</div>'
        + '<div class="ni-ls-text">' + esc(data.body || '') + '</div>'
        + (data.sourceUrl ? '<a href="' + esc(data.sourceUrl) + '" target="_blank" class="ni-ls-link" style="color:' + d.color + ';">Via ' + esc(data.sourceLabel || 'Source') + ' &rarr;</a>' : '')
        + '</div>'
        + '</div>';
    });
    html += '</div></div>';
  }

  if (issue.mindsetLine) {
    html += '<div class="ni-mindset">'
      + '<div class="ni-mindset-label">FFX Mindset Line</div>'
      + '<div class="ni-mindset-text">&ldquo;' + esc(issue.mindsetLine) + '&rdquo;</div>'
      + '</div>';
  }

  html += '<div class="ni-issue-nav">'
    + '<a href="/newsletter">&#8592; All Issues</a>'
    + (issue.prevIssueDate ? '<a href="/newsletter-issue?date=' + esc(issue.prevIssueDate) + '">Previous Issue &rarr;</a>' : '<span></span>')
    + '</div>';

  html += '<div class="ni-discord-cta">'
    + '<div class="ni-discord-title">Not in the Discord yet?</div>'
    + '<p class="ni-discord-body">Join the free FortitudeFX community. Real-time chart markups, daily recaps, direct access.</p>'
    + '<a href="/joinfree.html" class="btn btn-joinfree">Join Free &rarr;</a>'
    + '</div>';

  return html;
}

// newsletter-issue.html spliced byte-for-byte at build time, with per-issue
// {{TITLE}}/{{DESC}}/{{URL}}/{{JSONLD}}/{{ISSUENUM}}/{{H1TITLE}}/{{HEROMETA}}/{{BREADCRUMB}}/{{BODY}} markers.
const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{TITLE}}</title>
  <meta name="description" content="{{DESC}}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="{{URL}}" id="canonicalTag" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="{{URL}}" id="ogUrl" />
  <meta property="og:title" content="{{TITLE}}" id="ogTitle" />
  <meta property="og:description" content="{{DESC}}" id="ogDesc" />
  <meta property="og:image" content="https://fortitudefx.com/og-fortitudefx.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="FortitudeFX — Catch The Wick mechanical forex trading system" />
  <meta property="og:site_name" content="FortitudeFX™" />
  <meta property="og:locale" content="en_US" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@_fortitudefx" />
  <meta name="twitter:title" content="{{TITLE}}" id="twTitle" />
  <meta name="twitter:description" content="{{DESC}}" id="twDesc" />
  <meta name="twitter:image" content="https://fortitudefx.com/og-fortitudefx.png" />
  <meta name="twitter:image:alt" content="FortitudeFX — Catch The Wick mechanical forex trading system" />
  <meta name="theme-color" content="#0d0d14" />
  <link rel="stylesheet" href="/styles-base.css" />
  <link rel="stylesheet" href="/styles-components.css" />
  <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  <style>
    /* ── Issue hero ─────────────────────────────────────────────── */
    .ni-hero {
      padding: 100px 24px 60px;
      position: relative; z-index: 1;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    .ni-hero-wrap { max-width: 860px; margin: 0 auto; }
    .ni-breadcrumb {
      margin-bottom: 32px; font-size: 13px; color: rgba(255,255,255,0.30);
      display: flex; align-items: center; gap: 8px;
    }
    .ni-breadcrumb a { color: rgba(255,255,255,0.40); text-decoration: none; transition: color 0.20s; }
    .ni-breadcrumb a:hover { color: rgba(255,255,255,0.70); }
    .ni-issue-badge {
      display: inline-flex; align-items: center; gap: 10px;
      margin-bottom: 20px;
    }
    .ni-badge-tag {
      font-size: 10px; font-weight: 700; letter-spacing: 0.22em;
      text-transform: uppercase; color: rgba(201,168,76,0.90);
      border: 1px solid rgba(201,168,76,0.30); background: rgba(201,168,76,0.08);
      border-radius: 4px; padding: 4px 12px;
    }
    .ni-badge-num { font-size: 11px; color: rgba(255,255,255,0.28); }
    .ni-hero-title {
      font-size: clamp(2.8rem, 6vw, 5rem); font-weight: 800;
      letter-spacing: -0.05em; line-height: 0.94; color: #ffffff;
      margin: 0 0 16px;
    }
    .ni-hero-meta { font-size: 14px; color: rgba(255,255,255,0.35); }

    /* ── Content layout ──────────────────────────────────────────── */
    .ni-body { max-width: 860px; margin: 0 auto; padding: 0 24px 100px; }

    /* ── Section block ───────────────────────────────────────────── */
    .ni-section { margin-bottom: 64px; }
    .ni-section-label {
      display: flex; align-items: center; gap: 12px;
      font-size: 10px; font-weight: 700; letter-spacing: 0.22em;
      text-transform: uppercase; margin-bottom: 20px;
    }
    .ni-section-label::after {
      content: ''; flex: 1; height: 1px;
      background: linear-gradient(90deg, rgba(255,255,255,0.12), transparent);
    }
    .ni-section-heading {
      font-size: clamp(1.4rem, 3vw, 2rem); font-weight: 700;
      color: #ffffff; letter-spacing: -0.03em; line-height: 1.20;
      margin: 0 0 16px;
    }
    .ni-body-text {
      font-size: 1.04rem; color: rgba(255,255,255,0.72);
      line-height: 1.88; margin: 0 0 16px;
    }
    .ni-source-link {
      font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; text-decoration: none;
      transition: opacity 0.20s;
    }
    .ni-source-link:hover { opacity: 0.70; }
    .ni-article-link {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 13px; font-weight: 700; color: #7a5cff;
      text-decoration: none; margin-top: 8px;
    }

    /* ── Gold card — On This Day ─────────────────────────────────── */
    .ni-gold-card {
      border-left: 4px solid rgba(201,168,76,0.80);
      background: rgba(201,168,76,0.05);
      border-radius: 0 12px 12px 0; padding: 22px 28px;
    }
    .ni-gold-card-title {
      font-size: 1.15rem; font-weight: 700;
      color: rgba(232,210,140,0.95); margin-bottom: 10px; line-height: 1.35;
    }
    .ni-gold-card-body {
      font-size: 1.00rem; color: rgba(255,255,255,0.65);
      line-height: 1.80; margin-bottom: 14px;
    }

    /* ── Pull quote — Trending Question ──────────────────────────── */
    .ni-pull-quote {
      background: rgba(122,92,255,0.06);
      border: 1px solid rgba(122,92,255,0.16);
      border-radius: 16px; padding: 32px 36px; margin-bottom: 20px;
    }
    .ni-pull-quote-mark {
      font-size: 72px; color: rgba(122,92,255,0.30);
      line-height: 0.8; margin-bottom: 8px; display: block;
      font-family: Georgia, serif;
    }
    .ni-pull-quote-question {
      font-size: clamp(1.2rem, 2.5vw, 1.6rem); font-weight: 700;
      color: #ffffff; letter-spacing: -0.02em; line-height: 1.25;
      margin: 0 0 20px;
    }
    .ni-pull-quote-divider {
      height: 1px; background: rgba(122,92,255,0.20); margin-bottom: 20px;
    }
    .ni-pull-quote-answer {
      font-size: 1.04rem; color: rgba(255,255,255,0.75);
      line-height: 1.88; margin: 0;
    }

    /* ── Exclusive editorial — centrepiece ───────────────────────── */
    .ni-exclusive {
      border: 1px solid rgba(201,168,76,0.25);
      border-top: 3px solid #c9a84c;
      background: rgba(201,168,76,0.04);
      border-radius: 0 0 16px 16px;
      overflow: hidden; margin-bottom: 64px;
    }
    .ni-exclusive-header {
      background: #0a0a12; padding: 28px 36px;
      border-bottom: 1px solid rgba(201,168,76,0.15);
    }
    .ni-exclusive-badge {
      display: inline-block; background: #c9a84c; color: #000000;
      font-size: 9px; font-weight: 700; letter-spacing: 0.22em;
      text-transform: uppercase; padding: 4px 12px; border-radius: 3px;
      margin-bottom: 14px;
    }
    .ni-exclusive-title {
      font-size: clamp(1.6rem, 3.5vw, 2.4rem); font-weight: 800;
      color: #ffffff; letter-spacing: -0.04em; line-height: 1.10;
      margin: 0;
    }
    .ni-exclusive-body { padding: 28px 36px; }
    .ni-exclusive-text {
      font-size: 1.06rem; color: rgba(255,255,255,0.75);
      line-height: 1.90; margin: 0 0 20px;
    }
    /* Expandable — show full text */
    .ni-exclusive-toggle {
      font-size: 13px; font-weight: 700; color: #c9a84c;
      cursor: pointer; background: none; border: none;
      padding: 0; letter-spacing: 0.04em; text-decoration: underline;
      text-underline-offset: 3px;
    }
    .ni-exclusive-full { display: none; margin-top: 16px; }
    .ni-exclusive-full.is-open { display: block; }

    /* ── Article cards ───────────────────────────────────────────── */
    .ni-article-grid { display: flex; flex-direction: column; gap: 14px; }
    .ni-article-card {
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 12px; overflow: hidden; text-decoration: none;
      display: block; transition: border-color 0.20s, transform 0.20s cubic-bezier(0.22,1,0.36,1);
    }
    .ni-article-card:hover { border-color: rgba(201,168,76,0.30); transform: translateY(-2px); }
    .ni-article-cat {
      background: #1a1a2e; padding: 7px 16px;
      font-size: 9px; font-weight: 700; letter-spacing: 0.18em;
      text-transform: uppercase; color: #c9a84c;
    }
    .ni-article-content { background: rgba(255,255,255,0.03); padding: 16px 18px; }
    .ni-article-title {
      font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.88);
      margin-bottom: 6px; line-height: 1.35;
    }
    .ni-article-excerpt { font-size: 13px; color: rgba(255,255,255,0.45); line-height: 1.65; margin-bottom: 10px; }
    .ni-article-cta { font-size: 12px; font-weight: 700; color: #7a5cff; }

    /* ── Lifestyle grid ──────────────────────────────────────────── */
    .ni-lifestyle-header {
      margin-bottom: 20px; padding-bottom: 16px;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    .ni-lifestyle-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .ni-ls-card {
      border-radius: 12px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.07);
      transition: transform 0.24s cubic-bezier(0.22,1,0.36,1);
    }
    .ni-ls-card:hover { transform: translateY(-3px); }
    .ni-ls-bar { padding: 8px 16px; }
    .ni-ls-label { font-size: 9px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #ffffff; }
    .ni-ls-img { width: 100%; display: block; aspect-ratio: 16/9; object-fit: cover; }
    .ni-ls-body { padding: 14px 16px; }
    .ni-ls-title { font-size: 14px; font-weight: 700; color: rgba(255,255,255,0.88); margin-bottom: 6px; line-height: 1.3; }
    .ni-ls-text { font-size: 12px; color: rgba(255,255,255,0.50); line-height: 1.65; margin-bottom: 10px; }
    .ni-ls-link { font-size: 11px; font-weight: 700; text-decoration: none; letter-spacing: 0.06em; text-transform: uppercase; }

    /* ── Mindset block ───────────────────────────────────────────── */
    .ni-mindset {
      border-left: 4px solid rgba(201,168,76,0.70);
      background: rgba(201,168,76,0.05);
      border-radius: 0 14px 14px 0; padding: 24px 32px;
      margin-bottom: 64px;
    }
    .ni-mindset-label {
      font-size: 9px; font-weight: 700; letter-spacing: 0.20em;
      text-transform: uppercase; color: rgba(201,168,76,0.70); margin-bottom: 12px;
    }
    .ni-mindset-text {
      font-size: 1.3rem; font-weight: 700;
      color: rgba(232,210,140,0.95); line-height: 1.45; font-style: italic;
    }

    /* ── Nav between issues ──────────────────────────────────────── */
    .ni-issue-nav {
      display: flex; align-items: center; justify-content: space-between;
      padding-top: 32px; border-top: 1px solid rgba(255,255,255,0.07);
      margin-bottom: 64px;
    }
    .ni-issue-nav a {
      font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.40);
      text-decoration: none; transition: color 0.20s;
    }
    .ni-issue-nav a:hover { color: rgba(255,255,255,0.80); }

    /* ── Discord CTA ─────────────────────────────────────────────── */
    .ni-discord-cta {
      border: 1px solid rgba(122,92,255,0.22);
      background: rgba(122,92,255,0.05); border-radius: 18px;
      padding: 36px 40px; text-align: center; margin-bottom: 64px;
    }
    .ni-discord-title { font-size: 1.5rem; font-weight: 700; color: #ffffff; margin-bottom: 10px; letter-spacing: -0.02em; }
    .ni-discord-body { font-size: 1rem; color: rgba(255,255,255,0.45); line-height: 1.75; max-width: 400px; margin: 0 auto 22px; }

    /* ── Loading / error ─────────────────────────────────────────── */
    .ni-loading { padding: 100px 0; text-align: center; color: rgba(255,255,255,0.25); font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; }
    .ni-error { padding: 80px 0; text-align: center; }
    .ni-error-title { font-size: 1.4rem; font-weight: 700; color: rgba(248,113,113,0.80); margin-bottom: 10px; }
    .ni-error-body { font-size: 0.95rem; color: rgba(255,255,255,0.30); line-height: 1.7; }

    @media (max-width: 640px) {
      .ni-lifestyle-grid { grid-template-columns: 1fr; }
      .ni-pull-quote { padding: 22px 20px; }
      .ni-exclusive-header, .ni-exclusive-body { padding: 20px; }
      .ni-hero { padding: 80px 16px 40px; }
      .ni-body { padding: 0 16px 60px; }
    }
  </style>
{{JSONLD}}
</head>
<body class="page-home">

  <div class="ffx-bg" aria-hidden="true">
    <div class="ffx-glow ffx-glow-violet" style="width:700px;height:700px;top:-150px;right:-250px;opacity:0.55;"></div>
    <div class="ffx-glow ffx-glow-deep"   style="width:600px;height:600px;top:-100px;left:-300px;opacity:0.50;"></div>
    <div class="ffx-glow ffx-glow-mid"    style="width:800px;height:500px;top:800px;left:50%;transform:translateX(-50%);opacity:0.35;"></div>
  </div>

  <nav class="nav">
    <div class="nav-wrap">
      <div class="nav-brand"><a href="/">FORTITUDEFX</a></div>
      <div class="nav-center">
        <a href="/#about">About</a>
        <a href="/vipdiscord.html">VIP Discord</a>
        <a href="/bootcamp.html">Bootcamp</a>
        <a href="/blog.html">Blog</a>
        <a href="/newsletter">Newsletter</a>
      </div>
      <div class="nav-cta">
        <a class="nav-btn nav-btn-joinfree" href="/joinfree.html">Join Free</a>
        <a class="nav-btn nav-btn-primary"  href="/waitlist.html#form">Join Waitlist</a>
      </div>
    </div>
  </nav>

  <div class="page-container">

    <!-- Hero -->
    <div class="ni-hero">
      <div class="ni-hero-wrap">
        <div class="ni-breadcrumb">
          <a href="/newsletter">Newsletter</a>
          <span>›</span>
          <span id="breadcrumbDate">{{BREADCRUMB}}</span>
        </div>
        <div class="ni-issue-badge">
          <span class="ni-badge-tag">Intelligence Brief</span>
          <span class="ni-badge-num" id="issueNum">{{ISSUENUM}}</span>
        </div>
        <h1 class="ni-hero-title">{{H1TITLE}}</h1>
        <div class="ni-hero-meta" id="heroMeta">{{HEROMETA}}</div>
      </div>
    </div>

    <!-- Body -->
    <div class="ni-body" style="padding-top:56px;">
      <div id="issueContent">{{BODY}}</div>
    </div>

  </div>

  <footer style="position:relative;z-index:2;padding:40px 24px 32px;text-align:center;">
    <p style="font-family:Arial,sans-serif;font-size:12px;color:rgba(255,255,255,0.22);">&copy; 2026 FortitudeFX&trade;. All rights reserved. &middot; <a href="/about.html" style="color:rgba(255,255,255,0.30);text-decoration:none;">About</a> &middot; <a href="/privacy.html" style="color:rgba(255,255,255,0.30);text-decoration:none;">Privacy</a> &middot; <a href="/disclaimer.html" style="color:rgba(255,255,255,0.30);text-decoration:none;">Disclaimer</a> &middot; <a href="https://www.youtube.com/@FortitudeFX" target="_blank" rel="noopener" style="color:rgba(255,255,255,0.30);text-decoration:none;">YouTube</a></p>
    <p style="font-family:Arial,sans-serif;max-width:820px;margin:14px auto 0;font-size:11px;line-height:1.6;color:rgba(255,255,255,0.28);">Educational content only — not financial advice. FortitudeFX&trade; provides trading education based on price-action methodology. Nothing here is financial, investment, or trading advice, or a recommendation to buy or sell any instrument. Trading forex carries a high level of risk and can result in the loss of some or all of your capital; it is not suitable for everyone. Past performance is not indicative of future results. Always do your own research and consider seeking advice from an independent, licensed financial professional before trading. You are solely responsible for your own trading decisions.</p>
  </footer>

<script>
document.addEventListener('DOMContentLoaded', async function() {
  var params = new URLSearchParams(window.location.search);
  var date   = params.get('date');
  var el     = document.getElementById('issueContent');

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    el.innerHTML = '<div class="ni-error"><div class="ni-error-title">Issue not found.</div><div class="ni-error-body">No date specified. <a href="/newsletter" style="color:#7a5cff;">View all issues &rarr;</a></div></div>';
    return;
  }

  document.getElementById('breadcrumbDate').textContent = formatDate(date);

  try {
    var res  = await fetch('/api/newsletter?date=' + encodeURIComponent(date));
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); } catch(e) {
      el.innerHTML = '<div class="ni-error"><div class="ni-error-title">Could not load issue.</div></div>';
      return;
    }
    if (!res.ok || !data.issue) {
      el.innerHTML = '<div class="ni-error"><div class="ni-error-title">Issue not found.</div><div class="ni-error-body"><a href="/newsletter" style="color:#7a5cff;">View all issues &rarr;</a></div></div>';
      return;
    }
    renderIssue(data.issue, el);
  } catch(err) {
    el.innerHTML = '<div class="ni-error"><div class="ni-error-title">Network error.</div><div class="ni-error-body">' + esc(err.message) + '</div></div>';
  }
});

function renderIssue(issue, el) {
  document.title = 'Issue #' + issue.issueNumber + ' \u00b7 Catch The Wick\u2122 | FortitudeFX';
  // ── Per-issue SEO meta (client-side; middleware SSRs the same for crawlers) ──
  try {
    var issueUrl = 'https://fortitudefx.com/newsletter-issue?date=' + (issue.issueDate || '');
    var issueTitle = 'Issue #' + issue.issueNumber + ' \u00b7 Catch The Wick\u2122 | FortitudeFX';
    var issueDesc = (issue.mindsetLine || (issue.weekInMarkets && issue.weekInMarkets.content) ||
      'FortitudeFX bi-weekly intelligence brief — markets, mindset, lifestyle, and the Catch The Wick framework.');
    issueDesc = String(issueDesc).replace(/<[^>]+>/g, '').slice(0, 160);
    var setMeta = function(id, val) { var e = document.getElementById(id); if (e) e.setAttribute(id === 'canonicalTag' ? 'href' : 'content', val); };
    setMeta('canonicalTag', issueUrl);
    setMeta('ogUrl', issueUrl);
    setMeta('ogTitle', issueTitle);
    setMeta('twTitle', issueTitle);
    setMeta('ogDesc', issueDesc);
    setMeta('twDesc', issueDesc);
    var md = document.querySelector('meta[name="description"]'); if (md) md.setAttribute('content', issueDesc);
  } catch (e) {}
  document.getElementById('issueNum').textContent   = 'Issue #' + issue.issueNumber;
  document.getElementById('heroMeta').textContent   = formatDate(issue.issueDate) + ' \u00b7 Bi-Weekly Intelligence Brief';
  document.getElementById('breadcrumbDate').textContent = formatDate(issue.issueDate);

  var html = '';

  // ── 1. Week in Markets ─────────────────────────────────────────────
  if (issue.weekInMarkets && issue.weekInMarkets.content) {
    html += section(
      sectionLabel('&#128200; Week in Markets', '#e06b1a'),
      '<h2 class="ni-section-heading">What the market did \u2014 and what it told us.</h2>'
      + '<p class="ni-body-text">' + esc(issue.weekInMarkets.content) + '</p>'
      + (issue.weekInMarkets.sourceUrl
        ? '<a href="' + esc(issue.weekInMarkets.sourceUrl) + '" target="_blank" class="ni-source-link" style="color:#e06b1a;">Via ' + esc(issue.weekInMarkets.sourceLabel || 'Source') + ' &rarr;</a>'
        : '')
    );
  }

  // ── 2. On This Day ─────────────────────────────────────────────────
  if (issue.onThisDay && issue.onThisDay.event) {
    html += section(
      sectionLabel('&#128337; On This Day in Markets \u2014 ' + (issue.onThisDay.year || ''), '#c9a84c'),
      '<div class="ni-gold-card">'
      + '<div class="ni-gold-card-title">' + esc(issue.onThisDay.event) + '</div>'
      + (issue.onThisDay.lesson ? '<div class="ni-gold-card-body">' + esc(issue.onThisDay.lesson) + '</div>' : '')
      + (issue.onThisDay.wikiUrl ? '<a href="' + esc(issue.onThisDay.wikiUrl) + '" target="_blank" class="ni-source-link" style="color:#c9a84c;">Read on Wikipedia &rarr;</a>' : '')
      + '</div>'
    );
  }

  // ── 3. Trending Question ───────────────────────────────────────────
  if (issue.trendingQ && issue.trendingQ.question) {
    html += section(
      sectionLabel('&#10067; Trending Question', '#7a5cff'),
      '<div class="ni-pull-quote">'
      + '<span class="ni-pull-quote-mark">&ldquo;</span>'
      + '<div class="ni-pull-quote-question">' + esc(issue.trendingQ.question) + '</div>'
      + '<div class="ni-pull-quote-divider"></div>'
      + '<p class="ni-pull-quote-answer">' + esc(issue.trendingQ.answer) + '</p>'
      + '</div>'
      + (issue.trendingQ.relatedArticleSlug
        ? '<a href="/article?slug=' + esc(issue.trendingQ.relatedArticleSlug) + '" class="ni-article-link">&#128196; Related: ' + esc(issue.trendingQ.relatedArticleTitle || '') + ' &rarr;</a>'
        : '')
    );
  }

  // ── 4. Newsletter Exclusive ────────────────────────────────────────
  if (issue.exclusiveArticle && issue.exclusiveArticle.title) {
    var hookText = issue.exclusiveArticle.hookText || issue.exclusiveArticle.fullText.substring(0, 300);
    var fullText = issue.exclusiveArticle.fullText || '';
    var hasMore  = fullText && fullText.length > hookText.length;

    html += '<div class="ni-exclusive" id="exclusive">'
      + '<div class="ni-exclusive-header">'
      + '<div class="ni-exclusive-badge">&#11088; Newsletter Exclusive</div>'
      + '<h2 class="ni-exclusive-title">' + esc(issue.exclusiveArticle.title) + '</h2>'
      + '</div>'
      + '<div class="ni-exclusive-body">'
      + '<p class="ni-exclusive-text">' + esc(hookText) + '</p>'
      + (hasMore
        ? '<div class="ni-exclusive-full" id="exclusiveFull">'
          + fullText.split('\n').filter(function(p){ return p.trim(); }).map(function(p){ return '<p class="ni-exclusive-text">' + esc(p) + '</p>'; }).join('')
          + '</div>'
          + '<button class="ni-exclusive-toggle" onclick="toggleExclusive(this)" id="exclusiveBtn">Read the full editorial &darr;</button>'
        : '')
      + (issue.exclusiveArticle.relatedArticleSlug
        ? '<a href="/article?slug=' + esc(issue.exclusiveArticle.relatedArticleSlug) + '" class="ni-article-link" style="margin-top:16px;display:inline-flex;">&#128196; Related: ' + esc(issue.exclusiveArticle.relatedArticleTitle || '') + ' &rarr;</a>'
        : '')
      + '</div>'
      + '</div>';
  }

  // ── 5. Setup of the Fortnight ──────────────────────────────────────
  if (issue.setup && issue.setup.hasSetup) {
    html += section(
      sectionLabel('&#128200; Setup of the Fortnight', '#c9a84c'),
      (issue.setup.imageUrl ? '<img src="' + esc(issue.setup.imageUrl) + '" alt="Chart Setup" style="width:100%;border-radius:10px;border:1px solid rgba(255,255,255,0.09);margin-bottom:14px;display:block;" />' : '')
      + (issue.setup.note ? '<p class="ni-body-text">' + esc(issue.setup.note) + '</p>' : '')
    );
  }

  // ── 6. Articles ────────────────────────────────────────────────────
  if (issue.articles && issue.articles.length > 0) {
    html += section(
      sectionLabel('&#128196; This Fortnight on the Blog', '#7a5cff'),
      '<div class="ni-article-grid">'
      + issue.articles.map(function(a) {
        return '<a href="' + esc(a.url) + '" class="ni-article-card">'
          + '<div class="ni-article-cat">' + esc(a.category || 'Strategy') + '</div>'
          + '<div class="ni-article-content">'
          + '<div class="ni-article-title">' + esc(a.title) + '</div>'
          + (a.excerpt ? '<div class="ni-article-excerpt">' + esc(a.excerpt.substring(0,110)) + '&hellip;</div>' : '')
          + '<div class="ni-article-cta">Read article &rarr;</div>'
          + '</div></a>';
      }).join('')
      + '</div>'
    );
  }

  // ── 7. Lifestyle Edit ──────────────────────────────────────────────
  var ls = issue.lifestyle || {};
  var lsDefs = [
    { key:'travel',        label:'Trading Freedom \u2014 Travel & Destination', color:'#e06b1a', bg:'#1a0e08' },
    { key:'luxury',        label:'Luxury',                                       color:'#c9a84c', bg:'#1a1608' },
    { key:'women',         label:'Women & Lifestyle',                            color:'#7a5cff', bg:'#0f0c1f' },
    { key:'tech',          label:'Tech & AI',                                    color:'#38bdf8', bg:'#071820' },
    { key:'fitness',       label:'Fitness, Diet & Mindset',                     color:'#3ecf8e', bg:'#081a12' },
    { key:'entertainment', label:'Entertainment',                               color:'#a855f7', bg:'#160d1f' },
  ];
  var hasLifestyle = lsDefs.some(function(d) { return ls[d.key] && ls[d.key].title; });
  if (hasLifestyle) {
    html += '<div class="ni-section">'
      + '<div class="ni-lifestyle-header">'
      + '<div class="ni-section-label" style="color:#c9a84c;">&#127774; The Lifestyle Edit<span style="flex:1;height:1px;background:linear-gradient(90deg,rgba(201,168,76,0.25),transparent);display:inline-block;margin-left:12px;"></span></div>'
      + '<p class="ni-body-text" style="margin:0;">The life the consistency builds toward.</p>'
      + '</div>'
      + '<div class="ni-lifestyle-grid">';
    lsDefs.forEach(function(d) {
      var data = ls[d.key] || {};
      if (!data.title) return;
      html += '<div class="ni-ls-card" style="background:' + d.bg + ';">'
        + '<div class="ni-ls-bar" style="background:' + d.color + ';">'
        + '<div class="ni-ls-label">' + esc(d.label) + '</div>'
        + '</div>'
        + (data.imageUrl ? '<img src="' + esc(data.imageUrl) + '" alt="' + esc(d.label) + '" class="ni-ls-img" />' : '')
        + '<div class="ni-ls-body">'
        + '<div class="ni-ls-title">' + esc(data.title) + '</div>'
        + '<div class="ni-ls-text">' + esc(data.body || '') + '</div>'
        + (data.sourceUrl ? '<a href="' + esc(data.sourceUrl) + '" target="_blank" class="ni-ls-link" style="color:' + d.color + ';">Via ' + esc(data.sourceLabel || 'Source') + ' &rarr;</a>' : '')
        + '</div>'
        + '</div>';
    });
    html += '</div></div>';
  }

  // ── 8. Mindset Line ────────────────────────────────────────────────
  if (issue.mindsetLine) {
    html += '<div class="ni-mindset">'
      + '<div class="ni-mindset-label">FFX Mindset Line</div>'
      + '<div class="ni-mindset-text">&ldquo;' + esc(issue.mindsetLine) + '&rdquo;</div>'
      + '</div>';
  }

  // ── Issue navigation ───────────────────────────────────────────────
  html += '<div class="ni-issue-nav">'
    + '<a href="/newsletter">&#8592; All Issues</a>'
    + (issue.prevIssueDate ? '<a href="/newsletter-issue?date=' + esc(issue.prevIssueDate) + '">Previous Issue &rarr;</a>' : '<span></span>')
    + '</div>';

  // ── Discord CTA ────────────────────────────────────────────────────
  html += '<div class="ni-discord-cta">'
    + '<div class="ni-discord-title">Not in the Discord yet?</div>'
    + '<p class="ni-discord-body">Join the free FortitudeFX community. Real-time chart markups, daily recaps, direct access.</p>'
    + '<a href="/joinfree.html" class="btn btn-joinfree">Join Free &rarr;</a>'
    + '</div>';

  el.innerHTML = html;
}

// ── Toggle exclusive full text ─────────────────────────────────────
function toggleExclusive(btn) {
  var full = document.getElementById('exclusiveFull');
  if (!full) return;
  var open = full.classList.toggle('is-open');
  btn.textContent = open ? 'Show less \u2191' : 'Read the full editorial \u2193';
}

// ── Helpers ────────────────────────────────────────────────────────
function section(labelHtml, contentHtml) {
  return '<div class="ni-section">' + labelHtml + contentHtml + '</div>';
}
function sectionLabel(text, color) {
  return '<div class="ni-section-label" style="color:' + (color || 'rgba(255,255,255,0.40)') + ';">' + text + '</div>';
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
}
</script>
</body>
</html>
`;

// ── Branded error responses (serve the real static assets, override status) ─────
async function serveAsset(request, path, status, extraHeaders) {
  var headers = Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {});
  try {
    var res = await fetch(new URL(path, request.url).toString(), { redirect: 'follow' });
    if (res.ok) return new Response(await res.text(), { status: status, headers: headers });
  } catch (e) {}
  var msg = status === 404 ? 'This page does not exist.' : 'Temporarily unavailable. Please try again.';
  return new Response('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>' + status
    + '</title><meta name="robots" content="noindex, nofollow"></head><body style="background:#0d0d14;color:#e8e4de;'
    + 'font-family:sans-serif;text-align:center;padding:80px 24px;"><h1>' + status + '</h1><p>' + msg
    + '</p><p><a href="/newsletter" style="color:#7a5cff;">All issues</a></p></body></html>',
    { status: status, headers: headers });
}
function serve404(request) { return serveAsset(request, '/404.html', 404, null); }
function serve503(request) { return serveAsset(request, '/503.html', 503, { 'Retry-After': '120' }); }

export async function onRequestGet(context) {
  var request = context.request;
  var url = new URL(request.url);
  var date = url.searchParams.get('date');

  // No date → a bare issue URL is not a resource → send to the index.
  if (!date) {
    return new Response(null, { status: 302, headers: { 'Location': '/newsletter', 'Cache-Control': 'no-store' } });
  }
  // Malformed date → genuinely not a valid issue id → honest 404.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return serve404(request);

  var res;
  try {
    res = await fetch(new URL('/api/newsletter?date=' + encodeURIComponent(date), request.url).toString(),
                      { headers: { 'Accept': 'application/json' } });
  } catch (e) { return serve503(request); }

  if (res.status === 404 || res.status === 400) return serve404(request); // missing / bad id
  if (!res.ok) return serve503(request);                                   // 5xx / KV error → transient

  var data;
  try { data = await res.json(); } catch (e) { return serve503(request); }
  if (!data || !data.issue) return serve404(request);
  var issue = data.issue;

  // BUILD fully in memory…
  var html;
  try {
    var m = buildMeta(issue, date);
    var body = buildBody(issue);
    html = TEMPLATE
      .split('{{TITLE}}').join(m.title)
      .split('{{DESC}}').join(m.desc)
      .split('{{URL}}').join(m.url)
      .split('{{JSONLD}}').join(m.jsonld)
      .split('{{ISSUENUM}}').join(m.issueNum)
      .split('{{H1TITLE}}').join(m.h1title)
      .split('{{HEROMETA}}').join(m.heroMeta)
      .split('{{BREADCRUMB}}').join(m.breadcrumb)
      .split('{{BODY}}').join(body); // BODY last — issue content can't contain markers
  } catch (e) { return serve503(request); }

  // …then VERIFY complete before sending. Never a partial/shell page.
  var titleOk  = html.indexOf('Issue #' + issue.issueNumber) !== -1;
  var bodyOk   = html.indexOf('id="issueContent">') !== -1 && html.indexOf('ni-discord-cta') !== -1;
  var noMarker = html.indexOf('{{') === -1;
  if (!titleOk || !bodyOk || !noMarker) return serve503(request);

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate' }
  });
}

// HEAD mirrors GET — identical status + headers, no body (honest status for HEAD).
export async function onRequestHead(context) {
  var res = await onRequestGet(context);
  return new Response(null, { status: res.status, headers: res.headers });
}
