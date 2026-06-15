// ─────────────────────────────────────────────────────────────────────────────
// FFX Consumer Worker — Queue consumer
// 4 Claude calls: Global Article, Global Platforms, Regional Article, Regional Platforms
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processJob(message.body, env);
        message.ack();
      } catch (err) {
        console.error('[FFX] Unhandled crash:', err.message);
        try { await env.FFX_KV.delete('lock:generating'); } catch {}
        try {
          await env.FFX_KV.put(
            `job:${message.body.jobId}`,
            JSON.stringify({
              status: 'error', videoId: message.body.videoId, step: 'unknown',
              reason: 'Unhandled crash: ' + err.message, retryable: true,
              failedAt: new Date().toISOString(),
            }),
            { expirationTtl: 86400 }
          );
        } catch {}
        message.retry();
      }
    }
  }
};

async function processJob(job, env) {
  // Route newsletter jobs to separate handler
  if (job.type === 'newsletter') {
    await processNewsletterJob(job, env);
    return;
  }
  const { jobId, videoId, youtubeUrl, existingSlug } = job;
  console.log('[FFX] Processing job:', jobId, 'videoId:', videoId);

  // ── Skip Phase 1 entirely if video already fully generated ──────────────
  // Happens when: regenerate pressed after success, or Phase 2 (SEO) failed
  // All KV data from Phase 1 is permanent — no need to re-run 4 Claude calls
  try {
    const existingVideo = await env.FFX_KV.get('video:' + videoId, { type: 'json' }).catch(function() { return null; });
    if (existingVideo && existingVideo.slug && existingVideo.platforms) {
      console.log('[FFX] video:' + videoId + ' already exists — skipping Phase 1, marking job complete');
      await kvPut(env, 'job:' + jobId, JSON.stringify({
        status: 'complete', videoId: videoId, generatedAt: existingVideo.generatedAt || new Date().toISOString(),
        skipped: true,
      }), { expirationTtl: 86400 });
      try { await env.FFX_KV.delete('lock:generating'); } catch {}
      return;
    }
  } catch(skipErr) {
    console.error('[FFX] Skip-check failed (non-fatal, continuing):', skipErr.message);
  }

  await kvPut(env, 'lock:generating', JSON.stringify({
    jobId, videoId, startedAt: new Date().toISOString()
  }), { expirationTtl: 1800 });

  // Check for checkpoint — resume from regional if global already succeeded
  const CHECKPOINT_KEY = 'video:checkpoint:' + videoId;
  let checkpoint = null;
  try { checkpoint = await env.FFX_KV.get(CHECKPOINT_KEY, { type: 'json' }).catch(function() { return null; }); } catch(e) {}

  let transcript, globalContent, globalArticle, selectedLinkedin, selectedDiscord, selectedX, regionName, regionIndex;

  if (checkpoint && checkpoint.globalContent && checkpoint.transcript) {
    // RESUME — skip transcript + global steps
    console.log('[FFX] Checkpoint found — resuming from regional article for:', videoId);
    transcript       = checkpoint.transcript;
    globalContent    = checkpoint.globalContent;
    globalArticle    = checkpoint.globalArticle;
    selectedLinkedin = checkpoint.selectedLinkedin;
    selectedDiscord  = checkpoint.selectedDiscord;
    selectedX        = checkpoint.selectedX;
    regionName       = checkpoint.regionName;
    regionIndex      = checkpoint.regionIndex;
    await updateJob(env, jobId, videoId, 'processing', 'regional_article');

  } else {
    // FRESH — run from transcript
    await updateJob(env, jobId, videoId, 'processing', 'transcript');

    try {
      transcript = await fetchTranscriptSupadata(youtubeUrl, env.SUPADATA_API_KEY);
      console.log('[FFX] Transcript fetched, length:', transcript?.length);
    } catch (err) {
      await failJob(env, jobId, videoId, 'transcript',
        'Transcript fetch failed: ' + err.message + '. Ensure captions are enabled on this video in YouTube Studio.', false);
      return;
    }

    if (!transcript || transcript.trim().length < 100) {
      await failJob(env, jobId, videoId, 'transcript',
        'Transcript too short or empty. Enable captions in YouTube Studio and try again.', false);
      return;
    }

    try {
      await env.FFX_KV.put('transcript:' + videoId, transcript);
      console.log('[FFX] Transcript stored permanently:', videoId);
    } catch (err) {
      console.error('[FFX] Transcript KV write failed (non-fatal):', err.message);
    }

    // Fetch and store timestamped chunks for chapter generation in youtube-metadata.js
    // Non-fatal — plain text already stored, timestamps are bonus data
    try {
      const timestampedChunks = await fetchTranscriptTimestamped(youtubeUrl, env.SUPADATA_API_KEY);
      if (timestampedChunks && timestampedChunks.length > 0) {
        await env.FFX_KV.put('transcript:timestamps:' + videoId, JSON.stringify(timestampedChunks));
        console.log('[FFX] Timestamped transcript stored:', timestampedChunks.length, 'chunks');
      }
    } catch(tsErr) {
      console.error('[FFX] Timestamped transcript store failed (non-fatal):', tsErr.message);
    }

    const linkedinFormats = ['WALL', 'SHORT', 'SINGLE', 'STORY', 'CONTRARIAN'];
    const discordFormats  = ['NUGGET', 'DROP', 'QUESTION'];
    const xFormats        = ['THREAD', 'SINGLE', 'MINI', 'HOTTAKE'];
    selectedLinkedin = linkedinFormats[Math.floor(Math.random() * linkedinFormats.length)];
    selectedDiscord  = discordFormats[Math.floor(Math.random() * discordFormats.length)];
    selectedX        = xFormats[Math.floor(Math.random() * xFormats.length)];
    console.log('[FFX] Formats:', selectedLinkedin, selectedDiscord, selectedX);

    const regions = ['GCC', 'US/Canada', 'EU/UK/Germany', 'SEA/Asia'];
    regionIndex = 0;
    try {
      const stored = await env.FFX_KV.get('config:regionCycle');
      regionIndex = stored !== null ? parseInt(stored, 10) % 4 : 0;
    } catch {}
    regionName = regions[regionIndex];
    console.log('[FFX] Region:', regionName);

    await updateJob(env, jobId, videoId, 'processing', 'global_article');
    try {
      globalArticle = await callClaudeArticle(transcript, youtubeUrl, env.ANTHROPIC_API_KEY, 'Global', null, existingSlug, env);
      console.log('[FFX] Global article done, slug:', globalArticle.slug);
    } catch (err) {
      await failJob(env, jobId, videoId, 'global_article', formatClaudeError(err, 'Global article'), true);
      return;
    }

    await updateJob(env, jobId, videoId, 'processing', 'global_platforms');
    let globalPlatforms;
    try {
      globalPlatforms = await callClaudePlatforms(transcript, youtubeUrl, env.ANTHROPIC_API_KEY,
        selectedLinkedin, selectedDiscord, selectedX, 'Global', globalArticle.slug);
      console.log('[FFX] Global platforms done');
    } catch (err) {
      await failJob(env, jobId, videoId, 'global_platforms', formatClaudeError(err, 'Global platforms'), true);
      return;
    }

    globalContent = Object.assign({}, globalArticle, globalPlatforms, { region: 'Global', regionLabel: 'Global', videoId, youtubeUrl });

    // Save checkpoint after global succeeds — permanent, cleared only on publish
    try {
      await env.FFX_KV.put(CHECKPOINT_KEY, JSON.stringify({
        transcript: transcript,
        globalContent: globalContent,
        globalArticle: globalArticle,
        selectedLinkedin: selectedLinkedin,
        selectedDiscord: selectedDiscord,
        selectedX: selectedX,
        regionName: regionName,
        regionIndex: regionIndex,
        savedAt: new Date().toISOString(),
      }));
      console.log('[FFX] Checkpoint saved for:', videoId);
    } catch(cpErr) {
      console.error('[FFX] Checkpoint write failed (non-fatal):', cpErr.message);
    }

    await updateJob(env, jobId, videoId, 'processing', 'regional_article');
  }

  // REGIONAL ARTICLE
  let regionalArticle;
  try {
    regionalArticle = await callClaudeArticle(transcript, youtubeUrl, env.ANTHROPIC_API_KEY, regionName, globalArticle.slug, existingSlug);
    console.log('[FFX] Regional article done, region:', regionName);
  } catch (err) {
    await failJob(env, jobId, videoId, 'regional_article', formatClaudeError(err, 'Regional article (' + regionName + ')'), true);
    return;
  }

  await updateJob(env, jobId, videoId, 'processing', 'regional_platforms');
  let regionalPlatforms;
  try {
    regionalPlatforms = await callClaudePlatforms(transcript, youtubeUrl, env.ANTHROPIC_API_KEY,
      selectedLinkedin, selectedDiscord, selectedX, regionName, regionalArticle.slug);
    console.log('[FFX] Regional platforms done');
  } catch (err) {
    await failJob(env, jobId, videoId, 'regional_platforms', formatClaudeError(err, 'Regional platforms (' + regionName + ')'), true);
    return;
  }

  const regionalContent = Object.assign({}, regionalArticle, regionalPlatforms, { region: regionName, regionLabel: regionName, videoId, youtubeUrl });

  try { await env.FFX_KV.put('config:regionCycle', String((regionIndex + 1) % 4)); } catch {}

  await updateJob(env, jobId, videoId, 'processing', 'library');
  let libraryItems = [];
  try {
    libraryItems = await extractLibrary(transcript, youtubeUrl, globalArticle.title, videoId, env.ANTHROPIC_API_KEY);
    console.log('[FFX] Library extracted, items:', libraryItems.length);
  } catch (err) {
    console.error('[FFX] Library extraction failed (non-fatal):', err.message);
  }

  if (libraryItems.length > 0) {
    try {
      const indexRaw = await env.FFX_KV.get('nuggets:index');
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const now = new Date().toISOString();
      for (let i = 0; i < libraryItems.length; i++) {
        const item = libraryItems[i];
        try {
          const nuggetId = Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '-' + i;
          const nugget = {
            id: nuggetId, text: item.content, category: item.category,
            tags: Array.isArray(item.tags) ? item.tags : [],
            hook: item.hook || null, format: item.format || null,
            sourceVideoId: videoId, sourceTitle: globalArticle.title,
            youtubeUrl, publishedTo: {}, createdAt: now, updatedAt: now,
          };
          await env.FFX_KV.put('nugget:' + nuggetId, JSON.stringify(nugget));
          index.unshift(nuggetId);
        } catch (err) {
          console.error('[FFX] Nugget write failed:', i, err.message);
        }
      }
      await env.FFX_KV.put('nuggets:index', JSON.stringify(index));
      console.log('[FFX] nuggets:index updated, total:', index.length);
    } catch (err) {
      console.error('[FFX] Nuggets index update failed (non-fatal):', err.message);
    }
  }

  const videoRecord = {
    videoId, youtubeUrl,
    slug: globalContent.slug, title: globalContent.title,
    generatedAt: new Date().toISOString(), region: regionName,
    platforms: {
      blog_global:   { status: 'generated', content: globalContent,   updatedAt: new Date().toISOString() },
      blog_regional: { status: 'generated', content: regionalContent, updatedAt: new Date().toISOString() },
      x:             { status: 'generated', content: { tweets: [globalContent.tweet1, globalContent.tweet2, globalContent.tweet3, globalContent.tweet4, globalContent.tweet5, globalContent.tweet6].filter(Boolean) }, updatedAt: new Date().toISOString() },
      linkedin:      { status: 'generated', content: { text: globalContent.linkedin }, updatedAt: new Date().toISOString() },
      discord:       { status: 'generated', content: { text: globalContent.discord },  updatedAt: new Date().toISOString() },
      tumblr:        { status: 'generated', content: { text: globalContent.tumblr },   updatedAt: new Date().toISOString() },
    }
  };

  try {
    await kvPut(env, 'video:' + videoId, JSON.stringify(videoRecord), { expirationTtl: 86400 });
    console.log('[FFX] Video record written to KV');
  } catch (err) {
    await failJob(env, jobId, videoId, 'kv_write', 'Storage write failed: ' + err.message + '. Please retry.', true);
    return;
  }

  // ── Write content:performance record ─────────────────────────────────────
  try {
    let targetQuery  = null;
    let briefVersion = null;
    try {
      const brief = await env.FFX_KV.get('intelligence:brief', { type: 'json' }).catch(() => null);
      if (brief && brief.articleBrief && brief.articleBrief.targetQuery) targetQuery  = brief.articleBrief.targetQuery;
      if (brief && brief.generatedAt)                                    briefVersion = brief.generatedAt;
    } catch {}

    const wordCount = globalContent.body
      ? globalContent.body.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length
      : 0;

    const perfRecord = {
      slug:           globalContent.slug,
      videoId,
      youtubeUrl,
      title:          globalContent.title,
      contentPillar:  globalContent.category || 'Strategy',
      region:         regionName,
      wordCount,
      targetQuery:    targetQuery  || null,
      briefVersion:   briefVersion || null,
      promptInjected: !!targetQuery,
      generatedAt:    new Date().toISOString(),
      publishedAt:    null,
      status:         'generated',
      snapshot7:      null,
      snapshot30:     null,
      snapshot90:     null,
    };

    await env.FFX_KV.put('content:performance:' + globalContent.slug, JSON.stringify(perfRecord));
    console.log('[FFX] content:performance written for slug:', globalContent.slug);
  } catch (perfErr) {
    console.error('[FFX] content:performance write failed (non-fatal):', perfErr.message);
  }

  // ── Component 2: Write content:link_graph record ──────────────────────
  try {
    if (globalArticle._linkedArticles && globalArticle._linkedArticles.length > 0) {
      const linkGraph = {
        slug:        globalContent.slug,
        title:       globalContent.title,
        linksTo:     globalArticle._linkedArticles,
        generatedAt: new Date().toISOString(),
      };
      await env.FFX_KV.put('content:link_graph:' + globalContent.slug, JSON.stringify(linkGraph));
      console.log('[FFX] content:link_graph written, links to:', globalArticle._linkedArticles.map(function(a){return a.slug;}).join(', '));
    }
  } catch (lgErr) {
    console.error('[FFX] content:link_graph write failed (non-fatal):', lgErr.message);
  }

  // ── Update queue:index ────────────────────────────────────────────────────
  try {
    const queueRaw = await env.FFX_KV.get('queue:index', { type: 'json' });
    if (Array.isArray(queueRaw)) {
      const qIdx = queueRaw.findIndex(function(q){ return q.videoId === videoId; });
      if (qIdx !== -1) {
        queueRaw[qIdx].title        = globalContent.title || queueRaw[qIdx].title;
        queueRaw[qIdx].wasGenerated = true;
        await env.FFX_KV.put('queue:index', JSON.stringify(queueRaw));
        console.log('[FFX] queue:index updated for:', videoId);
      }
    }
  } catch (err) {
    console.error('[FFX] queue:index update failed (non-fatal):', err.message);
  }

  await kvPut(env, 'job:' + jobId, JSON.stringify({
    status: 'complete', videoId, generatedAt: new Date().toISOString(),
  }), { expirationTtl: 86400 });

  // Clear checkpoint on complete — it has served its purpose for retries
  // Note: video:checkpoint:{videoId} also cleared by youtube-signals.js on publish
  try { await env.FFX_KV.delete('video:checkpoint:' + videoId); } catch {}

  try { await env.FFX_KV.delete('lock:generating'); } catch {}
  console.log('[FFX] Job complete:', jobId);

  try {
    await sendCompletionEmail(env, youtubeUrl, videoId, globalContent.title);
    console.log('[FFX] Completion email sent');
  } catch (err) {
    console.error('[FFX] Completion email failed (non-fatal):', err.message);
  }
}

