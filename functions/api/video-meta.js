// functions/api/video-meta.js
// ─────────────────────────────────────────────────────────────────────────────
// VIDEO METADATA — inspect / build videometa:index (feeds VideoObject on /article)
//
//   GET  /api/video-meta            → inspect, no writes
//   POST /api/video-meta            → FIRST build. No key required.
//   POST /api/video-meta?force=1    → rebuild an already-populated map. Key required.
//
// WHY THE FIRST BUILD NEEDS NO KEY: GATE_AUDIT_KEY has never been set on this
// project, so a key-guarded endpoint is simply unusable. Keyless first-build is
// safe here — it takes NO user input, writes only values derived from this site's
// own published articles via the YouTube API, is idempotent (a second call is a
// no-op because the map is then populated), and produces nothing publishable.
// This mirrors /api/seed-demand-map, which is deliberately keyless for the same
// reasons. Overwriting a populated map is the only destructive path, so THAT is
// what stays key-guarded.
//
// The cron also self-seeds this on every run (lib/video/meta.js ensureVideoMeta),
// so it heals itself even if this endpoint is never called.
// ─────────────────────────────────────────────────────────────────────────────

import { ensureVideoMeta, readVideoMeta } from '../../lib/video/meta.js';

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
  const map = await readVideoMeta(env);
  if (!map || !Object.keys(map).length) {
    return json({ built: false, note: 'POST to this URL to build it (no key needed for the first build).' });
  }
  const ids = Object.keys(map);
  return json({ built: true, videos: ids.length, sample: ids.slice(0, 3).map(id => ({ id, ...map[id] })) });
}

// POST — build (keyless) or force-rebuild (key-guarded).
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);

  const force = url.searchParams.get('force') === '1';
  if (force) {
    if (!env.GATE_AUDIT_KEY) {
      return json({ error: 'force rebuild needs GATE_AUDIT_KEY set in the Cloudflare dashboard. The keyless first build still works when the map is empty.' }, 501);
    }
    if (url.searchParams.get('key') !== env.GATE_AUDIT_KEY) {
      return json({ error: 'forbidden — valid ?key= required for force rebuild' }, 403);
    }
  }

  const result = await ensureVideoMeta(env, { force });
  if (!result.seeded && result.reason === 'already populated') {
    return json({ ...result, note: 'Map already built. Pass &force=1 with a key to rebuild.' }, 409);
  }
  return json(result, result.seeded ? 200 : 500);
}
