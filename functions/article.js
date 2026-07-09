// ─────────────────────────────────────────────────────────────────────────────
// FFX /article — Server-Side Render (Phase 1)
//
// Claims GET /article and server-renders the COMPLETE page: real <title>, meta
// description, self-canonical, OG/Twitter, Article + BreadcrumbList JSON-LD, the
// <h1>, and the full body — all in the served HTML bytes (no client JS needed to
// see content). Replaces the static article.html shell + the _middleware head
// patch (both removed/retired in this change).
//
// HARD RULES honoured:
//  - Data comes from /article-content (read-only) via an internal subrequest —
//    identical data, identical fallback order. SELF-HEAL (SH-2, 2026-07-09): on a
//    TRANSIENT subrequest failure (network throw / non-200 / bad JSON / bodyless)
//    the subrequest is retried once (short backoff); if it still fails we read the
//    SAME underlying sources DIRECTLY (KV published/video/video:slug + articles.json
//    — mirrors article-content.js) and render from that. A 503 is served only when
//    the article is still genuinely unbuildable after retry AND direct fallback.
//  - The ONLY KV write in this file is a lightweight, TTL'd diagnostic record written
//    immediately before any 503 (key '503log:<ms>:<slug>'), so a residual 503 is
//    diagnosable via the site edge (GET /article?diag503=<token>) WITHOUT the
//    Cloudflare control plane / `wrangler tail`. The write is fully wrapped — a
//    logging failure can never escalate the response. The render path is otherwise
//    read-only. A genuine 404 (unknown slug) is never healed, never logged.
//  - Every URL byte-identical. /article?slug=… unchanged.
//  - Exact same markup/CSS/classes as article.html (spliced verbatim at build).
//    The only visible change is the "Loading…" shell is gone.
//  - Honest status codes: real 404 (branded 404.html) for missing; real 503
//    (branded 503.html + Retry-After) for transient build failure. Never a 200
//    shell — the page is verified complete before it is sent.
//
// Data-source choice: internal subrequest to /article-content (NOT a re-implemented
// KV read). Reason: it guarantees byte-identical data including the on-the-fly
// internal-link injection (article-content.js:134) and newsletter cross-link
// (article-content.js:181), and it cannot drift from the canonical read path.
// article-content.js is strictly read-only (only env.FFX_KV.get).
// ─────────────────────────────────────────────────────────────────────────────

const SITE    = 'FortitudeFX™';
const OG_IMG  = 'https://fortitudefx.com/og-fortitudefx.png';
const IMG_ALT = 'FortitudeFX — Catch The Wick mechanical forex trading system';
const BASE    = 'https://fortitudefx.com';

// ── SH-2 self-heal + edge-readable diagnostics (2026-07-09) ─────────────────────
const BACKOFF_MS   = 200;        // one short backoff before the single subrequest retry
const LOG_TTL      = 604800;     // 7 days — 503 diagnostic records self-expire
const DIAG_TOKEN   = 'ffx-503-9d4b1c'; // gate for GET /article?diag503=<token> (logs are
                                       // non-sensitive: branch id + status + slug, no PII)
const ARTICLES_RAW = 'https://raw.githubusercontent.com/fortitudefx/FFX-v10-SEO1/main/articles.json';

// ── Escaping helpers (reused verbatim from the retired _middleware.js) ──────────
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
function htmlText(v) {
  // Safe for HTML text-node context (titles, category, etc.)
  return String(v == null ? '' : v).replace(/[<>&]/g, function (c) {
    return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;';
  });
}

// ── Date formatting — reproduces article.html's en-GB "7 June 2026" exactly,
//    without relying on the Workers Intl/ICU locale data being present ──────────
const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];
function formatDate(dateStr) {
  if (!dateStr) return '';
  var d = new Date(String(dateStr) + 'T00:00:00');
  if (isNaN(d.getTime())) return String(dateStr);
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

// ── Static chunks spliced byte-for-byte from article.html at build time ─────────
// (injected by tools/build — markers below are replaced with the exact source ranges)
const GTAG         = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-Y056J2K2WK"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-Y056J2K2WK');
</script>`;          // article.html 4-11
const HEAD_TAIL    = `<meta name="theme-color" content="#0d0d14" />
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192x192.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="styles-nav-footer.css" />`;      // article.html 34-43
const STYLE        = `<style>
/* ── Reset ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: 'Inter', sans-serif;
  background: #0d0d14;
  color: #e8e4de;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

/* ── Tokens ── */
:root {
  --gold: #C9A84C;
  --orange: #E06B1A;
  --dark: #0d0d14;
  --dark-alt: #111118;
  --cream: #e8e4de;
  --cream-muted: rgba(232,228,222,0.5);
  --gold-border: rgba(201,168,76,0.15);
}

/* ── Reveal ── */
.ffx-reveal {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.75s cubic-bezier(0.22,1,0.36,1), transform 0.75s cubic-bezier(0.22,1,0.36,1);
}
.ffx-reveal.is-visible { opacity: 1; transform: translateY(0); }
.ffx-reveal-delay-1 { transition-delay: 0.1s; }
.ffx-reveal-delay-2 { transition-delay: 0.2s; }
.ffx-reveal-delay-3 { transition-delay: 0.3s; }

/* ── Page layout ── */
.page-wrap {
  min-height: 100vh;
  padding-top: 68px;
  display: flex;
  flex-direction: column;
}

/* ── Article section ── */
.article-section {
  flex: 1;
  padding: 64px 24px 96px;
}
.article-wrap {
  max-width: 720px;
  margin: 0 auto;
}

/* ── Back link ── */
.article-back {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--cream-muted);
  text-decoration: none;
  letter-spacing: 0.02em;
  margin-bottom: 48px;
  transition: color 0.2s;
}
.article-back:hover { color: var(--cream); }
.article-back svg {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ── Article meta ── */
.article-meta-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.article-cat {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gold);
  padding: 4px 12px;
  border: 1px solid var(--gold-border);
  border-radius: 100px;
  background: rgba(201,168,76,0.06);
}
.article-date-read {
  font-size: 13px;
  font-weight: 400;
  color: var(--cream-muted);
  letter-spacing: 0.02em;
}

/* ── Article headline ── */
.article-wrap h1 {
  font-family: 'Playfair Display', serif;
  font-size: clamp(28px, 4vw, 48px);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  color: var(--cream);
  margin-bottom: 40px;
}

/* ── Byline ── */
.article-byline {
  margin: -24px 0 40px;
  font-size: 14px;
  color: var(--cream-muted);
  letter-spacing: 0.01em;
}
.article-byline a {
  color: var(--gold);
  text-decoration: none;
  font-weight: 500;
  transition: color 0.2s;
}
.article-byline a:hover { color: var(--cream); }

