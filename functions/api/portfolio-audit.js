// functions/api/portfolio-audit.js
// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO AUDIT — the checks no per-article gate can make.
//
//   GET  /api/portfolio-audit   → last stored result (portfolio:status), no writes
//   POST /api/portfolio-audit   → run the checks, store, return. Keyless (read-only
//                                 analysis of our own KV; writes one status blob).
//
// WHY THIS EXISTS
// Every existing gate asks "is THIS article good?" — thin, similarity, fabrication,
// quotes, voice, structure. They all work, and they were all blind to the problems
// that actually flattened this site, because those problems only exist ACROSS
// articles:
//   • 7 pages each claiming the opening-candle topic. Each passed every gate.
//   • 26 articles targeting phrases with zero measured search demand.
//   • 33 of 45 pages with no internal links — a property of the graph, not a page.
//   • A demand map that silently ran dry.
// They were found by a human reading GSC months later. That is the failure this
// endpoint removes: each check below corresponds to a defect we actually shipped.
//
// Verdicts: 'pass' | 'warn' | 'fail'. The cron alerts on fail (and on new warns),
// so drift reports itself instead of waiting to be noticed.
// ─────────────────────────────────────────────────────────────────────────────

import { CONSOLIDATED, consolidationTarget, isIndexableArticle } from '../_seo-pages.js';
import { headTopic, rowTopic, readDemandMap } from '../../lib/keyword/select.js';
import { pickRelated, relTokens } from '../../lib/related/pick.js';

const STATUS_KEY = 'portfolio:status';
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};
const json = (b, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: HEADERS });

const check = (id, status, summary, detail) => ({ id, status, summary, detail: detail || null });

// ── 1. TOPIC COLLISION ──────────────────────────────────────────────────────
// Would have caught the 7 opening-candle pages and the fair-value-gap/gaps pair.
// Compares canonical (non-merged) articles by title-token overlap: two indexable
// pages whose titles overlap heavily are competing for one query, regardless of
// how differently the prose is written.
function checkTopicCollision(canon) {
  const toks = canon.map(a => ({ slug: a.slug, title: a.title, set: new Set(relTokens(a.title)) }));
  const pairs = [];
  for (let i = 0; i < toks.length; i++) {
    for (let j = i + 1; j < toks.length; j++) {
      const A = toks[i].set, B = toks[j].set;
      if (!A.size || !B.size) continue;
      let inter = 0;
      for (const t of A) if (B.has(t)) inter++;
      const jac = inter / (A.size + B.size - inter);
      if (jac >= 0.6) pairs.push({ a: toks[i].slug, b: toks[j].slug, overlap: Math.round(jac * 100) / 100 });
    }
  }
  pairs.sort((x, y) => y.overlap - x.overlap);
  if (!pairs.length) return check('topic_collision', 'pass', 'No canonical articles compete for the same query.');
  return check('topic_collision', 'fail',
    `${pairs.length} pair(s) of canonical articles overlap >=60% by title — cannibalization risk.`,
    pairs.slice(0, 10));
}

// ── 2. DEMAND COVERAGE ──────────────────────────────────────────────────────
// Would have caught 26 articles built on proprietary phrases nobody searches.
// A claimed demand-map row with volume 0 means we spent a generation on a term
// with no measured demand.
function checkDemandCoverage(map) {
  const claimed = map.filter(r => r && (r.status === 'claimed' || r.status === 'done'));
  if (!claimed.length) return check('demand_coverage', 'warn', 'No claimed demand-map rows to evaluate.');
  const zero = claimed.filter(r => !(r.volume > 0)).map(r => r.keyword);
  const pct = Math.round(((claimed.length - zero.length) / claimed.length) * 100);
  if (!zero.length) return check('demand_coverage', 'pass', `All ${claimed.length} generated topics target measured demand.`);
  return check('demand_coverage', zero.length > claimed.length * 0.2 ? 'fail' : 'warn',
    `${zero.length} of ${claimed.length} generated topics have zero measured volume (${pct}% covered).`, zero.slice(0, 15));
}

