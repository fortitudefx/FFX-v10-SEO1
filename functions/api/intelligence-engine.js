// functions/api/intelligence-engine.js
// POST /api/intelligence-engine — full intelligence analysis
// GET  /api/intelligence-engine — returns latest brief
// GET  /api/intelligence-engine?progress=1 — returns current run progress

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// ── Progress writer — real step tracking during run ───────────────────────
async function writeProgress(env, step, label, status) {
  // status: 'active' | 'done' | 'error'
  try {
    await env.FFX_KV.put('intelligence:progress', JSON.stringify({
      step, label, status, updatedAt: new Date().toISOString(),
    }), { expirationTtl: 300 }); // 5 min TTL — auto-clears after run
  } catch(e) {
    console.error('[intelligence-engine] writeProgress failed (non-fatal):', e.message);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500, headers);

  try {
    // ── STEP 1: Read signals ──────────────────────────────────────────────
    await writeProgress(env, 1, 'Reading SEO & GA4 signals', 'active');

    const [
      seoSignals, seoLearning, ga4Signals, ga4Learning,
      ytSignals, discordSignals, emailSignals, intelSignals,
      calSignals, knowledgeTaxonomy, knowledgePerf, prevBrief,
    ] = await Promise.all([
      env.FFX_KV.get('seo:signals',          { type: 'json' }).catch(() => null),
      env.FFX_KV.get('seo:learning',          { type: 'json' }).catch(() => null),
      env.FFX_KV.get('ga4:signals',           { type: 'json' }).catch(() => null),
      env.FFX_KV.get('ga4:learning',          { type: 'json' }).catch(() => null),
      env.FFX_KV.get('youtube:signals',       { type: 'json' }).catch(() => null),
      env.FFX_KV.get('discord:signals',       { type: 'json' }).catch(() => null),
      env.FFX_KV.get('email:signals',         { type: 'json' }).catch(() => null),
      env.FFX_KV.get('intelligence:signals',  { type: 'json' }).catch(() => null),
      env.FFX_KV.get('calendar:signals',      { type: 'json' }).catch(() => null),
      env.FFX_KV.get('knowledge:taxonomy',    { type: 'json' }).catch(() => null),
      env.FFX_KV.get('knowledge:performance', { type: 'json' }).catch(() => null),
      env.FFX_KV.get('intelligence:brief',    { type: 'json' }).catch(() => null),
    ]);

    if (!seoSignals && !ga4Signals) {
      await writeProgress(env, 1, 'Reading SEO & GA4 signals', 'error');
      return json({ error: 'No signal data available. Run signal collection first.' }, 400, headers);
    }

    await writeProgress(env, 1, 'Reading SEO & GA4 signals', 'done');

    // ── STEP 2: Read content performance + directive outcomes ─────────────
    await writeProgress(env, 2, 'Reading content performance history', 'active');

    const [articlesIndex, directiveOutcomes, titleTests] = await Promise.all([
      env.FFX_KV.get('articles:index', { type: 'json' }).catch(() => null),
      readDirectiveOutcomes(env),
      readTitleTestOutcomes(env),
    ]);

    await writeProgress(env, 2, 'Reading content performance history', 'done');

    // ── STEP 3: Build context + call Claude ──────────────────────────────
    await writeProgress(env, 3, 'Calling Claude intelligence analyst', 'active');

    const signalContext = buildSignalContext({
      seoSignals, seoLearning, ga4Signals, ga4Learning,
      ytSignals, discordSignals, emailSignals, intelSignals,
      calSignals, knowledgeTaxonomy, knowledgePerf, prevBrief,
      articlesIndex, directiveOutcomes, titleTests,
    });

    let brief;
    try {
      brief = await callClaudeAnalyst(signalContext, env.ANTHROPIC_API_KEY);
    } catch(claudeErr) {
      await writeProgress(env, 3, 'Claude analyst failed: ' + claudeErr.message, 'error');
      throw claudeErr;
    }

    await writeProgress(env, 3, 'Calling Claude intelligence analyst', 'done');

    // ── STEP 4: Write brief to KV ─────────────────────────────────────────
    await writeProgress(env, 4, 'Writing intelligence brief to KV', 'active');

    const output = {
      ...brief,
      generatedAt: new Date().toISOString(),
      signalSources: {
        seo:          !!seoSignals,
        ga4:          !!ga4Signals,
        youtube:      !!ytSignals,
        discord:      !!discordSignals,
        email:        !!emailSignals,
        intelligence: !!intelSignals,
        calendar:     !!calSignals,
        knowledge:    !!knowledgeTaxonomy,
      },
    };

    await env.FFX_KV.put('intelligence:brief', JSON.stringify(output));
    await writeProgress(env, 4, 'Writing intelligence brief to KV', 'done');

    // ── STEP 5: Compute directive resolutions (up to 3 daily mandates) ────
    await writeProgress(env, 5, 'Computing directive resolution', 'active');

    try {
      // Primary directive (existing single resolution - backward compat)
      const resolution = await computeDirectiveResolution(brief, env, articlesIndex);
      output.directiveResolution = resolution;

      // All mandates: resolve each priority action into an actionable directive
      // Up to 3 mandates, each independently trackable
      const mandates = [];
      if (resolution && resolution.type !== 'none' && resolution.type !== 'no_directive') {
        mandates.push(resolution);
      }

      // Resolve remaining priority actions into mandates (up to 2 more)
      if (brief.priorityActions && brief.priorityActions.length > 1 && mandates.length < 3) {
        for (var pi = 1; pi < brief.priorityActions.length && mandates.length < 3; pi++) {
          try {
            var pa = brief.priorityActions[pi];
            var paResolution = {
              type: 'priority_action',
              matchType: 'action_only',
              directiveText: pa.action || '',
              action: {
                label: 'Mark Done',
                type: 'generic',
                note: pa.action,
                impact: pa.impact || 'medium',
                reasoning: pa.reasoning || '',
              },
              rank: pi + 1,
            };
            // Check if this priority action is a link action — resolve it properly
            var paText = (pa.action || '').toLowerCase();
            if (paText.includes('internal link') || paText.includes('link between') || paText.includes('add link')) {
              var linkRes = await computeLinkMandate(brief, env, articlesIndex);
              if (linkRes) { paResolution = linkRes; paResolution.rank = pi + 1; }
            }
            mandates.push(paResolution);
          } catch(paErr) {
            console.error('[intelligence-engine] Mandate', pi, 'resolution failed (non-fatal):', paErr.message);
          }
        }
      }

      output.directiveResolutions = mandates;
      // Re-write with resolutions included
      await env.FFX_KV.put('intelligence:brief', JSON.stringify(output));
      console.log('[intelligence-engine] Resolutions computed:', mandates.length, 'mandates');
    } catch(resErr) {
      console.error('[intelligence-engine] Resolution failed (non-fatal):', resErr.message);
    }

    await writeProgress(env, 5, 'Computing directive resolution', 'done');

    // ── STEP 6: Logging + learning ────────────────────────────────────────
    await writeProgress(env, 6, 'Updating brief log', 'active');

    try {
      const today = new Date().toISOString().split('T')[0];
      const briefLog = {
        briefId: today, generatedAt: output.generatedAt,
        signalSources: output.signalSources,
        signalConfidence: (output.signalSources.seo && output.signalSources.ga4) ? 'low' : 'minimal',
        recommendations: [],
        accuracyScore: null, usefulnessScore: null, scoredAt: null,
      };

      if (brief.articleBrief) {
        briefLog.recommendations.push({
          id: today + '_article', type: 'article_brief',
          target: brief.articleBrief.targetQuery || null,
          prediction: 'Article ranks in top 50 for "' + brief.articleBrief.targetQuery + '" within 30 days',
          confidence: 'low', actedOn: null, outcome: null, accurate: null,
        });
      }
      if (Array.isArray(brief.titleRewrites)) {
        brief.titleRewrites.forEach(function(r, i) {
          briefLog.recommendations.push({
            id: today + '_title_' + i, type: 'title_rewrite',
            target: r.currentUrl || null,
            prediction: 'CTR improvement within 14 days of title change',
            confidence: r.currentPosition < 15 ? 'high' : 'medium',
            actedOn: null, outcome: null, accurate: null,
          });
        });
      }
      if (Array.isArray(brief.priorityActions)) {
        brief.priorityActions.forEach(function(a, i) {
          briefLog.recommendations.push({
            id: today + '_action_' + i, type: 'priority_action',
            target: a.action || null,
            prediction: 'Impact: ' + a.impact + ', Effort: ' + a.effort,
            confidence: a.impact === 'high' ? 'medium' : 'low',
            actedOn: null, outcome: null, accurate: null,
          });
        });
      }

      await env.FFX_KV.put('intelligence:brief_log:' + today, JSON.stringify(briefLog));
    } catch(logErr) {
      console.error('[intelligence-engine] Brief log failed (non-fatal):', logErr.message);
    }

    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 1) {
      await updateLearningSummary(env, seoLearning, ga4Learning, brief).catch(function(e) {
        console.error('[intelligence-engine] Learning summary failed (non-fatal):', e.message);
      });
    }

    await writeProgress(env, 6, 'Analysis complete', 'done');

    console.log('[intelligence-engine] Brief written successfully');
    return json({ success: true, brief: output }, 200, headers);

  } catch(err) {
    console.error('[intelligence-engine] Error:', err.message);
    await writeProgress(env, 0, 'Error: ' + err.message, 'error').catch(function(){});
    return json({ error: err.message }, 500, headers);
  }
}