// ── Component 2: Fetch topically related published articles ───────────────
// Reads articles:index, scores by tag overlap with transcript, returns top 3
async function fetchRelatedArticles(transcript, env) {
  const result = { articles: [], linkBlock: '', status: 'skipped' };
  try {
    const index = await env.FFX_KV.get('articles:index', { type: 'json' }).catch(function(){ return null; });
    if (!index || !Array.isArray(index) || index.length === 0) {
      result.status = 'no_index';
      return result;
    }
    const transcriptLower = transcript.toLowerCase();
    const scored = index
      .filter(function(a){ return a.slug && a.title && Array.isArray(a.tags); })
      .map(function(a) {
        const score = a.tags.filter(function(t){ return transcriptLower.includes(t.toLowerCase()); }).length;
        return Object.assign({}, a, { score: score });
      })
      .filter(function(a){ return a.score > 0; })
      .sort(function(a, b){ return b.score - a.score; })
      .slice(0, 3);

    if (scored.length === 0) {
      result.status = 'no_match';
      return result;
    }

    result.articles = scored;
    result.status = 'found';

    const lines = scored.map(function(a) {
      return '  - "' + a.title + '" -> https://fortitudefx.com/article?slug=' + a.slug + ' (topics: ' + a.tags.slice(0, 3).join(', ') + ')';
    }).join('\n');

    result.linkBlock = '\n\nINTERNAL LINKING - RELATED PUBLISHED ARTICLES:\nLink naturally to these existing articles where topically relevant. Use descriptive anchor text, never "click here". Maximum 3 internal article links in the body.\n' + lines;

    console.log('[FFX] Related articles found:', scored.length, '| slugs:', scored.map(function(a){return a.slug;}).join(', '));
    return result;
  } catch (err) {
    result.status = 'error';
    console.error('[FFX] fetchRelatedArticles failed (non-fatal):', err.message);
    return result;
  }
}

