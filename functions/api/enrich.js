// functions/api/enrich.js
// ─────────────────────────────────────────────────────────────────────────────
// ENRICH AN EXISTING ARTICLE — the other half of consolidation.
//
//   GET  /api/enrich                    → the plan: which pages, which keywords, ranked
//   POST /api/enrich?slug=<slug>        → generate + gate + STAGE to pendingEdits
//   POST /api/enrich?slug=<slug>&preview=1 → generate + gate, return it, write NOTHING
//
// WHY: 12,690 searches/month of already-measured demand had no route into the
// system. Every one of those keywords normalises to a head topic that is already
// claimed, so selectTargets correctly refuses to spawn an article — and nothing
// else ever picked them up. The original design named this "enrichment" and never
// built it, so it fell to Salman manually. It shouldn't.
//
// SAFETY — this touches PUBLISHED, INDEXED pages, so:
//   • The existing body is passed through byte-for-byte. Sections are APPENDED.
//     Nothing rewrites what already ranks.
//   • The merged body runs the SAME gate suite as any new article — similarity,
//     thin, voice, banned openings, quote verification, anti-fabrication.
//     Fail = nothing is written anywhere.
//   • A pass writes to record.pendingEdits.body ONLY — the existing staging
//     channel (save-edits.js). globalContent, the live source of truth, is never
//     touched. The page changes when Salman republishes, and not before.
// ─────────────────────────────────────────────────────────────────────────────

import { buildEnrichmentPlan, planByPriority } from '../../lib/enrich/plan.js';
import { generateSections, mergeSections, phraseOverlap } from '../../lib/enrich/generate.js';
import { readDemandMap, retrieveNuggetIds } from '../../lib/keyword/select.js';
import { loadNuggetTexts } from '../../lib/keyword/grounding.js';
import { runGate } from '../../lib/gate/gate.js';
import { loadCorpus, writeVerdict } from '../../lib/gate/verdict.js';

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};
const json = (b, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: HEADERS });

// GET — the plan, ranked. Read-only.
export async function onRequestGet(context) {
  const { env } = context;
  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  const map = await readDemandMap(env).catch(() => []);
  if (!map.length) return json({ error: 'demand:map empty or unreadable' }, 500);
  const plan = planByPriority(buildEnrichmentPlan(map));
  return json({
    pages: plan.length,
    totalAddedVolume: plan.reduce((n, p) => n + p.addedVolume, 0),
    plan: plan.map(p => ({
      slug: p.slug,
      currentlyTargets: `${p.headKeyword} (${p.headVolume}/mo)`,
      sectionsToAdd: p.targets.length,
      addedVolume: p.addedVolume,
      targets: p.targets,
    })),
  });
}