// ── Read directive outcomes for feedback loop ─────────────────────────────
async function readDirectiveOutcomes(env) {
  try {
    const list = await env.FFX_KV.list({ prefix: 'intelligence:directive_outcome:' }).catch(function(){ return null; });
    if (!list || !list.keys.length) return [];
    // Read last 30 outcomes only — avoid excessive KV reads
    const recent = list.keys.slice(-30);
    const results = await Promise.all(
      recent.map(function(k){ return env.FFX_KV.get(k.name, { type: 'json' }).catch(function(){ return null; }); })
    );
    return results.filter(Boolean);
  } catch(e) {
    console.error('[intelligence-engine] readDirectiveOutcomes failed (non-fatal):', e.message);
    return [];
  }
}

// ── Read title test outcomes for feedback loop ────────────────────────────
async function readTitleTestOutcomes(env) {
  try {
    const list = await env.FFX_KV.list({ prefix: 'seo:title_tests:' }).catch(function(){ return null; });
    if (!list || !list.keys.length) return [];
    const results = await Promise.all(
      list.keys.slice(0, 20).map(function(k){ return env.FFX_KV.get(k.name, { type: 'json' }).catch(function(){ return null; }); })
    );
    return results.filter(Boolean);
  } catch(e) {
    console.error('[intelligence-engine] readTitleTestOutcomes failed (non-fatal):', e.message);
    return [];
  }
}