async function sendCompletionEmail(env, youtubeUrl, videoId, videoTitle) {
  if (!env.BREVO_API_KEY) throw new Error('BREVO_API_KEY not set on consumer Worker');
  if (!env.APPROVAL_EMAIL) throw new Error('APPROVAL_EMAIL not set on consumer Worker');

  const pressLink    = 'https://fortitudefx.com/dashboard-queue.html?video=' + videoId;
  const thumbnailUrl = 'https://img.youtube.com/vi/' + videoId + '/maxresdefault.jpg';
  const expiry       = new Date(Date.now() + 86400000);
  const expiryStr    = expiry.toLocaleString('en-GB', {
    timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  const emailHtml = '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;max-width:560px;margin:0 auto;background:#0c0c0c;color:#e8e8e8;padding:40px 32px;border-radius:8px;">'
    + '<div style="font-family:\'Courier New\',monospace;font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#787878;margin-bottom:24px;">FortitudeFX&#8482; &#8212; Internal</div>'
    + '<h1 style="font-size:22px;font-weight:700;color:#ffffff;margin:0 0 8px;letter-spacing:-0.02em;">Content Ready for Review</h1>'
    + '<p style="font-size:14px;color:#b8b8b8;margin:0 0 24px;line-height:1.6;">Global + Regional articles generated. All platforms ready.</p>'
    + '<a href="' + youtubeUrl + '" style="display:block;margin-bottom:24px;border-radius:8px;overflow:hidden;text-decoration:none;">'
    + '<img src="' + thumbnailUrl + '" alt="' + (videoTitle || 'Video thumbnail') + '" style="width:100%;display:block;border-radius:8px;" /></a>'
    + '<p style="font-size:15px;font-weight:600;color:#ffffff;margin:0 0 24px;">' + (videoTitle || '') + '</p>'
    + '<a href="' + pressLink + '" style="display:block;background:#ffffff;color:#000000;text-align:center;padding:16px 24px;border-radius:6px;font-size:15px;font-weight:700;text-decoration:none;margin-bottom:24px;">Review &amp; Publish in FFX Press &#8594;</a>'
    + '<p style="font-family:\'Courier New\',monospace;font-size:11px;color:#484848;word-break:break-all;margin:0 0 8px;">' + pressLink + '</p>'
    + '<p style="font-size:12px;color:#484848;margin:0;">Expires: ' + expiryStr + '</p></div>';

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify({
      sender:      { name: 'FortitudeFX', email: 'salmankhanfx@fortitudefx.com' },
      to:          [{ email: env.APPROVAL_EMAIL }],
      replyTo:     { email: 'support@fortitudefx.com' },
      subject:     'FFX Content Ready - Expires ' + expiryStr,
      htmlContent: emailHtml,
    }),
  });

  if (!res.ok) throw new Error('Brevo ' + res.status + ': ' + await res.text());
}

function formatClaudeError(err, step) {
  const msg = err.message || '';
  if (msg.includes('524')) return step + ': Anthropic took too long (timeout). Click Retry.';
  if (msg.includes('529')) return step + ': Anthropic overloaded. Wait 2 minutes and click Retry.';
  if (msg.includes('401')) return step + ': Anthropic API key invalid. Check ANTHROPIC_API_KEY.';
  if (msg.includes('429')) return step + ': Rate limit hit. Wait 1 minute and click Retry.';
  if (msg.includes('invalid JSON') || msg.includes('Missing field')) return step + ': Claude returned incomplete response. Click Retry.';
  return step + ': ' + msg + '. Click Retry.';
}

async function updateJob(env, jobId, videoId, status, step) {
  try {
    await kvPut(env, 'job:' + jobId, JSON.stringify({ status, videoId, step }), { expirationTtl: 86400 });
  } catch {}
}

async function failJob(env, jobId, videoId, step, reason, retryable) {
  console.error('[FFX] Job failed at step:', step, reason);
  try {
    await kvPut(env, 'job:' + jobId, JSON.stringify({
      status: 'error', videoId, step, reason, retryable, failedAt: new Date().toISOString(),
    }), { expirationTtl: 86400 });
  } catch {}
  try { await env.FFX_KV.delete('lock:generating'); } catch {}
}

async function kvPut(env, key, value, options) {
  options = options || {};
  await env.FFX_KV.put(key, value, options);
}

async function fetchTranscriptSupadata(youtubeUrl, apiKey) {
  if (!apiKey) throw new Error('SUPADATA_API_KEY not set');

  // Fetch plain text transcript for article/platform generation
  const textUrl = 'https://api.supadata.ai/v1/youtube/transcript?url=' + encodeURIComponent(youtubeUrl) + '&text=true';
  const textRes = await fetch(textUrl, { headers: { 'x-api-key': apiKey } });
  console.log('[FFX] Supadata text status:', textRes.status);
  if (!textRes.ok) throw new Error('Supadata ' + textRes.status + ': ' + await textRes.text());
  const textData = await textRes.json();

  let plainText = '';
  if (textData.content && typeof textData.content === 'string') {
    plainText = textData.content.trim();
  } else if (Array.isArray(textData.content)) {
    plainText = textData.content.map(function(s){ return s.text || ''; }).join(' ').trim();
  } else {
    throw new Error('Unexpected Supadata text response: ' + JSON.stringify(textData).slice(0, 200));
  }

  return plainText;
}

// Separate function — fetch timestamped chunks for chapter generation
// Called alongside fetchTranscriptSupadata but stored separately
// Returns array of { text, start, duration } — start is seconds from video start
async function fetchTranscriptTimestamped(youtubeUrl, apiKey) {
  if (!apiKey) {
    console.error('[FFX] SUPADATA_API_KEY not set — skipping timestamped fetch');
    return null;
  }
  try {
    // Without &text=true, Supadata returns timestamped chunks
    const tsUrl = 'https://api.supadata.ai/v1/youtube/transcript?url=' + encodeURIComponent(youtubeUrl);
    const tsRes = await fetch(tsUrl, { headers: { 'x-api-key': apiKey } });
    console.log('[FFX] Supadata timestamped status:', tsRes.status);
    if (!tsRes.ok) {
      console.error('[FFX] Supadata timestamped fetch failed:', tsRes.status);
      return null;
    }
    const tsData = await tsRes.json();
    if (Array.isArray(tsData.content) && tsData.content.length > 0 && typeof tsData.content[0] === 'object') {
      // Validate structure: each item should have text and start
      const valid = tsData.content.filter(function(s) {
        return s && typeof s.text === 'string' && typeof s.start === 'number';
      });
      console.log('[FFX] Timestamped chunks fetched:', valid.length);
      return valid;
    }
    console.error('[FFX] Supadata timestamped: unexpected structure');
    return null;
  } catch(e) {
    console.error('[FFX] fetchTranscriptTimestamped failed (non-fatal):', e.message);
    return null;
  }
}