/* ── Source video link ── */
.article-source-video {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 40px 0;
  padding: 16px 22px;
  border: 1px solid rgba(232,228,222,0.08);
  border-radius: 12px;
  background: rgba(232,228,222,0.03);
  color: var(--cream);
  text-decoration: none;
  font-size: 15px;
  font-weight: 500;
  transition: all 0.2s;
}
.article-source-video:hover {
  border-color: var(--gold-border);
  background: rgba(201,168,76,0.05);
}
.article-source-video svg { width: 22px; height: 22px; color: var(--gold); flex-shrink: 0; }
.article-source-video .article-source-arrow { margin-left: auto; color: var(--gold); }

/* ── Article body typography ── */
.article-body {
  font-size: 17px;
  font-weight: 300;
  line-height: 1.85;
  color: rgba(232,228,222,0.75);
}
.article-body h2 {
  font-family: 'Playfair Display', serif;
  font-size: clamp(22px, 2.5vw, 30px);
  font-weight: 700;
  color: var(--cream);
  line-height: 1.25;
  letter-spacing: -0.02em;
  margin: 48px 0 18px;
}
.article-body h3 {
  font-family: 'Inter', sans-serif;
  font-size: 18px;
  font-weight: 600;
  color: var(--cream);
  margin: 36px 0 14px;
  letter-spacing: -0.01em;
}
.article-body p { margin-bottom: 22px; }
.article-body p:last-child { margin-bottom: 0; }
.article-body strong { color: var(--cream); font-weight: 600; }
.article-body em { font-style: italic; }
.article-body a {
  color: rgba(201,168,76,0.85);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: rgba(201,168,76,0.3);
  transition: color 0.2s;
}
.article-body a:hover { color: var(--gold); }
.article-body ul,
.article-body ol {
  margin: 0 0 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.article-body li { padding-left: 4px; }
.article-body blockquote {
  margin: 32px 0;
  padding: 24px 28px;
  border-left: 3px solid var(--gold);
  background: rgba(201,168,76,0.04);
  border-radius: 0 10px 10px 0;
  font-style: italic;
  color: var(--cream-muted);
}
.article-body hr {
  border: none;
  border-top: 1px solid rgba(232,228,222,0.08);
  margin: 40px 0;
}
.article-body img {
  max-width: 100%;
  border-radius: 12px;
  margin: 24px 0;
}

/* ── Sibling article ── */
.article-sibling {
  margin: 40px 0;
  padding: 20px 24px;
  border: 1px solid rgba(232,228,222,0.08);
  border-radius: 12px;
  background: rgba(232,228,222,0.03);
}
.article-sibling-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--cream-muted);
  margin-bottom: 8px;
  display: block;
}
.article-sibling a {
  font-size: 15px;
  color: var(--gold);
  text-decoration: none;
  font-weight: 500;
  transition: opacity 0.2s;
}
.article-sibling a:hover { opacity: 0.75; }

/* ── Divider ── */
.article-divider {
  border: none;
  border-top: 1px solid rgba(232,228,222,0.08);
  margin: 56px 0;
}

/* ── Article CTA ── */
.article-cta {
  padding: 44px 44px;
  border: 1px solid var(--gold-border);
  border-radius: 20px;
  background: rgba(201,168,76,0.03);
  text-align: center;
}
.article-cta-kicker {
  display: block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: rgba(201,168,76,0.7);
  margin-bottom: 16px;
}
.article-cta h3 {
  font-family: 'Playfair Display', serif;
  font-size: clamp(22px, 2.5vw, 30px);
  font-weight: 700;
  color: var(--cream);
  letter-spacing: -0.02em;
  margin-bottom: 14px;
}
.article-cta p {
  font-size: 15px;
  font-weight: 300;
  color: var(--cream-muted);
  line-height: 1.75;
  max-width: 480px;
  margin: 0 auto 32px;
}
.article-cta-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
}
.btn-primary {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  color: #0d0d14;
  background: var(--gold);
  text-decoration: none;
  padding: 14px 28px;
  border-radius: 100px;
  transition: background 0.2s, transform 0.15s;
  letter-spacing: 0.02em;
}
.btn-primary:hover { background: #d4b05a; transform: translateY(-1px); }
.btn-secondary {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 500;
  color: var(--cream-muted);
  background: transparent;
  text-decoration: none;
  padding: 13px 28px;
  border-radius: 100px;
  border: 1px solid rgba(232,228,222,0.15);
  transition: all 0.2s;
  letter-spacing: 0.02em;
}
.btn-secondary:hover { border-color: rgba(232,228,222,0.35); color: var(--cream); }

/* ── Loading / error ── */
.article-loading {
  padding: 80px 0;
  text-align: center;
  color: var(--cream-muted);
  font-size: 15px;
}
.article-error {
  padding: 80px 0;
  text-align: center;
  color: var(--cream-muted);
  font-size: 15px;
}
.article-error a {
  color: var(--gold);
  text-decoration: none;
}

/* ── Back to top ── */
.back-to-top {
  position: fixed;
  bottom: 32px;
  right: 32px;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: rgba(201,168,76,0.1);
  border: 1px solid var(--gold-border);
  color: var(--gold);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  visibility: hidden;
  transition: all 0.3s;
  z-index: 50;
}
.back-to-top.is-visible { opacity: 1; visibility: visible; }
.back-to-top:hover { background: rgba(201,168,76,0.2); }
.back-to-top svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2.5; }