// ── Build signal context for Claude ──────────────────────────────────────
function buildSignalContext(signals) {
  const {
    seoSignals, seoLearning, ga4Signals, ga4Learning,
    ytSignals, discordSignals, emailSignals, intelSignals,
    calSignals, knowledgeTaxonomy, knowledgePerf, prevBrief,
    articlesIndex, directiveOutcomes, titleTests,
  } = signals;

  let ctx = 'You are the intelligence analyst for FortitudeFX (fortitudefx.com), a forex trading education brand built around the Catch The Wick\u2122 mechanical entry system by Salman Khan.\n'
    + 'Your job is to analyse ALL available signal data and produce a precise, actionable intelligence brief that will:\n'
    + '1. Brief Claude (the content writer) on exactly what article to write next\n'
    + '2. Identify the highest-ROI opportunities across all platforms\n'
    + '3. Surface patterns that improve future content performance\n'
    + '4. Draft reply opportunities for community engagement\n\n'
    + 'ABOUT FORTITUDEFX:\n'
    + '- Brand: FortitudeFX\u2122, methodology: Catch The Wick\u2122, 2 Candle. 1 Story.\u2122\n'
    + '- Founder: Salman Khan \u2014 calm, institutional, slightly contrarian voice\n'
    + '- Products: Free Discord community, Catch the Wick Bootcamp, VIP Discord\n'
    + '- Content pillars: CTW Framework, Execution Discipline, Market Psychology, Trading Reality, Lifestyle & Philosophy\n'
    + '- Target: Retail forex traders who want mechanical, rules-based trading\n'
    + '- Zero ad spend \u2014 entirely organic, SEO, community\n\n'
    + 'SIGNAL DATA AVAILABLE:\n';

  if (seoSignals) {
    ctx += '\n\u2501\u2501 SEARCH CONSOLE SIGNALS (last 7 days) \u2501\u2501\n'
      + 'Clicks: ' + (seoSignals.totals && seoSignals.totals.clicks || 0)
      + ' | Impressions: ' + (seoSignals.totals && seoSignals.totals.impressions || 0)
      + ' | Avg Position: ' + (seoSignals.totals && seoSignals.totals.position ? seoSignals.totals.position.toFixed(1) : 'N/A') + '\n'
      + 'Momentum: ' + (seoSignals.momentum || 'unknown') + '\n'
      + 'Impressions delta vs prev week: ' + (seoSignals.imprDelta ? seoSignals.imprDelta.toFixed(1) + '%' : 'N/A') + '\n'
      + 'Rising queries:\n'
      + ((seoSignals.risingQueries || []).map(function(q){ return '  - "' + q.query + '" \u2014 ' + q.impressions + ' impr, pos ' + (q.position && q.position.toFixed(0)); }).join('\n') || '  None yet') + '\n'
      + 'Zero-click opportunities:\n'
      + ((seoSignals.zeroClickOpportunities || []).map(function(z){ return '  - ' + z.url + ' \u2014 ' + z.impressions + ' impr, pos ' + (z.position && z.position.toFixed(1)); }).join('\n') || '  None') + '\n'
      + 'Page 2 opportunities:\n'
      + ((seoSignals.page2Opportunities || []).map(function(p){ return '  - ' + p.url + ' \u2014 pos ' + (p.position && p.position.toFixed(1)) + ', ' + p.impressions + ' impr'; }).join('\n') || '  None') + '\n'
      + 'Best page: ' + (seoSignals.bestPage && seoSignals.bestPage.url || 'N/A') + ' (' + (seoSignals.bestPage && seoSignals.bestPage.clicks || 0) + ' clicks)\n'
      + 'Total indexed: ' + (seoSignals.totalIndexedPages || 0) + '\n'
      + 'Top countries: ' + ((seoSignals.topCountries || []).map(function(c){ return c.country; }).join(', ')) + '\n';
  }

  if (seoLearning && seoLearning.length > 0) {
    ctx += '\n\u2501\u2501 SEO LEARNING (' + seoLearning.length + ' weeks) \u2501\u2501\n'
      + seoLearning.map(function(w){ return '  Week ' + w.week + ': ' + w.momentum + ', ' + w.clicks + ' clicks, pos ' + (w.position && w.position.toFixed(1)); }).join('\n') + '\n';
  }

  if (ga4Signals) {
    ctx += '\n\u2501\u2501 GA4 AUDIENCE SIGNALS \u2501\u2501\n'
      + 'Users: ' + (ga4Signals.totals && ga4Signals.totals.users || 0)
      + ' | Sessions: ' + (ga4Signals.totals && ga4Signals.totals.sessions || 0) + '\n'
      + 'Bounce rate: ' + ((ga4Signals.totals && ga4Signals.totals.bounceRate || 0) * 100).toFixed(1) + '%\n'
      + 'EQS: ' + (ga4Signals.engagementQualityScore || 0) + '/100\n'
      + 'Top pages:\n'
      + ((ga4Signals.topPages || []).slice(0, 5).map(function(p){ return '  - ' + p.path + ': ' + p.sessions + ' sessions, ' + Math.round(p.duration) + 's avg'; }).join('\n') || '  None') + '\n';
  }

  if (ga4Learning && ga4Learning.length > 0) {
    ctx += '\n\u2501\u2501 GA4 LEARNING \u2501\u2501\n'
      + ga4Learning.map(function(w){ return '  Week ' + w.week + ': EQS ' + w.eqs + ', ' + w.users + ' users, bounce ' + ((w.bounceRate || 0) * 100).toFixed(0) + '%'; }).join('\n') + '\n';
  }

  if (ytSignals) ctx += '\n\u2501\u2501 YOUTUBE SIGNALS \u2501\u2501\n' + JSON.stringify(ytSignals, null, 2) + '\n';
  if (discordSignals) ctx += '\n\u2501\u2501 DISCORD SIGNALS \u2501\u2501\n' + JSON.stringify(discordSignals, null, 2) + '\n';
  if (emailSignals) ctx += '\n\u2501\u2501 EMAIL SIGNALS \u2501\u2501\n' + JSON.stringify(emailSignals, null, 2) + '\n';
  if (intelSignals) ctx += '\n\u2501\u2501 INTELLIGENCE AGENT SIGNALS \u2501\u2501\n' + JSON.stringify(intelSignals, null, 2) + '\n';
  if (calSignals) ctx += '\n\u2501\u2501 FOREX CALENDAR SIGNALS \u2501\u2501\n' + JSON.stringify(calSignals, null, 2) + '\n';

  if (knowledgeTaxonomy) {
    ctx += '\n\u2501\u2501 KNOWLEDGE LIBRARY \u2501\u2501\n'
      + 'Categories: ' + ((knowledgeTaxonomy.categories || []).join(', ')) + '\n'
      + 'Total nuggets: ' + (knowledgeTaxonomy.totalNuggets || 'unknown') + '\n'
      + 'Underrepresented: ' + ((knowledgeTaxonomy.underrepresented || []).join(', ') || 'unknown') + '\n';
  }

  if (prevBrief) {
    ctx += '\n\u2501\u2501 YESTERDAY\'S BRIEF \u2501\u2501\n'
      + 'Yesterday target: ' + (prevBrief.articleBrief && prevBrief.articleBrief.targetQuery || 'N/A') + '\n'
      + 'Yesterday momentum: ' + (prevBrief.weeklyInsight && prevBrief.weeklyInsight.momentum || 'N/A') + '\n';
  }

  // ── Content gap detection ─────────────────────────────────────────────
  if (articlesIndex && articlesIndex.length > 0) {
    const pillars = {};
    articlesIndex.forEach(function(a) {
      var p = a.category || 'Strategy';
      pillars[p] = (pillars[p] || 0) + 1;
    });
    const allPillars = ['Strategy', 'Psychology', 'Risk Management', 'Market Analysis', 'Fundamentals'];
    const gaps = allPillars.filter(function(p){ return !pillars[p] || pillars[p] < 2; });
    ctx += '\n\u2501\u2501 CONTENT GAP ANALYSIS (' + articlesIndex.length + ' published articles) \u2501\u2501\n'
      + 'Published by category: ' + Object.entries(pillars).map(function(e){ return e[0] + ' (' + e[1] + ')'; }).join(', ') + '\n'
      + 'Underrepresented pillars (< 2 articles): ' + (gaps.join(', ') || 'none') + '\n'
      + 'Consider filling gaps to build topical authority across all pillars.\n';
  }

  // ── Directive outcome feedback loop ───────────────────────────────────
  if (directiveOutcomes && directiveOutcomes.length > 0) {
    const acted = directiveOutcomes.filter(function(o){ return o.actedOn; });
    const improved = directiveOutcomes.filter(function(o){ return o.outcome === 'improved'; });
    const byType = {};
    acted.forEach(function(o) {
      if (!byType[o.directiveType]) byType[o.directiveType] = { acted: 0, improved: 0 };
      byType[o.directiveType].acted++;
      if (o.outcome === 'improved') byType[o.directiveType].improved++;
    });
    ctx += '\n\u2501\u2501 DIRECTIVE FEEDBACK LOOP (your actions & outcomes) \u2501\u2501\n'
      + 'Total directives acted on: ' + acted.length + ' | Confirmed improvements: ' + improved.length + '\n'
      + 'By type: ' + Object.entries(byType).map(function(e){ return e[0] + ': ' + e[1].acted + ' acted, ' + e[1].improved + ' improved'; }).join(' | ') + '\n'
      + 'CALIBRATION: Prioritise directive types with highest improvement rate. Avoid repeating types that consistently show no improvement.\n';
  }

  // ── Title test outcomes ───────────────────────────────────────────────
  if (titleTests && titleTests.length > 0) {
    const completed = titleTests.filter(function(t){ return t.status === 'complete'; });
    const improved = completed.filter(function(t){ return t.improvement === true; });
    if (completed.length > 0) {
      ctx += '\n\u2501\u2501 TITLE TEST OUTCOMES \u2501\u2501\n'
        + 'Completed tests: ' + completed.length + ' | Improved CTR: ' + improved.length + '\n'
        + completed.slice(0, 5).map(function(t){ return '  - "' + t.newTitle + '": ' + (t.improvement ? 'CTR improved ' + ((t.ctrAfter - t.ctrAtChange) * 100).toFixed(2) + '%' : 'no improvement'); }).join('\n') + '\n';
    }
  }

  return ctx;
}