async function callClaudeArticle(transcript, youtubeUrl, apiKey, region, globalSlug, existingSlug, env) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const isRegional = region !== 'Global';

  // ── Component 2: Fetch related articles + Read intelligence signals ────
  let signalInjection = '';
  let relatedArticles = { articles: [], linkBlock: '', status: 'skipped' };

  if (env && region === 'Global') {
    // Fetch related articles for internal linking
    try {
      relatedArticles = await fetchRelatedArticles(transcript, env);
    } catch (linkErr) {
      console.error('[FFX] Related articles fetch failed (non-fatal):', linkErr.message);
    }

    // Read intelligence signals for prompt injection
    try {
      const brief         = await env.FFX_KV.get('intelligence:brief',   { type: 'json' }).catch(function(){ return null; });
      const learningSummary = await env.FFX_KV.get('seo:learning:summary', { type: 'json' }).catch(function(){ return null; });
      const targets       = await env.FFX_KV.get('intelligence:targets', { type: 'json' }).catch(function(){ return null; });

      const parts = [];

      if (brief && brief.promptInjection) {
        const pi = brief.promptInjection;
        if (pi.currentSignals)     parts.push('CURRENT SIGNALS (act on these now):\n' + pi.currentSignals);
        if (pi.historicalLearning) parts.push('WHAT HAS WORKED ON FORTITUDEFX (last 12 weeks):\n' + pi.historicalLearning);
        if (pi.avoidance)          parts.push('AVOID (based on poor performance data):\n' + pi.avoidance);
      }

      if (brief && brief.articleBrief) {
        const ab = brief.articleBrief;
        const briefLines = [];
        if (ab.targetQuery)    briefLines.push('Target query: "' + ab.targetQuery + '"');
        if (ab.suggestedTitle) briefLines.push('Suggested title: "' + ab.suggestedTitle + '"');
        if (ab.angle)          briefLines.push('Angle: ' + ab.angle);
        if (ab.targetLength)   briefLines.push('Target length: ' + ab.targetLength + ' words');
        if (ab.contentPillar)  briefLines.push('Content pillar: ' + ab.contentPillar);
        if (ab.keyPoints && ab.keyPoints.length) briefLines.push('Key points to cover:\n' + ab.keyPoints.map(function(p){ return '  - ' + p; }).join('\n'));
        if (ab.nuggetTags && ab.nuggetTags.length) briefLines.push('Knowledge tags to draw from: ' + ab.nuggetTags.join(', '));
        if (briefLines.length) parts.push("TODAY'S ARTICLE BRIEF (from intelligence analysis):\n" + briefLines.join('\n'));
      }

      if (learningSummary) {
        const ls = learningSummary;
        const lsParts = [];
        if (ls.seoSummary)       lsParts.push(ls.seoSummary);
        if (ls.audienceSummary)  lsParts.push(ls.audienceSummary);
        if (ls.optimalLength)    lsParts.push('Optimal article length for FFX: ' + ls.optimalLength + ' words');
        if (ls.optimalStructure) lsParts.push('Best structure: ' + ls.optimalStructure);
        if (lsParts.length) parts.push('SITE LEARNING PATTERNS:\n' + lsParts.join('\n'));
      }

      if (targets && targets.current) {
        const gap     = targets.current.primaryGap;
        const overall = targets.current.overallStatus;
        if (gap || overall) {
          parts.push('PERFORMANCE CONTEXT:\nSite momentum: ' + (overall || 'building') + (gap ? '. Primary gap to close: ' + gap : '') + '. Write content that drives organic traffic and Discord community engagement.');
        }
      }

      if (parts.length > 0) {
        const SEP = '============================================================';
        signalInjection = '\n\n' + SEP + '\nINTELLIGENCE CONTEXT - READ BEFORE WRITING\n' + SEP + '\n' + parts.join('\n\n') + '\n' + SEP + '\n\nApply the above context to shape what you write and how you target it. Your voice rules and trademark rules below remain absolute.\n';
        console.log('[FFX] Signal injection built - targetQuery:', (brief && brief.articleBrief && brief.articleBrief.targetQuery) || 'none');
      }
    } catch (injErr) {
      console.error('[FFX] Signal injection failed (non-fatal - continuing without):', injErr.message);
    }

    // Append related articles link block
    if (relatedArticles && relatedArticles.linkBlock) {
      signalInjection += relatedArticles.linkBlock;
      console.log('[FFX] Internal link injection appended - status:', relatedArticles.status);
    }
  }

  const regionInstruction = isRegional
    ? '\nREGIONAL TARGETING - THIS ARTICLE IS FOR: ' + region + '\nThis is the regional variant. The global slug is: ' + globalSlug + '.\nAppend the region to the slug: e.g. "trading-london-session-gcc".\nFrame examples, market session times, currency pairs, and cultural context specifically for ' + region + ' traders.\nKeep the core trading insight identical - only framing and examples shift.'
    : '';

  const systemPrompt = 'You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick mechanical entry system.' + signalInjection + '\n\nTRADEMARK RULE: FortitudeFX, Catch the Wick, and 2 Candle. 1 Story. must always include the TM symbol on first use.\n\nArticle region: ' + region + regionInstruction + '\n\nGenerate ONLY the blog article fields. Return a single valid JSON object with exactly these keys and no others:\n\n{\n  "slug": "url-safe-lowercase-hyphenated-3-to-6-words",\n  "title": "SEO title 50-60 characters including primary keyword",\n  "excerpt": "compelling meta description max 160 characters",\n  "category": "exactly one of: Strategy, Psychology, Risk Management, Market Analysis, Fundamentals",\n  "tags": "comma-separated 4-6 relevant tags",\n  "readTime": "7 min read",\n  "body": "full 2000-word SEO article as valid HTML using h2 and h3 tags. Include internal links to /bootcamp /vipdiscord /blog. End with CTA to join free Discord at https://discord.gg/fortitudefx. Maximum 1 exclamation mark."\n}\n\nCRITICAL: Return ONLY the raw JSON object. No markdown. No code fences. No preamble. Start with { end with }.\nThe body field contains HTML - ensure all quotes inside HTML attributes use single quotes to avoid breaking JSON string parsing.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Transcript:\n\n' + transcript + '\n\nVOICE: This is Salman speaking - founder of FortitudeFX. Write in his voice - direct, calm, experienced, institutional tone.' + (isRegional ? '\n\nREGIONAL: Write the ' + region + ' variant.' : '') }],
    }),
  });

  console.log('[FFX] Claude article status:', res.status, 'region:', region);
  if (!res.ok) throw new Error('Anthropic ' + res.status + ': ' + await res.text());

  const data       = await res.json();
  const stopReason = data.stop_reason || '';

  // stop_reason === 'max_tokens' means Claude hit the ceiling and truncated
  // With max_tokens:8000 this should never happen — but catch it explicitly
  if (stopReason === 'max_tokens') {
    throw new Error('Claude article hit token ceiling (stop_reason: max_tokens). Response truncated — cannot parse JSON. Contact support if this persists.');
  }

  if (!data.content || !data.content[0] || !data.content[0].text) {
    throw new Error('Claude article returned empty response for ' + region + '. stop_reason: ' + stopReason);
  }

  const rawText = data.content[0].text.trim();
  const first   = rawText.indexOf('{');
  const last    = rawText.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new Error('No JSON object found in Claude ' + region + ' article response. stop_reason: ' + stopReason + '. Response starts: ' + rawText.slice(0, 120));
  }
  const cleaned = rawText.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Claude ' + region + ' article invalid JSON: ' + e.message.slice(0, 80) + '. stop_reason: ' + stopReason);
  }

  const required = ['slug', 'title', 'excerpt', 'category', 'tags', 'readTime', 'body'];
  for (let i = 0; i < required.length; i++) {
    if (!parsed[required[i]]) throw new Error('Missing field: "' + required[i] + '" in ' + region + ' article');
  }

  if (existingSlug && existingSlug.trim() && region === 'Global') parsed.slug = existingSlug;

  // Attach internal link data for link_graph write in processJob
  if (region === 'Global' && relatedArticles && relatedArticles.articles.length > 0) {
    parsed._linkedArticles = relatedArticles.articles.map(function(a) {
      return { slug: a.slug, title: a.title, score: a.score };
    });
  }

  console.log('[FFX] Article complete, slug:', parsed.slug, 'region:', region);
  return parsed;
}

