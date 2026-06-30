#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// FFX — Pre-deploy SEO audit (RG / recurrence guard)
//
// Runs the SEO checks we used to do by hand, as a CRAWLER would: GET requests,
// Googlebot UA, inspecting the RAW BYTES (not a rendered DOM). PASS/FAIL per
// check; exits NON-ZERO if any check fails, so it can gate a deploy/merge.
//
// Usage:   node scripts/seo-audit.js <baseUrl>
//   preview:    node scripts/seo-audit.js https://redesign.ffx-v10-seo1.pages.dev
//   production: node scripts/seo-audit.js https://fortitudefx.com
//
// READ-ONLY: only fetches and inspects. No writes, no KV, no side effects.
// Plain Node (global fetch, Node 18+). No dependencies, no build step.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('Usage: node scripts/seo-audit.js <baseUrl>');
  process.exit(2);
}
const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SAMPLE_ARTICLES = 3;

// Known generic shell titles that must NEVER be what a crawler sees on a real page
const SHELL_TITLES = [
  'FortitudeFX™ — Trading Insights',
  'FFX Newsletter | FortitudeFX',
];

const results = [];
function record(name, pass, detail) { results.push({ name, pass: !!pass, detail: detail || '' }); }

async function get(path) {
  const url = path.startsWith('http') ? path : BASE + path;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }, redirect: 'manual' });
  let body = '';
  try { body = await res.text(); } catch {}
  return { status: res.status, location: res.headers.get('location'), body };
}

