// ═══════════════════════════════════════════════════════════════════════════
// VERDICT LAYER — the KV record the publisher reads (FFX's missing piece).
// ───────────────────────────────────────────────────────────────────────────
// The audit's core silent-failure finding: FFX writes NO quality verdict anywhere,
// so "passed", "failed", and "never gated" are indistinguishable, and publish.js
// had nothing to enforce. This is FFX's analogue of Scout's verdict-store fix.
//
//   gate:{slug} = { status, reason, fabrication, similarity, structural, voice, bannedOpenings, contentHash, at }
//
// publish.js REFUSES to publish unless status === 'passed' AND hashContent(body)
// === contentHash — binding the verdict to the exact bytes that were gated, so
// content edited after gating cannot ride a stale "passed" to publish (it must
// re-gate). Mirrors Scout's publisher.js:63-83.
//
// gate:corpus = [ { slug, fp, vec } ] — the published-article comparison set for the
// similarity (TF-IDF uni+bigram) + structural-diversity checks. Appended on pass.
// ═══════════════════════════════════════════════════════════════════════════

import { structuralFingerprint } from './structure.js';
import { htmlToStructuralText } from './html.js';
import { termVector } from './similarity.js';
import { canonicalRole } from './blueprints.js';

// SHA-256 hex of the exact body string. crypto.subtle is present in both the
// Cloudflare Workers runtime (consumer) and Pages Functions (publish.js), and in Node.
export async function hashContent(body) {
  const bytes = new TextEncoder().encode(String(body ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function gateKey(slug) { return `gate:${slug}`; }

// Write the verdict for a slug, binding it to the exact body via contentHash.
export async function writeVerdict(env, slug, body, verdict) {
  const contentHash = await hashContent(body);
  const record = {
    status: verdict.status,                 // 'passed' | 'failed'
    reason: verdict.reason || null,
    fabrication: verdict.fabrication ?? null,   // { status:'clean'|'flagged'|'unverified', claim, note }
    similarity: verdict.similarity ?? null,     // max TF-IDF (uni+bigram) cosine vs corpus
    structural: verdict.structural ?? null,     // max composite skeleton sim vs corpus
    voice: verdict.voice ?? null,               // voice compliance score (0-100)
    bannedOpenings: verdict.bannedOpenings ?? null, // { pass, violations }
    contentHash,
    at: verdict.at || new Date().toISOString(),
  };
  await env.FFX_KV.put(gateKey(slug), JSON.stringify(record));
  return record;
}

export async function readVerdict(env, slug) {
  return await env.FFX_KV.get(gateKey(slug), { type: 'json' });
}

// The publisher's enforcement decision. Returns { ok, reason }. Refuses unless a
// PASSED verdict exists AND its hash matches the body being published.
export async function checkPublishAllowed(env, slug, body) {
  const verdict = await readVerdict(env, slug);
  if (!verdict) return { ok: false, reason: `No gate verdict for "${slug}" — content was never gated. Run the gate before publishing.` };
  if (verdict.status !== 'passed') return { ok: false, reason: `Gate verdict is "${verdict.status}"${verdict.reason ? ' — ' + verdict.reason : ''}. Not publishable.` };
  const currentHash = await hashContent(body);
  if (verdict.contentHash !== currentHash) {
    return { ok: false, reason: `Content changed since it was gated (hash mismatch) — re-gate the edited article before publishing.` };
  }
  return { ok: true, reason: 'gate passed + hash matches' };
}

// ─── COMPARISON CORPUS (published set for similarity + structural checks) ─────
export async function loadCorpus(env) {
  const c = await env.FFX_KV.get('gate:corpus', { type: 'json' }).catch(() => null);
  return Array.isArray(c) ? c : [];
}

// Build a corpus entry from a body: structural fingerprint + a TF-IDF-ready
// uni+bigram term vector (weighted against the corpus IDF at gate time).
export function corpusEntry(slug, body, topicTokens = []) {
  return {
    slug,
    fp: structuralFingerprint(htmlToStructuralText(body), topicTokens, canonicalRole),
    vec: termVector(body),
  };
}

// Append/replace an entry (dedupe by slug) — called after an article passes + publishes.
export async function upsertCorpus(env, slug, body, topicTokens = []) {
  const corpus = await loadCorpus(env);
  const filtered = corpus.filter(e => e && e.slug !== slug);
  filtered.push(corpusEntry(slug, body, topicTokens));
  await env.FFX_KV.put('gate:corpus', JSON.stringify(filtered));
  return filtered.length;
}