async function callClaudePlatforms(transcript, youtubeUrl, apiKey, linkedinFormat, discordFormat, xFormat, region, slug) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const articleUrl = 'https://fortitudefx.com/article?slug=' + slug;
  const isRegional = region !== 'Global';

  const systemPrompt = 'You are the content engine for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick mechanical entry system.\n\nTRADEMARK RULE: FortitudeFX, Catch the Wick, and 2 Candle. 1 Story. must always include the TM symbol on first use.\n\nTHIS RUN\'S FORMATS (follow exactly):\n- LinkedIn format: ' + linkedinFormat + '\n- Discord format: ' + discordFormat + '\n- X format: ' + xFormat + '\n- Region: ' + region + '\n\nABSOLUTELY BANNED OPENING WORDS - NEVER start any post with:\n- "Most traders" or any variation\n- "The reality is" / "One thing I\'ve learned" / "The market doesn\'t care"\n- "This is why" / "Here\'s the truth" / "Trading is" / "Many traders" / "Many people"\n\nARTICLE URL for this content: ' + articleUrl + '\nYOUTUBE URL: ' + youtubeUrl + '\n\nGenerate ONLY the platform content fields. Return a single valid JSON object:\n\n{\n  "linkedin": "LinkedIn post - FORMAT: ' + linkedinFormat + '. WALL: 350-500w / SHORT: 80-150w / SINGLE: 60-100w / STORY: 200-350w / CONTRARIAN: 150-300w. End with: Full breakdown: ' + articleUrl + ' and https://fortitudefx.com. Add 3-5 hashtags at end only.",\n  "x_thread": ["tweet 1", "tweet 2", "tweet 3", "tweet 4", "tweet 5", "tweet 6"],\n  "discord": "Discord post - FORMAT: ' + discordFormat + '. NUGGET: 40-80w / DROP: 100-200w / QUESTION: 80-150w. End with article and youtube URLs.",\n  "tumblr": "Tumblr post 300-600 words. Plain text. End with article and youtube URLs.",\n  "mediumIntro": "150-200 word rewritten article opening. Final line: Originally published at ' + articleUrl + '"\n}\n\nX THREAD RULES - THREAD format: exactly 6 tweets.\nTweet 1: hook only, no links, no URLs.\nTweet 2: first reply tweet, ends with https://fortitudefx.com on its own line.\nTweets 3-5: content only, no links, no URLs.\nTweet 6: ends with https://fortitudefx.com on its own line, then ' + articleUrl + ' on its own line, then ' + youtubeUrl + ' on its own line.\n\nCRITICAL: Return ONLY the raw JSON object. Start with { end with }.\nx_thread must be a JSON array of strings.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 5000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Transcript:\n\n' + transcript + '\n\nVOICE: Salman Khan - founder. Direct, calm, slightly contrarian, institutional.' + (isRegional ? '\n\nREGIONAL: Frame for ' + region + '.' : '') }],
    }),
  });

  console.log('[FFX] Claude platforms status:', res.status, 'region:', region);
  if (!res.ok) throw new Error('Anthropic ' + res.status + ': ' + await res.text());

  const data    = await res.json();
  const rawText = data.content[0].text.trim();
  const first   = rawText.indexOf('{');
  const last    = rawText.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object found in Claude platforms response');
  const cleaned = rawText.slice(first, last + 1);

  let parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) {
    throw new Error('Claude platforms returned invalid JSON: ' + e.message);
  }

  const required = ['linkedin', 'x_thread', 'discord', 'tumblr', 'mediumIntro'];
  for (let i = 0; i < required.length; i++) {
    if (!parsed[required[i]]) throw new Error('Missing field: "' + required[i] + '" in ' + region + ' platforms');
  }

  if (!Array.isArray(parsed.x_thread) || parsed.x_thread.length === 0) {
    throw new Error('x_thread must be an array of tweets in ' + region + ' platforms');
  }

  parsed.x_thread.forEach(function(t, i){ parsed['tweet' + (i + 1)] = t; });

  console.log('[FFX] Platforms complete, region:', region);
  return parsed;
}

async function extractLibrary(transcript, youtubeUrl, videoTitle, videoId, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = 'You are extracting high-quality reusable community content from a FortitudeFX YouTube transcript.\n\nEXTRACTION STANDARD - MANDATORY:\nOnly extract an item if it passes ALL THREE tests:\n1. Would an experienced trader stop scrolling to read this?\n2. Does it add something the FFX community cannot get from generic trading content anywhere else?\n3. Is it specific enough to spark a real discussion?\n\nCATEGORIES (assign exactly one):\nCTW Framework, Market Psychology, Execution Discipline, Professional Thinking, Trading Reality, Lifestyle & Philosophy, Founder Observation, Hook/Viral\n\nFORMATS (assign exactly one): question, insight, contrarian, story, chart_game\n\nReturn a JSON array of objects:\n{\n  "category": "Psychology",\n  "format": "contrarian",\n  "content": "The full post content - 50-180 words",\n  "hook": "The opening line only",\n  "tags": ["tag1", "tag2", "tag3"]\n}\n\nReturn ONLY the raw JSON array. Start with [ end with ].';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Video: ' + videoTitle + '\nURL: ' + youtubeUrl + '\n\nTranscript:\n\n' + transcript + '\n\nExtract 10-15 high-quality items. Apply three-test filter strictly. Salman\'s voice - calm, direct, experienced.' }],
    }),
  });

  if (!res.ok) throw new Error('Library extraction ' + res.status + ': ' + await res.text());

  const data    = await res.json();
  const rawText = data.content[0].text.trim();
  const first   = rawText.indexOf('[');
  const last    = rawText.lastIndexOf(']');
  if (first === -1 || last === -1) throw new Error('No JSON array in library response');
  const cleaned = rawText.slice(first, last + 1);

  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    throw new Error('Library extraction returned invalid JSON');
  }

  if (!Array.isArray(parsed)) throw new Error('Library extraction did not return array');
  return parsed.filter(function(item){ return item.category && item.format && item.content; });
}


