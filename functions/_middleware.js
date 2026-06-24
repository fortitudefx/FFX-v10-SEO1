// ─────────────────────────────────────────────────────────────────────────────
// FFX SEO middleware — server-side <head> injection for crawlers & social scrapers
//
// WHY: /article and /newsletter-issue render their content + meta client-side.
// Crawlers (Googlebot first wave) and social scrapers (X, LinkedIn, Discord,
// WhatsApp, Facebook, Slack) DO NOT run JavaScript, so without this they see a
// generic shell. This middleware fetches the real data from the existing internal
// APIs and rewrites the static HTML <head> at the edge — correct title, description,
// canonical, Open Graph, Twitter card, and JSON-LD — before the response is sent.
//
// SAFETY: Only acts on exactly /article and /newsletter-issue GET requests with a
// param. Every other request returns context.next() untouched. All work is wrapped
// in try/catch — on ANY error it returns the original unmodified response, so it can
// never break a page. Worst case = current client-rendered behaviour (no regression).
// ─────────────────────────────────────────────────────────────────────────────

const OG_IMG = 'https://fortitudefx.com/og-fortitudefx.png';
const IMG_ALT = 'FortitudeFX — Catch The Wick mechanical forex trading system';
const SITE = 'FortitudeFX\u2122';

function attr(v) {
  // Safe for use inside an HTML attribute value
  return String(v == null ? '' : v).replace(/[<>"]/g, function (c) {
    return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
  }).replace(/\s+/g, ' ').trim();
}
function jsonLdSafe(obj) {
  // Escape < to prevent </script> breakout
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

// HTMLRewriter handlers
class SetAttr {
  constructor(name, value) { this.name = name; this.value = value; }
  element(el) { el.setAttribute(this.name, this.value); }
}
class SetText {
  constructor(value) { this.value = value; }
  element(el) { el.setInnerContent(this.value); }
}
class AppendHead {
  constructor(html) { this.html = html; }
  element(el) { el.append(this.html, { html: true }); }
}

function rewrite(response, meta) {
  let rw = new HTMLRewriter()
    .on('title', new SetText(meta.title))
    .on('meta[name="description"]', new SetAttr('content', meta.description))
    .on('link#canonicalTag', new SetAttr('href', meta.url))
    .on('meta[property="og:url"]', new SetAttr('content', meta.url))
    .on('meta[property="og:title"]', new SetAttr('content', meta.title))
    .on('meta[property="og:description"]', new SetAttr('content', meta.description))
    .on('meta[name="twitter:title"]', new SetAttr('content', meta.title))
    .on('meta[name="twitter:description"]', new SetAttr('content', meta.description));
  if (meta.noindex) {
    rw = rw.on('meta[name="robots"]', new SetAttr('content', 'noindex, nofollow'));
  }
  if (meta.jsonld) {
    rw = rw.on('head', new AppendHead(
      '<script type="application/ld+json">' + meta.jsonld + '</script>'
    ));
  }
  return rw.transform(response);
}

async function buildArticleMeta(request, slug) {
  const api = new URL('/article-content?slug=' + encodeURIComponent(slug), request.url);
  const r = await fetch(api.toString());
  if (!r.ok) return null;
  const data = await r.json();
  if (!data || !data.success || !data.article) return null;
  const a = data.article;
  const url = 'https://fortitudefx.com/article?slug=' + a.slug;
  const title = attr(a.title + ' | ' + SITE);
  const description = attr(a.excerpt || '');
  const jsonld = jsonLdSafe({
    '@context': 'https://schema.org', '@type': 'Article',
    headline: a.title, description: a.excerpt, image: OG_IMG,
    datePublished: a.date, dateModified: a.updatedAt || a.date,
    author: { '@type': 'Person', name: 'Salman Khan', url: 'https://fortitudefx.com' },
    publisher: { '@type': 'Organization', name: SITE, url: 'https://fortitudefx.com',
      logo: { '@type': 'ImageObject', url: 'https://fortitudefx.com/favicon-192x192.png' } },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url: url, keywords: Array.isArray(a.tags) ? a.tags.join(', ') : ''
  });
  return { title, description, url, jsonld, noindex: !!a.draft };
}

async function buildNewsletterMeta(request, date) {
  const api = new URL('/api/newsletter?date=' + encodeURIComponent(date), request.url);
  const r = await fetch(api.toString());
  if (!r.ok) return null;
  const data = await r.json();
  if (!data || !data.issue) return null;
  const i = data.issue;
  const url = 'https://fortitudefx.com/newsletter-issue?date=' + (i.issueDate || date);
  const title = attr('Issue #' + i.issueNumber + ' \u00b7 Catch The Wick\u2122 | FortitudeFX');
  let raw = i.mindsetLine || (i.weekInMarkets && i.weekInMarkets.content) ||
    'FortitudeFX bi-weekly intelligence brief — markets, mindset, lifestyle, and the Catch The Wick framework.';
  const description = attr(String(raw).replace(/<[^>]+>/g, '').slice(0, 160));
  const jsonld = jsonLdSafe({
    '@context': 'https://schema.org', '@type': 'Article',
    headline: 'Issue #' + i.issueNumber + ' — Catch The Wick Bi-Weekly Brief',
    description: description, image: OG_IMG, datePublished: i.issueDate,
    author: { '@type': 'Person', name: 'Salman Khan', url: 'https://fortitudefx.com' },
    publisher: { '@type': 'Organization', name: SITE, url: 'https://fortitudefx.com',
      logo: { '@type': 'ImageObject', url: 'https://fortitudefx.com/favicon-192x192.png' } },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url }, url: url
  });
  return { title, description, url, jsonld, noindex: false };
}

export async function onRequest(context) {
  const { request, next } = context;

  // Fast path: only intercept the two dynamic GET routes. Everything else passes through.
  let pathname;
  try { pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/'; }
  catch { return next(); }

  const isArticle = pathname === '/article';
  const isIssue = pathname === '/newsletter-issue';
  if (request.method !== 'GET' || (!isArticle && !isIssue)) return next();

  const response = await next();

  // Only rewrite successful HTML responses
  const ct = response.headers.get('content-type') || '';
  if (!response.ok || ct.indexOf('text/html') === -1) return response;

  try {
    const url = new URL(request.url);
    let meta = null;
    if (isArticle) {
      const slug = url.searchParams.get('slug');
      if (!slug) return response;
      meta = await buildArticleMeta(request, slug);
    } else {
      const date = url.searchParams.get('date');
      if (!date) return response;
      meta = await buildNewsletterMeta(request, date);
    }
    if (!meta) return response;           // data not found → serve static shell unchanged
    return rewrite(response, meta);
  } catch (err) {
    // Any failure → original response, never break the page
    return response;
  }
}
