// functions/api/bulk-link-scan.js
// POST /api/bulk-link-scan — scans all published articles, finds missing internal links
//   clusters by tag overlap, inserts missing links, returns full report
// GET  /api/bulk-link-scan — returns link graph stats without modifying anything

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  try {
    // Read articles:index
    const articlesIndex = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(function(){ return null; });
    const articles = Array.isArray(articlesIndex) ? articlesIndex : [];

    if (!articles.length) {
      return json({ error: 'articles:index is empty. Run POST /api/backfill-articles-index first.' }, 400, headers);
    }

    // Read all link_graph keys
    const lgList = await env.FFX_KV.list({ prefix: 'content:link_graph:' }).catch(function(){ return { keys: [] }; });
    const linkGraphEntries = (await Promise.all(
      lgList.keys.map(function(k){ return env.FFX_KV.get(k.name, { type: 'json' }).catch(function(){ return null; }); })
    )).filter(Boolean);

    // Build link map: slug -> [slugs it links to]
    const linkMap = {};
    articles.forEach(function(a){ linkMap[a.slug] = []; });
    linkGraphEntries.forEach(function(lg) {
      if (lg.slug && Array.isArray(lg.linksTo)) {
        linkMap[lg.slug] = lg.linksTo.map(function(l){ return l.slug; });
      }
    });

    // Also check articles:index internalLinks field (set by article-link.js)
    articles.forEach(function(a) {
      if (Array.isArray(a.internalLinks) && a.internalLinks.length > 0) {
        var existing = linkMap[a.slug] || [];
        a.internalLinks.forEach(function(il) {
          if (!existing.includes(il.targetSlug)) existing.push(il.targetSlug);
        });
        linkMap[a.slug] = existing;
      }
    });

    // Compute stats
    var totalArticles  = articles.length;
    var linkedArticles = Object.values(linkMap).filter(function(links){ return links.length > 0; }).length;
    var coverage       = totalArticles > 0 ? Math.round((linkedArticles / totalArticles) * 100) : 0;

    // Inbound links per article
    var inboundMap = {};
    articles.forEach(function(a){ inboundMap[a.slug] = []; });
    Object.entries(linkMap).forEach(function(entry) {
      var fromSlug = entry[0];
      var toSlugs  = entry[1];
      toSlugs.forEach(function(toSlug) {
        if (inboundMap[toSlug]) inboundMap[toSlug].push(fromSlug);
      });
    });

    // Find missing link opportunities (tag overlap >= 2, no existing link)
    var opportunities = [];
    for (var i = 0; i < articles.length; i++) {
      for (var j = i + 1; j < articles.length; j++) {
        var a = articles[i];
        var b = articles[j];
        if (!a.tags || !b.tags) continue;
        var sharedTags = a.tags.filter(function(t) {
          return b.tags.some(function(bt){ return bt.toLowerCase() === t.toLowerCase(); });
        });
        if (sharedTags.length < 1) continue;
        // Check if link already exists in either direction
        var aLinksB = (linkMap[a.slug] || []).includes(b.slug);
        var bLinksA = (linkMap[b.slug] || []).includes(a.slug);
        if (!aLinksB) {
          opportunities.push({
            fromSlug: a.slug, fromTitle: a.title,
            toSlug:   b.slug, toTitle:   b.title,
            sharedTags, score: sharedTags.length,
          });
        }
        if (!bLinksA) {
          opportunities.push({
            fromSlug: b.slug, fromTitle: b.title,
            toSlug:   a.slug, toTitle:   a.title,
            sharedTags, score: sharedTags.length,
          });
        }
      }
    }

    // Sort by score descending
    opportunities.sort(function(a, b){ return b.score - a.score; });

    // Build article link graph for display
    var graph = articles.map(function(a) {
      return {
        slug:          a.slug,
        title:         a.title,
        outbound:      (linkMap[a.slug] || []).length,
        inbound:       (inboundMap[a.slug] || []).length,
        outboundSlugs: linkMap[a.slug] || [],
        inboundSlugs:  inboundMap[a.slug] || [],
      };
    });

    return json({
      totalArticles, linkedArticles, coverage,
      graph,
      opportunities: opportunities.slice(0, 20), // Top 20
      totalOpportunities: opportunities.length,
    }, 200, headers);

  } catch(err) {
    console.error('[bulk-link-scan] GET error:', err.message);
    return json({ error: err.message }, 500, headers);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500, headers);

  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  // dryRun=true returns what would be done without doing it
  const dryRun    = body.dryRun === true;
  const maxLinks  = Math.min(body.maxLinks || 10, 50); // Safety cap at 50

  try {
    // Read articles:index
    const articlesIndex = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(function(){ return null; });
    const articles = Array.isArray(articlesIndex) ? articlesIndex : [];

    if (!articles.length) {
      return json({ error: 'articles:index is empty. Run POST /api/backfill-articles-index first.' }, 400, headers);
    }

    // ── Step 1: Build current link map from link_graph + articles:index ──
    const lgList = await env.FFX_KV.list({ prefix: 'content:link_graph:' }).catch(function(){ return { keys: [] }; });
    const linkGraphEntries = (await Promise.all(
      lgList.keys.map(function(k){ return env.FFX_KV.get(k.name, { type: 'json' }).catch(function(){ return null; }); })
    )).filter(Boolean);

    const linkMap = {};
    articles.forEach(function(a){ linkMap[a.slug] = []; });
    linkGraphEntries.forEach(function(lg) {
      if (lg.slug && Array.isArray(lg.linksTo)) {
        linkMap[lg.slug] = lg.linksTo.map(function(l){ return l.slug; });
      }
    });
    // Merge in manual retroactive links
    articles.forEach(function(a) {
      if (Array.isArray(a.internalLinks)) {
        a.internalLinks.forEach(function(il) {
          if (linkMap[a.slug] && !linkMap[a.slug].includes(il.targetSlug)) {
            linkMap[a.slug].push(il.targetSlug);
          }
        });
      }
    });

    // ── Step 2: Find all missing link pairs by tag overlap ────────────────
    var pairs = [];
    for (var i = 0; i < articles.length; i++) {
      for (var j = i + 1; j < articles.length; j++) {
        var a = articles[i]; var b = articles[j];
        if (!a.tags || !b.tags) continue;
        var shared = a.tags.filter(function(t){
          return b.tags.some(function(bt){ return bt.toLowerCase() === t.toLowerCase(); });
        });
        if (shared.length < 1) continue;
        if (!(linkMap[a.slug] || []).includes(b.slug)) {
          pairs.push({ fromSlug: a.slug, fromTitle: a.title, toSlug: b.slug, toTitle: b.title,
            toUrl: 'https://fortitudefx.com/article?slug=' + b.slug, sharedTags: shared, score: shared.length });
        }
        if (!(linkMap[b.slug] || []).includes(a.slug)) {
          pairs.push({ fromSlug: b.slug, fromTitle: b.title, toSlug: a.slug, toTitle: a.title,
            toUrl: 'https://fortitudefx.com/article?slug=' + a.slug, sharedTags: shared, score: shared.length });
        }
      }
    }

    pairs.sort(function(a, b){ return b.score - a.score; });
    var toProcess = pairs.slice(0, maxLinks);

    if (dryRun) {
      return json({ dryRun: true, totalPairs: pairs.length, wouldProcess: toProcess.length, pairs: toProcess }, 200, headers);
    }

    // ── Step 3: For each pair, get videoId then insert link ───────────────
    var results = [];
    var inserted = 0; var skipped = 0; var failed = 0;

    for (var k = 0; k < toProcess.length; k++) {
      var pair = toProcess[k];
      try {
        // Get videoId for source article
        const articleMeta = await env.FFX_KV.get('article:' + pair.fromSlug, { type: 'json' }).catch(function(){ return null; });
        if (!articleMeta || !articleMeta.videoId) {
          results.push({ fromSlug: pair.fromSlug, toSlug: pair.toSlug, status: 'skipped', reason: 'No videoId for source article' });
          skipped++;
          continue;
        }

        const videoId = articleMeta.videoId;
        const published = await env.FFX_KV.get('published:' + videoId, { type: 'json' }).catch(function(){ return null; });
        if (!published || !published.globalContent || !published.globalContent.body) {
          results.push({ fromSlug: pair.fromSlug, toSlug: pair.toSlug, status: 'skipped', reason: 'No published body found' });
          skipped++;
          continue;
        }

        const body = published.globalContent.body;

        // Check if link already exists
        if (body.includes(pair.toUrl)) {
          results.push({ fromSlug: pair.fromSlug, toSlug: pair.toSlug, status: 'skipped', reason: 'Link already exists' });
          skipped++;
          continue;
        }

        // Find insertion point — second to last </p> before CTA
        var occurrences = [];
        var searchFrom = 0;
        while (true) {
          var idx = body.indexOf('</p>', searchFrom);
          if (idx === -1) break;
          occurrences.push(idx);
          searchFrom = idx + 4;
        }
        var ctaStart = body.indexOf('discord.gg/fortitudefx');
        var candidates = occurrences.filter(function(idx){ return ctaStart === -1 || idx < ctaStart; });
        var insertIdx = candidates.length >= 2 ? candidates[candidates.length - 2] + 4
          : candidates.length === 1 ? candidates[0] + 4
          : occurrences.length > 0 ? occurrences[Math.max(0, occurrences.length - 2)] + 4 : -1;

        if (insertIdx === -1) {
          results.push({ fromSlug: pair.fromSlug, toSlug: pair.toSlug, status: 'failed', reason: 'No safe insertion point found' });
          failed++;
          continue;
        }

        const linkHtml = ' For further reading, see <a href="' + pair.toUrl + '">' + pair.toTitle + '</a>.';
        const newBody = body.slice(0, insertIdx) + '<p>' + linkHtml + '</p>' + body.slice(insertIdx);

        // Write back
        published.globalContent.body = newBody;
        if (!published.internalLinks) published.internalLinks = [];
        published.internalLinks.push({ targetSlug: pair.toSlug, targetTitle: pair.toTitle, targetUrl: pair.toUrl, insertedAt: new Date().toISOString() });
        await env.FFX_KV.put('published:' + videoId, JSON.stringify(published));

        // Update articles:index entry
        try {
          const indexRaw = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(function(){ return null; });
          if (Array.isArray(indexRaw)) {
            var aIdx = indexRaw.findIndex(function(a){ return a.slug === pair.fromSlug; });
            if (aIdx !== -1) {
              if (!indexRaw[aIdx].internalLinks) indexRaw[aIdx].internalLinks = [];
              indexRaw[aIdx].internalLinks.push({ targetSlug: pair.toSlug, targetUrl: pair.toUrl, insertedAt: new Date().toISOString() });
              // Update linkMap for subsequent iterations
              if (!linkMap[pair.fromSlug]) linkMap[pair.fromSlug] = [];
              linkMap[pair.fromSlug].push(pair.toSlug);
              await env.FFX_KV.put('articles:index', JSON.stringify(indexRaw));
            }
          }
        } catch(idxErr) {
          console.error('[bulk-link-scan] articles:index update failed (non-fatal):', idxErr.message);
        }

        results.push({ fromSlug: pair.fromSlug, fromTitle: pair.fromTitle, toSlug: pair.toSlug, toTitle: pair.toTitle, status: 'inserted', sharedTags: pair.sharedTags });
        inserted++;
        console.log('[bulk-link-scan] Inserted:', pair.fromSlug, '->', pair.toSlug);

      } catch(pairErr) {
        console.error('[bulk-link-scan] Pair error:', pair.fromSlug, '->', pair.toSlug, pairErr.message);
        results.push({ fromSlug: pair.fromSlug, toSlug: pair.toSlug, status: 'failed', reason: pairErr.message });
        failed++;
      }
    }

    // Write bulk scan outcome for feedback loop
    try {
      const today = new Date().toISOString().split('T')[0];
      await env.FFX_KV.put('intelligence:directive_outcome:' + today + ':bulk_link_scan', JSON.stringify({
        directiveType: 'bulk_link_scan', actedOn: true, actedOnAt: new Date().toISOString(),
        inserted, skipped, failed, totalPairs: pairs.length, date: today, outcome: null, accurate: null,
      }));
    } catch(outcomeErr) {
      console.error('[bulk-link-scan] Outcome write failed (non-fatal):', outcomeErr.message);
    }

    return json({ success: true, inserted, skipped, failed, totalPairs: pairs.length, results }, 200, headers);

  } catch(err) {
    console.error('[bulk-link-scan] POST error:', err.message);
    return json({ error: err.message }, 500, headers);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