// ── byte-level inspectors ───────────────────────────────────────────────────
function getCanonical(html) {
  const tag = (html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i) || [])[0] || '';
  const href = (tag.match(/href=["']([^"']*)["']/i) || [])[1];
  return href; // undefined if no tag, '' if empty href
}
function getTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}
function jsonLdTypes(html) {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const types = [];
  for (const b of blocks) {
    const inner = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try { const o = JSON.parse(inner); if (o && o['@type']) types.push(o['@type']); else types.push('(untyped)'); }
    catch { types.push('(unparseable)'); }
  }
  return types; // e.g. ['Article','BreadcrumbList']
}
function articleLinks(html) {
  // real article hrefs only — slug chars [a-z0-9-]; ignores client-JS template strings
  const m = html.match(/href=["']\/article\?slug=[a-z0-9-]+["']/gi) || [];
  return [...new Set(m)];
}
function locs(xml) {
  return (xml.match(/<loc>([^<]+)<\/loc>/gi) || []).map(s => s.replace(/<\/?loc>/gi, ''));
}

// ── checks ──────────────────────────────────────────────────────────────────
async function checkArticle(slug) {
  const tag = 'article[' + slug.slice(0, 28) + ']';
  const r = await get('/article?slug=' + encodeURIComponent(slug));
  if (r.status !== 200) { record(tag + ' 200', false, 'status ' + r.status); return; }

  const canon = getCanonical(r.body);
  record(tag + ' canonical non-empty', canon && canon.length > 0, 'href=' + JSON.stringify(canon));

  const title = getTitle(r.body);
  record(tag + ' real <title>', title && !SHELL_TITLES.includes(title), JSON.stringify(title));

  const hasBody = /class=["']article-body/.test(r.body) && /<h1>/.test(r.body);
  record(tag + ' body in raw bytes', hasBody, hasBody ? 'article-body + <h1> present' : 'MISSING (client-only?)');

  const types = jsonLdTypes(r.body);
  const dupes = types.filter((t, i) => types.indexOf(t) !== i);
  record(tag + ' JSON-LD present, no dupes', types.length > 0 && dupes.length === 0,
    'types=[' + types.join(',') + ']' + (dupes.length ? ' DUPLICATE:' + dupes.join(',') : ''));
}

async function checkBadSlug() {
  const r = await get('/article?slug=__seo_audit_nonexistent_' + Date.now() + '__');
  record('garbage slug → real 404', r.status === 404, 'status ' + r.status + (r.status === 200 ? ' (200 SHELL — soft-404!)' : ''));
}

async function checkBlog() {
  const r = await get('/blog');
  record('/blog 200', r.status === 200, 'status ' + r.status);
  if (r.status !== 200) return;
  record('/blog canonical non-empty', !!getCanonical(r.body), 'href=' + JSON.stringify(getCanonical(r.body)));
  const title = getTitle(r.body);
  record('/blog real <title> (≤60)', title && !SHELL_TITLES.includes(title) && title.length <= 60, JSON.stringify(title) + ' (' + (title ? title.length : 0) + ' chars)');
  const links = articleLinks(r.body);
  record('/blog exposes article <a href> links', links.length > 0, links.length + ' real article links in bytes');
}

async function checkHome() {
  const r = await get('/');
  record('home 200', r.status === 200, 'status ' + r.status);
  if (r.status !== 200) return;
  record('home canonical non-empty', !!getCanonical(r.body), 'href=' + JSON.stringify(getCanonical(r.body)));
  record('home real <title>', !!getTitle(r.body), JSON.stringify(getTitle(r.body)));
  const links = articleLinks(r.body);
  record('home exposes article <a href> links', links.length > 0, links.length + ' real article links in bytes');
}

async function checkNewsletterIssue() {
  // honest-status checks always run
  const noDate = await get('/newsletter-issue');
  record('/newsletter-issue no-date → 302 /newsletter', noDate.status === 302 && /\/newsletter$/.test(noDate.location || ''), 'status ' + noDate.status + ' loc ' + noDate.location);
  const bad = await get('/newsletter-issue?date=__garbage__');
  record('/newsletter-issue garbage → real 404', bad.status === 404, 'status ' + bad.status);

  // content checks only if a published issue exists
  let dates = [];
  try { const idx = await get('/api/newsletter'); const j = JSON.parse(idx.body); dates = (j.issues || []).map(i => i.date || i.issueDate).filter(Boolean); } catch {}
  if (!dates.length) { record('/newsletter-issue content (SKIP — 0 published issues)', true, 'no issues to check; route returns honest 404'); return; }
  const r = await get('/newsletter-issue?date=' + encodeURIComponent(dates[0]));
  record('newsletter-issue[' + dates[0] + '] 200', r.status === 200, 'status ' + r.status);
  if (r.status !== 200) return;
  record('newsletter-issue canonical non-empty', !!getCanonical(r.body), 'href=' + JSON.stringify(getCanonical(r.body)));
  const title = getTitle(r.body);
  record('newsletter-issue real <title>', title && !SHELL_TITLES.includes(title), JSON.stringify(title));
  record('newsletter-issue body in raw bytes', /id=["']issueContent["']>/.test(r.body) && /ni-discord-cta/.test(r.body), 'issueContent populated');
  const types = jsonLdTypes(r.body);
  const dupes = types.filter((t, i) => types.indexOf(t) !== i);
  record('newsletter-issue JSON-LD present, no dupes', types.length > 0 && dupes.length === 0, 'types=[' + types.join(',') + ']');
}

async function checkSitemap() {
  const r = await get('/sitemap.xml');
  record('sitemap.xml 200', r.status === 200, 'status ' + r.status);
  if (r.status !== 200) return;
  const all = locs(r.body);
  const uniq = new Set(all);
  record('sitemap zero duplicate <loc>', all.length === uniq.size, all.length + ' total, ' + uniq.size + ' unique, ' + (all.length - uniq.size) + ' dupes');
}

// ── run ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\nFFX SEO audit — ' + BASE + '  (Googlebot UA, raw bytes)\n' + '='.repeat(64));
  let slugs = [];
  try {
    const a = await get('/articles');
    const j = JSON.parse(a.body);
    slugs = (j.articles || []).map(x => x.slug).filter(Boolean).slice(0, SAMPLE_ARTICLES);
  } catch (e) { record('/articles reachable for sampling', false, e.message); }
  if (!slugs.length) record('article sample available', false, 'could not read /articles');

  for (const s of slugs) await checkArticle(s);
  await checkBadSlug();
  await checkBlog();
  await checkHome();
  await checkNewsletterIssue();
  await checkSitemap();

  let fails = 0;
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) fails++;
    console.log(`  [${tag}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log('='.repeat(64));
  console.log(`  ${results.length - fails}/${results.length} passed` + (fails ? `  ·  ${fails} FAILED` : '  ·  ALL PASS'));
  console.log('');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('audit crashed:', e); process.exit(2); });
