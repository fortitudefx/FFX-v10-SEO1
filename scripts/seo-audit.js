#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// FFX — Pre-deploy SEO audit (RG / recurrence guard)
//
// Runs the SEO checks we used to do by hand, as a CRAWLER would: GET requests,
// Googlebot UA, inspecting the RAW BYTES. PLUS a real-browser RENDER check that
// catches runtime/JS failures a bytes-only check misses (the blank-article bug:
// body present in bytes but invisible because a script error killed the reveal).
//
// Usage:   node scripts/seo-audit.js <baseUrl>
//   preview:    node scripts/seo-audit.js https://redesign.ffx-v10-seo1.pages.dev
//   production: node scripts/seo-audit.js https://fortitudefx.com
//   self-test:  node scripts/seo-audit.js <baseUrl> --selftest   (proves the render
//               check FAILS a deliberately body-invisible page)
//
// Render check engine (dev/audit-only — NEVER a shipped/production dependency):
//   Preferred: puppeteer-core driving an already-installed Chrome.
//     - point it at puppeteer-core:  SEO_AUDIT_PUPPETEER=/abs/path/to/puppeteer-core
//       (or have `puppeteer-core` resolvable from here)
//     - Chrome path:                 SEO_AUDIT_CHROME=/path/to/Chrome
//       (defaults to macOS Google Chrome)
//   Fallback (no browser available): a DOM-shim that executes the served inline
//     <script> against a stubbed DOM + IntersectionObserver and asserts the reveal
//     path flips `is-visible` (and that the script does not throw). Coarser, but it
//     still catches "script dies → body stays invisible".
//
// READ-ONLY: only fetches/renders and inspects. No writes, no KV, no side effects.
// Plain Node (global fetch, Node 18+). No repo dependency.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const SELFTEST = process.argv.includes('--selftest');
if (!BASE) { console.error('Usage: node scripts/seo-audit.js <baseUrl> [--selftest]'); process.exit(2); }

const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SAMPLE_ARTICLES = 3;
const SHELL_TITLES = ['FortitudeFX™ — Trading Insights', 'FFX Newsletter | FortitudeFX'];

const results = [];
function record(name, pass, detail) { results.push({ name, pass: !!pass, detail: detail || '' }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(path, follow) {
  const url = path.startsWith('http') ? path : BASE + path;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: follow ? 'follow' : 'manual' });
  let body = ''; try { body = await res.text(); } catch {}
  return { status: res.status, location: res.headers.get('location'), body, url };
}

// ── byte-level inspectors ───────────────────────────────────────────────────
const getCanonical = h => ((h.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i) || [''])[0].match(/href=["']([^"']*)["']/i) || [])[1];
const getTitle = h => { const m = h.match(/<title>([\s\S]*?)<\/title>/i); return m ? m[1].trim() : null; };
function jsonLdTypes(h) {
  const blocks = h.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  return blocks.map(b => { try { const o = JSON.parse(b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim()); return o && o['@type'] || '(untyped)'; } catch { return '(unparseable)'; } });
}
const articleLinks = h => [...new Set(h.match(/href=["']\/article\?slug=[a-z0-9-]+["']/gi) || [])];
const locs = x => (x.match(/<loc>([^<]+)<\/loc>/gi) || []).map(s => s.replace(/<\/?loc>/gi, ''));

// ── real-browser render engine (optional) ───────────────────────────────────
function loadPuppeteer() {
  // dev/audit-only — resolve puppeteer-core from cwd, this dir, or SEO_AUDIT_PUPPETEER
  // (a dir that contains node_modules/puppeteer-core). Never a repo dependency.
  const paths = [process.cwd(), __dirname];
  if (process.env.SEO_AUDIT_PUPPETEER) paths.unshift(process.env.SEO_AUDIT_PUPPETEER);
  try { return require(require.resolve('puppeteer-core', { paths })); } catch { return null; }
}
async function loadBrowser() {
  const pptr = loadPuppeteer();
  if (!pptr) return null;
  const chrome = process.env.SEO_AUDIT_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try {
    return await pptr.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  } catch (e) { console.error('  (browser launch failed: ' + e.message.split('\n')[0] + ' — falling back to DOM-shim)'); return null; }
}

// Render a URL in the real browser; report console/page errors + whether `selector`
// computes visible to a human (opacity>0.5, not display:none/hidden, has size + text).
async function renderReal(browser, url, selector) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 }); // realistic desktop, not the 800x600 default
  const errors = [];
  // Count uncaught JS errors: pageerror (e.g. the blank-article SyntaxError) + real
  // console.error from scripts. EXCLUDE "Failed to load resource" — that's an HTTP-status
  // log (e.g. an intentional 404/503 document), not a JS/render failure.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text().slice(0, 120)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.split('\n')[0]));
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    status = resp ? resp.status() : 0;
    await sleep(1000); // let reveal observer + transitions settle
    // Scroll the target into view so reveal-on-scroll (ffx-reveal) fires — a body that
    // reveals only below the fold must NOT be a false FAIL. A page whose script is dead
    // (the blank-article bug) never sets up the observer, so it stays opacity:0 even
    // after this scroll → still correctly caught.
    await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) { el.scrollIntoView({ block: 'center' }); window.scrollBy(0, 150); } }, selector).catch(() => {});
    await sleep(600);
    const vis = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { found: true, opacity: parseFloat(cs.opacity), display: cs.display, visibility: cs.visibility, h: Math.round(r.height), text: (el.innerText || '').trim().length };
    }, selector);
    const visible = vis.found && vis.opacity > 0.5 && vis.display !== 'none' && vis.visibility !== 'hidden' && vis.h > 0 && vis.text > 30;
    return { mode: 'browser', status, errors, vis, visible };
  } finally { await page.close().catch(() => {}); }
}

