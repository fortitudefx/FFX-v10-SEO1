// ═══════════════════════════════════════════════════════════════════════════
// VIDEO METADATA — self-seeding source for VideoObject schema on /article
// ───────────────────────────────────────────────────────────────────────────
// Every published article is built from a YouTube video, but the article record
// stores only `videoId` / `youtubeUrl` — no upload date, no duration, no real
// video title. Google REQUIRES uploadDate on VideoObject, and an article's
// publish date is NOT its video's upload date, so deriving one would be
// fabricated structured data. We fetch the real values once and cache them.
//
// Shape: ONE KV blob (videometa:index) mapping videoId -> { title, description,
// uploadDate, duration }. One blob rather than a key per video means /article
// costs a single extra KV read per request, and ~45 small entries fit easily.
//
// Self-seeding, exactly like ensureDemandMap()/ensureCorpus() in
// lib/keyword/seed.js: idempotent, a no-op once populated, callable with no key
// or manual step. A video the API cannot resolve (deleted, private, quota) is
// simply absent from the map and /article emits NO VideoObject for that page —
// never a guessed one.
// ═══════════════════════════════════════════════════════════════════════════

export const VIDEO_META_KEY = 'videometa:index';
const YT_API = 'https://www.googleapis.com/youtube/v3/videos';

export async function readVideoMeta(env) {
  const raw = await env.FFX_KV.get(VIDEO_META_KEY, { type: 'json' }).catch(() => null);
  return (raw && typeof raw === 'object') ? raw : null;
}

// Collect every distinct videoId across the published set, via the same
// articles:index the sitemap and blog read from.
async function collectVideoIds(env) {
  const index = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(() => null);
  const slugs = Array.isArray(index) ? index.filter(a => a && a.slug).map(a => a.slug) : [];
  const ids = new Set();
  for (const slug of slugs) {
    try {
      const meta = await env.FFX_KV.get('article:' + slug, { type: 'json' });
      if (meta && meta.videoId) ids.add(meta.videoId);
    } catch { /* unreadable record — skip */ }
  }
  return [...ids];
}

// Fetch real metadata from the YouTube API, 50 ids per call (API maximum).
async function fetchMeta(ids, apiKey, fetchImpl) {
  const map = {};
  const failed = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const res = await fetchImpl(`${YT_API}?part=snippet,contentDetails&id=${batch.join(',')}&key=${apiKey}`);
      if (!res.ok) { failed.push(...batch); continue; }
      const data = await res.json();
      for (const item of (data.items || [])) {
        const sn = item.snippet || {};
        const cd = item.contentDetails || {};
        if (!sn.publishedAt) continue;          // uploadDate is required — no date, no entry
        map[item.id] = {
          title: sn.title || '',
          description: String(sn.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          uploadDate: sn.publishedAt,
          duration: cd.duration || '',          // ISO-8601, e.g. PT12M34S
        };
      }
    } catch { failed.push(...batch); }
  }
  return { map, failed };
}

// Build videometa:index if empty (or force). Returns a result object; NEVER throws,
// so a caller in a cron chain can't be broken by it.
export async function ensureVideoMeta(env, { force = false, fetchImpl = fetch } = {}) {
  try {
    if (!env || !env.FFX_KV) return { seeded: false, reason: 'FFX_KV not bound' };
    if (!env.YOUTUBE_API_KEY) return { seeded: false, reason: 'YOUTUBE_API_KEY not configured' };

    const existing = await readVideoMeta(env);
    if (existing && Object.keys(existing).length && !force) {
      return { seeded: false, reason: 'already populated', count: Object.keys(existing).length };
    }

    const ids = await collectVideoIds(env);
    if (!ids.length) return { seeded: false, reason: 'no videoIds across articles:index' };

    const { map, failed } = await fetchMeta(ids, env.YOUTUBE_API_KEY, fetchImpl);
    const resolved = Object.keys(map).length;
    if (!resolved) return { seeded: false, reason: 'YouTube API resolved nothing', requested: ids.length, failed };

    await env.FFX_KV.put(VIDEO_META_KEY, JSON.stringify(map));   // PERMANENT — no TTL
    return {
      seeded: true,
      requested: ids.length,
      resolved,
      unresolved: ids.filter(id => !map[id]),
      failed,
    };
  } catch (err) {
    return { seeded: false, reason: 'errored (non-fatal): ' + (err && err.message) };
  }
}
