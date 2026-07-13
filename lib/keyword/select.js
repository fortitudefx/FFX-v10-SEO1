// ═══════════════════════════════════════════════════════════════════════════
// KEYWORD SOURCE — target selection (shared by ffx-cron and ffx-consumer)
// ───────────────────────────────────────────────────────────────────────────
// SOURCE SWAP: the pipeline can be sourced from the YouTube back-catalogue
// (mode 'video', the original behaviour) or from the keyword demand map
// (mode 'keyword'). The mode is a single env var, SOURCE_MODE. Flipping it back
// to 'video' restores the exact original behaviour with no other change.
//
//   demand:map (KV)  = the live demand map: an array of target rows, each
//                      { keyword, volume, kd, verdict, cluster, canonical,
//                        proprietary_term, nugget_tags, status, article_slug,
//                        claimedAt }. Seeded once from lib/keyword/seed-data.js
//                      via /api/seed-demand-map, refreshed by re-seeding.
//
// The cron selects the next N WINNABLE, unclaimed, DISTINCT-canonical-topic
// targets each weekday, marks them claimed, and enqueues them. One article per
// canonical topic — keyword variants of a claimed topic are left for enrichment,
// never spawned as duplicate articles (that is what cannibalised the first 26).
// ═══════════════════════════════════════════════════════════════════════════

export const DEMAND_MAP_KEY = 'demand:map';

// SOURCE_MODE gate. Anything other than the exact string 'keyword' is treated as
// 'video' so a missing/typo'd var can never silently divert the live pipeline.
export function sourceMode(env) {
  return (env && env.SOURCE_MODE === 'keyword') ? 'keyword' : 'video';
}

// DRY_RUN gate. When true the keyword pipeline generates + gates an article but
// writes it to a preview key instead of the live video record / queue, so it can
// never be published. Off by default.
export function isDryRun(env) {
  return !!(env && (env.KEYWORD_DRY_RUN === '1' || env.KEYWORD_DRY_RUN === 'true'));
}

// Articles per weekday cron run (2/weekday = 10/week). Overridable via env.
export function keywordsPerRun(env) {
  const n = parseInt((env && env.KEYWORDS_PER_RUN) || '2', 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

export async function readDemandMap(env) {
  const raw = await env.FFX_KV.get(DEMAND_MAP_KEY, { type: 'json' }).catch(() => null);
  return Array.isArray(raw) ? raw : [];
}

export async function writeDemandMap(env, map) {
  await env.FFX_KV.put(DEMAND_MAP_KEY, JSON.stringify(map)); // PERMANENT — no TTL
}

// A stable, url-safe slug for a keyword — used for the synthetic id/anchor so the
// existing video:{id} / queue:index / gate:{slug} plumbing works unchanged.
export function keywordId(keyword) {
  return 'kw-' + String(keyword || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Select the next N winnable, unclaimed, distinct-canonical-topic targets.
// Returns { picks, winnableRemaining, ambiguousRemaining } — the caller marks
// picks claimed via markClaimed() and decides whether to alert on a low count.
export function selectTargets(map, n) {
  const openWinnable = map
    .filter(r => r && r.verdict === 'WINNABLE' && (r.status || 'open') === 'open')
    .sort((a, b) => (b.volume || 0) - (a.volume || 0));

  const picks = [];
  const usedTopics = new Set(
    // topics already claimed/done anywhere in the map are off-limits for a NEW article
    map.filter(r => r && r.canonical && (r.status === 'claimed' || r.status === 'done'))
       .map(r => r.canonical)
  );
  for (const row of openWinnable) {
    if (picks.length >= n) break;
    const topic = row.canonical || row.keyword;
    if (usedTopics.has(topic)) continue; // one article per canonical topic
    usedTopics.add(topic);
    picks.push(row);
  }

  // remaining distinct winnable topics still available AFTER these picks
  const remainingTopics = new Set();
  for (const row of openWinnable) {
    const topic = row.canonical || row.keyword;
    if (!usedTopics.has(topic)) remainingTopics.add(topic);
  }

  return {
    picks,
    winnableRemaining: remainingTopics.size,
    ambiguousRemaining: map.filter(r => r && r.verdict === 'AMBIGUOUS' && (r.status || 'open') === 'open').length,
  };
}

// Mark a target claimed in the map (mutates the row object in place).
export function markClaimed(row, extra) {
  row.status = 'claimed';
  row.claimedAt = (extra && extra.at) || null;
  if (extra && extra.articleSlug) row.article_slug = extra.articleSlug;
  return row;
}

// ── Nugget retrieval ────────────────────────────────────────────────────────
// Mirror of the intelligence-engine's nugget matcher (functions/api/
// intelligence-engine.js ~:744): filter the library by tag overlap with the
// target's nugget_tags (falling back to keyword tokens). Returns matched nugget
// IDs, most-recent first, capped at `limit`.
const NUGGET_STOP = new Set(['the','and','for','a','an','of','to','in','is','on','how','what','vs','forex','trading','trade']);

function targetTokens(target) {
  const tagStr = (target.nugget_tags || '').toLowerCase();
  const fromTags = tagStr.split(',').map(s => s.trim()).filter(Boolean);
  if (fromTags.length) return fromTags;
  // fallback: canonical/keyword tokens
  return String(target.canonical || target.keyword || '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !NUGGET_STOP.has(w));
}

export async function retrieveNuggetIds(env, target, limit = 8) {
  const indexRaw = await env.FFX_KV.get('nuggets:index', { type: 'json' }).catch(() => null);
  const index = Array.isArray(indexRaw) ? indexRaw : [];
  if (!index.length) return [];

  const tokens = targetTokens(target);
  if (!tokens.length) return [];

  // Scan a bounded window of the newest nuggets (the library is ~226; cap reads).
  const window = index.slice(0, 120);
  const nuggets = (await Promise.all(
    window.map(id => env.FFX_KV.get('nugget:' + id, { type: 'json' }).catch(() => null))
  )).filter(Boolean);

  const scored = [];
  for (const n of nuggets) {
    const hay = [
      (n.tags || []).join(' '),
      n.category || '', n.text || '', n.hook || '',
    ].join(' ').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (hay.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ id: n.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.id);
}