// ── 3. INTERNAL LINK COVERAGE ───────────────────────────────────────────────
// Would have caught 33 of 45 pages having no lateral links. Uses the SAME scorer
// the renderer uses, so this reports on links the site genuinely emits.
function checkInternalLinks(index, canon) {
  const inbound = {};
  canon.forEach(a => { inbound[a.slug] = 0; });
  let totalOut = 0;
  for (const a of canon) {
    const rel = pickRelated(index, a, 4, consolidationTarget);
    totalOut += rel.length;
    for (const r of rel) if (inbound[r.slug] !== undefined) inbound[r.slug]++;
  }
  const orphans = Object.keys(inbound).filter(s => inbound[s] === 0);
  const avgOut = canon.length ? Math.round((totalOut / canon.length) * 100) / 100 : 0;
  if (!orphans.length) return check('internal_links', 'pass', `Every canonical article is linked from another (avg ${avgOut} outbound).`);
  return check('internal_links', orphans.length > canon.length * 0.15 ? 'fail' : 'warn',
    `${orphans.length} canonical article(s) receive no internal links (avg ${avgOut} outbound).`, orphans.slice(0, 15));
}

// ── 4. DEMAND RUNWAY ────────────────────────────────────────────────────────
// Would have caught the map silently running dry — the reason generation is paused.
function checkRunway(map) {
  const used = new Set(map.filter(r => r && (r.status === 'claimed' || r.status === 'done')).map(rowTopic).filter(Boolean));
  const open = new Set();
  for (const r of map) {
    if (!r || r.verdict !== 'WINNABLE' || (r.status || 'open') !== 'open') continue;
    const t = rowTopic(r);
    if (t && !used.has(t)) open.add(t);
  }
  const n = open.size;
  const status = n === 0 ? 'fail' : (n <= 5 ? 'warn' : 'pass');
  return check('demand_runway', status,
    `${n} distinct winnable topic(s) remaining before the demand map is exhausted.`,
    n <= 5 ? [...open] : null);
}

// ── 5. CONSOLIDATION INTEGRITY ──────────────────────────────────────────────
// A broken canonical silently un-merges a cluster and re-splits the signal.
function checkConsolidation(liveSlugs) {
  const problems = [];
  for (const [dup, target] of Object.entries(CONSOLIDATED)) {
    if (!liveSlugs.has(dup)) problems.push({ slug: dup, issue: 'merged slug is not a live article' });
    if (!liveSlugs.has(target)) problems.push({ slug: dup, issue: `survivor "${target}" is not a live article` });
    if (dup === target) problems.push({ slug: dup, issue: 'self-canonical' });
    if (CONSOLIDATED[target]) problems.push({ slug: dup, issue: `survivor "${target}" is itself merged (chain)` });
  }
  if (!problems.length) {
    return check('consolidation', 'pass', `All ${Object.keys(CONSOLIDATED).length} merged pages point at a live survivor.`);
  }
  return check('consolidation', 'fail', `${problems.length} consolidation problem(s).`, problems.slice(0, 10));
}

// ── 6. VIDEO SCHEMA COVERAGE ────────────────────────────────────────────────
// Articles whose video metadata is cached but which no longer surface a video
// (or vice versa) mean schema and page content have drifted apart.
function checkVideoSchema(withVideo, videoMeta) {
  const missing = withVideo.filter(a => !videoMeta[a.videoId]).map(a => a.slug);
  if (!withVideo.length) return check('video_schema', 'warn', 'No articles carry a source video.');
  if (!missing.length) return check('video_schema', 'pass', `All ${withVideo.length} video articles have cached metadata for VideoObject.`);
  return check('video_schema', 'warn',
    `${missing.length} of ${withVideo.length} video articles have no cached metadata — they emit no VideoObject.`,
    missing.slice(0, 15));
}