// ── Compute directive resolution ──────────────────────────────────────────
async function computeDirectiveResolution(brief, env, articlesIndexPrefetched) {
  const resolution = { type: 'none', matchType: 'none', directiveText: '', action: null };

  try {
    const hasArticleBrief   = !!(brief.articleBrief && brief.articleBrief.targetQuery);
    const hasTitleRewrite   = !!(brief.titleRewrites && brief.titleRewrites.length > 0);
    const hasPriorityAction = !!(brief.priorityActions && brief.priorityActions.length > 0);

    // Use prefetched articlesIndex from step 2 — no duplicate KV read
    const articles = Array.isArray(articlesIndexPrefetched) ? articlesIndexPrefetched : [];

    const [nuggetsIndex, queueIndex] = await Promise.all([
      env.FFX_KV.get('nuggets:index',  { type: 'json' }).catch(function(){ return null; }),
      env.FFX_KV.get('queue:index',    { type: 'json' }).catch(function(){ return null; }),
    ]);

    const nuggetIds = Array.isArray(nuggetsIndex) ? nuggetsIndex : [];
    const queue     = Array.isArray(queueIndex)   ? queueIndex   : [];

    // ── Title rewrite directive ─────────────────────────────────────────
    if (hasTitleRewrite) {
      // Validate that article has a published body before surfacing title rewrite
      // Never suggest title changes for articles that have no live content
      var validRewrite = null;
      for (var ri = 0; ri < brief.titleRewrites.length; ri++) {
        var candidate = brief.titleRewrites[ri];
        var cSlug = candidate.currentUrl ? candidate.currentUrl.replace('/article?slug=', '') : '';
        if (!cSlug) continue;
        try {
          var cMeta = await env.FFX_KV.get('article:' + cSlug, { type: 'json' }).catch(function(){ return null; });
          if (!cMeta) continue;
          // Read-only check on published record — never write
          var cVid = cMeta.videoId;
          if (cVid) {
            var cPub = await env.FFX_KV.get('published:' + cVid, { type: 'json' }).catch(function(){ return null; });
            var hasBody = !!(cPub && cPub.globalContent && cPub.globalContent.body);
            if (!hasBody) {
              console.log('[intelligence-engine] Skipping title rewrite for ' + cSlug + ' — no published body');
              continue;
            }
          }
          // Article has body (or no videoId meaning it serves from articles.json) — valid
          validRewrite = { rewrite: candidate, slug: cSlug, meta: cMeta };
          break;
        } catch(valErr) {
          console.error('[intelligence-engine] Title rewrite validation error (non-fatal):', valErr.message);
        }
      }

      if (!validRewrite) {
        // No valid title rewrites — fall through to article brief
        console.log('[intelligence-engine] All title rewrites skipped — no articles with published body');
      } else {
        var rewrite = validRewrite.rewrite;
        var slug    = validRewrite.slug;
        var cMeta   = validRewrite.meta;
        var currentTitle = cMeta.title || '';

        resolution.type = 'title_rewrite';
        resolution.directiveText = 'Rewrite title for: ' + (currentTitle || slug);
        resolution.action = {
          label: 'Apply Title', type: 'title_rewrite',
          slug: slug,
          currentTitle:   currentTitle,
          suggestedTitle: rewrite.suggestedTitle,
          reasoning:      rewrite.reasoning,
          ctrBefore:      rewrite.currentClicks && rewrite.currentImpressions ? (rewrite.currentClicks / rewrite.currentImpressions) : null,
          position:       rewrite.currentPosition || null,
        };
        resolution.matchType = 'found_article';
        return resolution;
      }
    }

    // ── Article brief directive ─────────────────────────────────────────
    if (hasArticleBrief) {
      var targetQuery = brief.articleBrief.targetQuery.toLowerCase();
      var nuggetTags  = (brief.articleBrief.nuggetTags || []).map(function(t){ return t.toLowerCase(); });
      var queryWords  = targetQuery.split(/\s+/).filter(function(w){ return w.length > 3; });

      resolution.type = 'article_brief';
      resolution.directiveText = 'Generate article targeting: "' + brief.articleBrief.targetQuery + '"';

      // 1. Published article already covers this topic?
      var matchedArticle = articles.find(function(a) {
        var titleLower = a.title.toLowerCase();
        var tagsLower  = (a.tags || []).map(function(t){ return t.toLowerCase(); });
        var titleMatch = queryWords.some(function(w){ return titleLower.includes(w); });
        var tagMatch   = nuggetTags.some(function(nt){ return tagsLower.some(function(t){ return t.includes(nt) || nt.includes(t); }); });
        return titleMatch || tagMatch;
      });

      if (matchedArticle) {
        resolution.matchType = 'found_published_article';
        resolution.action = {
          label: 'Update Title', type: 'title_rewrite',
          slug:           matchedArticle.slug,
          currentTitle:   matchedArticle.title,
          suggestedTitle: brief.articleBrief.suggestedTitle,
          articleUrl:     'https://fortitudefx.com/article?slug=' + matchedArticle.slug,
          note: 'You already have a published article on this topic. Update its title to match the target query.',
        };
        return resolution;
      }

      // 2. Queue item for this topic?
      var matchedQueueItem = queue.find(function(q) {
        if (!q.title) return false;
        return queryWords.some(function(w){ return q.title.toLowerCase().includes(w); });
      });

      if (matchedQueueItem && matchedQueueItem.wasGenerated) {
        resolution.matchType = 'found_queue_ready';
        resolution.action = {
          label: 'Go to Article', type: 'queue_ready',
          videoId: matchedQueueItem.videoId, title: matchedQueueItem.title,
          note: 'Content generated and ready to review.',
        };
        return resolution;
      }

      if (matchedQueueItem && !matchedQueueItem.wasGenerated) {
        resolution.matchType = 'found_queue_pending';
        resolution.action = {
          label: 'Generate Now', type: 'queue_pending',
          videoId: matchedQueueItem.videoId, title: matchedQueueItem.title,
          note: 'Video in queue — generate article now.',
        };
        return resolution;
      }

      // 3. Nuggets for this topic?
      if (nuggetIds.length > 0 && nuggetTags.length > 0) {
        var sampleIds = nuggetIds.slice(0, 30);
        var nuggets = (await Promise.all(
          sampleIds.map(function(id){ return env.FFX_KV.get('nugget:' + id, { type: 'json' }).catch(function(){ return null; }); })
        )).filter(Boolean);

        var matchedNuggets = nuggets.filter(function(n) {
          var nTags = (n.tags || []).map(function(t){ return t.toLowerCase(); });
          return nuggetTags.some(function(nt){ return nTags.some(function(t){ return t.includes(nt) || nt.includes(t); }); });
        });

        if (matchedNuggets.length >= 2) {
          resolution.matchType = 'found_nuggets';
          resolution.action = {
            label: 'Generate with Nuggets', type: 'nugget_generate',
            nuggetCount:    matchedNuggets.length,
            nuggetIds:      matchedNuggets.slice(0, 5).map(function(n){ return n.id; }),
            nuggetTags:     nuggetTags,
            suggestedTitle: brief.articleBrief.suggestedTitle,
            targetQuery:    brief.articleBrief.targetQuery,
            note: matchedNuggets.length + ' existing nuggets match this topic — inject them for a stronger article.',
          };
          return resolution;
        }
      }

      // 4. No existing content
      resolution.matchType = 'no_existing_content';
      resolution.action = {
        label: 'Add Video to Queue', type: 'new_article',
        targetQuery:    brief.articleBrief.targetQuery,
        suggestedTitle: brief.articleBrief.suggestedTitle,
        angle:          brief.articleBrief.angle,
        note: 'No existing content on this topic. Add a relevant video URL to generate a new article.',
      };
      return resolution;
    }

    // ── Priority action — retroactive linking / generic ─────────────────
    if (hasPriorityAction) {
      var action = brief.priorityActions[0];
      var actionText = (action.action || '').toLowerCase();

      if (actionText.includes('internal link') || actionText.includes('link between') || actionText.includes('add link')) {
        if (articles.length >= 2) {
          var sorted = articles.slice().sort(function(a, b){ return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0); });
          var newest  = sorted[0];
          var related = sorted.slice(1).find(function(a) {
            return (a.tags || []).some(function(t){ return (newest.tags || []).some(function(nt){ return nt.toLowerCase() === t.toLowerCase(); }); });
          }) || sorted[1];

          if (newest && related) {
            resolution.type = 'retroactive_link';
            resolution.directiveText = 'Add internal link from "' + related.title + '" to "' + newest.title + '"';
            resolution.matchType = 'found_link_pair';
            resolution.action = {
              label: 'Apply Link', type: 'retroactive_link',
              sourceSlug:  related.slug, sourceTitle: related.title,
              targetSlug:  newest.slug,  targetTitle: newest.title,
              targetUrl:   'https://fortitudefx.com/article?slug=' + newest.slug,
              note: 'Add a link from "' + related.title + '" to your newest article "' + newest.title + '" to boost its ranking.',
            };
            return resolution;
          }
        }
      }

      resolution.type = 'priority_action';
      resolution.directiveText = action.action || '';
      resolution.matchType = 'action_only';
      resolution.action = { label: 'Mark Done', type: 'generic', note: action.action };
      return resolution;
    }

    resolution.matchType = 'no_directive';
    return resolution;

  } catch(err) {
    console.error('[intelligence-engine] computeDirectiveResolution error:', err.message);
    resolution.matchType = 'error';
    return resolution;
  }
}