// Resolve the published record that owns a slug, plus its live body.
async function loadPublished(env, slug) {
  let key = 'published:slug:' + slug;
  let raw = await env.FFX_KV.get(key, { type: 'json' }).catch(() => null);
  if (!raw) {
    // Fall back via the article record's videoId.
    const meta = await env.FFX_KV.get('article:' + slug, { type: 'json' }).catch(() => null);
    if (meta && meta.videoId) {
      key = 'published:' + meta.videoId;
      raw = await env.FFX_KV.get(key, { type: 'json' }).catch(() => null);
    }
  }
  if (!raw) return null;
  const gc = raw.globalContent || {};
  const pe = raw.pendingEdits || {};
  return { key, record: raw, title: pe.title || gc.title || '', body: pe.body || gc.body || '' };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  const preview = url.searchParams.get('preview') === '1';

  if (!env.FFX_KV) return json({ error: 'FFX_KV not bound' }, 500);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);
  if (!slug) return json({ error: 'pass ?slug=<article-slug>' }, 400);

  // 1. Plan for this page
  const map = await readDemandMap(env).catch(() => []);
  const plan = buildEnrichmentPlan(map);
  const entry = plan[slug];
  if (!entry) return json({ error: `no enrichment plan for "${slug}" — GET /api/enrich lists eligible pages` }, 404);

  // 2. The live article
  const pub = await loadPublished(env, slug);
  if (!pub || !pub.body) return json({ error: `no published body found for "${slug}"` }, 404);

  // 2b. BATCHING — asking for all 23 sections in one call timed out the Worker
  // (Cloudflare returned a bare 502 before the function could answer). Small
  // batches keep each request well inside limits.
  //
  // Resumability falls out of the body itself: a target whose keyword already
  // appears in the live body has been covered, so it is skipped. Re-POSTing the
  // same slug therefore continues where the last call stopped, and a repeat call
  // after completion is a no-op. No progress state to store or corrupt.
  // Coverage is tracked EXPLICITLY on the record, not inferred from the body.
  // Inferring failed: the check looked for the keyword phrase verbatim, but the
  // model writes natural headings, so an awkward query like "what is a order
  // block" never appeared and the target was re-generated on every batch — the
  // order-block page took the same three questions three times before the thin
  // check finally caught the repetition.
  // ?reset=1 discards staged enrichment and starts again from the live body.
  // Needed after a bad run — the order-block page accumulated duplicate sections
  // before explicit tracking existed. Only ever clears pendingEdits; globalContent
  // (what is actually live) is untouched.
  if (url.searchParams.get('reset') === '1') {
    const r = pub.record;
    if (r.pendingEdits) delete r.pendingEdits.body;
    r.enrichedTargets = [];
    if (Array.isArray(r.editedFields)) r.editedFields = r.editedFields.filter(f => f !== 'body');
    await env.FFX_KV.put(pub.key, JSON.stringify(r));
    return json({ slug, reset: true, note: 'Staged enrichment cleared. The live page was never touched. Re-run to rebuild.' });
  }

  const covered = new Set(Array.isArray(pub.record.enrichedTargets) ? pub.record.enrichedTargets : []);
  const remaining = entry.targets.filter(t => !covered.has(t.keyword));
  if (!remaining.length) {
    return json({ slug, staged: false, complete: true, note: 'Every planned section already appears in this page.' });
  }
  const batchSize = Math.max(1, Math.min(8, parseInt(url.searchParams.get('batch') || '4', 10) || 4));
  const batch = remaining.slice(0, batchSize);

  // 3. Ground in Salman's own words
  let nuggets = [];
  try {
    const ids = await retrieveNuggetIds(env, { keyword: entry.topic, canonical: entry.topic, nugget_tags: '' }, 8);
    nuggets = await loadNuggetTexts(env, ids);
  } catch { nuggets = []; }

  // 4. Generate
  let sections;
  try {
    sections = await generateSections({ title: pub.title, body: pub.body }, batch, nuggets, env.ANTHROPIC_API_KEY);
  } catch (err) {
    return json({ error: 'generation failed: ' + err.message }, 502);
  }
  const mergedBody = mergeSections(pub.body, sections);

  // 4b. SELF-REPETITION GUARD — the prompt tells the model not to restate what the
  // article already says; this verifies it rather than trusting it. Compares the
  // new sections against the EXISTING body, which the corpus check cannot do
  // (a page is always excluded from its own similarity corpus).
  try {
    const overlap = phraseOverlap(sections, pub.body);
    if (overlap > 0.30) {
      return json({
        slug, staged: false,
        gate: { status: 'failed', reason: `[self-repetition] ${Math.round(overlap * 100)}% of the new text's phrasing already appears in the article — restating, not adding` },
        note: 'Nothing was written — the live page is untouched.',
        sectionsPreview: sections.slice(0, 1200),
      }, 422);
    }
  } catch { /* non-fatal — the corpus check below still runs */ }

  // 5. THE SAME GATES AS ANY NEW ARTICLE. Fail closed — write nothing.
  // addedBody = the new sections only. Duplication AND quote verification judge
  // just what this run added; thin, voice and anti-fabrication still judge the
  // full merged body, where they belong.
  let verdict;
  try {
    const corpus = await loadCorpus(env);
    verdict = await runGate(
      { slug, title: pub.title, tags: [], body: mergedBody, targetQuery: entry.headKeyword },
      { corpus, pageType: 'article', nuggetTexts: nuggets.map(n => n.text), addedBody: sections },
      env
    );
  } catch (err) {
    verdict = { status: 'failed', reason: '[gate-error] ' + err.message };
  }

  if (verdict.status !== 'passed') {
    return json({
      slug, staged: false, gate: verdict,
      note: 'Gate rejected the enriched body. Nothing was written — the live page is untouched.',
      sectionsPreview: sections.slice(0, 1200),
    }, 422);
  }

  if (preview) {
    return json({ slug, staged: false, preview: true, gate: verdict, generated: batch, remainingAfter: remaining.length - batch.length, sections });
  }

  // 6. Stage to pendingEdits — never globalContent.
  const rec = pub.record;
  if (!rec.pendingEdits) rec.pendingEdits = {};
  rec.pendingEdits.body = mergedBody;
  if (!Array.isArray(rec.editedFields)) rec.editedFields = [];
  if (!rec.editedFields.includes('body')) rec.editedFields.push('body');
  rec.enrichedTargets = [...covered, ...batch.map(t => t.keyword)];
  rec.updatedAt = new Date().toISOString();
  rec.enrichedAt = rec.updatedAt;
  await env.FFX_KV.put(pub.key, JSON.stringify(rec));

  try { await writeVerdict(env, slug, mergedBody, verdict); } catch { /* non-fatal */ }

  return json({
    slug,
    staged: true,
    kvKey: pub.key,
    sectionsAdded: batch.length,
    addedVolume: batch.reduce((n, t) => n + t.volume, 0),
    remainingAfter: remaining.length - batch.length,
    keywords: batch.map(t => t.keyword),
    bodyBefore: pub.body.length,
    bodyAfter: mergedBody.length,
    gate: { status: verdict.status, similarity: verdict.similarity, voice: verdict.voice, wordCount: verdict.wordCount },
    note: 'Staged to pendingEdits. The LIVE page is unchanged until you republish it.',
  });
}
