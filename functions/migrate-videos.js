// ─────────────────────────────────────────────────────────────────────────────
// FFX Migration — ONE TIME USE ONLY
// GET /migrate-videos → migrates all video:* entries to published:* structure
// DELETE THIS FILE AFTER CONFIRMING MIGRATION SUCCESS
//
// What it does:
// 1. Reads all video:* keys from KV
// 2. For each entry — extracts full content and platform URLs
// 3. Writes published:{videoId} permanently with full content + platform URLs
// 4. Sets video:* entries to 24hr TTL (staging only going forward)
// 5. Returns full report of what was migrated
//
// What it does NOT touch:
// article:* keys, job:* keys, library:* keys, config:* keys, lock:* keys
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.FFX_KV) {
    return new Response(JSON.stringify({ error: 'FFX_KV binding not found' }), { status: 500, headers });
  }

  const report = {
    total: 0,
    migrated: [],
    skipped: [],
    errors: [],
  };

  try {
    // ── Step 1: List all video:* keys ────────────────────────────────────────
    const allKeys = [];
    let cursor = undefined;
    let done = false;

    while (!done) {
      const result = await env.FFX_KV.list({ prefix: 'video:', cursor, limit: 1000 });
      allKeys.push(...result.keys);
      if (result.list_complete) {
        done = true;
      } else {
        cursor = result.cursor;
      }
    }

    report.total = allKeys.length;
    console.log('[FFX Migration] Found', allKeys.length, 'video keys');

    // ── Step 2: Process each entry ───────────────────────────────────────────
    for (const key of allKeys) {
      try {
        const entry = await env.FFX_KV.get(key.name, { type: 'json' });
        if (!entry) {
          report.skipped.push({ key: key.name, reason: 'Empty entry' });
          continue;
        }

        // Extract videoId from key name — strip 'video:' or 'video:slug:' prefix
        const keyName = key.name;
        let videoId = entry.videoId || null;

        // For video:slug:* entries — videoId field contains slug text not real videoId
        // Use the slug as identifier for published key
        const isSlugKey = keyName.startsWith('video:slug:');
        const publishedKey = isSlugKey
          ? `published:slug:${entry.slug || entry.videoId}`
          : `published:${videoId}`;

        if (!videoId && !entry.slug) {
          report.skipped.push({ key: keyName, reason: 'No videoId or slug found' });
          continue;
        }

        // ── Extract full content ──────────────────────────────────────────────
        // Old structure: entry.content has everything flat
        // New structure: entry.platforms.blog_global.content
        const globalContent = entry.content || entry.platforms?.blog_global?.content || null;

        if (!globalContent) {
          report.skipped.push({ key: keyName, reason: 'No content found' });
          continue;
        }

        // Ensure youtubeUrl is in globalContent
        if (!globalContent.youtubeUrl && entry.youtubeUrl) {
          globalContent.youtubeUrl = entry.youtubeUrl;
        }
        if (!globalContent.videoId && videoId) {
          globalContent.videoId = videoId;
        }

        // ── Extract platform URLs from =HYPERLINK(...) format ─────────────────
        const extractUrl = (status) => {
          if (!status) return null;
          if (status.startsWith('http')) return status;
          if (status.startsWith('=HYPERLINK(')) {
            const match = status.match(/=HYPERLINK\("([^"]+)"/);
            return match ? match[1] : null;
          }
          return null;
        };

        // Old structure has platforms at entry.platforms.blog/x/linkedin etc
        // New structure has platforms at entry.platforms.blog_global etc
        const oldPlatforms = entry.platforms || {};

        const blogUrl      = extractUrl(oldPlatforms.blog?.status);
        const xUrl         = extractUrl(oldPlatforms.x?.status);
        const linkedinUrl  = extractUrl(oldPlatforms.linkedin?.status);
        const tumblrUrl    = extractUrl(oldPlatforms.tumblr?.status);
        const discordUrl   = extractUrl(oldPlatforms.discord?.status);

        // ── Build published:{videoId} entry ──────────────────────────────────
        const now = new Date();
        const dubaiTime = new Date(now.getTime() + (4 * 60 * 60 * 1000));
        const timestamp = dubaiTime.toISOString().replace('T', ' ').substring(0, 19);

        const platforms = {};

        if (blogUrl) {
          platforms.blog = { status: blogUrl, publishedAt: oldPlatforms.blog?.updatedAt || timestamp };
        }
        if (xUrl) {
          platforms.x = { status: xUrl, publishedAt: oldPlatforms.x?.updatedAt || timestamp };
        }
        if (linkedinUrl) {
          platforms.linkedin = { status: linkedinUrl, publishedAt: oldPlatforms.linkedin?.updatedAt || timestamp };
        }
        if (tumblrUrl) {
          platforms.tumblr = { status: tumblrUrl, publishedAt: oldPlatforms.tumblr?.updatedAt || timestamp };
        }
        if (discordUrl) {
          platforms.discord = { status: discordUrl, publishedAt: oldPlatforms.discord?.updatedAt || timestamp };
        }

        // Check if published entry already exists — preserve existing data
        const existingPublished = await env.FFX_KV.get(publishedKey, { type: 'json' });
        const existingPlatforms = existingPublished?.platforms || {};

        // Merge — existing published data takes priority over migrated data
        const mergedPlatforms = { ...platforms, ...existingPlatforms };

        const publishedEntry = {
          videoId:         isSlugKey ? null : videoId,
          slug:            entry.slug || globalContent.slug || '',
          title:           entry.title || globalContent.title || '',
          youtubeUrl:      entry.youtubeUrl || globalContent.youtubeUrl || '',
          region:          entry.region || globalContent.region || 'Global',
          updatedAt:       timestamp,
          migratedAt:      timestamp,
          // Full content stored permanently for republishing from Press
          globalContent,
          regionalContent: entry.platforms?.blog_regional?.content || null,
          platforms:       mergedPlatforms,
        };

        // Write published:* — PERMANENT, no TTL
        await env.FFX_KV.put(publishedKey, JSON.stringify(publishedEntry));

        // Set video:* to 24hr TTL — staging only going forward
        // Rewrite in new unified structure
        const newVideoEntry = {
          videoId:     isSlugKey ? null : videoId,
          youtubeUrl:  entry.youtubeUrl || '',
          slug:        entry.slug || globalContent.slug || '',
          title:       entry.title || globalContent.title || '',
          region:      entry.region || 'Global',
          generatedAt: entry.createdAt || entry.generatedAt || timestamp,
          platforms: {
            blog_global: {
              status: 'generated',
              content: globalContent,
              updatedAt: timestamp,
            },
            blog_regional: {
              status: 'generated',
              content: entry.platforms?.blog_regional?.content || null,
              updatedAt: timestamp,
            },
            x: {
              status: 'generated',
              content: {
                tweets: [
                  globalContent.tweet1, globalContent.tweet2,
                  globalContent.tweet3, globalContent.tweet4,
                  globalContent.tweet5, globalContent.tweet6,
                ].filter(Boolean),
              },
              updatedAt: timestamp,
            },
            linkedin: {
              status: 'generated',
              content: { text: globalContent.linkedin || '' },
              updatedAt: timestamp,
            },
            discord: {
              status: 'generated',
              content: { text: globalContent.discord || '' },
              updatedAt: timestamp,
            },
            tumblr: {
              status: 'generated',
              content: { text: globalContent.tumblr || '' },
              updatedAt: timestamp,
            },
          },
        };

        // Write video:* with 24hr TTL — staging only
        await env.FFX_KV.put(key.name, JSON.stringify(newVideoEntry), { expirationTtl: 86400 });

        report.migrated.push({
          key: keyName,
          publishedKey,
          slug: publishedEntry.slug,
          title: publishedEntry.title,
          platforms: Object.keys(mergedPlatforms),
        });

        console.log('[FFX Migration] Migrated:', keyName, '→', publishedKey);

      } catch (err) {
        console.error('[FFX Migration] Error processing key:', key.name, err.message);
        report.errors.push({ key: key.name, error: err.message });
      }
    }

    console.log('[FFX Migration] Complete. Migrated:', report.migrated.length, 'Skipped:', report.skipped.length, 'Errors:', report.errors.length);

    return new Response(JSON.stringify({
      success: true,
      summary: {
        total:    report.total,
        migrated: report.migrated.length,
        skipped:  report.skipped.length,
        errors:   report.errors.length,
      },
      migrated: report.migrated,
      skipped:  report.skipped,
      errors:   report.errors,
      next: 'Confirm all articles appear in Press, then delete functions/migrate-videos.js from your repo immediately.',
    }, null, 2), { status: 200, headers });

  } catch (err) {
    console.error('[FFX Migration] Fatal error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