// ── Compute retroactive link mandate ─────────────────────────────────────
// Finds the best cross-link pair from articles:index
async function computeLinkMandate(brief, env, articles) {
  if (!articles || articles.length < 2) return null;
  try {
    var sorted = articles.slice().sort(function(a, b){ return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0); });
    var newest = sorted[0];
    var related = sorted.slice(1).find(function(a) {
      return (a.tags || []).some(function(t){ return (newest.tags || []).some(function(nt){ return nt.toLowerCase() === t.toLowerCase(); }); });
    }) || sorted[1];
    if (!newest || !related) return null;
    return {
      type: 'retroactive_link',
      matchType: 'found_link_pair',
      directiveText: 'Add internal link from "' + related.title + '" to "' + newest.title + '"',
      action: {
        label: 'Apply Link', type: 'retroactive_link',
        sourceSlug: related.slug, sourceTitle: related.title,
        targetSlug: newest.slug, targetTitle: newest.title,
        targetUrl: 'https://fortitudefx.com/article?slug=' + newest.slug,
        note: 'Add a link from "' + related.title + '" to "' + newest.title + '" to boost its ranking.',
      },
    };
  } catch(e) { return null; }
}

// ── Call Claude analyst ───────────────────────────────────────────────────
async function callClaudeAnalyst(signalContext, apiKey) {
  const prompt = signalContext + '\n\n'
    + '\u2501'.repeat(40) + '\nYOUR TASK\n' + '\u2501'.repeat(40) + '\n\n'
    + 'Analyse ALL signal data above and produce a comprehensive intelligence brief. '
    + 'Look for cross-signal patterns. Use the directive feedback loop and title test outcomes to calibrate your recommendations.\n\n'
    + 'Return ONLY a valid JSON object with exactly this structure:\n\n'
    + '{\n'
    + '  "articleBrief": {\n'
    + '    "targetQuery": "exact search query to target",\n'
    + '    "suggestedTitle": "SEO-optimised article title in Salman\'s voice",\n'
    + '    "angle": "specific angle",\n'
    + '    "keyPoints": ["point 1", "point 2", "point 3"],\n'
    + '    "targetLength": 1200,\n'
    + '    "contentPillar": "CTW Framework|Execution Discipline|Market Psychology|Trading Reality|Lifestyle & Philosophy",\n'
    + '    "internalLinks": ["slug-1", "slug-2"],\n'
    + '    "nuggetTags": ["tags to pull nuggets from"],\n'
    + '    "reasoning": "why this specific article now"\n'
    + '  },\n'
    + '  "titleRewrites": [{\n'
    + '    "currentUrl": "/article?slug=example",\n'
    + '    "currentImpressions": 0, "currentClicks": 0, "currentPosition": 0,\n'
    + '    "suggestedTitle": "new title", "reasoning": "why"\n'
    + '  }],\n'
    + '  "replyOpportunities": [{\n'
    + '    "platform": "reddit|quora|x|youtube|linkedin",\n'
    + '    "topic": "topic description", "urgency": "high|medium|low",\n'
    + '    "angle": "how to approach", "relevantNuggetTags": ["tags"],\n'
    + '    "articleToLink": "slug", "draftReply": "150-200 word draft reply in Salman\'s voice"\n'
    + '  }],\n'
    + '  "weeklyInsight": {\n'
    + '    "momentum": "accelerating|growing|stable|declining",\n'
    + '    "headline": "one sentence summary",\n'
    + '    "keyWin": "biggest win", "keyRisk": "biggest risk",\n'
    + '    "forecast": "30-day projection"\n'
    + '  },\n'
    + '  "priorityActions": [{\n'
    + '    "rank": 1, "action": "specific action",\n'
    + '    "impact": "high|medium|low", "effort": "high|medium|low",\n'
    + '    "reasoning": "why priority 1"\n'
    + '  }],\n'
    + '  "learningUpdate": {\n'
    + '    "newPattern": "new pattern this week",\n'
    + '    "confirmedPattern": "confirmed again",\n'
    + '    "invalidatedPattern": "stopped working"\n'
    + '  },\n'
    + '  "promptInjection": {\n'
    + '    "currentSignals": "2-3 sentences for article generation",\n'
    + '    "historicalLearning": "2-3 sentences on what worked",\n'
    + '    "avoidance": "1-2 sentences on what to avoid"\n'
    + '  }\n'
    + '}\n\n'
    + 'CRITICAL: Return ONLY the raw JSON object. No markdown. No code fences. Start with { end with }.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
  const data  = await res.json();
  const raw   = data.content[0].text.trim();
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON in Claude response');
  return JSON.parse(raw.slice(first, last + 1));
}