// ─────────────────────────────────────────────────────────────────────────────
// Newsletter Job Handler
// Runs in consumer Worker — no 30s timeout limit
// Reads from KV, makes 4 Claude calls, writes draft to KV
// ─────────────────────────────────────────────────────────────────────────────
async function processNewsletterJob(job, env) {
  var ANTHROPIC_API   = 'https://api.anthropic.com/v1/messages';
  var ANTHROPIC_MODEL = 'claude-sonnet-4-5';
  var PROGRESS_KEY    = 'newsletter:generate:progress';
  var DRAFT_KEY       = 'newsletter:draft';

  async function writeProgress(step, total, label) {
    try { await env.FFX_KV.put(PROGRESS_KEY, JSON.stringify({ step: step, total: total, label: label, updatedAt: new Date().toISOString() }), { expirationTtl: 600 }); } catch(e) {}
  }

  function extractJson(text) {
    if (!text) return null;
    var start = text.indexOf('{');
    var end   = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch(e) { return null; }
  }

  function formatDateDisplay(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  try {
    var issueNumber   = job.issueNumber   || 1;
    var issueDate     = job.issueDate     || new Date().toISOString().split('T')[0];
    var setupNote     = job.setupNote     || '';
    var setupImageUrl = job.setupImageUrl || '';

    await writeProgress(1, 8, 'Reading KV data — articles, signals, brief');

    var kvResults = await Promise.all([
      env.FFX_KV.get('intelligence:brief',   { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('seo:signals',          { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('articles:index',       { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('newsletter:last_sent', { type: 'json' }).catch(function() { return null; }),
      env.FFX_KV.get('newsletter:index',     { type: 'json' }).catch(function() { return null; }),
    ]);

    var brief            = kvResults[0];
    var seoSignals       = kvResults[1];
    var articlesIndex    = kvResults[2];
    var newsletterLastSent = kvResults[3];
    var newsletterIdx    = kvResults[4];

    var cutoff   = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    var articles = Array.isArray(articlesIndex) ? articlesIndex.filter(function(a) { return a.publishedAt && a.publishedAt > cutoff; }).slice(0, 3) : [];
    if (articles.length === 0 && Array.isArray(articlesIndex)) articles = articlesIndex.slice(0, 3);

    var featuredSlugs = [];
    if (Array.isArray(newsletterIdx)) {
      newsletterIdx.slice(0, 3).forEach(function(ni) { if (ni.featuredSlugs) featuredSlugs = featuredSlugs.concat(ni.featuredSlugs); });
    }

    var articleContext = Array.isArray(articlesIndex) ? articlesIndex.slice(0, 20).map(function(a) { return a.slug + ' | ' + a.title + ' | ' + (a.category || '') + ' | ' + (a.excerpt || '').substring(0, 80); }).join('\n') : '';
    var topKeyword = (seoSignals && seoSignals.risingQueries && seoSignals.risingQueries[0] && seoSignals.risingQueries[0].query) || (seoSignals && seoSignals.topQueries && seoSignals.topQueries[0] && seoSignals.topQueries[0].query) || 'forex risk management';
    var prevExclusiveTitle = (newsletterLastSent && newsletterLastSent.exclusiveTitle) || '';

    await writeProgress(2, 8, 'Calling Claude — On This Day in Markets (web search)');

    var onThisDayPrompt = 'You are writing for FortitudeFX — a forex trading education brand. Voice: direct, authoritative, specific.\n\nGenerate ONE section for the bi-weekly FFX newsletter dated ' + issueDate + ':\n\nON THIS DAY IN MARKETS\nFind a significant historical forex, macro, or financial markets event on or near ' + issueDate + ' in any past year. Must be real and verifiable. One punchy paragraph — what happened, why it mattered to traders, one clear lesson. Find the Wikipedia URL for this event.\n\nCRITICAL INSTRUCTION: Return ONLY a JSON object. First character must be {. Last must be }. No preamble. No markdown.\n{"onThisDay":{"year":"YYYY","event":"what happened in one punchy paragraph","lesson":"the trader lesson in one clear sentence","wikiUrl":"https://en.wikipedia.org/wiki/..."}}';

    var onThisDayRes  = await fetch(ANTHROPIC_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'web-search-2025-03-05' }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1000, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: onThisDayPrompt }] }) });
    var onThisDayData = await onThisDayRes.json();
    var onThisDayText = '';
    if (onThisDayData.content) { for (var i = 0; i < onThisDayData.content.length; i++) { if (onThisDayData.content[i].type === 'text') onThisDayText += onThisDayData.content[i].text; } }
    var onThisDayJson = extractJson(onThisDayText) || {};
    if (!onThisDayJson.onThisDay) { onThisDayJson.onThisDay = { year: '', event: '', lesson: '', wikiUrl: '' }; }

    await writeProgress(3, 8, 'Calling Claude — FFX Perspective + Trending Question');

    // Build intelligence context for Perspective — grounded in what audience is actually searching
    var intelContext = '';
    if (brief) {
      if (brief.articleBrief) {
        var ab = brief.articleBrief;
        if (ab.targetQuery)    intelContext += 'Top searched keyword right now: "' + ab.targetQuery + '"\n';
        if (ab.angle)          intelContext += 'Recommended angle: ' + ab.angle + '\n';
        if (ab.contentPillar)  intelContext += 'Content pillar: ' + ab.contentPillar + '\n';
        if (ab.keyPoints && ab.keyPoints.length) intelContext += 'Key points the audience wants answered:\n' + ab.keyPoints.map(function(p){ return '- ' + p; }).join('\n') + '\n';
      }
      if (brief.promptInjection) {
        if (brief.promptInjection.currentSignals)     intelContext += 'Current signals: ' + brief.promptInjection.currentSignals + '\n';
        if (brief.promptInjection.historicalLearning) intelContext += 'What has worked: ' + brief.promptInjection.historicalLearning + '\n';
        if (brief.promptInjection.avoidance)          intelContext += 'Avoid: ' + brief.promptInjection.avoidance + '\n';
      }
    }

    var perspectivePrompt = 'You are writing for FortitudeFX in Salman Khan\'s voice. Salman is a professional forex trader and founder of FortitudeFX. Voice: direct, institutional, calm authority, slightly contrarian, never motivational fluff. The Catch The Wick (CTW) methodology: mechanical 2-candle entry system — wick candle + reversal candle. 5 models: LC-E, LE-I, LC-ZIE, LC-ZR, LC-FR. Any pair, any timeframe, zero guesswork.\n\nINTELLIGENCE CONTEXT — what your audience is searching for right now:\n' + (intelContext || 'Focus on risk management and mechanical entry discipline.\n') + '\nExisting articles (slug | title | category) — cross-link where relevant:\n' + articleContext + '\n\nGenerate TWO sections:\n\n1. THE FFX PERSPECTIVE (newsletter-exclusive original article)\nThis is the flagship section of the newsletter. Write a 500-600 word original article in Salman\'s voice targeting the top searched keyword above. Rules:\n- First sentence is a direct statement — never a question, never a preamble\n- Specific, tactical, grounded in real market mechanics\n- References real pairs, real levels, real CTW setups where relevant\n- Includes 1-2 internal cross-links to existing articles listed above\n- Ends with one clear actionable takeaway\n- Maximum 1 exclamation mark in the entire piece\n- Never mention competitors\n- hookText: first 150-200 words shown in the email\n- fullText: complete 500-600 word article shown on the site\n- Do NOT repeat previous perspective title: "' + prevExclusiveTitle + '"\n\n2. TRENDING QUESTION (150-200 words)\nPick the most interesting mechanical trading question your audience is asking right now based on the intelligence context. Answer it fully in Salman\'s voice — direct, complete, no hedging. If any existing article is closely related, return its slug and title.\n\nCRITICAL INSTRUCTION: Return ONLY a JSON object. First character must be {. Last must be }. No preamble. No markdown.\n{"perspective":{"title":"...","hookText":"first 150-200 words of the article","fullText":"complete 500-600 word article","relatedArticleSlug":"slug-or-null","relatedArticleTitle":"title-or-null"},"trendingQ":{"question":"...","answer":"full 150-200 word paragraph","relatedArticleSlug":"slug-or-null","relatedArticleTitle":"title-or-null"}}';

    var articleRes  = await fetch(ANTHROPIC_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 3000, messages: [{ role: 'user', content: perspectivePrompt }] }) });
    var articleData = await articleRes.json();
    var articleText = '';
    if (articleData.content) { for (var j = 0; j < articleData.content.length; j++) { if (articleData.content[j].type === 'text') articleText += articleData.content[j].text; } }
    var articleJson = extractJson(articleText) || {};
    if (!articleJson.perspective) { articleJson.perspective = { title: '', hookText: '', fullText: '', relatedArticleSlug: null, relatedArticleTitle: null }; }
    if (!articleJson.trendingQ)   { articleJson.trendingQ   = { question: '', answer: '', relatedArticleSlug: null, relatedArticleTitle: null }; }

    await writeProgress(4, 8, 'Calling Claude — 6 Lifestyle Sections (web search)');

    // ── Pexels image fetcher ─────────────────────────────────────────────────
    // Returns a permanent Pexels image URL for a given search query.
    // Returns empty string on any failure — never a broken image.
    async function fetchPexelsImage(query, apiKey) {
      if (!apiKey || !query) return '';
      try {
        var url = 'https://api.pexels.com/v1/search?query=' + encodeURIComponent(query) + '&per_page=5&orientation=landscape';
        var res = await fetch(url, { headers: { 'Authorization': apiKey } });
        if (!res.ok) { console.error('[FFX] Pexels error:', res.status, query); return ''; }
        var data = await res.json();
        if (!data.photos || !data.photos.length) { console.error('[FFX] Pexels no results for:', query); return ''; }
        // Pick randomly from top 5 so the newsletter varies each issue
        var pick = data.photos[Math.floor(Math.random() * data.photos.length)];
        return (pick.src && pick.src.large) ? pick.src.large : '';
      } catch(e) {
        console.error('[FFX] Pexels fetch failed (non-fatal):', e.message);
        return '';
      }
    }

    // ── Validate source URL — must be a specific article path, not a homepage ─
    function validateSourceUrl(url) {
      if (!url || typeof url !== 'string') return '';
      try {
        var u = new URL(url);
        // Must have a meaningful path beyond just '/' — at least one segment with content
        var path = u.pathname.replace(/\/+$/, '');
        if (!path || path.length < 3) return ''; // just a homepage
        return url;
      } catch(e) { return ''; }
    }

    // ── Claude lifestyle prompt — no image URLs, returns imageSearchQuery ────
    // Claude's job: find real articles, write original 2-sentence body, return exact article URL
    // Pexels' job: fetch the matching image using imageSearchQuery
    var lifestylePrompt = 'You are curating 6 lifestyle sections for the FortitudeFX bi-weekly newsletter. FFX sells the aspirational lifestyle that forex trading freedom creates — GQ, Robb Report, Gentleman\'s Journal aesthetic for young ambitious men.\n\nFor EACH section:\n1. Web search for a SPECIFIC current article from a top English publication listed below\n2. Write 2 original sentences in an aspirational tone selling the lifestyle — do NOT copy the article, write original content inspired by it\n3. Return the EXACT article URL — the full path to the specific article, NOT the homepage. e.g. https://www.gq.com/story/omega-seamaster-review-2026 NOT https://www.gq.com\n4. Return an imageSearchQuery — 4-6 words describing exactly what image should appear (e.g. "Omega Seamaster watch blue dial" or "Amalfi Coast Italy cliffs sea")\n\nSECTIONS AND APPROVED SOURCES:\n\n1. TRAVEL: One specific aspirational destination. Lisbon, Amalfi, Mykonos, Bali, Dubai, Maldives, Barcelona, Santorini, Monaco, Positano.\nAPPROVED SOURCES ONLY: condenasttraveller.com, cntraveler.com, travelandleisure.com, lonelyplanet.com, theguardian.com/travel, telegraph.co.uk/travel\n\n2. LUXURY: One specific luxury item — exact watch model, car, hotel suite, sneaker, accessory. Real product, real substance.\nAPPROVED SOURCES ONLY: robbreport.com, hodinkee.com, gq.com, gentlemansjournal.com, therakemag.com, hypebeast.com\n\n3. WOMEN: Write about an aspirational woman — a model, actress, or public figure — in an upscale editorial setting. Beach, resort pool, yacht, luxury terrace. Classy and aspirational, GQ editorial tone. NOT a magazine subscription page. NOT a fashion news roundup. Must be a specific editorial feature or profile.\nAPPROVED SOURCES ONLY: gq.com, esquire.com, gentlemansjournal.com\n\n4. TECH: One genuine AI or tech development from the past 2 weeks relevant to traders or high-performers.\nAPPROVED SOURCES ONLY: wired.com, techcrunch.com, theverge.com, technologyreview.mit.edu\n\n5. FITNESS: One specific protocol, diet, or mindset practice that sharpens decision-making and trading performance. Real science, actionable.\nAPPROVED SOURCES ONLY: menshealth.com, gq.com/story/health, artofmanliness.com, examine.com\n\n6. ENTERTAINMENT: One specific film, series, book, or podcast about discipline, risk, excellence, or ambition. Must be a review or feature article, NOT a subscription or purchase page.\nAPPROVED SOURCES ONLY: gq.com, esquire.com, gentlemansjournal.com, therakemag.com\n\nCRITICAL RULES:\n- ALL content in English only\n- sourceUrl must be the FULL path to the specific article — never a homepage, never a subscription page, never a magazine purchase page\n- If you cannot find a valid specific article URL from the approved sources, leave sourceUrl as empty string\n- imageSearchQuery must describe the SPECIFIC subject of what you wrote (not generic)\n- For women section imageSearchQuery use: "beautiful woman resort pool luxury" or "stunning woman beach sunset" or "elegant woman yacht deck mediterranean" style — NO clubs, NO nightlife\n\nCRITICAL: Return ONLY a JSON object. First character {. Last character }. No preamble. No markdown.\n{"travel":{"title":"...","body":"2 original aspirational sentences","sourceUrl":"https://publication.com/specific/article/path","sourceLabel":"Conde Nast Traveller","imageSearchQuery":"specific 4-6 word image search"},"luxury":{"title":"...","body":"2 original aspirational sentences","sourceUrl":"https://publication.com/specific/article/path","sourceLabel":"Robb Report","imageSearchQuery":"specific 4-6 word image search"},"women":{"title":"...","body":"2 original aspirational sentences","sourceUrl":"https://publication.com/specific/article/path","sourceLabel":"GQ","imageSearchQuery":"beautiful woman resort pool luxury"},"tech":{"title":"...","body":"2 original aspirational sentences","sourceUrl":"https://publication.com/specific/article/path","sourceLabel":"Wired","imageSearchQuery":"specific 4-6 word image search"},"fitness":{"title":"...","body":"2 original aspirational sentences","sourceUrl":"https://publication.com/specific/article/path","sourceLabel":"Men\'s Health","imageSearchQuery":"specific 4-6 word image search"},"entertainment":{"title":"...","body":"2 original aspirational sentences","sourceUrl":"https://publication.com/specific/article/path","sourceLabel":"GQ","imageSearchQuery":"specific 4-6 word image search"}}';

    var lifestyleRes  = await fetch(ANTHROPIC_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'web-search-2025-03-05' }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 3000, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: lifestylePrompt }] }) });
    var lifestyleData = await lifestyleRes.json();
    var lifestyleText = '';
    if (lifestyleData.content) { for (var k = 0; k < lifestyleData.content.length; k++) { if (lifestyleData.content[k].type === 'text') lifestyleText += lifestyleData.content[k].text; } }
    var lifestyleJson = extractJson(lifestyleText) || {};

    // ── Validate and enrich each lifestyle section ───────────────────────────
    var LIFESTYLE_KEYS = ['travel', 'luxury', 'women', 'tech', 'fitness', 'entertainment'];

    // Ensure all keys exist with defaults
    LIFESTYLE_KEYS.forEach(function(key) {
      lifestyleJson[key] = lifestyleJson[key] || {};
      lifestyleJson[key].title       = lifestyleJson[key].title       || '';
      lifestyleJson[key].body        = lifestyleJson[key].body        || '';
      lifestyleJson[key].sourceLabel = lifestyleJson[key].sourceLabel || '';
      lifestyleJson[key].imageUrl    = ''; // will be set by Pexels below
      // Validate sourceUrl — must be a specific article path not a homepage
      lifestyleJson[key].sourceUrl   = validateSourceUrl(lifestyleJson[key].sourceUrl || '');
    });

    // ── Fetch Pexels images in parallel for all 6 sections ──────────────────
    // Uses imageSearchQuery from Claude — specific to the exact subject written
    // Women section: override with aspirational lifestyle query regardless of what Claude returns
    var WOMEN_QUERIES = [
      'beautiful woman luxury infinity pool villa',
      'stunning woman beach resort white sand',
      'elegant woman yacht deck mediterranean sea',
      'beautiful woman rooftop terrace city sunset',
      'glamorous woman luxury pool lounge cabana',
      'stunning woman tropical beach turquoise water',
      'beautiful woman upscale restaurant terrace',
      'elegant woman resort pool sunbathing luxury',
      'stunning woman penthouse terrace city view',
      'beautiful woman beach club ibiza daytime',
      'glamorous woman outdoor pool palm trees',
      'stunning woman mediterranean villa poolside',
    ];
    var womenQuery = WOMEN_QUERIES[Math.floor(Math.random() * WOMEN_QUERIES.length)];

    if (env.PEXELS_API_KEY) {
      var pexelsResults = await Promise.all([
        fetchPexelsImage((lifestyleJson.travel.imageSearchQuery        || 'luxury travel destination beach'), env.PEXELS_API_KEY),
        fetchPexelsImage((lifestyleJson.luxury.imageSearchQuery        || 'luxury watch premium'), env.PEXELS_API_KEY),
        fetchPexelsImage(womenQuery, env.PEXELS_API_KEY),
        fetchPexelsImage((lifestyleJson.tech.imageSearchQuery          || 'technology artificial intelligence'), env.PEXELS_API_KEY),
        fetchPexelsImage((lifestyleJson.fitness.imageSearchQuery       || 'fitness athlete training'), env.PEXELS_API_KEY),
        fetchPexelsImage((lifestyleJson.entertainment.imageSearchQuery || 'cinema entertainment luxury'), env.PEXELS_API_KEY),
      ]);
      lifestyleJson.travel.imageUrl        = pexelsResults[0];
      lifestyleJson.luxury.imageUrl        = pexelsResults[1];
      lifestyleJson.women.imageUrl         = pexelsResults[2];
      lifestyleJson.tech.imageUrl          = pexelsResults[3];
      lifestyleJson.fitness.imageUrl       = pexelsResults[4];
      lifestyleJson.entertainment.imageUrl = pexelsResults[5];
      console.log('[FFX] Pexels images fetched:', pexelsResults.map(function(r){ return r ? 'OK' : 'EMPTY'; }).join(', '));
    } else {
      console.error('[FFX] PEXELS_API_KEY not set — images will be empty');
    }

    await writeProgress(5, 8, 'Selecting Mindset Line from Knowledge database');

    // Pull mindset line from validated knowledge nuggets — not Claude-generated
    var mindsetLine = '';
    try {
      var nuggetIndex = await env.FFX_KV.get('nuggets:index', { type: 'json' }).catch(function() { return null; });
      if (Array.isArray(nuggetIndex) && nuggetIndex.length > 0) {
        // Pick a random nugget from the index
        var randomIdx = Math.floor(Math.random() * Math.min(nuggetIndex.length, 30));
        var randomNuggetId = nuggetIndex[randomIdx];
        var randomNugget = await env.FFX_KV.get('nugget:' + randomNuggetId, { type: 'json' }).catch(function() { return null; });
        if (randomNugget && randomNugget.text) {
          mindsetLine = randomNugget.text.trim().replace(/^["']+|["']+$/g, '');
        }
      }
    } catch(nuggetErr) {
      console.error('[FFX] Nugget read failed (non-fatal):', nuggetErr.message);
    }
    // Fallback: if no nuggets exist yet, generate one
    if (!mindsetLine) {
      var mindsetPrompt = 'Write ONE sentence — the FFX Mindset Line for this bi-weekly newsletter. Rules: mechanical and specific to CTW framework, not motivational fluff, memorable, in Salman\'s direct voice, maximum 25 words. Tied to current market: ' + ((marketsJson.weekInMarkets && marketsJson.weekInMarkets.content) || '').substring(0, 150) + '. Return ONLY the sentence. No quotes. No explanation.';
      var mindsetRes  = await fetch(ANTHROPIC_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 60, messages: [{ role: 'user', content: mindsetPrompt }] }) });
      var mindsetData = await mindsetRes.json();
      if (mindsetData.content && mindsetData.content[0] && mindsetData.content[0].text) mindsetLine = mindsetData.content[0].text.trim().replace(/^["']|["']$/g, '');
    }

    await writeProgress(6, 8, 'Building draft + saving to KV');

    var allFeaturedSlugs = articles.map(function(a) { return a.slug; });
    if (articleJson.trendingQ && articleJson.trendingQ.relatedArticleSlug) allFeaturedSlugs.push(articleJson.trendingQ.relatedArticleSlug);
    if (articleJson.perspective && articleJson.perspective.relatedArticleSlug) allFeaturedSlugs.push(articleJson.perspective.relatedArticleSlug);

    var draft = {
      issueNumber:  issueNumber,
      issueDate:    issueDate,
      generatedAt:  new Date().toISOString(),
      status:       'draft',
      perspective:  {
        title:               (articleJson.perspective && articleJson.perspective.title)               || '',
        hookText:            (articleJson.perspective && articleJson.perspective.hookText)            || '',
        fullText:            (articleJson.perspective && articleJson.perspective.fullText)            || '',
        relatedArticleSlug:  (articleJson.perspective && articleJson.perspective.relatedArticleSlug)  || null,
        relatedArticleTitle: (articleJson.perspective && articleJson.perspective.relatedArticleTitle) || null,
      },
      onThisDay:    {
        year:    (onThisDayJson.onThisDay && onThisDayJson.onThisDay.year)    || '',
        event:   (onThisDayJson.onThisDay && onThisDayJson.onThisDay.event)   || '',
        lesson:  (onThisDayJson.onThisDay && onThisDayJson.onThisDay.lesson)  || '',
        wikiUrl: (onThisDayJson.onThisDay && onThisDayJson.onThisDay.wikiUrl) || '',
      },
      trendingQ:    {
        question:            (articleJson.trendingQ && articleJson.trendingQ.question)            || '',
        answer:              (articleJson.trendingQ && articleJson.trendingQ.answer)              || '',
        relatedArticleSlug:  (articleJson.trendingQ && articleJson.trendingQ.relatedArticleSlug)  || null,
        relatedArticleTitle: (articleJson.trendingQ && articleJson.trendingQ.relatedArticleTitle) || null,
      },
      mindsetLine:  mindsetLine,
      setup:        { note: setupNote, imageUrl: setupImageUrl, hasSetup: !!(setupNote || setupImageUrl) },
      articles:     articles.map(function(a) { return { slug: a.slug, title: a.title, excerpt: a.excerpt || '', category: a.category || '', youtubeUrl: a.youtubeUrl || '', publishedAt: a.publishedAt || '', url: 'https://fortitudefx.com/article?slug=' + a.slug }; }),
      lifestyle:    lifestyleJson,
      featuredSlugs: allFeaturedSlugs,
      subject:      'Catch The Wick™ · Issue #' + issueNumber + ' · ' + formatDateDisplay(issueDate),
    };

    await writeProgress(7, 8, 'Saving draft to KV');
    await env.FFX_KV.put(DRAFT_KEY, JSON.stringify(draft));
    await writeProgress(8, 8, 'Complete');

    try { await env.FFX_KV.delete(PROGRESS_KEY); } catch(e) {}
    console.log('[FFX] Newsletter draft generated — Issue #' + issueNumber);

  } catch(err) {
    console.error('[FFX] Newsletter job failed:', err.message);
    try { await env.FFX_KV.put('newsletter:generate:progress', JSON.stringify({ step: 0, total: 8, label: 'Error: ' + err.message, status: 'error', updatedAt: new Date().toISOString() }), { expirationTtl: 600 }); } catch(e) {}
  }
}