async function runAudit(env) {
  const index = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(() => null);
  const rawArticles = Array.isArray(index) ? index.filter(a => a && a.slug && a.title) : [];
  if (!rawArticles.length) throw new Error('articles:index empty or unreadable');

  // articles:index does NOT carry region/draft — functions/articles.js:19 merges
  // them in from article:{slug}, and the live renderer decides robots from that
  // record too. Reading the raw index alone counted all 14 regional variants as
  // canonical (38 instead of 24) and reported their by-design near-duplicate
  // titles as cannibalization. Enrich first, exactly as /articles does.
  const withVideo = [];
  const articles = [];
  for (const a of rawArticles) {
    let meta = null;
    try { meta = await env.FFX_KV.get('article:' + a.slug, { type: 'json' }); } catch { /* keep index values */ }
    const merged = {
      ...a,
      region: (meta && meta.region) || a.region || 'Global',
      draft: !!((meta && meta.draft) || a.draft),
    };
    articles.push(merged);
    if (meta && meta.videoId && meta.youtubeUrl) withVideo.push({ slug: a.slug, videoId: meta.videoId, region: merged.region, draft: merged.draft });
  }

  const liveSlugs = new Set(articles.map(a => a.slug));
  // Canonical = indexable AND not merged away. This is the set Google actually counts.
  const canon = articles.filter(a => isIndexableArticle(a) && !consolidationTarget(a.slug));
  const canonSlugs = new Set(canon.map(a => a.slug));

  const map = await readDemandMap(env).catch(() => []);
  const videoMeta = (await env.FFX_KV.get('videometa:index', { type: 'json' }).catch(() => null)) || {};
  const canonWithVideo = withVideo.filter(v => canonSlugs.has(v.slug));

  const checks = [
    checkTopicCollision(canon),
    checkDemandCoverage(map),
    checkInternalLinks(articles, canon),
    checkRunway(map),
    checkConsolidation(liveSlugs),
    checkVideoSchema(canonWithVideo, videoMeta),
  ];

  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warn').length;

  return {
    at: new Date().toISOString(),
    verdict: failed ? 'fail' : (warned ? 'warn' : 'pass'),
    counts: { failed, warned, passed: checks.length - failed - warned },
    portfolio: {
      liveArticles: articles.length,
      indexableArticles: articles.filter(isIndexableArticle).length,
      canonicalArticles: canon.length,
      mergedAway: Object.keys(CONSOLIDATED).length,
      regionalNoindex: articles.filter(a => a.region && a.region !== 'Global').length,
    },
    checks,
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  const last = await env.FFX_KV.get(STATUS_KEY, { type: 'json' }).catch(() => null);
  if (!last) return json({ ran: false, note: 'POST to run the audit.' });
  return json({ ran: true, ...last });
}

export async function onRequestPost(context) {
  const { env } = context;
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  try {
    const result = await runAudit(env);

    // ── CHANGE DETECTION ────────────────────────────────────────────────────
    // A check that fails every day for a reason you already know is noise, and
    // noise trains you to ignore the alert — which would defeat the entire point
    // of this endpoint. demand_runway will sit at 'fail' for as long as generation
    // is deliberately paused. So the cron alerts on CHANGE, not on state:
    // newIssues lists checks that were not failing on the previous run.
    const prev = await env.FFX_KV.get(STATUS_KEY, { type: 'json' }).catch(() => null);
    const prevFailing = new Set(((prev && prev.checks) || []).filter(c => c.status === 'fail').map(c => c.id));
    const nowFailing = result.checks.filter(c => c.status === 'fail').map(c => c.id);
    result.newIssues = nowFailing.filter(id => !prevFailing.has(id));
    result.resolvedIssues = [...prevFailing].filter(id => !nowFailing.includes(id));
    result.changed = result.newIssues.length > 0 || result.resolvedIssues.length > 0;

    await env.FFX_KV.put(STATUS_KEY, JSON.stringify(result));   // PERMANENT — dashboard reads it
    return json(result);
  } catch (err) {
    return json({ error: 'audit failed: ' + (err && err.message) }, 500);
  }
}
