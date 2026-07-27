// functions/api/video-meta.js
// ─────────────────────────────────────────────────────────────────────────────
// VIDEO METADATA BACKFILL — feeds VideoObject schema on /article.
//
//   GET  /api/video-meta                  → inspect videometa:index (no writes)
//   POST /api/video-meta?key=<GATE_AUDIT_KEY>  → (re)build it from the YouTube API
//
// WHY THIS EXISTS: every published article has a source YouTube video, but the
// article record only stores `videoId` and `youtubeUrl` — no upload date, no
// duration, no real video title. Google's VideoObject REQUIRES uploadDate, and
// duration is what earns the enriched video result. Deriving uploadDate from the
// article's publish date would be fabricated structured data (the video is
// generally published well before the article), so instead we fetch the real
// values ONCE and cache them.
//
// One KV blob (videometa:index), not one key per video: /article then costs a
// single extra KV read per request instead of one per video, and the whole map is
// ~45 small entries.
//
// Idempotent and safe to re-run. Videos the API can't resolve (deleted, private)
// are simply absent from the map, and /article emits no VideoObject for them —
// never a guessed one.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'videometa:index';
const YT = 'https://www.googleapis.com/youtube/v3/videos';
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: HEADERS });

// GET — inspect without writing.
export async function onRequestGet(context) {
  const { env } = context;
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  const map = await env.FFX_KV.get(KEY, { type: 'json' }).catch(() => null);
  if (!map) return json({ built: false, note: 'POST with ?key= to build.' });
  const ids = Object.keys(map);
  return json({
    built: true,
    videos: ids.length,
    sample: ids.slice(0, 3).map(id => ({ id, ...map[id] })),
  });
}

// POST — rebuild from the YouTube API.
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  if (!env.GATE_AUDIT_KEY || url.searchParams.get('key') !== env.GATE_AUDIT_KEY) {
    return json({ error: 'unauthorized — pass ?key=<GATE_AUDIT_KEY>' }, 401);
  }
  if (!env.YOUTUBE_API_KEY) return json({ error: 'YOUTUBE_API_KEY not configured' }, 500);

  // 1. Every published slug, from the same index the sitemap and blog use.
  const index = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(() => null);
  const slugs = Array.isArray(index) ? index.filter(a => a && a.slug).map(a => a.slug) : [];
  if (!slugs.length) return json({ error: 'articles:index empty or unreadable' }, 500);

  // 2. Resolve each slug's videoId from its article record.
  const idToSlugs = {};
  for (const slug of slugs) {
    try {
      const meta = await env.FFX_KV.get('article:' + slug, { type: 'json' });
      const vid = meta && meta.videoId;
      if (vid) (idToSlugs[vid] = idToSlugs[vid] || []).push(slug);
    } catch { /* skip unreadable record */ }
  }
  const ids = Object.keys(idToSlugs);
  if (!ids.length) return json({ error: 'no videoIds found across articles:index' }, 500);

  // 3. Fetch real metadata, 50 ids per call (the API's per-request maximum).
  const map = {};
  const failed = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const res = await fetch(`${YT}?part=snippet,contentDetails&id=${batch.join(',')}&key=${env.YOUTUBE_API_KEY}`);
      if (!res.ok) { failed.push(...batch); continue; }
      const data = await res.json();
      for (const item of (data.items || [])) {
        const sn = item.snippet || {};
        const cd = item.contentDetails || {};
        if (!sn.publishedAt) continue;           // uploadDate is required — no date, no entry
        map[item.id] = {
          title: sn.title || '',
          description: String(sn.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          uploadDate: sn.publishedAt,
          duration: cd.duration || '',           // ISO-8601, e.g. PT12M34S
        };
      }
    } catch { failed.push(...batch); }
  }

  await env.FFX_KV.put(KEY, JSON.stringify(map));   // PERMANENT — no TTL

  return json({
    built: true,
    videosRequested: ids.length,
    videosResolved: Object.keys(map).length,
    unresolved: ids.filter(id => !map[id]),
    fetchFailures: failed,
    note: 'Unresolved videos get no VideoObject — schema is never fabricated.',
  });
}