/* ── Popup ── */
#ffx-popup-overlay {
  position: fixed; inset: 0;
  background: rgba(6,6,10,0.80);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  z-index: 9998; display: flex; align-items: center; justify-content: center;
  padding: 20px; opacity: 0; visibility: hidden;
  transition: opacity 0.35s ease, visibility 0.35s ease;
}
#ffx-popup-overlay.is-open { opacity: 1; visibility: visible; }
#ffx-popup {
  background: #0d0d14;
  border: 1px solid rgba(201,168,76,0.2);
  border-radius: 24px;
  padding: 44px 40px 36px;
  max-width: 520px; width: 100%;
  position: relative;
  box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 80px rgba(201,168,76,0.06);
  transform: translateY(20px) scale(0.97);
  transition: transform 0.35s cubic-bezier(0.22,1,0.36,1);
}
#ffx-popup-overlay.is-open #ffx-popup { transform: translateY(0) scale(1); }
#ffx-popup::before {
  content: ''; position: absolute; top: 0; left: 10%; right: 10%; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(201,168,76,0.5), transparent);
}
#ffx-popup-close {
  position: absolute; top: 16px; right: 16px;
  width: 32px; height: 32px; border-radius: 50%;
  background: rgba(232,228,222,0.05); border: 1px solid rgba(232,228,222,0.1);
  color: rgba(232,228,222,0.45); font-size: 1.1rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.2s, color 0.2s;
}
#ffx-popup-close:hover { background: rgba(232,228,222,0.1); color: var(--cream); }
.ffx-popup-sig { font-size: 10px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(201,168,76,0.7); margin-bottom: 16px; }
.ffx-popup-headline { font-family: 'Playfair Display', serif; font-size: 20px; font-weight: 700; color: var(--cream); line-height: 1.35; letter-spacing: -0.02em; margin: 0 0 14px; }
.ffx-popup-body { font-size: 14px; color: var(--cream-muted); line-height: 1.75; margin: 0 0 10px; }
.ffx-popup-sign { font-size: 13px; color: rgba(232,228,222,0.3); font-style: italic; margin: 0 0 28px; }
.ffx-popup-divider { height: 1px; background: rgba(232,228,222,0.07); margin: 0 0 24px; }
.ffx-popup-actions { display: flex; flex-direction: column; gap: 10px; }
.ffx-popup-btn-primary {
  display: block; width: 100%; text-align: center;
  padding: 14px 24px; border-radius: 100px;
  background: var(--gold); border: none;
  color: #0d0d14; font-size: 14px; font-weight: 700;
  letter-spacing: 0.04em; text-decoration: none;
  font-family: 'Inter', sans-serif;
  transition: background 0.2s, transform 0.15s;
}
.ffx-popup-btn-primary:hover { background: #d4b05a; transform: translateY(-1px); }
.ffx-popup-btn-secondary {
  display: block; width: 100%; text-align: center;
  padding: 13px 24px; border-radius: 100px;
  background: transparent; border: 1px solid rgba(232,228,222,0.14);
  color: var(--cream-muted); font-size: 14px; font-weight: 500;
  letter-spacing: 0.03em; text-decoration: none;
  font-family: 'Inter', sans-serif;
  transition: border-color 0.2s, color 0.2s, transform 0.15s;
}
.ffx-popup-btn-secondary:hover { border-color: rgba(232,228,222,0.3); color: var(--cream); transform: translateY(-1px); }

/* ── Responsive ── */
@media (max-width: 900px) {
  .article-section { padding: 48px 24px 72px; }
  .article-cta { padding: 32px 24px; }
  .article-cta-actions { flex-direction: column; align-items: stretch; }
  .back-to-top { bottom: 20px; right: 20px; }
}
@media (max-width: 560px) {
  #ffx-popup { padding: 36px 24px 28px; }
}
</style>`;         // article.html 45-439 (<style>…</style>)
const NAV          = `<nav id="mainNav" class="nav-dark">
  <a class="nav-brand" href="index.html">FortitudeFX<sup class="tm">™</sup></a>
  <ul class="nav-links">
    <li><a href="index.html">Home</a></li>
    <li><a href="about.html">About</a></li>
    <li><a href="vipdiscord.html">VIP Discord</a></li>
    <li><a href="bootcamp.html">Bootcamp</a></li>
    <li><a href="blog.html" class="active">Blog</a></li>
    <li><a href="contact.html">Contact</a></li>
  </ul>
  <div class="nav-actions">
    <a class="nav-btn-ghost" href="joinfree.html">Join Free</a>
    <a class="nav-btn-primary" href="waitlist.html?path=VIP#form">Request Your Spot</a>
  </div>
  <button class="nav-hamburger" id="navToggle" aria-label="Open menu">
    <span></span><span></span><span></span>
  </button>
</nav>
<div class="nav-mobile nav-dark-mobile" id="navMobile">
  <a href="index.html">Home</a>
  <a href="about.html">About</a>
  <a href="vipdiscord.html">VIP Discord</a>
  <a href="bootcamp.html">Bootcamp</a>
  <a href="blog.html">Blog</a>
  <a href="contact.html">Contact</a>
  <div class="nav-mobile-actions">
    <a class="nav-btn-ghost" href="joinfree.html">Join Free</a>
    <a class="nav-btn-primary" href="waitlist.html?path=VIP#form">Request Your Spot</a>
  </div>
</div>`;           // article.html 444-471 (nav + nav-mobile)
const FOOTER       = `  <!-- Footer -->
  <footer>
    <div class="footer-inner">
      <div class="footer-brand">
        <strong>FortitudeFX<sup class="tm">™</sup></strong>
        Catch The Wick<sup class="tm">™</sup> · Dubai, UAE
      </div>
      <ul class="footer-links">
        <li><a href="index.html">Home</a></li>
        <li><a href="vipdiscord.html">VIP Discord</a></li>
        <li><a href="bootcamp.html">Bootcamp</a></li>
        <li><a href="blog.html">Blog</a></li>
        <li><a href="contact.html">Contact</a></li>
        <li><a href="about.html">About</a></li>
        <li><a href="privacy.html">Privacy</a></li>
        <li><a href="disclaimer.html">Disclaimer</a></li>
      </ul>
      <div class="footer-socials">
        <a href="https://www.youtube.com/@FortitudeFX" class="footer-social-icon" aria-label="YouTube" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.2 31.2 0 0 0 0 12a31.2 31.2 0 0 0 .6 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.2 31.2 0 0 0 24 12a31.2 31.2 0 0 0-.5-5.8zM9.7 15.5V8.5l6.3 3.5-6.3 3.5z"/></svg></a>
        <a href="https://instagram.com/fortitudefx_official" class="footer-social-icon" aria-label="Instagram" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg></a>
        <a href="https://tiktok.com/@fortitudefx_official" class="footer-social-icon" aria-label="TikTok" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.75a4.85 4.85 0 0 1-1.01-.06z"/></svg></a>
        <a href="https://x.com/_fortitudefx" class="footer-social-icon" aria-label="X" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
        <a href="https://t.me/FFX_Official" class="footer-social-icon" aria-label="Telegram" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg></a>
      </div>
    </div>
    <div class="footer-bottom">
      <p class="footer-copy">© 2026 FortitudeFX<sup class="tm">™</sup> · All rights reserved · Dubai, UAE</p>
      <p class="footer-tm">Catch The Wick<sup class="tm">™</sup> · 2 Candles. 1 Story.<sup class="tm">™</sup></p>
      <p class="footer-disclaimer" style="max-width:820px;margin:14px auto 0;font-size:11px;line-height:1.6;color:rgba(255,255,255,0.3);text-align:center;padding:0 16px;">Educational content only — not financial advice. FortitudeFX<sup class="tm">™</sup> provides trading education based on price-action methodology. Nothing here is financial, investment, or trading advice, or a recommendation to buy or sell any instrument. Trading forex carries a high level of risk and can result in the loss of some or all of your capital; it is not suitable for everyone. Past performance is not indicative of future results. Always do your own research and consider seeking advice from an independent, licensed financial professional before trading. You are solely responsible for your own trading decisions.</p>
    </div>
  </footer>`;        // article.html 481-508
const POPUP_HTML   = `<!-- Back to top -->
<button class="back-to-top" id="backToTop" aria-label="Back to top">
  <svg viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"></polyline></svg>
</button>

<!-- Popup -->
<div id="ffx-popup-overlay" role="dialog" aria-modal="true" aria-labelledby="ffx-popup-headline">
  <div id="ffx-popup">
    <button id="ffx-popup-close" aria-label="Close">&times;</button>
    <div class="ffx-popup-sig">FortitudeFX<sup class="tm">™</sup></div>
    <h2 class="ffx-popup-headline" id="ffx-popup-headline"></h2>
    <p class="ffx-popup-body" id="ffx-popup-body"></p>
    <p class="ffx-popup-sign">— Salman Khan</p>
    <div class="ffx-popup-divider"></div>
    <div class="ffx-popup-actions">
      <a href="joinfree.html?utm_source=popup&utm_medium=overlay&utm_campaign=discord" class="ffx-popup-btn-primary" id="ffx-popup-cta-primary">Join Free →</a>
      <a href="waitlist.html?path=VIP&utm_source=popup&utm_medium=overlay&utm_campaign=waitlist#form" class="ffx-popup-btn-secondary" id="ffx-popup-cta-secondary">Request Your Spot →</a>
    </div>
  </div>
</div>`;     // article.html 512-531 (back-to-top + popup)
const SCRIPT_NAV   = `  /* ── Nav ── */
  var nav = document.getElementById('mainNav');
  window.addEventListener('scroll', function() {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  }, { passive: true });

  var toggle = document.getElementById('navToggle');
  var mobile = document.getElementById('navMobile');
  if (toggle && mobile) {
    toggle.addEventListener('click', function() {
      var open = mobile.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open);
    });
    mobile.querySelectorAll('a').forEach(function(a) {
      a.addEventListener('click', function() {
        mobile.classList.remove('open');
        toggle.setAttribute('aria-expanded', false);
      });
    });
  }

  /* ── Back to top ── */
  var btt = document.getElementById('backToTop');
  if (btt) {
    window.addEventListener('scroll', function() {
      btt.classList.toggle('is-visible', window.scrollY > 400);
    }, { passive: true });
    btt.addEventListener('click', function() { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }`;     // article.html 537-565 (nav + back-to-top JS)
const SCRIPT_POPUP = `  /* ── Popup ── */
  if (!sessionStorage.getItem('ffx_popup_shown')) {
    var MESSAGES = {
      timer: {
        headline: 'Most traders spend years jumping between strategies, indicators, and opinions without ever building a real framework.',
        body: 'FortitudeFX was built to simplify trading into something mechanical, repeatable, and mentally sustainable. If you\\'re serious about learning how we approach the market through the Catch The Wick framework — join the free community below.'
      },
      exit: {
        headline: 'Before you go —',
        body: 'The goal here was never to create another signal group or "trade all day" community. FortitudeFX is built around structure, patience, and freeing traders from emotional decision-making and screen addiction. If that resonates with you, join the free Discord or the waitlist and stay connected.'
      }
    };

    var overlay  = document.getElementById('ffx-popup-overlay');
    var headline = document.getElementById('ffx-popup-headline');
    var body     = document.getElementById('ffx-popup-body');
    var closeBtn = document.getElementById('ffx-popup-close');
    var shown = false; var timerRef = null; var exitBound = false; var popupVariant = null;

    function showPopup(variant) {
      if (shown) return;
      shown = true; popupVariant = variant;
      sessionStorage.setItem('ffx_popup_shown', '1');
      if (timerRef) clearTimeout(timerRef);
      if (exitBound) document.removeEventListener('mouseleave', onMouseLeave);
      headline.textContent = MESSAGES[variant].headline;
      body.textContent     = MESSAGES[variant].body;
      overlay.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      if (typeof gtag !== 'undefined') gtag('event', 'popup_shown', { trigger: variant, page_slug: slug || '' });
    }
    function closePopup() {
      overlay.classList.remove('is-open');
      document.body.style.overflow = '';
      if (typeof gtag !== 'undefined') gtag('event', 'popup_dismissed', { trigger: popupVariant || 'unknown', page_slug: slug || '' });
    }

    closeBtn.addEventListener('click', closePopup);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closePopup(); });
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closePopup(); });

    document.getElementById('ffx-popup-cta-primary').addEventListener('click', function() {
      if (typeof gtag !== 'undefined') gtag('event', 'popup_cta_clicked', { cta: 'join_free', trigger: popupVariant || 'unknown', page_slug: slug || '' });
    });
    document.getElementById('ffx-popup-cta-secondary').addEventListener('click', function() {
      if (typeof gtag !== 'undefined') gtag('event', 'popup_cta_clicked', { cta: 'waitlist', trigger: popupVariant || 'unknown', page_slug: slug || '' });
    });

    timerRef = setTimeout(function() { showPopup('timer'); }, 30000 + Math.random() * 5000);
    function onMouseLeave(e) { if (e.clientY <= 0) showPopup('exit'); }
    if (window.innerWidth >= 768) { exitBound = true; document.addEventListener('mouseleave', onMouseLeave); }
  }`;   // article.html 724-775 (popup JS)

// ── hreflang (reproduces article.html:653-671) ──────────────────────────────────
function regionToHreflang(region) {
  if (!region || region === 'Global') return 'en';
  if (region.indexOf('GCC') !== -1) return 'en-AE';
  if (region.indexOf('US') !== -1 || region.indexOf('Canada') !== -1) return 'en-US';
  if (region.indexOf('EU') !== -1 || region.indexOf('UK') !== -1 || region.indexOf('Germany') !== -1) return 'en-GB';
  if (region.indexOf('SEA') !== -1 || region.indexOf('Asia') !== -1) return 'en-SG';
  return 'en';
}
function buildHreflang(a, url) {
  if (!a.slug || !a.siblingSlug) return '';
  var siblingUrl = BASE + '/article?slug=' + a.siblingSlug;
  var thisHL    = regionToHreflang(a.region);
  var siblingHL = regionToHreflang(a.siblingRegion);
  var globalUrl = (!a.region || a.region === 'Global') ? url : siblingUrl;
  var pairs = [[thisHL, url], [siblingHL, siblingUrl], ['x-default', globalUrl]];
  return pairs.map(function (p) {
    return '<link rel="alternate" hreflang="' + attr(p[0]) + '" href="' + attr(p[1]) + '" />';
  }).join('\n');
}

// ── JSON-LD (reproduces article.html:616-647: Article + BreadcrumbList) ──────────
function buildJsonLd(a, url) {
  var article = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.excerpt,
    image: OG_IMG,
    datePublished: a.date,
    dateModified: a.updatedAt || a.date,
    wordCount: a.body ? a.body.replace(/<[^>]+>/g, '').split(/\s+/).length : 0,
    author: { '@type': 'Person', name: 'Salman Khan', url: BASE + '/about' },
    publisher: {
      '@type': 'Organization', name: SITE, url: BASE,
      logo: { '@type': 'ImageObject', url: OG_IMG }
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url: url,
    keywords: Array.isArray(a.tags) ? a.tags.join(', ') : (a.tags || '')
  };
  var breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: BASE },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: BASE + '/blog' },
      { '@type': 'ListItem', position: 3, name: a.title, item: url }
    ]
  };
  return '<script type="application/ld+json">' + jsonLdSafe(article) + '</script>\n'
       + '<script type="application/ld+json">' + jsonLdSafe(breadcrumb) + '</script>';
}

// ── Article body markup (reproduces article.html:674-708 exactly) ───────────────
function buildArticleInner(a) {
  var sibling = '';
  if (a.siblingSlug) {
    sibling =
      '<div class="article-sibling ffx-reveal ffx-reveal-delay-2">' +
        '<span class="article-sibling-label">Also available</span>' +
        '<a href="/article?slug=' + attr(a.siblingSlug) + '">' +
          (a.siblingTitle ? htmlText(a.siblingTitle) : 'Read the ' + htmlText(a.siblingRegion) + ' edition') + ' &rarr;' +
        '</a>' +
      '</div>';
  }
  return (
    '<a class="article-back ffx-reveal" href="blog.html">' +
      '<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"></polyline></svg>' +
      'Back to Blog' +
    '</a>' +
    '<div class="ffx-reveal ffx-reveal-delay-1">' +
      '<div class="article-meta-row">' +
        '<span class="article-cat">' + htmlText(a.category || 'Strategy') + '</span>' +
        '<span class="article-date-read">' + htmlText(formatDate(a.date)) + ' &nbsp;&middot;&nbsp; ' + htmlText(a.readTime || '7 min read') + '</span>' +
      '</div>' +
      '<h1>' + htmlText(a.title) + '</h1>' +
      '<div class="article-byline">By <a href="/about">Salman Khan</a></div>' +
    '</div>' +
    '<div class="article-body ffx-reveal ffx-reveal-delay-2">' + (a.body || '') + '</div>' +
    (a.youtubeUrl ? '<a class="article-source-video ffx-reveal ffx-reveal-delay-2" href="' + attr(a.youtubeUrl) + '" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.2 31.2 0 0 0 0 12a31.2 31.2 0 0 0 .6 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.2 31.2 0 0 0 24 12a31.2 31.2 0 0 0-.5-5.8zM9.7 15.5V8.5l6.3 3.5-6.3 3.5z"/></svg><span>Watch the original video on YouTube</span><span class="article-source-arrow">&rarr;</span></a>' : '') +
    sibling +
    '<hr class="article-divider ffx-reveal ffx-reveal-delay-2">' +
    '<div class="article-cta ffx-reveal ffx-reveal-delay-3">' +
      '<span class="article-cta-kicker">Free Community</span>' +
      '<h3>Ready to trade with an edge?</h3>' +
      '<p>Join hundreds of traders inside the free FortitudeFX<sup class="tm">™</sup> Discord — live setups, real-time market commentary, and the full Catch The Wick<sup class="tm">™</sup> methodology explained from the ground up.</p>' +
      '<div class="article-cta-actions">' +
        '<a class="btn-primary" href="vipdiscord.html?utm_source=article&utm_medium=cta&utm_campaign=discord&utm_content=' + attr(a.slug) + '">Join Free Discord</a>' +
        '<a class="btn-secondary" href="bootcamp.html?utm_source=article&utm_medium=cta&utm_campaign=bootcamp&utm_content=' + attr(a.slug) + '">Explore the Bootcamp</a>' +
      '</div>' +
    '</div>' +
    '<p class="article-foot-disclaimer" style="margin:40px 0 0;padding-top:24px;border-top:1px solid rgba(232,228,222,0.1);font-size:12px;line-height:1.7;color:rgba(232,228,222,0.45);">Educational content only — not financial advice. FortitudeFX<sup class="tm">™</sup> provides trading education based on price-action methodology. Nothing here is financial, investment, or trading advice, or a recommendation to buy or sell any instrument. Trading forex carries a high level of risk and can result in the loss of some or all of your capital; it is not suitable for everyone. Past performance is not indicative of future results. Always do your own research and consider seeking advice from an independent, licensed financial professional before trading. You are solely responsible for your own trading decisions.</p>'
  );
}

// ── Assemble the full page ──────────────────────────────────────────────────────
// Cap the document <title> at ≤60 chars: prefer "Title | SITE", drop the brand
// suffix if that overflows, and word-boundary-truncate a very long headline.
function capTitle(title) {
  var t    = String(title || '').trim();
  var full = t + ' | ' + SITE;
  if (full.length <= 60) return full;
  if (t.length <= 60) return t;
  return t.slice(0, 59).replace(/\s+\S*$/, '') + '…';
}

// Fallback meta description when excerpt is empty: derive from the body text,
// else a brand template. Never emit content="".
function deriveDesc(a) {
  if (a.excerpt && String(a.excerpt).trim()) return String(a.excerpt).trim();
  var txt = String(a.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (txt) { var s = txt.slice(0, 157); return txt.length > 157 ? s.replace(/\s+\S*$/, '') + '…' : s; }
  return (a.title ? String(a.title).trim() + ' — ' : '') + 'Mechanical forex trading insights from FortitudeFX.';
}

function buildPage(a) {
  var url       = BASE + '/article?slug=' + a.slug;
  var fullTitle = a.title + ' | ' + SITE;
  var pageTitle = capTitle(a.title);
  var desc      = deriveDesc(a);
  // ── REGIONAL CONSOLIDATION (noindex→global, 2026-07-07) ──────────────────
  // WHY: 14 regional variants are same-intent duplicates of their global sibling
  //      (cosmetic diffs only) — consolidate to stop cannibalization on a young domain.
  // EFFECT: regionals serve noindex,follow + canonical→global sibling; noindex-only +
  //      self-canonical where no live SAME-VIDEO global exists (slug-collision orphans,
  //      e.g. z2RwH06okKQ). a._consolidateTo is resolved videoId-authoritatively in the
  //      route handler (onRequestGet) — NOT by suffix-strip.
  // REVERT: restore `var robots = a.draft ? 'noindex, nofollow' : 'index, follow';`,
  //      `canonicalUrl = url`, and `hreflang = buildHreflang(a, url)` (delete this block).
  // ─────────────────────────────────────────────────────────────────────────
  var isRegional   = !a.draft && !!a.region && a.region !== 'Global';
  var robots       = a.draft ? 'noindex, nofollow'
                   : (isRegional ? 'noindex, follow' : 'index, follow');
  var canonicalUrl = (isRegional && a._consolidateTo)
                   ? (BASE + '/article?slug=' + a._consolidateTo)
                   : url;
  var inner     = buildArticleInner(a);
  var jsonld    = buildJsonLd(a, url);
  var hreflang  = isRegional ? '' : buildHreflang(a, url);  // noindex regional: no self hreflang alternate

  return '<!DOCTYPE html>\n'
+ '<html lang="en">\n'
+ '<head>\n'
+ GTAG + '\n'
+ '<meta charset="UTF-8" />\n'
+ '<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
+ '<title>' + htmlText(pageTitle) + '</title>\n'
+ '<meta name="description" content="' + attr(desc) + '" />\n'
+ '<meta name="robots" content="' + robots + '" />\n'
+ '<link rel="canonical" href="' + attr(canonicalUrl) + '" id="canonicalTag" />\n'
+ '<meta property="og:type" content="article" />\n'
+ '<meta property="og:image" content="' + OG_IMG + '" />\n'
+ '<meta property="og:image:width" content="1200" />\n'
+ '<meta property="og:image:height" content="630" />\n'
+ '<meta property="og:site_name" content="' + SITE + '" />\n'
+ '<meta property="og:locale" content="en_US" />\n'
+ '<meta property="og:url" content="' + attr(url) + '" />\n'
+ '<meta property="og:title" content="' + attr(fullTitle) + '" />\n'
+ '<meta property="og:description" content="' + attr(desc) + '" />\n'
+ '<meta property="og:image:alt" content="' + IMG_ALT + '" />\n'
+ '<meta name="twitter:card" content="summary_large_image" />\n'
+ '<meta name="twitter:site" content="@_fortitudefx" />\n'
+ '<meta name="twitter:image" content="' + OG_IMG + '" />\n'
+ '<meta name="twitter:image:alt" content="' + IMG_ALT + '" />\n'
+ '<meta name="twitter:title" content="' + attr(fullTitle) + '" />\n'
+ '<meta name="twitter:description" content="' + attr(desc) + '" />\n'
+ HEAD_TAIL + '\n'
+ jsonld + '\n'
+ (hreflang ? hreflang + '\n' : '')
+ STYLE + '\n'
+ '</head>\n'
+ '<body>\n'
+ NAV + '\n'
+ '<div class="page-wrap">\n\n'
+ '  <section class="article-section">\n'
+ '    <div class="article-wrap" id="articleWrap">\n'
+ inner + '\n'
+ '    </div>\n'
+ '  </section>\n\n'
+ FOOTER + '\n\n'
+ '</div><!-- /.page-wrap -->\n\n'
+ POPUP_HTML + '\n\n'
+ '<script>\n'
+ '(function() {\n'
+ "  'use strict';\n"
+ SCRIPT_NAV + '\n'
+ '  var params = new URLSearchParams(window.location.search);\n'
+ "  var slug   = params.get('slug');\n"
+ "  var wrap   = document.getElementById('articleWrap');\n\n"
+ '  /* ── Reveal (server-rendered body) ── */\n'
+ '  var io = new IntersectionObserver(function(entries) {\n'
+ '    entries.forEach(function(e) {\n'
+ "      if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }\n"
+ '    });\n'
+ '  }, { threshold: 0.05 });\n'
+ "  document.querySelectorAll('.ffx-reveal').forEach(function(el) { io.observe(el); });\n\n"
+ SCRIPT_POPUP + '\n'
+ '})();\n'
+ '</script>\n\n'
+ '</body>\n'
+ '</html>';
}

// ── Branded error responses (serve the real static assets, override status) ─────
async function serveAsset(request, path, status, extraHeaders) {
  var headers = Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  try {
    var assetUrl = new URL(path, request.url);
    var res = await fetch(assetUrl.toString(), { redirect: 'follow' });
    if (res.ok) {
      var body = await res.text();
      return new Response(body, { status: status, headers: headers });
    }
  } catch (e) { /* fall through to minimal inline */ }
  // Minimal inline fallback so we never throw
  var msg = status === 404 ? 'This page does not exist.' : 'Temporarily unavailable. Please try again.';
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>' + status + '</title>'
    + '<meta name="robots" content="noindex, nofollow"></head><body style="background:#0d0d14;color:#e8e4de;'
    + 'font-family:sans-serif;text-align:center;padding:80px 24px;"><h1>' + status + '</h1><p>' + msg
    + '</p><p><a href="/" style="color:#C9A84C;">Home</a></p></body></html>',
    { status: status, headers: headers }
  );
}
function serve404(request) { return serveAsset(request, '/404.html', 404, null); }
function serve503(request) { return serveAsset(request, '/503.html', 503, { 'Retry-After': '120' }); }

// ── SH-2 self-heal helpers ──────────────────────────────────────────────────────
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// One attempt at the internal /article-content subrequest. Classifies the outcome so
// the caller can distinguish a GENUINE 404 (do not heal/log) from a TRANSIENT failure
// (retry → fallback). Never throws.
async function tryContentOnce(request, slug) {
  var res;
  try {
    var acUrl = new URL('/article-content?slug=' + encodeURIComponent(slug), request.url);
    res = await fetch(acUrl.toString(), { headers: { 'Accept': 'application/json' } });
  } catch (e) {
    return { ok: false, notfound: false, branch: 'subreq-fetch-threw', detail: String((e && e.message) || e) };
  }
  if (res.status === 404) return { ok: false, notfound: true, branch: 'subreq-404', detail: '404' };
  if (!res.ok)            return { ok: false, notfound: false, branch: 'subreq-not-ok', detail: 'status=' + res.status };
  var data;
  try { data = await res.json(); }
  catch (e) { return { ok: false, notfound: false, branch: 'subreq-json-parse', detail: String((e && e.message) || e) }; }
  if (!data || data.success === false || !data.article) {
    return { ok: false, notfound: false, branch: 'subreq-no-article', detail: 'success=' + (data && data.success) };
  }
  return { ok: true, article: data.article };
}

// Subrequest with ONE retry on transient failure. Returns 'ok' | 'notfound' | 'fail'.
// A successful retry is a SILENT heal (no 503, no log). Records the last real failure
// branch/detail on `diag` for the logger.
async function fetchContentWithRetry(request, slug, diag) {
  var a1 = await tryContentOnce(request, slug);
  if (a1.ok)       return { status: 'ok', article: a1.article };
  if (a1.notfound) return { status: 'notfound' };
  diag.retried = true;
  diag.branch = a1.branch; diag.detail = a1.detail;
  await sleep(BACKOFF_MS);
  var a2 = await tryContentOnce(request, slug);
  if (a2.ok)       return { status: 'ok', article: a2.article };
  if (a2.notfound) return { status: 'notfound' };
  diag.branch = a2.branch; diag.detail = a2.detail;
  return { status: 'fail' };
}

// Direct read of the SAME underlying sources /article-content uses, in the SAME order
// (article-content.js:30-199). Used only as the fallback when the subrequest is
// transiently down. Read-only. Returns 'ok' | 'notfound' | 'error'. Never throws.
async function readArticleDirect(env, slug) {
  if (!env || !env.FFX_KV) return { status: 'error' };
  var meta;
  try { meta = await env.FFX_KV.get('article:' + slug, { type: 'json' }); }
  catch (e) { return { status: 'error' }; }
  if (!meta) return { status: 'notfound' };   // no metadata key = genuinely missing (honest 404)

  var videoId = meta.videoId;
  var body = '';
  var fullContent = {};
  var siblingSlug = null, siblingRegion = null, siblingTitle = null;

  if (videoId) {
    try {
      var pub = await env.FFX_KV.get('published:' + videoId, { type: 'json' });
      if (pub) {
        if (pub.regionalContent && pub.regionalContent.slug === slug && pub.regionalContent.body) {
          fullContent = pub.regionalContent; body = fullContent.body;
        } else if (pub.globalContent && pub.globalContent.body) {
          fullContent = pub.globalContent; body = fullContent.body;
        } else if (pub.platforms && pub.platforms.blog && pub.platforms.blog.content && pub.platforms.blog.content.body) {
          fullContent = pub.platforms.blog.content; body = fullContent.body;
        }
        if (pub.regionalContent && pub.regionalContent.slug) {
          var rSlug   = pub.regionalContent.slug;
          var rRegion = pub.regionalContent.region || pub.region || 'Regional';
          var rTitle  = pub.regionalContent.title || '';
          if (slug === (pub.globalContent && pub.globalContent.slug)) {
            siblingSlug = rSlug; siblingRegion = rRegion; siblingTitle = rTitle;
          } else if (slug === rSlug) {
            siblingSlug   = (pub.globalContent && pub.globalContent.slug) || null;
            siblingRegion = 'Global';
            siblingTitle  = (pub.globalContent && pub.globalContent.title) || '';
          }
        }
      }
    } catch (e) { /* non-fatal */ }

    if (!body) {
      try {
        var vid = await env.FFX_KV.get('video:' + videoId, { type: 'json' });
        if (vid) {
          var bc = (vid.platforms && vid.platforms.blog_global && vid.platforms.blog_global.content) || vid.content || null;
          if (bc) { fullContent = bc; body = bc.body || ''; }
        }
      } catch (e) { /* non-fatal */ }
    }
  }

  if (!body) {
    try {
      var se = await env.FFX_KV.get('video:slug:' + slug, { type: 'json' });
      if (se && se.content) { fullContent = se.content; body = se.content.body || ''; }
    } catch (e) { /* non-fatal */ }
  }

  if (!body) {
    try {
      var gh = await fetch(ARTICLES_RAW, { headers: { 'Cache-Control': 'no-cache' } });
      if (gh.ok) {
        var all = await gh.json();
        var found = Array.isArray(all) ? all.find(function (x) { return x.slug === slug; }) : null;
        if (found && found.body) { body = found.body; fullContent = found; }
      }
    } catch (e) { /* non-fatal */ }
  }

  // On-the-fly internal-link injection — mirrors article-content.js:140-166.
  if (body) {
    try {
      var pendingLinks = await env.FFX_KV.get('article:links:' + slug, { type: 'json' });
      if (pendingLinks && Array.isArray(pendingLinks.links) && pendingLinks.links.length > 0) {
        var linksHtml = pendingLinks.links.map(function (l) {
          return '<p>For further reading, see <a href="' + l.targetUrl + '">' + l.targetTitle + '</a>.</p>';
        }).join('');
        var ctaIdx = body.indexOf('discord.gg/fortitudefx');
        if (ctaIdx !== -1) {
          var paraStart = body.lastIndexOf('<p', ctaIdx);
          body = (paraStart !== -1) ? (body.slice(0, paraStart) + linksHtml + body.slice(paraStart)) : (body + linksHtml);
        } else { body = body + linksHtml; }
      }
    } catch (e) { /* non-fatal */ }
  }

  var article = {
    slug:       meta.slug,
    title:      meta.title    || fullContent.title    || '',
    excerpt:    meta.excerpt  || fullContent.excerpt  || '',
    category:   meta.category || fullContent.category || 'Strategy',
    tags:       Array.isArray(meta.tags) ? meta.tags : (fullContent.tags || []),
    readTime:   meta.readTime || fullContent.readTime || '5 min read',
    date:       meta.date     || fullContent.date     || '',
    body:       body || fullContent.body || '',
    youtubeUrl: meta.youtubeUrl || fullContent.youtubeUrl || '',
    videoId:    meta.videoId  || '',
    region:     meta.region   || fullContent.region   || 'Global',
    draft:      meta.draft    || false,
    siblingSlug: siblingSlug,
    siblingRegion: siblingRegion,
    siblingTitle: siblingTitle
  };

  // Newsletter cross-link append — mirrors article-content.js:188-199.
  try {
    var refs = await env.FFX_KV.get('newsletter:article_refs:' + slug, { type: 'json' });
    if (Array.isArray(refs) && refs.length > 0) {
      var latest = refs[refs.length - 1];
      var nlUrl  = '/newsletter-issue?date=' + latest.issueDate;
      var nlBlock = '<div style="margin-top:32px;padding:16px 20px;border-left:3px solid rgba(201,168,76,0.70);background:rgba(201,168,76,0.05);border-radius:0 8px 8px 0;">'
        + '<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:rgba(201,168,76,0.70);">Featured in Newsletter</p>'
        + '<p style="margin:0;font-size:14px;"><a href="' + nlUrl + '" style="color:#7a5cff;text-decoration:none;font-weight:700;">Read Issue #' + latest.issueNumber + ' →</a></p>'
        + '</div>';
      article.body = (article.body || '') + nlBlock;
    }
  } catch (e) { /* non-fatal */ }

  return { status: 'ok', article: article };
}

// ── SH-2 observability: write a lightweight, TTL'd 503 diagnostic to KV ──────────
// Called immediately before EVERY 503. Fully wrapped: a logging failure is swallowed
// so it can never escalate the response into a worse failure.
async function log503(context, diag) {
  try {
    var env = context && context.env;
    if (!env || !env.FFX_KV) return;
    var ts  = Date.now();
    var key = '503log:' + ts + ':' + (diag.slug || 'noslug');
    var rec = {
      ts:       new Date(ts).toISOString(),
      slug:     diag.slug || null,
      branch:   diag.branch || 'unknown',
      detail:   diag.detail || '',
      retried:  !!diag.retried,
      fellBack: !!diag.fellBack
    };
    await env.FFX_KV.put(key, JSON.stringify(rec), { expirationTtl: LOG_TTL });
  } catch (e) {
    // Swallow — logging must never make the outage worse.
  }
}

// Edge-readable diagnostics: GET /article?diag503=<token> → recent 503 records as JSON.
// Reachable from the site edge, so residual 503s are diagnosable WITHOUT the control
// plane. noindex + no-store. Non-sensitive payload.
async function serveDiag503(context, token) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow'
  };
  if (token !== DIAG_TOKEN) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: headers });
  }
  var env = context && context.env;
  if (!env || !env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'kv-unbound' }), { status: 500, headers: headers });
  }
  try {
    var list = await env.FFX_KV.list({ prefix: '503log:', limit: 1000 });
    var keys = (list && list.keys) ? list.keys.slice() : [];
    keys.sort(function (a, b) {
      return (parseInt(b.name.split(':')[1], 10) || 0) - (parseInt(a.name.split(':')[1], 10) || 0);
    });
    var top = keys.slice(0, 200);
    var records = [];
    for (var i = 0; i < top.length; i++) {
      var v = await env.FFX_KV.get(top[i].name, { type: 'json' });
      if (v) records.push(v);
    }
    return new Response(JSON.stringify({ count: records.length, total: keys.length, records: records }, null, 2),
      { status: 200, headers: headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers: headers });
  }
}

// ── Route handler ───────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  var request = context.request;
  var url = new URL(request.url);

  // ── Edge-readable diagnostics (no control plane needed) ──────────────────
  // GET /article?diag503=<token> → recent 503 records this function wrote.
  var diagTok = url.searchParams.get('diag503');
  if (diagTok) return serveDiag503(context, diagTok);

  var slug = url.searchParams.get('slug');

  // No slug → not a real article → honest 404 (never 503, never logged)
  if (!slug) return serve404(request);

  var diag = { slug: slug, retried: false, fellBack: false, branch: '', detail: '' };

  // ── PART 1a: internal /article-content subrequest, retry once on transient failure ──
  var got = await fetchContentWithRetry(request, slug, diag);

  // Genuinely missing → honest 404. Never healed, never logged.
  if (got.status === 'notfound') return serve404(request);

  var a = (got.status === 'ok') ? got.article : null;

  // ── PART 1b: direct-source fallback when the subrequest failed OR returned a
  //            bodyless article. Reads the SAME sources /article-content would. ──
  var bodyUsable = a && a.body && String(a.body).trim();
  if (got.status === 'fail' || !bodyUsable) {
    diag.fellBack = true;
    var direct = await readArticleDirect(context.env, slug);
    if (direct.status === 'ok' && direct.article.body && String(direct.article.body).trim()) {
      a = direct.article;                 // healed from the underlying source
    } else if (!a && direct.status === 'notfound') {
      return serve404(request);           // both paths agree: genuinely gone
    }
    // else: keep whatever `a` we have (possibly null / bodyless) → checks below decide
  }

  // No usable article after retry AND direct fallback → genuine transient 503 (logged)
  if (!a) {
    diag.branch = diag.branch || 'no-article-after-fallback';
    await log503(context, diag);
    return serve503(request);
  }
  if (!a.slug) return serve404(request);  // malformed record → honest 404

  // ── REGIONAL CONSOLIDATION (noindex→global, 2026-07-07) ──────────────────
  // Resolve the videoId-authoritative canonical target for a regional variant.
  // a.siblingSlug is derived from THIS video's published record, but a slug
  // collision (a later video republished under the same slug) can make it point
  // to a DIFFERENT video's global. Only canonicalise when the LIVE article at
  // siblingSlug is genuinely this video's global (same videoId + Global). The
  // slug-collision orphan (z2RwH06okKQ) fails this test → noindex-only, self-canonical.
  // REVERT: delete this block (buildPage then sees no _consolidateTo → self-canonical).
  // ─────────────────────────────────────────────────────────────────────────
  a._consolidateTo = null;
  if (a.region && a.region !== 'Global' && a.siblingSlug && a.videoId) {
    try {
      var sibUrl = new URL('/article-content?slug=' + encodeURIComponent(a.siblingSlug), request.url);
      var sibRes = await fetch(sibUrl.toString(), { headers: { 'Accept': 'application/json' } });
      if (sibRes.ok) {
        var sibData = await sibRes.json();
        var sib = sibData && sibData.article;
        if (sib && sib.videoId && sib.videoId === a.videoId && (!sib.region || sib.region === 'Global')) {
          a._consolidateTo = a.siblingSlug; // same-video live global → safe canonical target
        }
      }
    } catch (e) { /* leave null → noindex-only, self-canonical (safe default) */ }
  }

  // BUILD fully in memory…
  var html;
  try { html = buildPage(a); }
  catch (e) {
    diag.branch = 'buildpage-threw'; diag.detail = String((e && e.message) || e);
    await log503(context, diag);
    return serve503(request);
  }

  // …then VERIFY it is complete BEFORE sending. Never emit a partial/shell page.
  var titleOk = !!(a.title && String(a.title).trim());
  var bodyOk  = !!(a.body && String(a.body).trim());
  var markupOk = html.indexOf('<h1>') !== -1 && html.indexOf('class="article-body') !== -1;
  if (!titleOk || !bodyOk || !markupOk) {
    diag.branch = 'incomplete';
    diag.detail = 'title=' + titleOk + ' body=' + bodyOk + ' markup=' + markupOk;
    await log503(context, diag);
    return serve503(request);
  }

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate'
    }
  });
}

// HEAD mirrors GET — identical status + headers, no body (honest status for HEAD).
export async function onRequestHead(context) {
  var res = await onRequestGet(context);
  return new Response(null, { status: res.status, headers: res.headers });
}