// ── Weekly learning summary ───────────────────────────────────────────────
async function updateLearningSummary(env, seoLearning, ga4Learning, brief) {
  if (!seoLearning || seoLearning.length < 2) return;
  const summaryPrompt = 'Analyse FFX historical SEO and audience data. Extract actionable patterns.\n\n'
    + 'SEO Learning (' + seoLearning.length + ' weeks):\n' + JSON.stringify(seoLearning, null, 2) + '\n\n'
    + 'GA4 Learning (' + (ga4Learning ? ga4Learning.length : 0) + ' weeks):\n' + JSON.stringify(ga4Learning || [], null, 2) + '\n\n'
    + 'Return JSON only:\n'
    + '{"seoSummary":"","audienceSummary":"","risingTopics":[],"avoidTopics":[],"optimalLength":1200,"optimalStructure":"","generatedAt":""}\n'
    + 'Return ONLY raw JSON. No markdown.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1000, messages: [{ role: 'user', content: summaryPrompt }] }),
  });

  if (!res.ok) return;
  const data  = await res.json();
  const raw   = data.content[0].text.trim();
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first === -1) return;
  const summary = JSON.parse(raw.slice(first, last + 1));
  summary.generatedAt = new Date().toISOString();
  await env.FFX_KV.put('seo:learning:summary', JSON.stringify(summary));
  console.log('[intelligence-engine] Learning summary updated');
}

// ── GET handlers ──────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const url     = new URL(request.url);

  // ?progress=1 — returns current run step
  if (url.searchParams.get('progress') === '1') {
    try {
      const progress = await env.FFX_KV.get('intelligence:progress', { type: 'json' }).catch(function(){ return null; });
      return new Response(JSON.stringify({ progress: progress || null }), { status: 200, headers });
    } catch(err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  // Default — return latest brief
  try {
    const brief = await env.FFX_KV.get('intelligence:brief', { type: 'json' }).catch(function(){ return null; });
    return new Response(JSON.stringify({ brief: brief || null }), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
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