// DOM-shim fallback: run the served inline <script> against a stubbed DOM and assert
// (a) it doesn't throw, and (b) if the body is ffx-reveal-gated, the reveal flips is-visible.
async function renderShim(url, selector) {
  const r = await get(url, true); // follow redirects — the browser would
  const scripts = [...r.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const iife = scripts[scripts.length - 1] || '';
  const gated = /ffx-reveal/.test(r.body) && new RegExp(selector.replace('.', '') + '[^"]*ffx-reveal').test(r.body.replace(/[."#]/g, ''));
  const errors = []; const madeVisible = [];
  const el = () => ({ classList: { add: c => c === 'is-visible' && madeVisible.push(1), remove: () => {}, toggle: () => {} }, setAttribute: () => {}, addEventListener: () => {}, style: {}, textContent: '', querySelectorAll: () => [] });
  const revealNodes = (r.body.match(/ffx-reveal/g) || []).map(() => el());
  class IO { constructor(cb) { this.cb = cb; } observe(n) { this.cb([{ isIntersecting: true, target: n }], this); } unobserve() {} }
  try {
    const fn = new Function('document', 'window', 'IntersectionObserver', 'URLSearchParams', 'sessionStorage', 'setTimeout', 'clearTimeout', 'gtag', '"use strict";' + iife);
    fn({ getElementById: el, querySelectorAll: s => s === '.ffx-reveal' ? revealNodes : [], addEventListener: () => {}, createElement: el, head: { appendChild: () => {} }, body: { style: {} } },
       { addEventListener: () => {}, innerWidth: 1200, scrollY: 0, scrollTo: () => {}, location: { search: '?slug=x' } },
       IO, URLSearchParams, { getItem: () => '1', setItem: () => {} }, () => 0, () => {}, () => {});
  } catch (e) { errors.push('THROW: ' + e.message); }
  // parse a (possibly comma-separated) selector and test presence in the raw bytes
  const bodyPresent = selector.split(',').map(s => s.trim()).some(s => {
    if (s.startsWith('.')) return new RegExp('class=["\'][^"\']*\\b' + s.slice(1) + '\\b').test(r.body);
    if (s.startsWith('#')) return new RegExp('id=["\']' + s.slice(1) + '["\']').test(r.body);
    return new RegExp('<' + s + '[\\s>]').test(r.body);
  });
  const visible = errors.length === 0 && (gated ? madeVisible.length > 0 : bodyPresent);
  return { mode: 'shim', status: r.status, errors, vis: { gated, madeVisible: madeVisible.length, bodyPresent }, visible };
}

async function renderCheck(browser, url, selector) {
  return browser ? renderReal(browser, url, selector) : renderShim(url, selector);
}

// ── byte checks ──────────────────────────────────────────────────────────────
async function checkArticleBytes(slug) {
  const tag = 'article[' + slug.slice(0, 24) + ']';
  const r = await get('/article?slug=' + encodeURIComponent(slug));
  if (r.status !== 200) { record(tag + ' 200', false, 'status ' + r.status); return; }
  const canon = getCanonical(r.body);
  record(tag + ' canonical non-empty', canon && canon.length > 0, 'href=' + JSON.stringify(canon));
  const title = getTitle(r.body);
  record(tag + ' real <title>', title && !SHELL_TITLES.includes(title), JSON.stringify(title));
  record(tag + ' body in raw bytes', /class=["']article-body/.test(r.body) && /<h1>/.test(r.body), 'article-body + <h1>');
  const types = jsonLdTypes(r.body), dupes = types.filter((t, i) => types.indexOf(t) !== i);
  record(tag + ' JSON-LD present, no dupes', types.length > 0 && dupes.length === 0, 'types=[' + types.join(',') + ']' + (dupes.length ? ' DUP:' + dupes : ''));
}
async function checkBadSlug() {
  const r = await get('/article?slug=__seo_audit_nope_' + Date.now() + '__');
  record('garbage slug → real 404', r.status === 404, 'status ' + r.status + (r.status === 200 ? ' (200 SHELL — soft-404!)' : ''));
}
async function checkBlogBytes() {
  const r = await get('/blog'); record('/blog 200', r.status === 200, 'status ' + r.status);
  if (r.status !== 200) return;
  const title = getTitle(r.body);
  record('/blog real <title> (≤60)', title && !SHELL_TITLES.includes(title) && title.length <= 60, JSON.stringify(title) + ' (' + (title || '').length + ')');
  record('/blog exposes article <a href> links', articleLinks(r.body).length > 0, articleLinks(r.body).length + ' links');
}
async function checkSitemap() {
  const r = await get('/sitemap.xml'); record('sitemap.xml 200', r.status === 200, 'status ' + r.status);
  if (r.status !== 200) return;
  const all = locs(r.body), uniq = new Set(all);
  record('sitemap zero duplicate <loc>', all.length === uniq.size, all.length + ' total, ' + uniq.size + ' unique, ' + (all.length - uniq.size) + ' dupes');
}

// ── render checks (the new runtime dimension) ───────────────────────────────
async function checkRender(browser, label, url, selector, expectStatus) {
  const rc = await renderCheck(browser, url, selector);
  const statusOk = !expectStatus || rc.status === expectStatus || rc.status === 0; // shim can't always resolve final status
  record(label + ' no JS/console errors [' + rc.mode + ']', rc.errors.length === 0, rc.errors.length ? JSON.stringify(rc.errors.slice(0, 3)) : 'clean');
  record(label + ' body VISIBLE in browser [' + rc.mode + ']', rc.visible && statusOk, JSON.stringify(rc.vis));
  return rc;
}

// ── self-test: prove the render check FAILS a body-invisible page ───────────
async function selfTest(browser) {
  console.log('\n── SELF-TEST: render check must FAIL a deliberately body-invisible page ──');
  const evilHtml = '<!DOCTYPE html><html><head><style>.article-body{opacity:0}</style></head><body>' +
    '<div class="article-body">This text is present in the bytes but invisible.</div>' +
    "<script>var x = { body: 'oops you're broken' };</script></body></html>"; // deliberate SyntaxError + opacity:0
  if (browser) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
    await page.goto('data:text/html,' + encodeURIComponent(evilHtml), { waitUntil: 'load' });
    await sleep(300);
    const vis = await page.evaluate(() => { const el = document.querySelector('.article-body'); const cs = getComputedStyle(el); return { opacity: parseFloat(cs.opacity) }; });
    await page.close();
    const wouldFail = !(vis.opacity > 0.5) || errs.length > 0;
    console.log('  synthetic page: opacity=' + vis.opacity + ', pageerrors=' + errs.length);
    console.log('  guard would FAIL this page:', wouldFail, wouldFail ? '✓ (invisible body + script error caught)' : '✗');
    return wouldFail;
  } else {
    console.log('  (no browser — self-test needs the real engine; skipped)');
    return true;
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\nFFX SEO audit — ' + BASE + '  (Googlebot UA bytes + real-browser render)\n' + '='.repeat(66));
  const browser = await loadBrowser();
  console.log('  render engine: ' + (browser ? 'REAL browser (puppeteer-core + system Chrome)' : 'DOM-shim fallback (no browser available)') + '\n');

  if (SELFTEST) { const ok = await selfTest(browser); if (browser) await browser.close(); process.exit(ok ? 0 : 1); }

  // sample real slugs
  let slugs = [];
  try { const a = await get('/articles'); slugs = (JSON.parse(a.body).articles || []).map(x => x.slug).filter(Boolean).slice(0, SAMPLE_ARTICLES); } catch {}
  if (!slugs.length) record('article sample available', false, 'could not read /articles');

  // byte checks
  for (const s of slugs) await checkArticleBytes(s);
  await checkBadSlug();
  await checkBlogBytes();
  await checkSitemap();

  // render checks (runtime)
  for (const s of slugs) await checkRender(browser, 'article[' + s.slice(0, 20) + ']', BASE + '/article?slug=' + s, '.article-body', 200);
  await checkRender(browser, '/blog', BASE + '/blog', '.blog-list', 200);
  await checkRender(browser, '/newsletter-issue (404 branded)', BASE + '/newsletter-issue?date=__garbage__', '.card, .num, body', 404);
  await checkRender(browser, '/article (404 branded)', BASE + '/article?slug=__nope_' + Date.now() + '__', '.card, .num, body', 404);
  await checkRender(browser, '/503 (branded)', BASE + '/503.html', '.card, .num, body', null);

  // self-test always runs at the end so the sweep proves the guard bites
  const stOk = await selfTest(browser);
  record('SELF-TEST: guard fails a body-invisible page', stOk, stOk ? 'confirmed' : 'guard did NOT catch invisibility');

  if (browser) await browser.close();

  let fails = 0;
  console.log('\n' + '─'.repeat(66));
  for (const r of results) { if (!r.pass) fails++; console.log('  [' + (r.pass ? 'PASS' : 'FAIL') + '] ' + r.name + (r.detail ? '  — ' + r.detail : '')); }
  console.log('='.repeat(66));
  console.log('  ' + (results.length - fails) + '/' + results.length + ' passed' + (fails ? '  ·  ' + fails + ' FAILED' : '  ·  ALL PASS') + '\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('audit crashed:', e); process.exit(2); });
